// functions/_shared.js
// Helpers shared by create-checkout.js and stripe-webhook.js. The leading
// underscore keeps Netlify from treating this file as a function of its own.

// Pinned Stripe API version: upgrade deliberately, not implicitly with the SDK.
const STRIPE_API_VERSION = "2024-06-20";

function defaultStripeFactory(key) {
  const Stripe = require("stripe"); // lazy: tests inject a fake and need no package
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}

// Returns the request body as a utf8 string (handles Netlify's base64 encoding).
function decodeBody(event) {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

// Strips Stripe-style secrets from free text before it is logged.
function redact(s) {
  return String(s == null ? "" : s).replace(/\b(?:sk|rk|pk|whsec)_\w+/g, "[redacted]");
}

// Redacted and length-capped text, safe to log.
function safeText(s, max = 200) {
  return redact(s).slice(0, max);
}

// Parses the session metadata `bookings` ("mc1:2,mc3:1": masterclass id : persons) into
// [{id, seats}]. Malformed entries are skipped; seats are 1..8.
function parseBookings(raw) {
  const out = [];
  for (const part of String(raw == null ? "" : raw).split(",")) {
    const m = /^([a-z][a-z0-9-]{0,31}):([1-8])$/.exec(part.trim());
    if (m) out.push({ id: m[1], seats: Number(m[2]) });
  }
  return out;
}

module.exports = { STRIPE_API_VERSION, defaultStripeFactory, decodeBody, redact, safeText, parseBookings };
