// stripe-webhook: masterclass bookings sent to the Apps Script (contract v2), owner lines, local seats.
// Fake Stripe, fake Apps Script fetch, no network.
const test = require("node:test");
const assert = require("node:assert");
const src = require("../functions/_catalogue-source.js");
const { makeHandler, buildOrderSummary } = require("../functions/stripe-webhook.js");

const SECRET = "S3CRET-VALUE-XYZ";
const SCRIPT = "https://script.google.com/macros/s/AKFY123/exec";
const MCURL = "https://docs.google.com/spreadsheets/d/e/TOKMC/pub?gid=2&output=csv";
const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", CATALOGUE_WRITE_URL: SCRIPT, CATALOGUE_WRITE_SECRET: SECRET };
const CAT = {
  v3: { type: "physical", maxQty: 1, priceCents: 100, sold: false },
  mc1: { type: "digital", maxQty: 2, priceCents: 100, sold: false, tiersCents: [100, 180, null, null, null, null, null, null] },
  mc3: { type: "digital", maxQty: 2, priceCents: 100, sold: false, tiersCents: [100, 180, null, null, null, null, null, null] },
};
const getCatalogue = async () => ({ items: CAT });
const session = (metadata, over = {}) => ({
  id: "cs_1", amount_total: 28000, currency: "eur", payment_status: "paid", metadata,
  customer_details: { email: "a@b.it", name: "Ann", phone: "+39", address: { country: "IT" } },
  custom_fields: [], ...over,
});
const stripeOf = (obj, type = "checkout.session.completed") => ({
  webhooks: { constructEvent: () => ({ id: "evt_1", type, data: { object: obj } }) },
  checkout: { sessions: { listLineItems: async () => ({ data: [{ description: "Corso (2 persone)", quantity: 1 }] }) } },
});
const req = { httpMethod: "POST", headers: { "stripe-signature": "good" }, body: "{}" };

function capture() {
  const logs = [];
  const orig = { e: console.error, i: console.info, w: console.warn };
  console.error = (m) => logs.push(["error", String(m)]);
  console.info = (m) => logs.push(["info", String(m)]);
  console.warn = (m) => logs.push(["warn", String(m)]);
  return { logs, restore: () => Object.assign(console, { error: orig.e, info: orig.i, warn: orig.w }) };
}
const events = (cap, ev) => cap.logs.filter(([, l]) => l.includes(`"event":"${ev}"`)).map(([lvl, l]) => [lvl, JSON.parse(l)]);

// reply: object (JSON body) | Error | function(body) ; runs the real markSold against a fake Apps Script
async function run(obj, { reply, type, overrides = {} } = {}) {
  src._reset();
  const posts = [];
  const sent = [];
  const fetchImpl = async (url, o) => {
    posts.push({ url, body: JSON.parse(o.body) });
    const r = typeof reply === "function" ? reply(JSON.parse(o.body)) : reply;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), { status: 200 });
  };
  const cap = capture();
  let res;
  try {
    const h = makeHandler({
      stripeFactory: () => stripeOf(obj, type), env, notify: async (s) => sent.push(s), getCatalogue, fetchImpl,
      markSold: (ids, o) => src.markSold(ids, { ...o, sleep: async () => {}, timeoutMs: 50 }),
      ...overrides,
    });
    res = await h(req);
  } finally {
    cap.restore();
  }
  return { res, posts, sent, cap };
}
const ok = (booked, marked = []) => ({ ok: true, version: 2, sheet: "Vasi", marked, booked });
const entry = (id, seats, o = {}) => ({ id, seats, booked_after: seats, total: 8, overbooked: false, duplicate: false, ...o });

test("paid order: ONE combined call {secret, session_id, ids, bookings}; owner sees persons", async () => {
  const { res, posts, sent, cap } = await run(session({ item_ids: "v3,mc1,mc3", bookings: "mc1:2,mc3:1" }), { reply: ok([entry("mc1", 2), entry("mc3", 1)], ["v3"]) });
  assert.equal(res.statusCode, 200);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { secret: SECRET, session_id: "cs_1", ids: ["v3"], bookings: [{ id: "mc1", seats: 2 }, { id: "mc3", seats: 1 }] });
  assert.ok(sent[0].startsWith("New paid order"));
  assert.ok(sent[0].includes("Masterclass persons: mc1 x 2; mc3 x 1"));
  assert.ok(sent[0].includes("1 x Corso (2 persone)"));
  assert.ok(!sent[0].includes("ACTION") && !sent[0].includes("OVERBOOKED"));
  assert.equal(events(cap, "seats_booked")[0][1].bookings.join(), "mc1:2,mc3:1");
  assert.ok(!cap.logs.some(([, l]) => l.includes(SECRET) || l.includes("AKFY123")));
});

test("bookings only (no vase): ids is empty, still one call", async () => {
  const { posts, sent } = await run(session({ item_ids: "mc1", bookings: "mc1:8" }), { reply: ok([entry("mc1", 8)]) });
  assert.deepEqual(posts.map((p) => p.body), [{ secret: SECRET, session_id: "cs_1", ids: [], bookings: [{ id: "mc1", seats: 8 }] }]);
  assert.ok(!sent[0].includes("ACTION"));
});

test("a vase-only order keeps the first-version payload {secret, ids}", async () => {
  const { posts } = await run(session({ item_ids: "v3" }), { reply: { ok: true, sheet: "Vasi", marked: ["v3"] } });
  assert.deepEqual(posts[0].body, { secret: SECRET, ids: ["v3"] });
});

test("script reply without version 2 while bookings were sent -> script_outdated, ACTION lines with the update hint", async () => {
  const { res, sent, cap } = await run(session({ item_ids: "v3,mc1", bookings: "mc1:2" }), { reply: { ok: true, sheet: "Vasi", marked: ["v3"] } });
  assert.equal(res.statusCode, 200);
  assert.ok(sent[0].includes("ACTION: mark v3 as sold in the sheet manually (Apps Script needs updating)"));
  assert.ok(sent[0].includes("ACTION: add 2 seats to mc1 in the sheet manually (seats_booked) (Apps Script needs updating)"));
  assert.equal(events(cap, "sold_mark_failed")[0][1].reason, "script_outdated");
  for (const reply of [{ ok: true, version: 1, sheet: "Vasi" }, { ok: true, version: 2, sheet: "Other" }, { ok: false, error: "forbidden" }]) {
    const x = await run(session({ item_ids: "mc1", bookings: "mc1:2" }), { reply });
    assert.ok(x.sent[0].includes("ACTION: add 2 seats to mc1"), JSON.stringify(reply));
  }
});

test("overbooked reply adds the OVERBOOKED line; duplicate reply adds nothing", async () => {
  let x = await run(session({ item_ids: "mc1,mc3", bookings: "mc1:2,mc3:1" }), { reply: ok([entry("mc1", 2, { booked_after: 9, total: 8, overbooked: true }), entry("mc3", 1)]) });
  assert.equal(x.res.statusCode, 200);
  assert.ok(x.sent[0].includes("OVERBOOKED mc1: refund this booking or move it"));
  assert.ok(!x.sent[0].includes("OVERBOOKED mc3") && !x.sent[0].includes("ACTION"));
  assert.equal(events(x.cap, "seats_overbooked")[0][1].id, "mc1");
  x = await run(session({ item_ids: "mc1", bookings: "mc1:2" }), { reply: ok([entry("mc1", 2, { duplicate: true })]) });
  assert.ok(!x.sent[0].includes("ACTION") && !x.sent[0].includes("OVERBOOKED"));
});

test("a booking the script did not report (id not in the sheet) gets an ACTION line", async () => {
  const x = await run(session({ item_ids: "mc1,mc3", bookings: "mc1:2,mc3:1" }), { reply: ok([entry("mc1", 2)]) });
  assert.ok(x.sent[0].includes("ACTION: add 1 seats to mc3 in the sheet manually (seats_booked)"));
  assert.ok(!x.sent[0].includes("add 2 seats"));
});

test("call fails (network): 200, manual ACTION line per booking, local seats still applied, nothing sensitive logged", async () => {
  const local = [];
  const x = await run(session({ item_ids: "v3,mc1,mc3", bookings: "mc1:2,mc3:1" }), {
    reply: new Error(`boom ${SECRET} ${SCRIPT}`),
    overrides: { markBookedLocal: (b, o) => local.push([b, o]) },
  });
  assert.equal(x.res.statusCode, 200);
  assert.ok(x.sent[0].includes("ACTION: add 2 seats to mc1 in the sheet manually (seats_booked)"));
  assert.ok(x.sent[0].includes("ACTION: add 1 seats to mc3 in the sheet manually (seats_booked)"));
  assert.ok(x.sent[0].includes("ACTION: mark v3 as sold in the sheet manually"));
  assert.deepEqual(local, [[[{ id: "mc1", seats: 2 }, { id: "mc3", seats: 1 }], { sessionId: "cs_1" }]]);
  assert.ok(!x.cap.logs.some(([, l]) => l.includes(SECRET) || l.includes("AKFY123")));
  assert.ok(!x.sent[0].includes(SECRET));
});

test("markSold throwing still answers 200 with the ACTION line and local seats", async () => {
  const local = [];
  const x = await run(session({ item_ids: "mc1", bookings: "mc1:3" }), { overrides: { markSold: async () => { throw new Error("x"); }, markBookedLocal: (b) => local.push(b) } });
  assert.equal(x.res.statusCode, 200);
  assert.ok(x.sent[0].includes("ACTION: add 3 seats to mc1"));
  assert.equal(local.length, 1);
});

test("not configured (no script env): ACTION line, warn without secrets, local seats", async () => {
  const x = await run(session({ item_ids: "mc1", bookings: "mc1:2" }), { overrides: { env: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }, markSold: (ids, o) => src.markSold(ids, { ...o, env: {} }) } });
  assert.equal(x.res.statusCode, 200);
  assert.ok(x.sent[0].includes("ACTION: add 2 seats to mc1"));
  assert.equal(events(x.cap, "sold_mark_not_configured").length, 1);
});

test("unpaid / failed orders show the persons but book nothing", async () => {
  for (const [type, status] of [["checkout.session.completed", "unpaid"], ["checkout.session.async_payment_failed", "unpaid"]]) {
    const x = await run(session({ item_ids: "mc1", bookings: "mc1:2" }, { payment_status: status }), { type, reply: ok([entry("mc1", 2)]) });
    assert.equal(x.posts.length, 0);
    assert.ok(x.sent[0].includes("Masterclass persons: mc1 x 2"));
    assert.ok(!x.sent[0].includes("ACTION"));
  }
});

test("local effect: seats_booked/seats_free are effective at once, a Stripe retry does not count twice", async () => {
  const csv = "id,name_it,seats_total,seats_booked,price_1,price_2,img1\nmc1,Corso,8,1,100,180,a.jpg";
  const senv = { CATALOGUE_MASTERCLASS_CSV_URL: MCURL };
  const fetchSheet = async () => new Response(csv, { status: 200 });
  const obj = session({ item_ids: "mc1", bookings: "mc1:2" });
  const x = await run(obj, { reply: ok([entry("mc1", 2)]) }); // real markBookedLocal; run() resets before, not after
  assert.equal(x.res.statusCode, 200);
  let r = await src.getCatalogue({ env: senv, fetchImpl: fetchSheet, soldList: [] });
  assert.deepEqual([r.items.mc1.seatsBooked, r.items.mc1.seatsFree], [3, 5]);
  assert.deepEqual([r.tabs.masterclass.rows[0].seats_booked, r.tabs.masterclass.rows[0].seats_free], ["3", "5"]);
  // the same event delivered again (retry, or async_payment_succeeded after completed)
  const h = makeHandler({ stripeFactory: () => stripeOf(obj), env, notify: async () => {}, getCatalogue, fetchImpl: async () => new Response(JSON.stringify(ok([entry("mc1", 2, { duplicate: true })])), { status: 200 }) });
  const cap = capture();
  try {
    assert.equal((await h(req)).statusCode, 200);
  } finally {
    cap.restore();
  }
  r = await src.getCatalogue({ env: senv, fetchImpl: fetchSheet, soldList: [] });
  assert.deepEqual([r.items.mc1.seatsBooked, r.items.mc1.seatsFree], [3, 5]);
  src._reset();
});

test("buildOrderSummary shows the persons per masterclass, from metadata or explicitly; none without bookings", () => {
  const s = buildOrderSummary(session({ item_ids: "mc1,mc3", bookings: "mc1:2,mc3:1" }), [{ description: "Corso (2 persone)", quantity: 1 }], "mc1,mc3");
  assert.ok(s.includes("Masterclass persons: mc1 x 2; mc3 x 1"));
  assert.ok(buildOrderSummary(session({}), [], "", "paid", [{ id: "mc9", seats: 4 }]).includes("Masterclass persons: mc9 x 4"));
  assert.ok(!buildOrderSummary(session({ item_ids: "v3" }), [], "v3").includes("Masterclass persons"));
});

test("the 200 answer to Stripe carries the sheet outcome (visible in Stripe's delivery log), never a secret", async () => {
  const good = await run(session({ item_ids: "v3,mc1", bookings: "mc1:2" }), { reply: ok([entry("mc1", 2)], ["v3"]) });
  assert.deepEqual(JSON.parse(good.res.body), { received: true, sheet: "ok" });
  const old = await run(session({ item_ids: "v3,mc1", bookings: "mc1:2" }), { reply: { ok: true, sheet: "Vasi", marked: ["v3"] } });
  assert.equal(JSON.parse(old.res.body).sheet, "failed:script_outdated");
  const denied = await run(session({ item_ids: "v3" }), { reply: { ok: false, error: "forbidden" } });
  assert.match(JSON.parse(denied.res.body).sheet, /^failed:/);
  assert.ok(!denied.res.body.includes(SECRET) && !denied.res.body.includes("AKFY123"));
  const nothing = await run(session({ item_ids: "" }), { reply: ok([]) });
  assert.deepEqual(JSON.parse(nothing.res.body), { received: true, sheet: "nothing_to_record" });
});
