// functions/stripe-webhook.js
// Receives signed Stripe events and notifies the owner about:
//   checkout.session.completed               paid -> "New paid order"; not yet paid -> "AWAITING PAYMENT, do not ship"
//   checkout.session.async_payment_succeeded -> "New paid order" (payment confirmed)
//   checkout.session.async_payment_failed    -> "PAYMENT FAILED, do not ship"
// Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, OWNER_NOTIFY_WEBHOOK_URL (optional, https only),
// CATALOGUE_WRITE_URL / CATALOGUE_WRITE_SECRET (optional, see _catalogue-source.js).
// Paid orders also mark the ordered one-off physical pieces (maxQty 1) as sold in the Google
// Sheet (tab Vasi) and book the ordered masterclass seats (session metadata `bookings`, "mc1:2,mc3:1")
// in the tab Masterclass (column seats_booked), in ONE Apps Script call (contract v2: POST
// {secret, session_id, ids, bookings}, reply {ok, version:2, sheet:"Vasi", marked, booked:[{id, seats,
// booked_after, total, overbooked, duplicate}]}). Marking problems never change the 200 answer to Stripe:
// the owner is told to mark by hand. Booked seats also count locally for 15 minutes (per session id, so
// Stripe retries never count twice), until the published CSV catches up.
// Idempotency: stateless. Stripe may retry/duplicate deliveries (same event.id);
// the notification is informational only, so a duplicate is harmless. event.id is logged
// so duplicates can be spotted. Customer PII (name, email, phone, address, note) is never
// logged; only ids, totals, currency, payment status and country.
const crypto = require("crypto");
const { defaultStripeFactory, decodeBody, safeText, parseBookings } = require("./_shared.js");
const catalogueSource = require("./_catalogue-source.js");

const HANDLED = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
];
const FIELD_MAX = 200;
const NOTE_MAX = 500;
const NOTIFY_TIMEOUT_MS = 5000;
// Netlify sync functions stop at 10 s: marking (3 attempts x 5 s worst case) must not starve the owner notification.
const MARK_DEADLINE_MS = 4000;

// Neutralises chat-markup injection in customer-controlled text: escapes & < >
// (so "<!channel>", "<http://..|x>" and "<@U1>" cannot form links or mentions) and
// breaks leading @-mentions ("@channel", "@here") with a zero-width space.
function clean(v, max = FIELD_MAX) {
  return String(v == null ? "" : v)
    .slice(0, max)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/(^|\s)@/g, "$1@​");
}

function addressText(name, addr) {
  if (!addr) return "";
  return [clean(name), clean(addr.line1), clean(addr.line2), [clean(addr.postal_code), clean(addr.city)].filter(Boolean).join(" "), clean(addr.state), clean(addr.country)]
    .filter(Boolean)
    .join(", ");
}

function paymentKind(session) {
  return session.payment_status === "paid" || session.payment_status === "no_payment_required" ? "paid" : "awaiting";
}

const HEADERS = {
  paid: "New paid order",
  awaiting: "AWAITING PAYMENT, do not ship (payment not confirmed yet)",
  failed: "PAYMENT FAILED, do not ship (asynchronous payment failed)",
};

// kind: "paid" | "awaiting" | "failed" (defaults from session.payment_status)
function buildOrderSummary(session, lineItems = [], itemIds = "", kind = paymentKind(session), bookings = parseBookings(session.metadata && session.metadata.bookings)) {
  const cd = session.customer_details || {};
  const sd = session.shipping_details || session.collected_information?.shipping_details || null;
  const shipText = sd && sd.address ? addressText(sd.name, sd.address) : "";
  const billText = cd.address ? addressText(cd.name, cd.address) : "";
  const names = lineItems.map((li) => `${li.quantity || 1} x ${clean(li.description || li.name || "item")}`);
  const note = (session.custom_fields || []).find((f) => f.key === "note");
  const noteText = note && note.text && note.text.value ? clean(note.text.value, NOTE_MAX) : "";
  const total = typeof session.amount_total === "number" ? (session.amount_total / 100).toFixed(2) : "?";
  const ids = itemIds || (session.metadata && session.metadata.item_ids) || "";
  return [
    HEADERS[kind] || HEADERS.awaiting,
    `Session: ${session.id}`,
    `Payment status: ${session.payment_status || "?"}`,
    `Customer: ${clean(cd.name)} (${clean(cd.email)}) ${clean(cd.phone)}`.trim(),
    shipText ? `Ship to: ${shipText}` : "Shipping: none (digital order)",
    billText ? `Billing: ${billText}` : "",
    `Items: ${names.length ? names.join("; ") : clean(ids) || "(unknown)"}`,
    `Catalogue ids: ${clean(ids)}`,
    bookings.length ? `Masterclass persons: ${bookings.map((b) => `${clean(b.id, 40)} x ${b.seats}`).join("; ")}` : "",
    `Total: ${total} ${clean(String(session.currency || "eur").toUpperCase(), 10)}`,
    noteText ? `Note: ${noteText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function isHttpsUrl(u) {
  try {
    return new URL(u).protocol === "https:";
  } catch (_) {
    return false;
  }
}

// Pluggable owner notification: structured log line + optional JSON POST.
// Returns true when the summary was delivered to OWNER_NOTIFY_WEBHOOK_URL.
async function notifyOwner(summary, env = process.env, fetchImpl = globalThis.fetch, requestId) {
  console.info(JSON.stringify({ event: "owner_notification", request_id: requestId, length: summary.length }));
  const url = env.OWNER_NOTIFY_WEBHOOK_URL;
  if (!url) return false;
  if (!isHttpsUrl(url)) {
    console.error(JSON.stringify({ event: "notify_config_invalid", request_id: requestId, variable: "OWNER_NOTIFY_WEBHOOK_URL", reason: "must be an https URL" }));
    return false;
  }
  if (!fetchImpl) return false;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: summary, summary }),
      redirect: "error",
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
  } catch (err) {
    // Never propagate the original error: its message/cause may contain the URL.
    const e = new Error("notify_fetch_failed");
    e.name = "NotifyFetchError";
    e.code = (err && (err.code || (err.cause && err.cause.code))) || (err && err.name) || "unknown";
    throw e;
  }
  if (!res.ok) throw new Error("notify_webhook_status_" + res.status);
  return true;
}

// Ids of the unique pieces (physical, maxQty 1) among the ordered catalogue ids.
function uniquePieceIds(itemIds, items) {
  const ids = String(itemIds || "").split(",").map((x) => x.trim()).filter(Boolean);
  return [...new Set(ids)].filter((id) => Object.prototype.hasOwnProperty.call(items, id) && items[id].type === "physical" && items[id].maxQty === 1);
}

function makeHandler({
  stripeFactory = defaultStripeFactory,
  env = process.env,
  notify = notifyOwner,
  getCatalogue = catalogueSource.getCatalogue,
  markSold = catalogueSource.markSold,
  markSoldLocal = catalogueSource.markSoldLocal,
  markBookedLocal = catalogueSource.markBookedLocal,
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function handler(event) {
    const headers = event.headers || {};
    const lower = {};
    for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
    const requestId = lower["x-nf-request-id"] || crypto.randomUUID();
    const log = (level, obj) => console[level](JSON.stringify({ ...obj, request_id: requestId }));
    const res = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "x-request-id": requestId }, body: JSON.stringify(body) });

    if (event.httpMethod !== "POST") return res(405, { error: "method_not_allowed" });
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
      log("error", { event: "config_missing", variable: "STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET" });
      return res(500, { error: "server_error" });
    }
    const signature = lower["stripe-signature"];
    const raw = decodeBody(event);

    let stripe;
    try {
      stripe = stripeFactory(env.STRIPE_SECRET_KEY);
    } catch (err) {
      log("error", { event: "unexpected_error", name: err && err.name, message: safeText(err && err.message, 200) });
      return res(500, { error: "server_error" });
    }

    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      log("warn", { event: "webhook_bad_signature", type: err && err.type, message: safeText(err && err.message, 200) });
      return res(400, { error: "invalid_signature" });
    }
    if (!HANDLED.includes(stripeEvent.type)) return res(200, { received: true, ignored: true });

    const session = stripeEvent.data.object;
    const kind =
      stripeEvent.type === "checkout.session.async_payment_failed"
        ? "failed"
        : stripeEvent.type === "checkout.session.async_payment_succeeded"
          ? "paid"
          : paymentKind(session);
    try {
      let lineItems = [];
      try {
        const list = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
        lineItems = list.data || [];
      } catch (_) {
        log("warn", { event: "list_line_items_failed", session_id: session.id });
      }
      const itemIds = (session.metadata && session.metadata.item_ids) || "";
      // Marks the ordered unique pieces as sold and books the masterclass seats (one Apps Script call).
      // Returns the lines for the owner ("ACTION: ..." / "OVERBOOKED ...", joined by newlines), "" when all
      // went well. Never throws: marking problems must not turn into a non-200 answer to Stripe.
      const recordPaid = async (ids, sess, evt) => {
        let pieces = [];
        let localDone = false;
        const bookings = parseBookings(sess.metadata && sess.metadata.bookings);
        const book = bookings.map((b) => `${b.id}:${b.seats}`);
        const lines = [];
        const manual = (why) => {
          const out = [];
          const hint = why === "script_outdated" ? " (Apps Script needs updating)" : "";
          if (pieces.length) out.push(`ACTION: mark ${pieces.join(", ")} as sold in the sheet manually${hint}`);
          for (const b of bookings) out.push(`ACTION: add ${b.seats} seats to ${b.id} in the sheet manually (seats_booked)${hint}`);
          return out;
        };
        const localEffects = () => {
          if (pieces.length) markSoldLocal(pieces); // sold at once, before the published CSV catches up
          if (bookings.length) markBookedLocal(bookings, { sessionId: sess.id }); // seats taken at once, once per session
          localDone = true;
        };
        try {
          if (ids) {
            const { items } = await getCatalogue({ fetchImpl, env });
            pieces = uniquePieceIds(ids, items);
          }
          if (!pieces.length && !bookings.length) return "";
          localEffects();
          let timer;
          const deadline = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ ok: false, reason: "deadline" }), MARK_DEADLINE_MS);
          });
          const r = await Promise.race([markSold(pieces, { fetchImpl, env, bookings, sessionId: sess.id }), deadline]).finally(() => clearTimeout(timer));
          if (r && r.ok) {
            if (pieces.length) log("info", { event: "sold_marked", session_id: sess.id, event_id: evt.id, ids: pieces });
            if (bookings.length) {
              log("info", { event: "seats_booked", session_id: sess.id, event_id: evt.id, bookings: book });
              const reply = new Map((Array.isArray(r.booked) ? r.booked : []).map((b) => [b.id, b]));
              for (const b of bookings) {
                const e = reply.get(b.id);
                if (!e) {
                  log("warn", { event: "seats_book_unconfirmed", session_id: sess.id, event_id: evt.id, id: b.id });
                  lines.push(`ACTION: add ${b.seats} seats to ${b.id} in the sheet manually (seats_booked)`);
                } else if (e.overbooked) {
                  log("warn", { event: "seats_overbooked", session_id: sess.id, event_id: evt.id, id: b.id });
                  lines.push(`OVERBOOKED ${b.id}: refund this booking or move it`);
                }
              }
            }
            return lines.join("\n");
          }
          const reason = (r && r.reason) || "unknown";
          if (reason === "not_configured") log("warn", { event: "sold_mark_not_configured", session_id: sess.id, event_id: evt.id, ids: pieces, bookings: book });
          else log("warn", { event: "sold_mark_failed", session_id: sess.id, event_id: evt.id, ids: pieces, bookings: book, reason: safeText(reason, 60) });
          return manual(reason).join("\n");
        } catch (err) {
          try {
            if (!localDone) localEffects();
          } catch (_) {}
          log("warn", { event: "sold_mark_failed", session_id: sess.id, event_id: evt.id, ids: pieces, bookings: book, reason: "error", name: err && err.name });
          return manual("error").join("\n");
        }
      };
      const logNotConfigured = () => {
        // No PII here: this is the only trace the owner has when no channel is configured.
        const sd = session.shipping_details || session.collected_information?.shipping_details || null;
        const country = (sd && sd.address && sd.address.country) || (session.customer_details && session.customer_details.address && session.customer_details.address.country) || null;
        log("warn", {
          event: "owner_notify_not_configured",
          session_id: session.id,
          event_id: stripeEvent.id,
          item_ids: itemIds,
          amount_total: session.amount_total,
          currency: session.currency,
          payment_status: session.payment_status,
          country,
          kind,
        });
      };
      if (!env.OWNER_NOTIFY_WEBHOOK_URL) logNotConfigured();
      let summary = buildOrderSummary(session, lineItems, itemIds, kind);
      if (kind === "paid") {
        // Stripe retries are harmless: the Apps Script sets sold=true again and skips a session/item it already booked.
        const manual = await recordPaid(itemIds, session, stripeEvent);
        if (manual) summary += `\n${manual}`;
      }
      const delivered = await notify(summary, env, undefined, requestId);
      if (env.OWNER_NOTIFY_WEBHOOK_URL && delivered === false) logNotConfigured(); // invalid URL: nothing was sent
      log("info", { event: "order_completed", event_type: stripeEvent.type, kind, event_id: stripeEvent.id, session_id: session.id, item_ids: itemIds, amount_total: session.amount_total, payment_status: session.payment_status });
      return res(200, { received: true });
    } catch (err) {
      const out = { event: "webhook_processing_failed", event_id: stripeEvent.id, session_id: session.id, name: err && err.name };
      if (err && err.name === "NotifyFetchError") out.code = err.code; // never the URL
      else out.message = safeText(err && err.message, 200);
      log("error", out);
      return res(500, { error: "server_error" }); // Stripe will retry
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.buildOrderSummary = buildOrderSummary;
exports.notifyOwner = notifyOwner;
exports.clean = clean;
exports.uniquePieceIds = uniquePieceIds;
