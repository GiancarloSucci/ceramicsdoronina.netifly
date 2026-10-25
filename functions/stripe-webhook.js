// functions/stripe-webhook.js
// Receives signed Stripe events; on checkout.session.completed notifies the owner.
// Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, OWNER_NOTIFY_WEBHOOK_URL (optional).
// Idempotency: stateless. Stripe may retry/duplicate deliveries (same event.id);
// the notification is informational only, so a duplicate is harmless. event.id is logged
// so duplicates can be spotted. No customer PII is logged (only ids and totals).
const STRIPE_API_VERSION = "2024-06-20"; // keep in sync with create-checkout.js

function defaultStripeFactory(key) {
  const Stripe = require("stripe");
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}

function buildOrderSummary(session, lineItems = [], itemIds = "") {
  const cd = session.customer_details || {};
  const sd = session.shipping_details || session.collected_information?.shipping_details || {};
  const addr = sd.address || cd.address || null;
  const addrText = addr
    ? [sd.name, addr.line1, addr.line2, [addr.postal_code, addr.city].filter(Boolean).join(" "), addr.state, addr.country]
        .filter(Boolean)
        .join(", ")
    : "(no address: digital order)";
  const names = lineItems.map((li) => `${li.quantity || 1} x ${li.description || li.name || "item"}`);
  const note = (session.custom_fields || []).find((f) => f.key === "note");
  const noteText = note && note.text && note.text.value ? note.text.value : "";
  const total = typeof session.amount_total === "number" ? (session.amount_total / 100).toFixed(2) : "?";
  return [
    "New paid order",
    `Session: ${session.id}`,
    `Customer: ${cd.name || ""} <${cd.email || ""}> ${cd.phone || ""}`.trim(),
    `Ship to: ${addrText}`,
    `Items: ${names.length ? names.join("; ") : itemIds || "(unknown)"}`,
    `Catalogue ids: ${itemIds || (session.metadata && session.metadata.item_ids) || ""}`,
    `Total: ${total} ${String(session.currency || "eur").toUpperCase()}`,
    noteText ? `Note: ${noteText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Pluggable owner notification: structured log line + optional JSON POST.
async function notifyOwner(summary, env = process.env, fetchImpl = globalThis.fetch) {
  console.info(JSON.stringify({ event: "owner_notification", length: summary.length }));
  if (env.OWNER_NOTIFY_WEBHOOK_URL && fetchImpl) {
    const res = await fetchImpl(env.OWNER_NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: summary, summary }),
    });
    if (!res.ok) throw new Error("notify_webhook_status_" + res.status);
  }
}

function makeHandler({ stripeFactory = defaultStripeFactory, env = process.env, notify = notifyOwner } = {}) {
  return async function handler(event) {
    const res = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (event.httpMethod !== "POST") return res(405, { error: "method_not_allowed" });
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
      console.warn(JSON.stringify({ event: "config_missing", variable: "STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET" }));
      return res(500, { error: "server_error" });
    }
    const headers = event.headers || {};
    const signature = headers["stripe-signature"] || headers["Stripe-Signature"];
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
    const stripe = stripeFactory(env.STRIPE_SECRET_KEY);
    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (_) {
      console.warn(JSON.stringify({ event: "webhook_bad_signature" }));
      return res(400, { error: "invalid_signature" });
    }
    if (stripeEvent.type !== "checkout.session.completed") return res(200, { received: true, ignored: true });

    const session = stripeEvent.data.object;
    try {
      let lineItems = [];
      try {
        const list = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
        lineItems = list.data || [];
      } catch (_) {
        console.warn(JSON.stringify({ event: "list_line_items_failed", session_id: session.id }));
      }
      const itemIds = (session.metadata && session.metadata.item_ids) || "";
      await notify(buildOrderSummary(session, lineItems, itemIds), env);
      console.info(JSON.stringify({ event: "order_completed", event_id: stripeEvent.id, session_id: session.id, item_ids: itemIds, amount_total: session.amount_total }));
      return res(200, { received: true });
    } catch (err) {
      console.error(JSON.stringify({ event: "webhook_processing_failed", event_id: stripeEvent.id, session_id: session.id }));
      return res(500, { error: "server_error" }); // Stripe will retry
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.buildOrderSummary = buildOrderSummary;
exports.notifyOwner = notifyOwner;
