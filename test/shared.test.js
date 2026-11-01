const test = require("node:test");
const assert = require("node:assert");
const { STRIPE_API_VERSION, defaultStripeFactory, decodeBody, redact, safeText, parseBookings, maxLinearPersons, MAX_PERSONS, STRIPE_MAX_CENTS } = require("../functions/_shared.js");

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

test("maxLinearPersons: min(999, floor(Stripe max / price))", () => {
  assert.equal(maxLinearPersons(10000), 999);
  assert.equal(maxLinearPersons(500000), 199);
  assert.equal(maxLinearPersons(1000000), 99);
  assert.equal(maxLinearPersons(100000000), 0);
  assert.deepEqual([MAX_PERSONS, STRIPE_MAX_CENTS], [999, 99999999]);
});

test("parseBookings: seats 1..999, malformed entries skipped", () => {
  assert.deepEqual(parseBookings("mc1:1,mc2:20,mc3:9,mc4:10"), [{ id: "mc1", seats: 1 }, { id: "mc2", seats: 20 }, { id: "mc3", seats: 9 }, { id: "mc4", seats: 10 }]);
  assert.deepEqual(parseBookings("mc1:0,mc1:1000,mc1:9999,mc1:-1,mc1:1.5,mc1:,MC1:2,bad,mc1:01, mc2:2 "), [{ id: "mc2", seats: 2 }]);
  assert.deepEqual(parseBookings("mc1:21,mc1:100,mc2:150,mc3:999"), [{ id: "mc1", seats: 21 }, { id: "mc1", seats: 100 }, { id: "mc2", seats: 150 }, { id: "mc3", seats: 999 }]);
  assert.deepEqual(parseBookings("mc1:1000,mc1:0999,mc1:1e2"), []);
  assert.deepEqual(parseBookings(undefined), []);
});
