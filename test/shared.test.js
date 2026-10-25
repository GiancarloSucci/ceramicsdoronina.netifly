const test = require("node:test");
const assert = require("node:assert");
const { STRIPE_API_VERSION, defaultStripeFactory, decodeBody, redact, safeText } = require("../functions/_shared.js");

let stripeInstalled = true;
try { require.resolve("stripe"); } catch (_) { stripeInstalled = false; }

test("defaultStripeFactory builds a client with the pinned API version", {
  skip: stripeInstalled ? false : "the `stripe` package is not installed (run npm install); the real SDK is never needed by the faked tests",
}, () => {
  const client = defaultStripeFactory("sk_test_dummy");
  assert.equal(typeof client.checkout.sessions.create, "function");
  assert.equal(typeof client.webhooks.constructEvent, "function");
  assert.equal(STRIPE_API_VERSION, "2024-06-20");
});

test("decodeBody: plain, base64, empty, non-ASCII", () => {
  const s = '{"a":"Zoë €"}';
  assert.equal(decodeBody({ body: s }), s);
  assert.equal(decodeBody({ body: Buffer.from(s).toString("base64"), isBase64Encoded: true }), s);
  assert.equal(decodeBody({}), "");
  assert.equal(decodeBody({ body: null, isBase64Encoded: true }), "");
});

test("redact / safeText", () => {
  assert.equal(redact("a sk_live_AbC1 b rk_test_x whsec_Z9 pk_live_q"), "a [redacted] b [redacted] [redacted] [redacted]");
  assert.equal(safeText("x".repeat(300), 200).length, 200);
  assert.equal(safeText(undefined), "");
});
