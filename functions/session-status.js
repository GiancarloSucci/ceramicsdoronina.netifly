// functions/session-status.js
// GET ?session_id=cs_... -> {"paid": boolean, "status": "open"|"complete"|"expired"|"unknown"}.
// The site asks this for the Checkout sessions it has marked as pending in the visitor's browser, so the cart can be emptied
// as soon as the payment is completed even if the customer never returns through the site. It answers NOTHING else:
// no amounts, no customer data, no line items. An unknown session answers the same shape as any other (no existence leak).
const crypto = require("crypto");
const { defaultStripeFactory, safeText } = require("./_shared.js");
const { parseAllowedOrigins, isOriginAllowed } = require("./create-checkout.js");

const SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{8,}$/;
const SESSION_ID_MAX = 200;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(statusCode, body, headers, requestId) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "x-request-id": requestId, ...headers },
    body: JSON.stringify({ ...body, request_id: requestId }),
  };
}

function logLine(level, obj) {
  console[level](JSON.stringify(obj));
}

function makeHandler({ stripeFactory = defaultStripeFactory, env = process.env } = {}) {
  return async function handler(event) {
    const headers = event.headers || {};
    const requestId = headers["x-nf-request-id"] || crypto.randomUUID();
    const origin = headers.origin || headers.Origin || "";
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const originOk = isOriginAllowed(origin, allowed);
    const cors = originOk ? corsHeaders(origin) : {};

    if (event.httpMethod !== "OPTIONS" && event.httpMethod !== "GET") {
      logLine("info", { event: "method_not_allowed", request_id: requestId, method: safeText(event.httpMethod, 20) });
      return json(405, { error: "method_not_allowed" }, cors, requestId);
    }
    if (allowed.length === 0) {
      logLine("error", { event: "config_missing", request_id: requestId, variable: "ALLOWED_ORIGINS" });
      return json(500, { error: "server_error" }, {}, requestId);
    }
    if (!origin) {
      logLine("info", { event: "origin_missing", request_id: requestId });
      return json(400, { error: "bad_request" }, {}, requestId);
    }
    if (!originOk) {
      logLine("warn", { event: "origin_rejected", request_id: requestId, origin: safeText(origin, 200) });
      return json(403, { error: "origin_not_allowed" }, {}, requestId);
    }
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: { ...cors, "Cache-Control": "no-store", "x-request-id": requestId }, body: "" };
    }

    const secretKey = env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      logLine("error", { event: "config_missing", request_id: requestId, variable: "STRIPE_SECRET_KEY" });
      return json(500, { error: "server_error" }, cors, requestId);
    }

    const raw = event.queryStringParameters && event.queryStringParameters.session_id;
    if (typeof raw !== "string" || raw.length > SESSION_ID_MAX || !SESSION_ID_PATTERN.test(raw)) {
      logLine("warn", { event: "validation_failed", request_id: requestId, code: "invalid_session_id" });
      return json(400, { error: "invalid_session_id" }, cors, requestId);
    }

    let session;
    try {
      session = await stripeFactory(secretKey).checkout.sessions.retrieve(raw);
    } catch (err) {
      if (err && err.code === "resource_missing") return json(200, { paid: false, status: "unknown" }, cors, requestId);
      logLine("error", {
        event: "stripe_error",
        request_id: requestId,
        type: err && err.type,
        code: err && err.code,
        status_code: err && err.statusCode,
        stripe_request_id: err && err.requestId,
        message: safeText(err && err.message, 200),
      });
      return json(502, { error: "payment_provider_error" }, cors, requestId);
    }

    const status = session && ["open", "complete", "expired"].includes(session.status) ? session.status : "unknown";
    const paid = !!session && (session.payment_status === "paid" || session.payment_status === "no_payment_required");
    return json(200, { paid, status }, cors, requestId);
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.SESSION_ID_PATTERN = SESSION_ID_PATTERN;
