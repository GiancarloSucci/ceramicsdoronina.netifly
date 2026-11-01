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

const MAX_GROUP = 20; // masterclass price-table booking size (price_1..price_20): 1..20 persons
const MAX_PERSONS = 999; // technical ceiling of persons in ONE booking (linear pricing, seats in bookings)
const STRIPE_MAX_CENTS = 99999999; // Stripe's maximum amount of a single price, in cents

// Most persons a LINEAR masterclass (N x price_1) can book: min(MAX_PERSONS, what keeps N x price_1
// within Stripe's maximum amount).
function maxLinearPersons(linearCents) {
  return Math.max(0, Math.min(MAX_PERSONS, Math.floor(STRIPE_MAX_CENTS / linearCents)));
}

// Parses the session metadata `bookings` ("mc1:2,mc3:1": masterclass id : persons) into
// [{id, seats}]. Malformed entries are skipped; seats are 1..MAX_PERSONS (999).
function parseBookings(raw) {
  const out = [];
  for (const part of String(raw == null ? "" : raw).split(",")) {
    const m = /^([a-z][a-z0-9-]{0,31}):([1-9]\d{0,2})$/.exec(part.trim());
    if (m && Number(m[2]) <= MAX_PERSONS) out.push({ id: m[1], seats: Number(m[2]) });
  }
  return out;
}

module.exports = { STRIPE_API_VERSION, defaultStripeFactory, decodeBody, redact, safeText, parseBookings, MAX_GROUP, MAX_PERSONS, STRIPE_MAX_CENTS, maxLinearPersons };
