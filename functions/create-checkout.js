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
  const raw = process.env.ALLOWED_ORIGINS || "";
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || "";

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin || "*"), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // CORS allowlist
  const allowed = parseAllowedOrigins();
  if (!origin) {
    return { statusCode: 400, headers: { "Content-Type": "text/plain" }, body: "Missing origin" };
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

    // dove tornare dopo checkout (PROD: ceramicsdoronina.it)
    const returnBase = String(payload.return_base || "").trim() || origin;

    const successUrl = `${returnBase}/stripe-success.html?session_id={CHECKOUT_SESSION_ID}#catalogue`;
    const cancelUrl  = `${returnBase}/stripe-cancel.html#catalogue`;

    if (!Array.isArray(items) || items.length === 0) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        body: JSON.stringify({ error: "Missing items[]" }),
      };
    }

    const line_items = items.map((it) => {
      const name = String(it.name || "Item").trim().slice(0, 120);
      const currency = String(it.currency || "eur").toLowerCase();
      const unit_amount = Number(it.unit_amount);
      const quantity = Number(it.quantity ?? it.qty ?? 1);
      const image = it.image ? String(it.image) : "";

      if (!Number.isFinite(unit_amount) || !Number.isInteger(unit_amount) || unit_amount <= 0) {
        throw new Error(`Invalid integer: ${unit_amount}`);
      }
      if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(`Invalid quantity: ${quantity}`);
      }

      return {
        quantity,
        price_data: {
          currency,
          unit_amount,
          product_data: {
            name,
            images: image ? [image] : undefined,
          },
        },
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,

      // spedizione / fatturazione / contatti
      shipping_address_collection: {
        allowed_countries: ["IT","DE","FR","ES","NL","BE","AT","CH","GB","US"],
      },
      billing_address_collection: "required", // o "auto"
      phone_number_collection: { enabled: true },

      // campo extra
      custom_fields: [
        {
          key: "note",
          label: { type: "custom", custom: "Note per la consegna / regalo" },
          type: "text",
          optional: true,
        },
      ],

      allow_promotion_codes: true,

      // costo spedizione (opzionale)
      shipping_options: [
        {
          shipping_rate_data: {
            display_name: "Spedizione standard",
            type: "fixed_amount",
            fixed_amount: { amount: 1200, currency: "eur" }, // 12.00€
            delivery_estimate: {
              minimum: { unit: "business_day", value: 2 },
              maximum: { unit: "business_day", value: 5 },
            },
          },
        },
      ],

      metadata: payload.metadata || undefined,
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

