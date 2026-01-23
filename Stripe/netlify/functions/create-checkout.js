// Stripe/netlify/functions/create-checkout.js
// Netlify Function: crea una Checkout Session Stripe e ritorna { url }
// Richiede: npm i stripe

const Stripe = require('stripe');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return { statusCode: 500, body: 'Missing STRIPE_SECRET_KEY env var' };
    }

    const stripe = Stripe(secretKey, { apiVersion: '2023-10-16' });

    const payload = JSON.parse(event.body || '{}');
    const items = Array.isArray(payload.items) ? payload.items : [];

    if (!items.length) {
      return { statusCode: 400, body: 'No items' };
    }

    // Origin: usato per success/cancel URL.
    // Su Netlify puoi usare header origin/referer.
    const origin =
      (event.headers && (event.headers.origin || event.headers.Origin)) ||
      (payload.origin || '');

    if (!origin) {
      return { statusCode: 400, body: 'Missing origin' };
    }

    const successUrl = `${origin}/indexStripe.html?stripe_success=1&session_id={CHECKOUT_SESSION_ID}#catalogue`;
    const cancelUrl  = `${origin}/indexStripe.html?stripe_cancel=1#catalogue`;

    // NB: line_items in mode=payment richiede price_data.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: items.map((it) => ({
        quantity: Number(it.quantity || 1),
        price_data: {
          currency: String(it.currency || 'eur').toLowerCase(),
          unit_amount: Number(it.unit_amount),
          product_data: {
            name: String(it.name || 'Item').slice(0, 120),
            images: it.image ? [String(it.image)] : undefined,
          },
        },
      })),
      // opzionale: indirizzo di spedizione
      shipping_address_collection: { allowed_countries: ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'AT', 'CH', 'US', 'GB'] },
      // opzionale: telefono
      phone_number_collection: { enabled: true },
      allow_promotion_codes: true,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err && (err.message || err)) }),
    };
  }
};
