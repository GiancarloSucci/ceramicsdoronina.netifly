const test = require("node:test");
const assert = require("node:assert");
const { makeHandler } = require("../functions/session-status.js");
const { makeStripeFake } = require("./helpers/stripe-fake.js");

const ORIGIN = "https://ceramicsdoronina.it";
const PAID = "cs_test_PAID12345678";
const OPEN = "cs_test_OPEN12345678";
const EXPIRED = "cs_live_EXPIRED12345678";
const FREE = "cs_test_FREE12345678";

function setup(over = {}) {
  const { client } = makeStripeFake({
    sessions: {
      [PAID]: { status: "complete", payment_status: "paid", customer_details: { email: "x@y.z" }, amount_total: 12345 },
      [OPEN]: { status: "open", payment_status: "unpaid" },
      [EXPIRED]: { status: "expired", payment_status: "unpaid" },
      [FREE]: { status: "complete", payment_status: "no_payment_required" },
    },
    retrieveErr: over.retrieveErr,
  });
  return makeHandler({ stripeFactory: () => client, env: { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_SECRETVALUE", ...over.env } });
}
const get = (id, o = {}) => ({ httpMethod: o.method || "GET", headers: o.headers || { origin: ORIGIN }, queryStringParameters: id === undefined ? {} : { session_id: id } });
const body = (r) => JSON.parse(r.body);

test("paid session -> paid:true, status complete, nothing else leaks", async () => {
  const r = await setup()(get(PAID));
  assert.equal(r.statusCode, 200);
  const b = body(r);
  assert.deepEqual(Object.keys(b).sort(), ["paid", "request_id", "status"]);
  assert.equal(b.paid, true);
  assert.equal(b.status, "complete");
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.equal(r.headers["Access-Control-Allow-Origin"], ORIGIN);
  assert.equal(r.headers["Access-Control-Allow-Methods"], "GET,OPTIONS");
  assert.ok(!r.body.includes("x@y.z") && !r.body.includes("12345"));
});
test("no_payment_required counts as paid", async () => {
  assert.deepEqual({ paid: body(await setup()(get(FREE))).paid }, { paid: true });
});
test("open unpaid session -> paid:false, status open", async () => {
  const b = body(await setup()(get(OPEN)));
  assert.equal(b.paid, false);
  assert.equal(b.status, "open");
});
test("expired session -> paid:false, status expired", async () => {
  const b = body(await setup()(get(EXPIRED)));
  assert.equal(b.paid, false);
  assert.equal(b.status, "expired");
});
test("unknown session (resource_missing) -> 200 {paid:false,status:'unknown'}, same shape", async () => {
  const r = await setup()(get("cs_test_DOESNOTEXIST1"));
  assert.equal(r.statusCode, 200);
  const b = body(r);
  assert.deepEqual(Object.keys(b).sort(), ["paid", "request_id", "status"]);
  assert.equal(b.paid, false);
  assert.equal(b.status, "unknown");
});
test("invalid session ids -> 400 invalid_session_id, no Stripe call", async () => {
  let called = 0;
  const h = makeHandler({ stripeFactory: () => { called++; throw new Error("must not be called"); }, env: { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_X" } });
  for (const bad of [undefined, "", "cs_", "cs_test_short", "cs_prod_ABCDEFGH12", "x".repeat(10), "cs_test_" + "A".repeat(300), "cs_test_ABCDEFGH12/../x", "cs_test_ABCDEFGH12 "]) {
    const r = await h(get(bad));
    assert.equal(r.statusCode, 400, String(bad));
    assert.equal(body(r).error, "invalid_session_id");
  }
  assert.equal(called, 0);
});
test("origin rules: missing -> 400, not allowed -> 403 without CORS, no ALLOWED_ORIGINS -> 500 (fail closed)", async () => {
  assert.equal((await setup()(get(PAID, { headers: {} }))).statusCode, 400);
  const bad = await setup()(get(PAID, { headers: { origin: "https://evil.example" } }));
  assert.equal(bad.statusCode, 403);
  assert.equal(bad.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal((await setup({ env: { ALLOWED_ORIGINS: "" } })(get(PAID))).statusCode, 500);
});
test("OPTIONS preflight -> 204 with GET in allowed methods; POST/PUT -> 405", async () => {
  const pre = await setup()(get(PAID, { method: "OPTIONS" }));
  assert.equal(pre.statusCode, 204);
  assert.match(pre.headers["Access-Control-Allow-Methods"], /GET/);
  for (const m of ["POST", "PUT", "DELETE"]) assert.equal((await setup()(get(PAID, { method: m }))).statusCode, 405);
});
test("Stripe failure -> 502 payment_provider_error, secret never in the body", async () => {
  const err = Object.assign(new Error("boom sk_test_SECRETVALUE"), { type: "StripeAPIError", statusCode: 500 });
  const r = await setup({ retrieveErr: err })(get(PAID));
  assert.equal(r.statusCode, 502);
  assert.equal(body(r).error, "payment_provider_error");
  assert.ok(!r.body.includes("SECRETVALUE"));
});
test("missing STRIPE_SECRET_KEY -> 500 server_error", async () => {
  const r = await setup({ env: { STRIPE_SECRET_KEY: "" } })(get(PAID));
  assert.equal(r.statusCode, 500);
});
