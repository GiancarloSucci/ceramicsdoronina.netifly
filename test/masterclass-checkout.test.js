// create-checkout for masterclass bookings: group pricing, seat validation, holds from open sessions.
// Fake Stripe and fake sheet fetch, no network.
const test = require("node:test");
const assert = require("node:assert");
const src = require("../functions/_catalogue-source.js");
const { makeHandler, personsSuffix } = require("../functions/create-checkout.js");
const { makeStripeFake } = require("./helpers/stripe-fake.js");

const ORIGIN = "https://ceramicsdoronina.it";
const NOW = 1_000_000_000_000;
const MCURL = "https://docs.google.com/spreadsheets/d/e/TOKMC/pub?gid=2&output=csv";
const COLS = ["id", "name_it", "name_en", "name_ru", "seats_total", "seats_booked", ...Array.from({ length: 20 }, (_, i) => "price_" + (i + 1)), "img1"];
const tab = (...rows) => [COLS.join(","), ...rows.map((r) => COLS.map((c) => JSON.stringify(r[c] == null ? "" : String(r[c]))).join(","))].join("\n");
const base = { name_it: "Corso", name_en: "Course", name_ru: "Курс", img1: "w.jpg" };
const CSV = tab(
  // non-linear table with gaps: 3, 5, 6 and 7 persons are not bookable
  { ...base, id: "m1", seats_total: 8, seats_booked: 0, price_1: "100", price_2: "180", price_4: "320", price_8: "560" },
  { ...base, id: "m2", seats_total: 8, seats_booked: 2, price_1: "100", price_2: "180", price_3: "250", price_4: "320", price_5: "380", price_6: "430", price_7: "480", price_8: "520" },
  { ...base, id: "m3", seats_total: 8, seats_booked: 8, price_1: "100", price_2: "180" },
  { ...base, id: "m4", seats_total: 4, seats_booked: 0, price_2: "150", price_4: "250" } // price_1 blank: single seats not bookable
);
const VASE = { type: "physical", name_it: "Vaso", name_en: "Vase", name_ru: "Ваза", priceCents: 10000, sold: false, image: "", maxQty: 1 };

function setup(over = {}) {
  src._reset(); // the sheet is cached for 60 s per tab: every setup reads its own CSV
  const csv = over.csv || CSV;
  const fake = makeStripeFake({ now: () => NOW, ...over.fake });
  const env = { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_SECRETVALUE", ...over.env };
  const getCatalogue = async () => {
    const r = await src.getCatalogue({ env: { CATALOGUE_MASTERCLASS_CSV_URL: MCURL }, fetchImpl: async () => new Response(csv, { status: 200 }), soldList: [], now: () => NOW });
    return { items: { ...r.items, v1: VASE } };
  };
  const handler = makeHandler({ stripeFactory: () => fake.client, env, getCatalogue, now: () => NOW });
  return { ...fake, handler };
}
const post = (body) => ({ httpMethod: "POST", headers: { origin: ORIGIN }, body: JSON.stringify(body) });
const body = (r) => JSON.parse(r.body);
const mc = (id, quantity) => ({ items: [{ id, quantity }], locale: "it" });
const logsOf = async (fn) => {
  const orig = { w: console.warn, e: console.error, i: console.info };
  const logs = [];
  console.warn = console.error = console.info = (m) => logs.push(String(m));
  try {
    return [await fn(), logs];
  } finally {
    Object.assign(console, { warn: orig.w, error: orig.e, info: orig.i });
  }
};

test.beforeEach(() => src._reset());

test("price is the tier of the group size, not linear: 1, 2 and 8 persons", async () => {
  for (const [n, cents] of [[1, 10000], [2, 18000], [8, 56000]]) {
    const { handler, calls } = setup();
    const r = await handler(post({ items: [{ id: "m1", quantity: n }], locale: "en" }));
    assert.equal(r.statusCode, 200, `n=${n}`);
    const [li] = calls[0].line_items;
    assert.equal(calls[0].line_items.length, 1, "ONE line per masterclass");
    assert.equal(li.quantity, 1);
    assert.equal(li.price_data.unit_amount, cents);
    assert.deepEqual(li.price_data.product_data.metadata, { item_id: "m1", seats: String(n) });
    assert.equal(li.price_data.product_data.name, `Course (${n} ${n === 1 ? "person" : "people"})`);
    assert.equal(calls[0].metadata.bookings, `m1:${n}`);
    assert.equal(calls[0].metadata.item_ids, "m1");
  }
});

test("group sizes without a tier, outside 1..20 or malformed are rejected with distinct codes and item_id", async () => {
  const { handler, calls } = setup();
  const cases = [
    [{ id: "m1", quantity: 3 }, "group_size_unavailable"],
    [{ id: "m1", quantity: 5 }, "group_size_unavailable"],
    [{ id: "m1", quantity: 9 }, "group_size_unavailable"],
    [{ id: "m1", quantity: 21 }, "group_size_unavailable"],
    [{ id: "m1", quantity: 100 }, "group_size_unavailable"],
    [{ id: "m4", quantity: 1 }, "group_size_unavailable"],
    [{ id: "m1", quantity: 0 }, "invalid_quantity"],
    [{ id: "m1", quantity: -2 }, "invalid_quantity"],
    [{ id: "m1", quantity: 1.5 }, "invalid_quantity"],
    [{ id: "m1", quantity: "2" }, "invalid_quantity"],
    [{ id: "m3", quantity: 1 }, "sold_out"],
    [{ id: "m3", quantity: 3 }, "sold_out"],
  ];
  for (const [line, code] of cases) {
    const [r] = await logsOf(() => handler(post({ items: [line], locale: "it" })));
    assert.equal(r.statusCode, 400, JSON.stringify(line));
    const b = body(r);
    assert.deepEqual([b.error, b.item_id], [code, line.id], JSON.stringify(line));
    assert.ok(b.request_id);
  }
  assert.equal(calls.length, 0);
  const ok = await handler(post(mc("m4", 4)));
  assert.equal(ok.statusCode, 200);
});

test("seats still free: 2 booked of 8 leaves 6; 7 persons are not_enough_seats, 6 are fine", async () => {
  const { handler, calls } = setup();
  const [r] = await logsOf(() => handler(post(mc("m2", 7))));
  assert.deepEqual([r.statusCode, body(r).error, body(r).item_id], [400, "not_enough_seats", "m2"]);
  assert.equal((await handler(post(mc("m2", 6)))).statusCode, 200);
  assert.equal(calls[0].line_items[0].price_data.unit_amount, 43000);
  const full = tab({ ...base, id: "f", seats_total: 8, seats_booked: 8, price_1: "100" });
  const [r2] = await logsOf(() => setup({ csv: full }).handler(post(mc("f", 1))));
  assert.equal(body(r2).error, "sold_out", "0 seats free after 8 booked of 8");
});

test("two separate bookings of 1 person each pay 100 + 100, not a group price", async () => {
  const { handler, calls } = setup({ fake: { session: { id: "cs_a", url: "https://checkout.stripe.com/c/a" } } });
  assert.equal((await handler(post(mc("m1", 1)))).statusCode, 200);
  assert.equal((await handler(post(mc("m1", 1)))).statusCode, 200);
  assert.deepEqual(calls.map((c) => c.line_items[0].price_data.unit_amount), [10000, 10000]);
});

test("the same masterclass twice in one request is rejected (duplicate_item), also with different sizes", async () => {
  const { handler, calls } = setup();
  for (const items of [[{ id: "m1", quantity: 1 }, { id: "m1", quantity: 1 }], [{ id: "m2", quantity: 1 }, { id: "v1", quantity: 1 }, { id: "m2", quantity: 2 }]]) {
    const [r] = await logsOf(() => handler(post({ items, locale: "it" })));
    assert.deepEqual([r.statusCode, body(r).error, body(r).item_id], [400, "duplicate_item", items[0].id]);
  }
  assert.equal(calls.length, 0);
});

test("holds: seats of OPEN sessions are subtracted (only for the requested ids), list is asked once with status open", async () => {
  const openSessions = [
    { id: "cs_x", metadata: { item_ids: "m2,m1", bookings: "m2:3,m1:2" } },
    { id: "cs_y", metadata: { item_ids: "v1" } },
    { id: "cs_z", metadata: { bookings: "garbage,m2:1,m2:21,M2:2" } },
  ];
  const { handler, calls, listCalls } = setup({ fake: { openSessions } });
  // m2: 8 - 2 booked - 3 held - 1 held = 2 free
  const [r3] = await logsOf(() => handler(post(mc("m2", 3))));
  assert.deepEqual([r3.statusCode, body(r3).error, body(r3).item_id], [400, "not_enough_seats", "m2"]);
  assert.equal((await handler(post(mc("m2", 2)))).statusCode, 200);
  assert.deepEqual(listCalls[0], { status: "open", limit: 100 });
  assert.equal(listCalls.length, 2);
  // m1 holds are not mixed up with m2: 8 - 2 = 6 free, so 4 persons fit
  assert.equal((await handler(post(mc("m1", 4)))).statusCode, 200);
  assert.equal(calls.length, 2);
});

test("holds exhaust the workshop -> sold_out; a request for 1 seat after a 6-person open booking works once, then not", async () => {
  const { handler } = setup({ fake: { openSessions: [{ id: "cs_x", metadata: { bookings: "m2:6" } }] } });
  const [r] = await logsOf(() => handler(post(mc("m2", 1))));
  assert.deepEqual([r.statusCode, body(r).error], [400, "sold_out"]);
});

test("sequential checkouts hold seats: 4 persons then 3 persons on a workshop with 6 free", async () => {
  const f = setup();
  let r = await f.handler(post(mc("m2", 4)));
  assert.equal(r.statusCode, 200);
  assert.equal(f.open.length, 1);
  [r] = await logsOf(() => f.handler(post(mc("m2", 3))));
  assert.deepEqual([r.statusCode, body(r).error], [400, "not_enough_seats"]);
  assert.equal((await f.handler(post(mc("m2", 2)))).statusCode, 200);
});

test("the open-session list is only called when the cart has a masterclass", async () => {
  const f = setup();
  assert.equal((await f.handler(post({ items: [{ id: "v1", quantity: 1 }], locale: "it" }))).statusCode, 200);
  assert.equal(f.listCalls.length, 0);
  assert.equal((await f.handler(post({ items: [{ id: "v1", quantity: 1 }, { id: "m1", quantity: 2 }], locale: "it" }))).statusCode, 200);
  assert.equal(f.listCalls.length, 1);
});

test("holds lookup failing -> fail open (checkout proceeds on seatsFree), warn event without secrets", async () => {
  const err = Object.assign(new Error("boom sk_test_LEAK"), { type: "StripeConnectionError", code: "x" });
  const { handler, calls } = setup({ fake: { listErr: err } });
  const [r, logs] = await logsOf(() => handler(post(mc("m2", 6))));
  assert.equal(r.statusCode, 200);
  assert.equal(calls.length, 1);
  const w = logs.map((l) => JSON.parse(l)).find((o) => o.event === "holds_unavailable");
  assert.ok(w && w.request_id && w.type === "StripeConnectionError");
  assert.ok(!logs.join("").includes("LEAK") && !logs.join("").includes("SECRETVALUE"));
  // still validated against the sheet
  const [r2] = await logsOf(() => handler(post(mc("m2", 7))));
  assert.equal(body(r2).error, "not_enough_seats");
});

test("a truncated open-session list (has_more) is logged", async () => {
  const { handler } = setup({ fake: { hasMore: true } });
  const [, logs] = await logsOf(() => handler(post(mc("m1", 1))));
  assert.ok(logs.some((l) => l.includes('"event":"holds_list_truncated"')));
});

test("product names: persons suffix per locale, Russian plural forms, Italian persona for 1", () => {
  const exp = {
    it: ["1 persona", "2 persone", "3 persone", "4 persone", "5 persone", "6 persone", "7 persone", "8 persone"],
    en: ["1 person", "2 people", "3 people", "4 people", "5 people", "6 people", "7 people", "8 people"],
    ru: ["1 человек", "2 человека", "3 человека", "4 человека", "5 человек", "6 человек", "7 человек", "8 человек"],
  };
  for (const loc of Object.keys(exp)) for (let n = 1; n <= 8; n++) assert.equal(personsSuffix(n, loc), ` (${exp[loc][n - 1]})`, `${loc} ${n}`);
});

test("product names: Russian plural rule for every group size 1..20 and beyond (11-14 are chelovek)", () => {
  const form = (n) => personsSuffix(n, "ru").replace(/^ \(\d+ | ?\)$/g, "");
  for (let n = 1; n <= 20; n++) assert.equal(form(n), n === 1 ? "человек" : n >= 2 && n <= 4 ? "человека" : "человек", "ru " + n);
  for (const [n, w] of [[21, "человек"], [22, "человека"], [25, "человек"], [101, "человек"], [111, "человек"], [112, "человек"], [122, "человека"]]) assert.equal(form(n), w, "ru " + n);
  assert.equal(personsSuffix(20, "it"), " (20 persone)");
  assert.equal(personsSuffix(20, "en"), " (20 people)");
});

// price_1 only (rule A): u1 unlimited (seats_total blank), l1 and l2 limited to 30 seats (5 and 15 booked)
const CSV20 = tab(
  { ...base, id: "u1", seats_booked: 7, price_1: "100" },
  { ...base, id: "l1", seats_total: 30, seats_booked: 5, price_1: "100" },
  { ...base, id: "l2", seats_total: 30, seats_booked: 15, price_1: "100" }
);

test("unlimited masterclass (seats_total blank, only price_1): N x price_1 up to 20, no holds lookup, never sold out", async () => {
  for (const n of [1, 7, 20]) {
    const { handler, calls, listCalls } = setup({ csv: CSV20, fake: { openSessions: [{ id: "cs_x", metadata: { bookings: "u1:20" } }] } });
    assert.equal((await handler(post(mc("u1", n)))).statusCode, 200, "N=" + n);
    assert.equal(calls[0].line_items[0].price_data.unit_amount, 10000 * n);
    assert.equal(calls[0].metadata.bookings, `u1:${n}`);
    assert.equal(listCalls.length, 0, "sessions.list is not called for unlimited items");
  }
  const { handler, calls } = setup({ csv: CSV20 });
  const [r] = await logsOf(() => handler(post(mc("u1", 21))));
  assert.deepEqual([r.statusCode, body(r).error, body(r).item_id], [400, "group_size_unavailable", "u1"]);
  assert.equal(calls.length, 0);
});

test("limited masterclass with 30 seats: free seats and holds still decide, group cap stays 20", async () => {
  const f = setup({ csv: CSV20, fake: { openSessions: [{ id: "cs_x", metadata: { bookings: "l1:10" } }] } });
  assert.equal((await f.handler(post(mc("l1", 15)))).statusCode, 200); // 30 - 5 booked - 10 held = 15 free
  assert.equal(f.listCalls.length, 1);
  const f2 = setup({ csv: CSV20, fake: { openSessions: [{ id: "cs_x", metadata: { bookings: "l1:10" } }] } });
  const [r] = await logsOf(() => f2.handler(post(mc("l1", 16))));
  assert.equal(body(r).error, "not_enough_seats");
  const g = setup({ csv: CSV20 });
  assert.equal((await g.handler(post(mc("l1", 20)))).statusCode, 200);
  assert.equal(g.calls[0].line_items[0].price_data.unit_amount, 200000);
  const [r2] = await logsOf(() => g.handler(post(mc("l2", 16)))); // 15 free
  assert.equal(body(r2).error, "not_enough_seats");
  assert.equal((await g.handler(post(mc("l2", 15)))).statusCode, 200);
});

test("names reach Stripe in the customer's locale; long titles are cut so the suffix always fits", async () => {
  for (const [loc, name] of [["it", "Corso (2 persone)"], ["en", "Course (2 people)"], ["ru", "Курс (2 человека)"]]) {
    const { handler, calls } = setup();
    assert.equal((await handler(post({ items: [{ id: "m1", quantity: 2 }], locale: loc }))).statusCode, 200);
    assert.equal(calls[0].line_items[0].price_data.product_data.name, name);
  }
  const long = tab({ ...base, name_it: "L".repeat(200), name_en: "", name_ru: "", id: "m1", price_1: "100" });
  const { handler, calls } = setup({ csv: long });
  await handler(post({ items: [{ id: "m1", quantity: 1 }], locale: "ru" }));
  const n = calls[0].line_items[0].price_data.product_data.name;
  assert.ok(n.length <= 120 && n.endsWith(" (1 человек)"));
});

test("mixed cart: masterclass tier counted in the totals, shipping from the vase only, bookings metadata lists masterclasses only", async () => {
  const { handler, calls } = setup();
  const [r, logs] = await logsOf(() => handler(post({ items: [{ id: "v1", quantity: 1 }, { id: "m1", quantity: 2 }, { id: "m2", quantity: 1 }], locale: "it" })));
  assert.equal(r.statusCode, 200);
  const p = calls[0];
  assert.deepEqual(p.line_items.map((l) => [l.quantity, l.price_data.unit_amount]), [[1, 10000], [1, 18000], [1, 10000]]);
  assert.equal(p.shipping_options[0].shipping_rate_data.fixed_amount.amount, 4000);
  assert.equal(p.metadata.item_ids, "v1,m1,m2");
  assert.equal(p.metadata.bookings, "m1:2,m2:1");
  const created = logs.map((l) => JSON.parse(l)).find((o) => o.event === "session_created");
  assert.equal(created.subtotal_cents, 38000);
});

test("no bookings metadata without a masterclass", async () => {
  const { handler, calls } = setup();
  await handler(post({ items: [{ id: "v1", quantity: 1 }], locale: "it" }));
  assert.equal("bookings" in calls[0].metadata, false);
});
