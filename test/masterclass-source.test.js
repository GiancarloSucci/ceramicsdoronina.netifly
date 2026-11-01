// Masterclass seat schema (group prices, seats booked) of functions/_catalogue-source.js and its
// exposure through functions/catalogue.js. Fake fetch, no network.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const src = require("../functions/_catalogue-source.js");
const { makeHandler } = require("../functions/catalogue.js");

const fx = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
const V2 = fx("catalogue-tab-Masterclass-v2.csv");
const MCURL = "https://docs.google.com/spreadsheets/d/e/TOKMC/pub?gid=2&output=csv";
const env = { CATALOGUE_MASTERCLASS_CSV_URL: MCURL };
const fetchOf = (csv) => async () => new Response(csv, { status: 200 });
const clock = (t0 = 1_000_000) => {
  let t = t0;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
};
const PRICES = ["price_1", "price_2", "price_3", "price_4", "price_5", "price_6", "price_7", "price_8"];
// minimal seat-schema tab; rows: objects keyed by column (missing = blank)
function tab(cols, ...rows) {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] == null ? "" : String(r[c]))).join(","))].join("\n");
}
const COLS = ["id", "name_it", "name_en", "name_ru", "seats_total", "seats_booked", ...PRICES, "img1"];
const row = (o) => ({ id: "m1", name_it: "Corso", img1: "a.jpg", price_1: "100", ...o });
const parse = (...rows) => src.parseTabCsv("masterclass", tab(COLS, ...rows));
const cap = async (fn) => {
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

test("seat schema, real template: rows, tiers, seats and headers", () => {
  const p = src.parseTabCsv("masterclass", V2);
  assert.equal(p.seats, true);
  assert.deepEqual(p.dropped, []);
  assert.equal(p.rows.length, 6);
  const m = p.items.mc1;
  assert.deepEqual(m.tiersCents, [10000, 18000, null, null, null, null, null, null]);
  assert.deepEqual([m.type, m.priceCents, m.seatsTotal, m.seatsBooked, m.seatsFree, m.maxQty, m.sold], ["digital", 10000, 8, 0, 8, 2, false]);
  assert.equal(m.image, "images/masterclass/workshop-disegni-airbnb-generico.1.jpg");
  for (const h of ["seats_total", "seats_booked", "price_1", "price_8"]) assert.ok(p.headers.includes(h), h);
  assert.ok(!p.headers.includes("spots") && !p.headers.includes("seats_free"));
});

test("legacy schema (spots, price): linear tiers, no seat tracking, item level exactly as before", () => {
  const p = src.parseTabCsv("masterclass", fx("catalogue-tab-Masterclass.csv"));
  assert.equal(p.seats, false);
  const m = p.items.mc1;
  assert.equal(m.maxQty, 6);
  assert.equal(m.priceCents, 10000);
  assert.equal(m.sold, false);
  assert.deepEqual(m.tiersCents, [10000, 20000, 30000, 40000, 50000, 60000, null, null]);
  assert.deepEqual([m.seatsTotal, m.seatsBooked, m.seatsFree], [6, 0, 6]);
  assert.equal(m.tracked, undefined);
  // "spots" 12 -> maxQty 12 as today, tiers still stop at 8 persons
  const big = src.parseTabCsv("masterclass", "id,name_it,name_en,name_ru,img1,spots,price\nx,A,A,A,a.jpg,Max 12,10");
  assert.equal(big.items.x.maxQty, 12);
  assert.deepEqual(big.items.x.tiersCents, [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]);
});

test("price_1 present -> only the new schema is used (spots/price ignored)", () => {
  const p = src.parseTabCsv("masterclass", "id,name_it,img1,spots,price,price_1,price_2\nx,A,a.jpg,Max 3,999,50,90");
  assert.deepEqual(p.items.x.tiersCents.slice(0, 3), [5000, 9000, null]);
  assert.equal(p.items.x.maxQty, 2);
});

test("required columns of the seat schema: id, img1, price_1 and one name_*", () => {
  const ok = src.parseTabCsv("masterclass", "id,name_ru,img1,price_1\nx,Курс,a.jpg,10");
  assert.equal(ok.items.x.name_it, "Курс");
  for (const [csv, why] of [
    ["id,name_it,price_1\nx,A,10", "missing_column_img1"],
    ["id,img1,price_1\nx,a.jpg,10", "missing_column_name"],
    ["name_it,img1,price_1\nA,a.jpg,10", "missing_column_id"],
    ["id,name_it,img1,seats_total\nx,A,a.jpg,8", "missing_column_name_en"], // no price_1: legacy rules apply
  ]) assert.throws(() => src.parseTabCsv("masterclass", csv), (e) => e.reason === why, why);
});

test("titles are optional individually: missing ones take the first non-empty by it, en, ru; none -> row dropped", () => {
  const p = parse(row({ id: "a", name_it: "", name_en: "Course", name_ru: "Курс" }), row({ id: "b", name_ru: "Курс", name_it: "" }), row({ id: "c", name_it: "", name_en: "", name_ru: "" }), row({ id: "d" }));
  assert.deepEqual([p.items.a.name_it, p.items.a.name_en, p.items.a.name_ru], ["Course", "Course", "Курс"]);
  assert.deepEqual([p.items.b.name_it, p.items.b.name_en], ["Курс", "Курс"]);
  assert.deepEqual(p.dropped, ["c"]);
});

test("tier validation: strict prices, blanks = not bookable, bad values drop the row", () => {
  const p = parse(
    row({ id: "a", price_1: "", price_2: "180", price_4: "320,50" }),
    row({ id: "b", price_2: "abc" }),
    row({ id: "c", price_3: "0" }),
    row({ id: "d", price_1: "" }),
    row({ id: "e", price_1: "1.000,00" }),
    row({ id: "f", price_8: "€ 700" }),
    row({ id: "g", price_1: "20000" }),
    ...["k1", "k2", "k3", "k4", "k5", "k6"].map((id) => row({ id })) // valid filler: more than half invalid fails the tab
  );
  assert.deepEqual(p.dropped.sort(), ["b", "c", "d", "e", "g"]);
  assert.deepEqual(p.items.a.tiersCents, [null, 18000, null, 32050, null, null, null, null]);
  assert.equal(p.items.a.priceCents, 18000, "price_1 blank -> cheapest defined tier");
  assert.equal(p.items.a.maxQty, 4, "highest defined N");
  assert.equal(p.items.f.tiersCents[7], 70000);
  assert.equal(p.items.f.maxQty, 8);
});

test("seats_total / seats_booked parsing and seatsFree math", () => {
  const p = parse(
    row({ id: "a" }), // defaults: 8 total, 0 booked
    row({ id: "b", seats_booked: "8" }),
    row({ id: "c", seats_booked: "2" }),
    row({ id: "d", seats_total: "4", seats_booked: "9" }), // overbooked by hand: never negative
    row({ id: "e", seats_total: "9" }),
    row({ id: "f", seats_total: "0" }),
    row({ id: "g", seats_booked: "-1" }),
    row({ id: "h", seats_booked: "1.5" }),
    row({ id: "i", seats_total: "3", price_2: "180", price_3: "250", seats_booked: "1" })
  );
  assert.deepEqual(p.dropped.sort(), ["e", "f", "g", "h"]);
  const f = (id) => [p.items[id].seatsTotal, p.items[id].seatsBooked, p.items[id].seatsFree, p.items[id].maxQty, p.items[id].sold];
  assert.deepEqual(f("a"), [8, 0, 8, 1, false]);
  assert.deepEqual(f("b"), [8, 8, 0, 0, true], "0 free after 8 booked of 8");
  assert.deepEqual(f("c"), [8, 2, 6, 1, false], "6 free after 2");
  assert.deepEqual(f("d"), [4, 9, 0, 0, true]);
  assert.deepEqual(f("i"), [3, 1, 2, 2, false], "maxQty = min(8, seatsFree, highest tier)");
});

test("getCatalogue: items carry the seat fields; rows carry effective seats_booked and computed seats_free", async () => {
  const now = clock();
  const csv = tab(COLS, row({ id: "a", seats_booked: "2", price_2: "180" }), row({ id: "b", seats_booked: "8" }));
  const r = await src.getCatalogue({ env, fetchImpl: fetchOf(csv), soldList: [], now });
  assert.deepEqual(r.items.a, {
    type: "digital", name_it: "Corso", name_en: "Corso", name_ru: "Corso", priceCents: 10000, image: "images/masterclass/a.jpg", maxQty: 2, sold: false,
    tiersCents: [10000, 18000, null, null, null, null, null, null], seatsTotal: 8, seatsBooked: 2, seatsFree: 6,
  });
  assert.equal(r.items.b.sold, true);
  assert.equal(r.items.b.seatsFree, 0);
  const rows = Object.fromEntries(r.tabs.masterclass.rows.map((x) => [x.id, x]));
  assert.deepEqual([rows.a.seats_booked, rows.a.seats_free, rows.a.price_2, rows.b.seats_free], ["2", "6", "180", "0"]);
  assert.ok(!r.tabs.masterclass.headers.includes("seats_free"), "seats_free is a computed row field, not a sheet header");
});

test("local bookings: effective at once, summed, idempotent per session, expire after 15 minutes", async () => {
  const now = clock();
  const csv = tab(COLS, row({ id: "a", seats_booked: "1", price_2: "180" }));
  const get = () => src.getCatalogue({ env, fetchImpl: fetchOf(csv), soldList: [], now });
  src.markBookedLocal([{ id: "a", seats: 2 }, { id: "BAD ID", seats: 1 }, { id: "a", seats: 9 }, { id: "a", seats: 0 }], { now, sessionId: "cs_1" });
  src.markBookedLocal([{ id: "a", seats: 2 }], { now, sessionId: "cs_1" }); // Stripe retry: not counted twice
  let r = await get();
  assert.deepEqual([r.items.a.seatsBooked, r.items.a.seatsFree, r.items.a.maxQty], [3, 5, 2]);
  assert.deepEqual([r.tabs.masterclass.rows[0].seats_booked, r.tabs.masterclass.rows[0].seats_free], ["3", "5"]);
  now.advance(60_000);
  src.markBookedLocal([{ id: "a", seats: 5 }], { now, sessionId: "cs_2" });
  r = await get();
  assert.deepEqual([r.items.a.seatsFree, r.items.a.sold], [0, true], "sold out once the local bookings fill the workshop");
  now.advance(src.LOCAL_SOLD_TTL_MS - 30_000); // cs_1 expired, cs_2 not
  r = await get();
  assert.deepEqual([r.items.a.seatsBooked, r.items.a.seatsFree], [6, 2]);
  now.advance(60_000);
  r = await get();
  assert.deepEqual([r.items.a.seatsBooked, r.items.a.seatsFree], [1, 7]);
});

test("local bookings do not touch legacy rows or the snapshot (no seat tracking there)", async () => {
  src.markBookedLocal([{ id: "mc1", seats: 4 }], { sessionId: "cs_1" });
  const legacy = await src.getCatalogue({ env, fetchImpl: fetchOf(fx("catalogue-tab-Masterclass.csv")), soldList: [], now: clock() });
  assert.deepEqual([legacy.items.mc1.seatsBooked, legacy.items.mc1.seatsFree, legacy.items.mc1.maxQty], [0, 6, 6]);
  assert.ok(!("seats_free" in legacy.tabs.masterclass.rows[0]));
  const [snap] = await cap(() => src.getCatalogue({ env: {}, soldList: [] }));
  assert.deepEqual([snap.items.mc1.seatsBooked, snap.items.mc1.seatsFree], [0, 6]);
  assert.equal(snap.items.mc1.tiersCents[1], 20000);
});

test("endpoint: masterclass items expose the seat fields, other items do not; rows have seats_free", async () => {
  const h = makeHandler({ env, fetchImpl: fetchOf(V2), now: clock() });
  const [res] = await cap(() => h({ httpMethod: "GET", headers: {} }));
  const body = JSON.parse(res.body);
  assert.equal(body.version, 2);
  const mc1 = body.items.find((i) => i.id === "mc1");
  assert.deepEqual(Object.keys(mc1), ["id", "type", "name_it", "name_en", "name_ru", "priceCents", "image", "maxQty", "sold", "tiersCents", "seatsTotal", "seatsBooked", "seatsFree"]);
  assert.deepEqual(mc1.tiersCents, [10000, 18000, null, null, null, null, null, null]);
  assert.equal(body.tabs.masterclass.rows[0].seats_free, "8");
  assert.equal(body.tabs.masterclass.rows[0].price_2, "180");
  assert.equal(body.tabs.masterclass.rows[0].seats_total, "8");
  assert.ok(body.tabs.masterclass.headers.includes("price_8"));
});

test("a seat-schema tab that is invalid falls back to the snapshot like any tab", async () => {
  const [r, logs] = await cap(() => src.getCatalogue({ env, fetchImpl: fetchOf("id,name_it,img1\nx,A,a.jpg"), soldList: [], now: clock() }));
  assert.equal(r.sources.masterclass, "snapshot");
  assert.equal(r.tabs.masterclass, null);
  assert.ok(logs.some((l) => l.includes("catalogue_fetch_failed") && l.includes("missing_column_name_en")));
  assert.ok(!logs.join("").includes("TOKMC"));
});

// ---- markSold with bookings (contract v2) ------------------------------------

const WENV = { CATALOGUE_WRITE_URL: "https://script.google.com/macros/s/AKFY123/exec", CATALOGUE_WRITE_SECRET: "S3CRET-VALUE" };
const reply = (body, calls) => async (url, o) => {
  calls.push(JSON.parse(o.body));
  return new Response(JSON.stringify(body), { status: 200 });
};
const nosleep = async () => {};

test("markSold with bookings sends session_id and bookings and returns the cleaned booked list", async () => {
  const calls = [];
  const body = { ok: true, version: 2, sheet: "Vasi", marked: ["v1"], booked: [{ id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: true, extra: "x" }, { id: "BAD ID" }, null, { id: "mc2", seats: "2", overbooked: "yes" }] };
  const r = await src.markSold(["v1"], { fetchImpl: reply(body, calls), env: WENV, sleep: nosleep, bookings: [{ id: "mc1", seats: 2 }, { id: "mc2", seats: 9 }, { id: "x y", seats: 1 }], sessionId: "cs_1" });
  assert.deepEqual(calls, [{ secret: "S3CRET-VALUE", session_id: "cs_1", ids: ["v1"], bookings: [{ id: "mc1", seats: 2 }] }]);
  assert.deepEqual(r, {
    ok: true, marked: ["v1"],
    booked: [{ id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: true }, { id: "mc2", seats: null, booked_after: null, total: null, overbooked: false, duplicate: false }],
  });
});

test("markSold sends the customer with bookings only, accepts reply version 2 and 3, and keeps the calendar field of each booking", async () => {
  const cust = { email: "a@b.it", name: "Ann", locale: "xx" };
  const calls = [];
  const body = { ok: true, version: 3, sheet: "Vasi", marked: [], booked: [{ id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: false, calendar: { status: "failed", reason: "calendar_error", extra: 1 } }, { id: "mc2", calendar: { status: "weird" } }, { id: "mc3", calendar: { status: "skipped", reason: "Bad <b>" } }] };
  const r = await src.markSold([], { fetchImpl: reply(body, calls), env: WENV, sleep: nosleep, bookings: [{ id: "mc1", seats: 2 }], sessionId: "cs_1", customer: cust });
  assert.deepEqual(calls[0].customer, { email: "a@b.it", name: "Ann", locale: "it" });
  assert.equal(r.ok, true, "version 3 accepted");
  assert.deepEqual(r.booked.map((b) => b.calendar), [{ status: "failed", reason: "calendar_error" }, undefined, { status: "skipped" }]);
  const v2 = await src.markSold([], { fetchImpl: reply({ ...body, version: 2 }, []), env: WENV, sleep: nosleep, bookings: [{ id: "mc1", seats: 2 }], sessionId: "cs_1" });
  assert.equal(v2.ok, true, "a v2 script still counts as ok");
  const vase = [];
  await src.markSold(["v1"], { fetchImpl: reply({ ok: true, sheet: "Vasi", marked: ["v1"] }, vase), env: WENV, sleep: nosleep, customer: cust });
  assert.ok(!("customer" in vase[0]), "no customer without bookings");
});

test("markSold: with bookings an ok reply needs version 2 and sheet Vasi (script_outdated otherwise); ids only keep the old rule", async () => {
  for (const b of [{ ok: true, sheet: "Vasi", marked: [] }, { ok: true, version: 1, sheet: "Vasi" }, { ok: true, version: "2", sheet: "Vasi" }, { ok: true, version: 2 }]) {
    const calls = [];
    const r = await src.markSold(["v1"], { fetchImpl: reply(b, calls), env: WENV, sleep: nosleep, bookings: [{ id: "mc1", seats: 1 }], sessionId: "cs_1" });
    assert.deepEqual(r, { ok: false, reason: "script_outdated" }, JSON.stringify(b));
    assert.equal(calls.length, 1, "no retry on an outdated script");
  }
  const old = await src.markSold(["v1"], { fetchImpl: reply({ ok: true, sheet: "Vasi", marked: ["v1"] }, []), env: WENV, sleep: nosleep });
  assert.deepEqual(old, { ok: true, marked: ["v1"] });
});
