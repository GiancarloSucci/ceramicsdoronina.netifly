// stripe-webhook: contract v4 (order log in the private tabs). One POST per paid session with order, extended customer
// and consent; outcome `orders` in the 200 answer; no personal data in logs, answers or the owner message beyond the existing summary.
const test = require("node:test");
const assert = require("node:assert");
const src = require("../functions/_catalogue-source.js");
const { makeHandler, buildOrder, buildCustomer, buildConsent } = require("../functions/stripe-webhook.js");

const SECRET = "S3CRET-VALUE-XYZ";
const SCRIPT = "https://script.google.com/macros/s/AKFY123/exec";
const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", CATALOGUE_WRITE_URL: SCRIPT, CATALOGUE_WRITE_SECRET: SECRET };
const TIERS = [10000, 18000, null, null, null, null, null, null];
const CAT = {
  v3: { type: "physical", name_it: "Vaso tre", maxQty: 1, priceCents: 28000, sold: false },
  mc1: { type: "digital", name_it: "Corso", maxQty: 2, priceCents: 10000, sold: false, tiersCents: TIERS },
  "gc-50": { type: "digital", name_it: "Gift card", maxQty: 10, priceCents: 5000, sold: false },
};
const getCatalogue = async () => ({ items: CAT });
const PII = ["ann@example.com", "Ann Rossi", "+39 380 632 7838", "Via Roma 1", "Via Po 2", "16123", "Torino"];
const CONSENT_MD = { privacy_accepted: "1", privacy_version: "2026-11", marketing_optout: "1", consent_at: "2026-11-04T10:00:00.000Z" };
const session = (metadata, over = {}) => ({
  id: "cs_ord", created: 1793786400, amount_total: 41000, currency: "eur", payment_status: "paid", locale: "en", metadata,
  customer_details: { email: "ann@example.com", name: "Ann Rossi", phone: "+39 380 632 7838", address: { line1: "Via Roma 1", line2: "int. 4", city: "Genova", postal_code: "16123", state: "GE", country: "IT" } },
  shipping_details: { name: "Ann R.", address: { line1: "Via Po 2", city: "Torino", postal_code: "10100", country: "IT" } },
  custom_fields: [], ...over,
});
const prod = (id, extra = {}) => ({ id: "prod_" + id, name: "P " + id, metadata: { item_id: id, ...extra } });
const LI = (id, description, amount, quantity = 1, extra) => ({ description, quantity, amount_total: amount, price: { product: prod(id, extra) } });
const MIXED = session({ item_ids: "v3,mc1,gc-50", bookings: "mc1:2", ...CONSENT_MD });
const MIXED_LINES = [LI("v3", "Vaso tre", 28000), LI("mc1", "Corso (2 persone)", 18000, 1, { seats: "2" }), LI("gc-50", "Gift card", 5000, 2)];

function capture() {
  const logs = [];
  const orig = { e: console.error, i: console.info, w: console.warn };
  console.error = (m) => logs.push(String(m));
  console.info = (m) => logs.push(String(m));
  console.warn = (m) => logs.push(String(m));
  return { logs, restore: () => Object.assign(console, { error: orig.e, info: orig.i, warn: orig.w }) };
}

// reply: object | Error | function(body) ; runs the real markSold against a fake Apps Script
async function run(obj, { reply, lines = MIXED_LINES, type = "checkout.session.completed", e = env, listCalls = [] } = {}) {
  src._reset();
  const posts = [];
  const sent = [];
  const fetchImpl = async (url, o) => {
    posts.push(JSON.parse(o.body));
    const r = typeof reply === "function" ? reply(JSON.parse(o.body)) : reply;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), { status: 200 });
  };
  const stripe = {
    webhooks: { constructEvent: () => ({ id: "evt_1", type, data: { object: obj } }) },
    checkout: { sessions: { listLineItems: async (id, opts) => { listCalls.push([id, opts]); return { data: lines }; } } },
  };
  const cap = capture();
  let res;
  try {
    const h = makeHandler({ stripeFactory: () => stripe, env: e, notify: async (s) => sent.push(s), getCatalogue, fetchImpl, markSold: (ids, o) => src.markSold(ids, { ...o, sleep: async () => {}, timeoutMs: 50 }) });
    res = await h({ httpMethod: "POST", headers: { "stripe-signature": "good" }, body: "{}" });
  } finally {
    cap.restore();
  }
  return { res, posts, sent, cap, body: JSON.parse(res.body) };
}
const v9 = (orders, extra = {}) => ({ ok: true, version: 9, sheet: "Vasi", marked: [], booked: [], orders, ...extra });
const bookedOf = (id, seats) => ({ id, seats, booked_after: seats, total: 8, overbooked: false, duplicate: false, calendar: { status: "created" } });

test("mixed cart (vase + masterclass + gift certificate): ONE post with order lines by kind, extended customer, consent", async () => {
  const listCalls = [];
  const x = await run(MIXED, { reply: v9({ status: "ok", rows: 3 }, { marked: ["v3"], booked: [bookedOf("mc1", 2)] }), listCalls });
  assert.equal(x.posts.length, 1);
  const b = x.posts[0];
  assert.deepEqual([b.secret, b.session_id, b.ids, b.bookings], [SECRET, "cs_ord", ["v3"], [{ id: "mc1", seats: 2 }]]);
  assert.deepEqual(b.customer, {
    email: "ann@example.com", name: "Ann Rossi", phone: "+39 380 632 7838", locale: "en",
    billing: { line1: "Via Roma 1", line2: "int. 4", city: "Genova", postal_code: "16123", state: "GE", country: "IT" },
    shipping: { name: "Ann R.", line1: "Via Po 2", city: "Torino", postal_code: "10100", country: "IT" },
  });
  assert.deepEqual(b.order, {
    total_cents: 41000, currency: "eur", created_iso: "2026-11-04T10:00:00.000Z",
    lines: [
      { id: "v3", kind: "vasi", name: "Vaso tre", quantity: 1, amount_cents: 28000 },
      { id: "mc1", kind: "masterclass", name: "Corso (2 persone)", quantity: 1, seats: 2, amount_cents: 18000 },
      { id: "gc-50", kind: "certificati", name: "Gift card", quantity: 2, amount_cents: 5000 },
    ],
  });
  assert.deepEqual(b.consent, { privacy: true, privacy_version: "2026-11", marketing_optout: true, at: "2026-11-04T10:00:00.000Z" });
  assert.deepEqual(x.body, { received: true, sheet: "ok", calendar: "ok", orders: "ok", script_version: 9 });
  assert.deepEqual(listCalls[0][1], { limit: 100, expand: ["data.price.product"] }, "product metadata gives the catalogue id of every line");
});

test("masterclass-only and vase-only carts work the same way", async () => {
  const m = await run(session({ item_ids: "mc1", bookings: "mc1:2", ...CONSENT_MD }), { lines: [LI("mc1", "Corso (2 persone)", 18000, 1, { seats: "2" })], reply: v9({ status: "ok", rows: 1 }, { booked: [bookedOf("mc1", 2)] }) });
  assert.deepEqual(m.posts[0].order.lines.map((l) => [l.id, l.kind, l.seats]), [["mc1", "masterclass", 2]]);
  const v = await run(session({ item_ids: "v3", ...CONSENT_MD }), { lines: [LI("v3", "Vaso tre", 28000)], reply: v9({ status: "ok", rows: 1 }, { marked: ["v3"] }) });
  assert.deepEqual(v.posts[0].order.lines.map((l) => [l.id, l.kind]), [["v3", "vasi"]]);
  assert.equal(v.body.orders, "ok");
});

test("gift certificates only: nothing to mark or book, but the order is still logged (one call, ids empty)", async () => {
  const x = await run(session({ item_ids: "gc-50", ...CONSENT_MD }), { lines: [LI("gc-50", "Gift card", 5000)], reply: v9({ status: "ok", rows: 1 }) });
  assert.equal(x.posts.length, 1);
  assert.deepEqual([x.posts[0].ids, x.posts[0].bookings], [[], []]);
  assert.deepEqual(x.body, { received: true, sheet: "nothing_to_record", calendar: "none", orders: "ok", script_version: 9 });
  assert.ok(!x.sent[0].includes("ACTION"));
});

test("an old session without consent metadata is logged with privacy false and no version", async () => {
  const x = await run(session({ item_ids: "gc-50" }), { lines: [LI("gc-50", "Gift card", 5000)], reply: v9({ status: "ok", rows: 1 }) });
  assert.deepEqual(x.posts[0].consent, { privacy: false, privacy_version: "", marketing_optout: false, at: "" });
});

test("line ids fall back on item_ids order, then on the catalogue, when Stripe gives no product metadata", async () => {
  const noMeta = [{ description: "Vaso tre", quantity: 1, amount_total: 28000 }, { description: "Gift card", quantity: 1, amount_total: 5000 }];
  const a = await run(session({ item_ids: "v3,gc-50", ...CONSENT_MD }), { lines: noMeta, reply: v9({ status: "ok", rows: 2 }) });
  assert.deepEqual(a.posts[0].order.lines.map((l) => [l.id, l.kind, l.amount_cents]), [["v3", "vasi", 28000], ["gc-50", "certificati", 5000]]);
  const none = await run(session({ item_ids: "v3,gc-50", ...CONSENT_MD }), { lines: [], reply: v9({ status: "ok", rows: 2 }) });
  assert.deepEqual(none.posts[0].order.lines.map((l) => [l.id, l.kind, l.amount_cents]), [["v3", "vasi", 28000], ["gc-50", "certificati", 5000]], "rebuilt from item_ids and the catalogue");
});

test("orders outcome: ok | partial | none | failed:<code>, with an ACTION line for the owner when the log failed", async () => {
  const lines = [LI("gc-50", "Gift card", 5000)];
  const one = session({ item_ids: "gc-50", ...CONSENT_MD });
  let x = await run(one, { lines, reply: v9({ status: "ok", rows: 1, reason: "partial" }) });
  assert.equal(x.body.orders, "partial");
  assert.ok(x.sent[0].includes("ACTION: some order lines are missing in the orders sheet"));
  x = await run(one, { lines, reply: v9({ status: "failed", reason: "orders_sheet_unavailable", rows: 0 }) });
  assert.equal(x.body.orders, "failed:orders_sheet_unavailable");
  assert.ok(x.sent[0].endsWith("ACTION: record this order in the orders sheet manually (orders_sheet_unavailable)"));
  x = await run(one, { lines, reply: v9({ status: "skipped", reason: "no_order", rows: 0 }) });
  assert.equal(x.body.orders, "failed:no_order");
  x = await run(one, { lines, reply: { ok: true, version: 8, sheet: "Vasi", marked: [], booked: [] } }); // script not updated: no `orders` field
  assert.equal(x.body.orders, "failed:script_outdated");
  assert.ok(x.sent[0].includes("ACTION: record this order in the orders sheet manually (script_outdated)"));
  x = await run(one, { lines, reply: { ok: false, error: "forbidden" } });
  assert.deepEqual([x.res.statusCode, x.body.orders, x.body.sheet], [200, "failed:forbidden", "nothing_to_record"]);
  x = await run(one, { lines, reply: new Error("boom") });
  assert.equal(x.res.statusCode, 200, "a failing script never fails the webhook");
  assert.match(x.body.orders, /^failed:/);
  x = await run(one, { lines, reply: v9({ status: "ok", rows: 1 }), e: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" } }); // script not configured
  assert.deepEqual([x.res.statusCode, x.body.orders, x.posts.length], [200, "none", 0]);
  assert.ok(!x.sent[0].includes("ACTION"), "feature off: no noise");
});

test("when marking fails too, the owner gets both ACTION lines and the answer stays 200", async () => {
  const x = await run(MIXED, { reply: { ok: false, error: "forbidden" } });
  assert.equal(x.res.statusCode, 200);
  assert.deepEqual([x.body.sheet, x.body.orders], ["failed:forbidden", "failed:forbidden"]);
  assert.ok(x.sent[0].includes("ACTION: mark v3 as sold in the sheet manually"));
  assert.ok(x.sent[0].includes("ACTION: record this order in the orders sheet manually (forbidden)"));
});

test("unpaid or failed sessions are not logged (no post)", async () => {
  for (const [type, over] of [["checkout.session.completed", { payment_status: "unpaid" }], ["checkout.session.async_payment_failed", { payment_status: "unpaid" }]]) {
    const x = await run(session({ item_ids: "gc-50" }, over), { type, reply: v9({ status: "ok", rows: 1 }) });
    assert.equal(x.posts.length, 0, type);
    assert.equal(x.body.orders, undefined);
  }
  const ok = await run(session({ item_ids: "gc-50" }, { payment_status: "unpaid" }), { type: "checkout.session.async_payment_succeeded", reply: v9({ status: "ok", rows: 1 }) });
  assert.equal(ok.posts.length, 1, "async payment confirmed: logged then");
});

test("no personal data in logs, in the 200 answer or in ACTION lines; the owner summary shows only what it showed before", async () => {
  const x = await run(MIXED, { reply: v9({ status: "failed", reason: "write_error", rows: 0 }, { marked: ["v3"], booked: [bookedOf("mc1", 2)] }) });
  const seen = x.cap.logs.join("\n") + x.res.body;
  for (const pii of PII) assert.ok(!seen.includes(pii), "leaked: " + pii);
  assert.ok(!seen.includes(SECRET) && !seen.includes("AKFY123"));
  const action = x.sent[0].split("\n").filter((l) => l.startsWith("ACTION"));
  for (const l of action) for (const pii of PII) assert.ok(!l.includes(pii), l);
  const err = await run(MIXED, { reply: new Error("net down ann@example.com") });
  const seen2 = err.cap.logs.join("\n") + err.res.body;
  for (const pii of PII) assert.ok(!seen2.includes(pii), "leaked after failure: " + pii);
});

test("buildCustomer / buildConsent / buildOrder: shapes, caps and omissions", () => {
  assert.deepEqual(buildCustomer(session({}, { customer_details: { email: "e@x.it" }, shipping_details: undefined })), { email: "e@x.it", locale: "en" });
  assert.deepEqual(buildCustomer(session({}, { customer_details: {}, shipping_details: null })), {});
  const long = buildCustomer(session({}, { customer_details: { name: "n".repeat(500), address: { line1: "l".repeat(500) } } }));
  assert.deepEqual([long.name.length, long.billing.line1.length], [200, 200]);
  assert.deepEqual(buildCustomer(session({}, { locale: "de" })).locale, "it");
  assert.deepEqual(buildConsent({ metadata: CONSENT_MD }), { privacy: true, privacy_version: "2026-11", marketing_optout: true, at: "2026-11-04T10:00:00.000Z" });
  assert.deepEqual(buildConsent({}), { privacy: false, privacy_version: "", marketing_optout: false, at: "" });
  assert.equal(buildConsent({ metadata: { privacy_accepted: "0", marketing_optout: "0" } }).privacy, false);
  const o = buildOrder(session({ item_ids: "v3,nope" }), [], "v3,nope", [], CAT);
  assert.deepEqual([o.order.lines.map((l) => l.id), o.skipped], [["v3"], 1], "an id that is not in the catalogue cannot be filed in a tab");
  const many = buildOrder(session({}), Array.from({ length: 60 }, (_, i) => LI("v3", "Vaso", 1)), "", [], CAT);
  assert.equal(many.order.lines.length, 50);
  assert.equal(buildOrder(session({}), [], "", [], CAT).order.lines.length, 0);
});
