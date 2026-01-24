// netlify/functions/create-checkout.js
const Stripe = require("stripe");

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Origin",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function parseAllowedOrigins() {
  // separati da spazio o virgola
  const raw = process.env.ALLOWED_ORIGINS || "";
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  // Preflight CORS
  if (event.httpMethod === "OPTIONS") {
    // Se vuoi essere più restrittivo: rispondi solo se origin è ammesso
    return {
      statusCode: 204,
      headers: corsHeaders(origin || "*"),
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // CORS allowlist (consigliata)
  const allowed = parseAllowedOrigins();
  if (!origin) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/plain" },
      body: "Missing origin",
    };
  }
  if (allowed.length > 0 && !allowed.includes(origin)) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "text/plain", ...corsHeaders(origin) },
      body: `Origin not allowed: ${origin}`,
    };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/plain", ...corsHeaders(origin) },
      body: "Missing STRIPE_SECRET_KEY env var",
    };
  }

  try {
    const stripe = Stripe(secretKey);

    const payload = event.body ? JSON.parse(event.body) : {};
    const items = payload.items || payload.lineItems || [];

    // URL di ritorno: meglio usare il sito “vero” (ceramicsdoronina.it),
    // quindi passala dal frontend come payload.return_base
    const returnBase = String(payload.return_base || "").trim() || origin;

    const successUrl = `${returnBase}/stripe-success.html`;
    const cancelUrl  = `${returnBase}/stripe-cancel.html`;

    if (!Array.isArray(items) || items.length === 0) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        body: JSON.stringify({ error: "Missing items[]" }),
      };
    }

    const line_items = items.map((it) => {
      const name = String(it.name || "Item").trim();
      const unit_amount = Number(it.unit_amount);
      const quantity = Number(it.quantity ?? it.qty ?? 1);

      if (!Number.isFinite(unit_amount) || !Number.isInteger(unit_amount) || unit_amount <= 0) {
        throw new Error(`Invalid integer: ${unit_amount}`);
      }
      if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(`Invalid quantity: ${quantity}`);
      }

      return {
        quantity,
        price_data: {
          currency: "eur",
          unit_amount,
          product_data: { name },
        },
      };
    });

//    const session = await stripe.checkout.sessions.create({
 //     mode: "payment",
  //    line_items,
   //   success_url: successUrl,
    //  cancel_url: cancelUrl,
//      // opzionale: metadata
//      metadata: payload.metadata || undefined,
//    });

// Origin: usato per success/cancel URL (DEV + PROD)
const origin =
  (event.headers && (event.headers.origin || event.headers.Origin)) ||
  (payload.origin || '');

if (!origin) return { statusCode: 400, body: 'Missing origin' };

// URL ASSOLUTE (Stripe le vuole assolute)
const successUrl = `${origin}/netlify_stripe-success.html?session_id={CHECKOUT_SESSION_ID}#catalogue`;
const cancelUrl  = `${origin}/netlify_stripe-cancel.html#catalogue`;

const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  success_url: successUrl,
  cancel_url: cancelUrl,

  line_items: items.map((it) => ({
    quantity: Math.max(1, Number(it.quantity || 1)),
    price_data: {
      currency: String(it.currency || 'eur').toLowerCase(),
      unit_amount: Number(it.unit_amount),
      product_data: {
        name: String(it.name || 'Item').slice(0, 120),
        images: it.image ? [String(it.image)] : undefined,
      },
    },
  })),

  // ✅ 1. indirizzo di spedizione
  shipping_address_collection: {
    allowed_countries: ['IT','DE','FR','ES','NL','BE','AT','CH','GB','US']
  },

  // ✅ 2. indirizzo di fatturazione (se lo vuoi sempre)
  billing_address_collection: 'required', // oppure 'auto'

  // ✅ 3. telefono
  phone_number_collection: { enabled: true },

  // ✅ 4. campi extra in checkout (es. note per spedizione / regalo)
  custom_fields: [
    {
      key: 'note',
      label: { type: 'custom', custom: 'Note per la consegna / regalo' },
      type: 'text',
      optional: true,
    }
  ],

  // ✅ 5. codici sconto
  allow_promotion_codes: true,

  // (opzionale) se vuoi far comparire “Spedizione” con costi, devi aggiungere shipping_options
  shipping_options: [
    { shipping_rate_data: { display_name: 'Spedizione standard', type: 'fixed_amount', fixed_amount: { amount: 1200, currency: 'eur' }, delivery_estimate: { minimum: { unit: 'business_day', value: 2 }, maximum: { unit: 'business_day', value: 5 } } } }
   ],
});


    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
};

