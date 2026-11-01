// stripe-webhook: masterclass bookings sent to the Apps Script (contract v3), owner lines, calendar outcome, local seats.
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
const ok = (booked, marked = []) => ({ ok: true, version: 3, sheet: "Vasi", marked, booked });
const entry = (id, seats, o = {}) => ({ id, seats, booked_after: seats, total: 8, overbooked: false, duplicate: false, calendar: { status: "created" }, ...o });
const CUSTOMER = { email: "a@b.it", name: "Ann", locale: "it" };

test("paid order: ONE combined call {secret, session_id, ids, bookings}; owner sees persons", async () => {
  const { res, posts, sent, cap } = await run(session({ item_ids: "v3,mc1,mc3", bookings: "mc1:2,mc3:1" }), { reply: ok([entry("mc1", 2), entry("mc3", 1)], ["v3"]) });
  assert.equal(res.statusCode, 200);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { secret: SECRET, session_id: "cs_1", ids: ["v3"], bookings: [{ id: "mc1", seats: 2 }, { id: "mc3", seats: 1 }], customer: CUSTOMER });
  assert.ok(sent[0].startsWith("New paid order"));
  assert.ok(sent[0].includes("Masterclass persons: mc1 x 2; mc3 x 1"));
  assert.ok(sent[0].includes("1 x Corso (2 persone)"));
  assert.ok(!sent[0].includes("ACTION") && !sent[0].includes("OVERBOOKED"));
  assert.equal(events(cap, "seats_booked")[0][1].bookings.join(), "mc1:2,mc3:1");
  assert.ok(!cap.logs.some(([, l]) => l.includes(SECRET) || l.includes("AKFY123")));
});

test("bookings only (no vase): ids is empty, still one call", async () => {
  const { posts, sent } = await run(session({ item_ids: "mc1", bookings: "mc1:8" }), { reply: ok([entry("mc1", 8)]) });
  assert.deepEqual(posts.map((p) => p.body), [{ secret: SECRET, session_id: "cs_1", ids: [], bookings: [{ id: "mc1", seats: 8 }], customer: CUSTOMER }]);
  assert.ok(!sent[0].includes("ACTION"));
});

test("seats up to 999 are booked (parseBookings 1..999); 1000 or 0 are ignored", async () => {
  const { posts, sent } = await run(session({ item_ids: "mc1", bookings: "mc1:20" }), { reply: ok([entry("mc1", 20, { total: 30 })]) });
  assert.deepEqual(posts[0].body.bookings, [{ id: "mc1", seats: 20 }]);
  assert.ok(sent[0].includes("Masterclass persons: mc1 x 20") && !sent[0].includes("ACTION"));
  for (const n of [150, 999]) {
    const r = await run(session({ item_ids: "mc1", bookings: "mc1:" + n }), { reply: ok([entry("mc1", n)]) });
    assert.deepEqual(r.posts[0].body.bookings, [{ id: "mc1", seats: n }]);
    assert.ok(r.sent[0].includes("Masterclass persons: mc1 x " + n));
  }
  const x = await run(session({ item_ids: "mc1", bookings: "mc1:1000,mc3:0,mc3:020" }), { reply: ok([]) });
  assert.equal(x.posts.length, 0, "nothing valid to book");
});

test("unlimited masterclass: reply total null, overbooked false -> no OVERBOOKED line", async () => {
  const { res, sent, cap } = await run(session({ item_ids: "mc3", bookings: "mc3:20" }), { reply: ok([entry("mc3", 20, { booked_after: 40, total: null, overbooked: false })]) });
  assert.equal(res.statusCode, 200);
  assert.ok(!sent[0].includes("OVERBOOKED") && !sent[0].includes("ACTION"));
  assert.equal(events(cap, "seats_overbooked").length, 0);
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
  assert.deepEqual(JSON.parse(good.res.body), { received: true, sheet: "ok", calendar: "ok", script_version: 3 });
  const old = await run(session({ item_ids: "v3,mc1", bookings: "mc1:2" }), { reply: { ok: true, sheet: "Vasi", marked: ["v3"] } });
  assert.equal(JSON.parse(old.res.body).sheet, "failed:script_outdated");
  const denied = await run(session({ item_ids: "v3" }), { reply: { ok: false, error: "forbidden" } });
  assert.match(JSON.parse(denied.res.body).sheet, /^failed:/);
  assert.ok(!denied.res.body.includes(SECRET) && !denied.res.body.includes("AKFY123"));
  const nothing = await run(session({ item_ids: "" }), { reply: ok([]) });
  assert.deepEqual(JSON.parse(nothing.res.body), { received: true, sheet: "nothing_to_record", calendar: "none" });
});

// ---- calendar (contract v3) ----
const cal = (status, reason) => ({ status, ...(reason ? { reason } : {}) });
const bk = { item_ids: "mc1,mc3", bookings: "mc1:2,mc3:1" };

test("customer {email, name, locale} rides in the same single POST; locale from the session, it by default; omitted without email and name", async () => {
  let x = await run(session(bk, { locale: "ru" }), { reply: ok([entry("mc1", 2), entry("mc3", 1)]) });
  assert.equal(x.posts.length, 1);
  assert.deepEqual(x.posts[0].body.customer, { email: "a@b.it", name: "Ann", locale: "ru" });
  x = await run(session(bk, { locale: "de" }), { reply: ok([entry("mc1", 2), entry("mc3", 1)]) });
  assert.equal(x.posts[0].body.customer.locale, "it");
  x = await run(session(bk, { customer_details: { address: { country: "IT" } } }), { reply: ok([entry("mc1", 2), entry("mc3", 1)]) });
  assert.ok(!("customer" in x.posts[0].body));
  assert.equal(JSON.parse(x.res.body).calendar, "none", "no customer email: nothing to invite");
  assert.ok(!x.sent[0].includes("calendar event"));
});

test("calendar failed or skipped (or an older script without calendar) gives an ACTION line, partial answer and PII-free logs", async () => {
  const x = await run(session(bk), { reply: ok([entry("mc1", 2, { calendar: cal("failed", "calendar_error") }), entry("mc3", 1, { calendar: cal("skipped", "date_in_past") })]) });
  assert.equal(x.res.statusCode, 200);
  assert.equal(JSON.parse(x.res.body).calendar, "partial");
  assert.ok(x.sent[0].includes("ACTION: create the calendar event for mc1 manually (calendar_error)"));
  assert.ok(x.sent[0].includes("ACTION: create the calendar event for mc3 manually (date_in_past)"));
  const f = events(x.cap, "calendar_failed");
  const sk = events(x.cap, "calendar_skipped");
  assert.deepEqual([f[0][1].id, f[0][1].reason, sk[0][1].id, sk[0][1].reason], ["mc1", "calendar_error", "mc3", "date_in_past"]);
  const old = await run(session(bk), { reply: { ok: true, version: 2, sheet: "Vasi", marked: [], booked: [{ id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: false }, { id: "mc3", seats: 1, booked_after: 1, total: 8, overbooked: false, duplicate: false }] } });
  assert.equal(old.res.statusCode, 200);
  assert.equal(JSON.parse(old.res.body).sheet, "ok", "a v2 script still counts as ok for the seats");
  assert.equal(JSON.parse(old.res.body).calendar, "partial");
  assert.ok(old.sent[0].includes("ACTION: create the calendar event for mc1 manually (Apps Script needs updating)"));
  assert.ok(!old.sent[0].includes("add 2 seats"));
});

test("calendar created or exists is fine, a created note (owner guest missing) is not an action; partial only when one is missing", async () => {
  let x = await run(session(bk), { reply: ok([entry("mc1", 2, { duplicate: true, calendar: cal("exists") }), entry("mc3", 1, { calendar: cal("created", "owner_guest_missing") })]) });
  assert.equal(JSON.parse(x.res.body).calendar, "ok");
  assert.ok(!x.sent[0].includes("ACTION"));
  x = await run(session(bk), { reply: ok([entry("mc1", 2)]) }); // mc3 not reported
  assert.equal(JSON.parse(x.res.body).calendar, "partial");
});

test("sheet call failed: owner is told to create the events too; calendar partial", async () => {
  const x = await run(session(bk), { reply: new Error("boom") });
  assert.equal(JSON.parse(x.res.body).calendar, "partial");
  assert.ok(x.sent[0].includes("ACTION: create the calendar event for mc1 manually (sheet update failed)"));
});

test("webhook never logs or answers the customer's email or name; the summary shows no more than before", async () => {
  const x = await run(session(bk), { reply: ok([entry("mc1", 2, { calendar: cal("failed", "calendar_error") }), entry("mc3", 1)]) });
  const seen = x.cap.logs.map(([, l]) => l).join("\n") + x.res.body;
  assert.ok(!seen.includes("a@b.it") && !seen.includes("Ann"));
  const lines = x.sent[0].split("\n");
  assert.equal(lines.filter((l) => l.includes("a@b.it")).length, 1, "only the existing Customer line");
  assert.ok(!lines.some((l) => l.startsWith("ACTION") && (l.includes("a@b.it") || l.includes("Ann"))));
});

test("a booking without a calendar event is explained in the 200 answer (id:reason only, no email or name)", async () => {
  const skipped = { ...ok([{ ...entry("mc1", 2), calendar: { status: "skipped", reason: "date_in_past" } }]), version: 3 };
  const a = await run(session({ item_ids: "mc1", bookings: "mc1:2" }), { reply: skipped });
  const body = JSON.parse(a.res.body);
  assert.equal(body.calendar, "partial");
  assert.deepEqual(body.calendar_issues, ["mc1:date_in_past"]);
  assert.ok(!a.res.body.includes("a@b.it") && !a.res.body.includes("Ann"));
  const created = { ...ok([{ ...entry("mc1", 2), calendar: { status: "created" } }]), version: 3 };
  const b = await run(session({ item_ids: "mc1", bookings: "mc1:2" }), { reply: created });
  assert.deepEqual(JSON.parse(b.res.body), { received: true, sheet: "ok", calendar: "ok", script_version: 3 });
  const v2 = { ...ok([{ id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: false }]), version: 2 }; // an older script: no calendar field
  const old = await run(session({ item_ids: "mc1", bookings: "mc1:2" }), { reply: v2 });
  assert.deepEqual(JSON.parse(old.res.body).calendar_issues, ["mc1:Apps Script needs updating"]);
  assert.equal(JSON.parse(old.res.body).script_version, 2, "the answer names the script version that replied");
});
