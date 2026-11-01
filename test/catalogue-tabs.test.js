// Tests for the three-tab mode of functions/_catalogue-source.js and the version-2 endpoint,
// with an injected fake fetch (no network). The fixtures are the three published tabs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const src = require("../functions/_catalogue-source.js");
const { makeHandler } = require("../functions/catalogue.js");
const { makeHandler: makeWebhook } = require("../functions/stripe-webhook.js");
const snapshotRaw = require("../functions/catalogue.json");
// The snapshot as the functions serve it: masterclass items (digital, images/masterclass/) also carry the
// linear seat fields (tiers 1..min(8,maxQty) x price, null above; nothing booked), derived here independently.
const snapshot = Object.fromEntries(
  Object.entries(snapshotRaw).map(([id, p]) => {
    if (!(p.type === "digital" && p.image.startsWith("images/masterclass/"))) return [id, p];
    const tiersCents = Array.from({ length: 8 }, (_, i) => (i < p.maxQty ? p.priceCents * (i + 1) : null));
    return [id, { ...p, tiersCents, seatsTotal: p.maxQty, seatsBooked: 0, seatsFree: p.maxQty }];
  })
);

const fx = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
const TAB_CSV = { vasi: fx("catalogue-tab-Vasi.csv"), masterclass: fx("catalogue-tab-Masterclass.csv"), certificati: fx("catalogue-tab-Certificati.csv") };
const U = {
  vasi: "https://docs.google.com/spreadsheets/d/e/TOKVASI/pub?gid=1&output=csv",
  masterclass: "https://docs.google.com/spreadsheets/d/e/TOKMC/pub?gid=2&output=csv",
  certificati: "https://docs.google.com/spreadsheets/d/e/TOKCERT/pub?gid=3&output=csv",
};
const env = { CATALOGUE_VASI_CSV_URL: U.vasi, CATALOGUE_MASTERCLASS_CSV_URL: U.masterclass, CATALOGUE_CERTIFICATI_CSV_URL: U.certificati };
const HEADERS = {
  vasi: "id,name_ru,name_it,name_en,short_ru,short_it,short_en,long_ru,long_it,long_en,height,diameter,material,material-en,material-ru,technique,technique-en,technique-ru,finish,finish-en,finish-ru,img1,img2,img3,img4,img5,img6,venduto,price_old,price_new".split(","),
  masterclass: "id,name_it,name_en,name_ru,short_it,short_en,short_ru,long_it,long_en,long_ru,date,time,level,spots,price,img1".split(","),
  certificati: "id,name_it,name_en,name_ru,short_it,short_en,short_ru,long_it,long_en,long_ru,img1,amount_eur".split(","),
};
const MIN = { vasi: "id,name_it,name_en,name_ru,img1,venduto,price_new", masterclass: "id,name_it,name_en,name_ru,img1,spots,price", certificati: "id,name_it,name_en,name_ru,img1,amount_eur" };
// minimal tab CSV: rows are [id, img1, venduto|spots|"", price]
const mini = (key, ...rows) => [MIN[key], ...rows.map(([id, img, x, price]) => (key === "certificati" ? [id, "N", "N", "N", img, price] : [id, "N", "N", "N", img, x, price]).map((c) => JSON.stringify(c)).join(","))].join("\n");

const clock = (t0 = 1_000_000) => {
  let t = t0;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
};
// fake fetch routed by URL token; value: CSV string | Error | function(opts)
function router(map) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(String(url));
    const key = Object.keys(U).find((k) => String(url) === U[k]) || "other";
    const r = typeof map[key] === "function" && !(map[key] instanceof Error) ? map[key](opts) : map[key];
    if (r instanceof Error) throw r;
    if (r instanceof Response) return r;
    return new Response(r, { status: 200 });
  };
  fn.calls = calls;
  return fn;
}
function capture() {
  const logs = [];
  const orig = { e: console.error, i: console.info, w: console.warn };
  console.error = (m) => logs.push(["error", String(m)]);
  console.info = (m) => logs.push(["info", String(m)]);
  console.warn = (m) => logs.push(["warn", String(m)]);
  return { logs, restore: () => Object.assign(console, { error: orig.e, info: orig.i, warn: orig.w }) };
}
const events = (cap, ev) => cap.logs.filter(([, l]) => l.includes(`"event":"${ev}"`)).map(([lvl, l]) => [lvl, JSON.parse(l)]);
const quiet = async (fn) => {
  const cap = capture();
  try {
    return [await fn(cap), cap];
  } finally {
    cap.restore();
  }
};

test.beforeEach(() => src._reset());

test("three tabs, real fixtures: derived items deep-equal the bundled catalogue.json (ids included)", async () => {
  const f = router(TAB_CSV);
  const r = await src.getCatalogue({ env, fetchImpl: f, soldList: [], now: clock() });
  assert.equal(r.source, "sheet");
  assert.deepEqual(r.sources, { vasi: "sheet", masterclass: "sheet", certificati: "sheet" });
  assert.deepEqual(r.items, JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(Object.keys(r.items).sort(), Object.keys(snapshot).sort());
  assert.equal(f.calls.length, 3);
  for (const k of Object.keys(U)) {
    assert.deepEqual(r.tabs[k].headers, HEADERS[k]);
    assert.ok(r.tabs[k].rows.length > 0);
  }
  assert.equal(r.tabs.vasi.rows.length, 13);
  assert.equal(r.tabs.masterclass.rows.length, 6);
  assert.equal(r.tabs.certificati.rows.length, 4);
  assert.ok(r.tabs.vasi.rows[0].long_ru.includes("Скульптурная"));
  // CRLF/LF/BOM variants of the same tabs give the same result
  src._reset();
  const lf = Object.fromEntries(Object.entries(TAB_CSV).map(([k, v]) => [k, "﻿" + v.replace(/\r\n/g, "\n")]));
  const r2 = await src.getCatalogue({ env, fetchImpl: router(lf), soldList: [], now: clock() });
  assert.deepEqual(r2.items, r.items);
  assert.deepEqual(r2.tabs, r.tabs);
});

test("derivation rules: type, maxQty, price, sold words, image folders, names (mirrors build-catalogue.py)", () => {
  const v = src.parseTabCsv("vasi", mini("vasi", ["a1", "x.jpg", "no", "120"], ["a2", "x.png", "Sì", "120,50"], ["a3", "-", "", "€ 120.5"], ["a4", "x.webp", "X", "7"], ["a5", "x.svg", "yes", "8"], ["a6", "x.jpeg", "TRUE", "9"], ["a7", "x.jpg", "1", "10"], ["a8", "x.jpg", "-", "11"]));
  assert.deepEqual(v.dropped, []);
  const it = v.items;
  assert.deepEqual([it.a1.type, it.a1.maxQty, it.a1.priceCents, it.a1.sold, it.a1.image], ["physical", 1, 12000, false, "images/catalogue/x.jpg"]);
  assert.equal(it.a2.priceCents, 12050);
  assert.equal(it.a3.priceCents, 12050);
  assert.equal(it.a3.image, "", "empty or - means no image");
  assert.deepEqual(["a2", "a4", "a5", "a6", "a7"].map((k) => it[k].sold), [true, true, true, true, true]);
  assert.equal(it.a8.sold, false, "- is not sold");
  const m = src.parseTabCsv("masterclass", mini("masterclass", ["m1", "w.jpg", "Max 6 persone", "100€"], ["m2", "w.jpg", "Max 4", "99,90"], ["m3", "w.jpg", "", "50"], ["m4", "w.jpg", "12", "50"]));
  assert.deepEqual([m.items.m1.type, m.items.m1.maxQty, m.items.m1.priceCents, m.items.m1.sold, m.items.m1.image], ["digital", 6, 10000, false, "images/masterclass/w.jpg"]);
  assert.deepEqual([m.items.m2.maxQty, m.items.m2.priceCents, m.items.m3.maxQty, m.items.m4.maxQty], [4, 9990, 6, 12]);
  const c = src.parseTabCsv("certificati", mini("certificati", ["g1", "g.jpg", "", "50"]));
  assert.deepEqual(c.items.g1, { type: "digital", name_it: "N", name_en: "N", name_ru: "N", priceCents: 5000, image: "images/certificati/g.jpg", maxQty: 10, sold: false });
  // names: a missing language falls back to the first available one
  const n = src.parseTabCsv("vasi", "id,name_it,name_en,name_ru,img1,venduto,price_new\nn1,Ciao,,,a.jpg,,5");
  assert.deepEqual([n.items.n1.name_en, n.items.n1.name_ru], ["Ciao", "Ciao"]);
});

test("row validation: ids, prices, images, maxQty; invalid rows dropped with ids only, tab survives", async () => {
  const bad = [
    ["Bad", "a.jpg", "", "10"], // id uppercase
    ["1x", "a.jpg", "", "10"],
    ["p0", "a.jpg", "", "0"],
    ["p1", "a.jpg", "", "10000,01"],
    ["p2", "a.jpg", "", "1.234,50"],
    ["p3", "a.jpg", "", "abc"],
    ["i1", "../a.jpg", "", "10"],
    ["i2", "sub/a.jpg", "", "10"],
    ["i3", "a\\b.jpg", "", "10"],
    ["i4", "https://evil.example/a.jpg", "", "10"],
    ["i5", "a.jpg?x=1", "", "10"],
    ["i6", "a.gif", "", "10"],
    ["i7", "a..jpg", "", "10"],
    ["i8", "/etc/a.jpg", "", "10"],
    ["i9", "a.jpg#f", "", "10"],
  ];
  const good = Array.from({ length: bad.length + 1 }, (_, i) => ["ok" + i, "a.jpg", "", "10"]);
  const csv = mini("vasi", ...good, ...bad);
  const { items, dropped } = src.parseTabCsv("vasi", csv);
  assert.equal(Object.keys(items).length, good.length);
  assert.deepEqual(dropped, bad.map((b) => b[0]));
  assert.ok(src.parseTabCsv("vasi", mini("vasi", ["a", "a.jpg", "", "10000"])).items.a, "10000 EUR is accepted");
  const f = router({ ...TAB_CSV, vasi: csv });
  const [r, cap] = await quiet(() => src.getCatalogue({ env, fetchImpl: f, soldList: [], now: clock() }));
  assert.equal(r.sources.vasi, "sheet");
  assert.equal(r.tabs.vasi.rows.length, good.length);
  const [[lvl, o]] = events(cap, "catalogue_rows_dropped");
  assert.equal(lvl, "warn");
  assert.equal(o.tab, "vasi");
  assert.deepEqual(o.ids, bad.map((b) => b[0]));
  assert.ok(!cap.logs.some(([, l]) => l.includes("evil.example")), "only ids are logged");
  // masterclass maxQty out of range -> row dropped
  const mc = src.parseTabCsv("masterclass", mini("masterclass", ["m1", "a.jpg", "Max 6", "10"], ["m5", "a.jpg", "Max 6", "10"], ["m6", "a.jpg", "Max 6", "10"], ["m2", "a.jpg", "Max 0", "10"], ["m3", "a.jpg", "500 posti", "10"]));
  assert.deepEqual(mc.dropped, ["m2", "m3"]);
});

test("tab-level rejection: missing column, zero valid rows, >50% invalid rows, duplicate id inside the tab", () => {
  assert.throws(() => src.parseTabCsv("vasi", "id,name_it\nv1,x"), { reason: "missing_column_name_en" });
  assert.throws(() => src.parseTabCsv("vasi", ""), { reason: "csv_empty" });
  assert.throws(() => src.parseTabCsv("vasi", MIN.vasi + "\n"), { reason: "no_valid_rows" });
  assert.throws(() => src.parseTabCsv("vasi", mini("vasi", ["Bad", "a.jpg", "", "1"])), { reason: "no_valid_rows" });
  assert.throws(() => src.parseTabCsv("vasi", mini("vasi", ["a", "a.jpg", "", "1"], ["B", "a.jpg", "", "1"], ["C", "a.jpg", "", "1"])), { reason: "too_many_invalid_rows" });
  assert.ok(src.parseTabCsv("vasi", mini("vasi", ["a", "a.jpg", "", "1"], ["B", "a.jpg", "", "1"])), "exactly half is tolerated");
  assert.throws(() => src.parseTabCsv("vasi", mini("vasi", ["a", "a.jpg", "", "1"], ["a", "a.jpg", "", "2"])), { reason: "duplicate_id" });
});

test("exposure whitelist: extra columns and shopify_variant_id never leave; values untrimmed, CR stripped", async () => {
  const head = HEADERS.vasi.concat(["shopify_variant_id", "note_privata"]).join(",");
  const cells = (id) => {
    const o = { id, name_ru: "Р", name_it: " Vaso ", name_en: "Vase", long_en: '"line1\r\nline2, with comma"', img1: "a.jpg", venduto: "no", price_new: "10", shopify_variant_id: "VARIANT-123456", note_privata: "SECRET-NOTE" };
    return HEADERS.vasi.concat(["shopify_variant_id", "note_privata"]).map((h) => o[h] || "").join(",");
  };
  const csv = head + "\r\n" + cells("v1") + "\r\n";
  const r = await src.getCatalogue({ env, fetchImpl: router({ ...TAB_CSV, vasi: csv }), soldList: [], now: clock() });
  assert.deepEqual(r.tabs.vasi.headers, HEADERS.vasi);
  const row = r.tabs.vasi.rows[0];
  assert.deepEqual(Object.keys(row), HEADERS.vasi);
  assert.equal(row.name_it, " Vaso ", "content untrimmed");
  assert.equal(row.long_en, "line1\nline2, with comma", "CR stripped");
  const json = JSON.stringify(r);
  assert.ok(!json.includes("VARIANT-123456") && !json.includes("SECRET-NOTE") && !json.includes("shopify") && !json.includes("note_privata"));
  // the public endpoint exposes the same: nothing extra
  src._reset();
  const h = makeHandler({ env, fetchImpl: router({ ...TAB_CSV, vasi: csv }), now: clock() });
  const res = await h({ httpMethod: "GET", headers: {} });
  assert.ok(!res.body.includes("VARIANT-123456") && !res.body.includes("SECRET-NOTE"));
});

test("endpoint version 2: shape, sorted items, tabs, headers", async () => {
  const h = makeHandler({ env, fetchImpl: router(TAB_CSV), now: clock() });
  const r = await h({ httpMethod: "GET", headers: {} });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["Cache-Control"], "public, max-age=60");
  assert.equal(r.headers["Access-Control-Allow-Origin"], "*");
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body), ["version", "source", "sources", "items", "tabs"]);
  assert.equal(body.version, 2);
  assert.equal(body.source, "sheet");
  assert.deepEqual(body.sources, { vasi: "sheet", masterclass: "sheet", certificati: "sheet" });
  assert.deepEqual(body.items.map((i) => i.id), Object.keys(snapshot).sort());
  const BASE = ["id", "image", "maxQty", "name_en", "name_it", "name_ru", "priceCents", "sold", "type"];
  for (const it of body.items) {
    const mc = it.image.startsWith("images/masterclass/");
    assert.deepEqual(Object.keys(it).sort(), mc ? [...BASE, "seatsBooked", "seatsFree", "seatsTotal", "tiersCents"].sort() : BASE);
  }
  assert.deepEqual(Object.keys(body.tabs), ["vasi", "masterclass", "certificati"]);
  assert.deepEqual(body.tabs.masterclass.headers, HEADERS.masterclass);
  assert.equal(body.tabs.masterclass.rows[0].spots, "Max 6 persone");
});

test("snapshot mode (no variables): version 2 with null tabs, sources snapshot", async () => {
  const [r] = await quiet(() => makeHandler({ env: {} })({ httpMethod: "GET", headers: {} }));
  const body = JSON.parse(r.body);
  assert.equal(body.version, 2);
  assert.equal(body.source, "snapshot");
  assert.deepEqual(body.sources, { vasi: "snapshot", masterclass: "snapshot", certificati: "snapshot" });
  assert.deepEqual(body.tabs, { vasi: null, masterclass: null, certificati: null });
  assert.deepEqual(body.items.map((i) => i.id), Object.keys(snapshot).sort());
});

test("venduto in the vasi rows is the effective sold state (sheet OR sold.json OR local); others keep the sheet value", async () => {
  const csv = mini("vasi", ["a", "a.jpg", "no", "1"], ["b", "a.jpg", "", "1"], ["c", "a.jpg", "Sì", "1"], ["d", "a.jpg", "no", "1"], ["e", "a.jpg", "-", "1"], ["f", "a.jpg", "no", "1"]);
  const now = clock();
  const f = router({ ...TAB_CSV, vasi: csv });
  src.markSoldLocal(["d"], { now });
  const r = await src.getCatalogue({ env, fetchImpl: f, soldList: ["f"], now });
  const v = Object.fromEntries(r.tabs.vasi.rows.map((x) => [x.id, x.venduto]));
  assert.deepEqual(v, { a: "no", b: "no", c: "si", d: "si", e: "-", f: "si" });
  assert.deepEqual(["a", "b", "c", "d", "e", "f"].map((k) => r.items[k].sold), [false, false, true, true, false, true]);
  // the local marker expires with the 15 minutes
  now.advance(src.LOCAL_SOLD_TTL_MS + 1);
  const r2 = await src.getCatalogue({ env, fetchImpl: f, soldList: [], now });
  assert.equal(r2.tabs.vasi.rows.find((x) => x.id === "d").venduto, "no");
});

test("per tab failure: fetch error -> that tab from the snapshot (tab null), the others stay live; source is the worst", async () => {
  const f = router({ ...TAB_CSV, masterclass: new Error("ECONNRESET https://docs.google.com/TOKMC") });
  const [r, cap] = await quiet(() => src.getCatalogue({ env, fetchImpl: f, soldList: [], now: clock() }));
  assert.deepEqual(r.sources, { vasi: "sheet", masterclass: "snapshot", certificati: "sheet" });
  assert.equal(r.source, "snapshot");
  assert.equal(r.tabs.masterclass, null);
  assert.ok(r.tabs.vasi && r.tabs.certificati);
  assert.deepEqual(r.items, JSON.parse(JSON.stringify(snapshot)));
  const [[, o]] = events(cap, "catalogue_fetch_failed");
  assert.deepEqual([o.tab, o.host, o.reason, o.fallback], ["masterclass", "docs.google.com", "network", "snapshot"]);
  // only the failing tab's snapshot items are used: a price changed live in vasi is kept
  src._reset();
  const csv = mini("vasi", ["v1", "a.jpg", "", "155"]);
  const [r2] = await quiet(() => src.getCatalogue({ env, fetchImpl: router({ ...TAB_CSV, vasi: csv, certificati: "garbage" }), soldList: [], now: clock() }));
  assert.equal(r2.items.v1.priceCents, 15500);
  assert.equal(r2.sources.certificati, "snapshot");
  assert.equal(r2.items["gc-50"].priceCents, 5000);
});

test("per tab: HTTP error, invalid tab (zero valid rows, >50% invalid, in-tab duplicate), oversize, timeout all fall back", async () => {
  const cases = {
    http: new Response("x", { status: 503 }),
    zero: MIN.vasi + "\n",
    many: mini("vasi", ["a", "a.jpg", "", "1"], ["B", "a.jpg", "", "1"], ["C", "a.jpg", "", "1"]),
    dup: mini("vasi", ["a", "a.jpg", "", "1"], ["a", "a.jpg", "", "1"]),
    big: "x".repeat(src.MAX_CSV_BYTES + 1),
    hang: (opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  };
  for (const [name, vasi] of Object.entries(cases)) {
    src._reset();
    const [r] = await quiet(() => src.getCatalogue({ env, fetchImpl: router({ ...TAB_CSV, vasi }), soldList: [], now: clock(), timeoutMs: 20 }));
    assert.deepEqual(r.sources, { vasi: "snapshot", masterclass: "sheet", certificati: "sheet" }, name);
    assert.equal(r.tabs.vasi, null, name);
    assert.deepEqual(Object.keys(r.items).sort(), Object.keys(snapshot).sort(), name);
  }
});

test("per tab stale: own last good copy for <= 24 h (source stale, rows kept), then the snapshot; other tabs unaffected", async () => {
  const now = clock();
  const csv = mini("vasi", ["only", "a.jpg", "", "77"]);
  const good = router({ ...TAB_CSV, vasi: csv });
  let r = await src.getCatalogue({ env, fetchImpl: good, soldList: [], now });
  assert.deepEqual(Object.keys(r.items).filter((k) => k === "only" || k === "v1"), ["only"]);
  const failing = router({ ...TAB_CSV, vasi: new Response("x", { status: 500 }) });
  now.advance(src.CACHE_TTL_MS + 1);
  let cap;
  [r, cap] = await quiet(() => src.getCatalogue({ env, fetchImpl: failing, soldList: [], now }));
  assert.deepEqual(r.sources, { vasi: "stale", masterclass: "sheet", certificati: "sheet" });
  assert.equal(r.source, "stale");
  assert.equal(r.items.only.priceCents, 7700);
  assert.equal(r.tabs.vasi.rows.length, 1);
  assert.equal(events(cap, "catalogue_fetch_failed")[0][1].fallback, "stale");
  now.advance(src.STALE_MAX_MS);
  [r] = await quiet(() => src.getCatalogue({ env, fetchImpl: router({ ...TAB_CSV, vasi: new Response("x", { status: 500 }) }), soldList: [], now }));
  assert.equal(r.sources.vasi, "snapshot");
  assert.ok(r.items.v1 && !r.items.only);
  assert.equal(r.tabs.vasi, null);
});

test("cache (60 s), shared in-flight request and 15 s back-off apply per tab", async () => {
  const now = clock();
  const f = router(TAB_CSV);
  await Promise.all([1, 2, 3].map(() => src.getCatalogue({ env, fetchImpl: f, soldList: [], now })));
  assert.equal(f.calls.length, 3, "one request per tab for concurrent callers");
  now.advance(src.CACHE_TTL_MS - 1);
  await src.getCatalogue({ env, fetchImpl: f, soldList: [], now });
  assert.equal(f.calls.length, 3);
  now.advance(2);
  const f2 = router({ ...TAB_CSV, vasi: new Response("x", { status: 500 }) });
  await quiet(() => src.getCatalogue({ env, fetchImpl: f2, soldList: [], now }));
  assert.equal(f2.calls.length, 3);
  now.advance(src.FAIL_BACKOFF_MS - 1);
  await quiet(() => src.getCatalogue({ env, fetchImpl: f2, soldList: [], now }));
  assert.equal(f2.calls.length, 3, "cached tabs are not refetched and the failed one backs off");
  now.advance(2);
  await quiet(() => src.getCatalogue({ env, fetchImpl: f2, soldList: [], now }));
  assert.equal(f2.calls.length, 4, "after the back-off only the failed tab is retried");
});

test("mode selection: one variable set -> tab mode, unset tabs behave like failed tabs; legacy URL ignored then", async () => {
  const f = router({ ...TAB_CSV, other: "x" });
  const only = { CATALOGUE_CERTIFICATI_CSV_URL: U.certificati, CATALOGUE_CSV_URL: "https://docs.google.com/spreadsheets/d/e/LEGACY/pub?output=csv" };
  const [r, cap] = await quiet(() => src.getCatalogue({ env: only, fetchImpl: f, soldList: [], now: clock() }));
  assert.deepEqual(r.sources, { vasi: "snapshot", masterclass: "snapshot", certificati: "sheet" });
  assert.deepEqual(f.calls, [U.certificati], "legacy URL is not fetched");
  assert.equal(events(cap, "catalogue_source_not_configured").length, 2);
  assert.deepEqual(r.tabs.vasi, null);
  // a rejected URL (wrong host / http) fails that tab only
  src._reset();
  const bad = { ...env, CATALOGUE_VASI_CSV_URL: "https://evil.example/x.csv", CATALOGUE_MASTERCLASS_CSV_URL: "http://docs.google.com/x" };
  const f2 = router(TAB_CSV);
  const [r2, cap2] = await quiet(() => src.getCatalogue({ env: bad, fetchImpl: f2, soldList: [], now: clock() }));
  assert.deepEqual(r2.sources, { vasi: "snapshot", masterclass: "snapshot", certificati: "sheet" });
  assert.deepEqual(f2.calls, [U.certificati]);
  assert.deepEqual(events(cap2, "catalogue_source_rejected").map(([, o]) => [o.variable, o.reason]), [["CATALOGUE_VASI_CSV_URL", "host_not_allowed"], ["CATALOGUE_MASTERCLASS_CSV_URL", "not_https"]]);
  assert.ok(!cap2.logs.some(([, l]) => l.includes("evil.example")));
});

test("legacy mode: only CATALOGUE_CSV_URL set -> single CSV still works (tabs null); none set -> snapshot", async () => {
  const legacyCsv = fx("catalogue-sheet.csv");
  const lenv = { CATALOGUE_CSV_URL: "https://docs.google.com/spreadsheets/d/e/LEGACY/pub?output=csv" };
  const f = async () => new Response(legacyCsv, { status: 200 });
  let r = await src.getCatalogue({ env: lenv, fetchImpl: f, soldList: [], now: clock() });
  assert.equal(r.source, "sheet");
  assert.deepEqual(r.sources, { vasi: "sheet", masterclass: "sheet", certificati: "sheet" });
  assert.deepEqual(r.tabs, { vasi: null, masterclass: null, certificati: null });
  assert.deepEqual(r.items, JSON.parse(JSON.stringify(snapshotRaw))); // single 9-column sheet: no seat fields
  const h = makeHandler({ env: lenv, fetchImpl: f, now: clock() });
  const body = JSON.parse((await h({ httpMethod: "GET", headers: {} })).body);
  assert.equal(body.version, 2);
  assert.equal(body.source, "sheet");
  assert.equal(body.tabs.vasi, null);
  src._reset();
  const [none, cap] = await quiet(() => src.getCatalogue({ env: {}, fetchImpl: async () => { throw new Error("no fetch expected"); }, soldList: [], now: clock() }));
  assert.equal(none.source, "snapshot");
  assert.deepEqual(none.items, JSON.parse(JSON.stringify(snapshot)));
  assert.equal(events(cap, "catalogue_source_not_configured").length, 1);
});

test("duplicate id across tabs: the later tab's row is rejected (warn, id only), the earlier wins, rows follow", async () => {
  const mc = mini("masterclass", ["v1", "w.jpg", "Max 6", "10"], ["mc9", "w.jpg", "Max 6", "10"]);
  const [r, cap] = await quiet(() => src.getCatalogue({ env, fetchImpl: router({ ...TAB_CSV, masterclass: mc }), soldList: [], now: clock() }));
  assert.equal(r.items.v1.type, "physical");
  assert.equal(r.items.v1.priceCents, 15000);
  assert.ok(r.items.mc9);
  assert.deepEqual(r.tabs.masterclass.rows.map((x) => x.id), ["mc9"]);
  assert.equal(r.tabs.vasi.rows.find((x) => x.id === "v1").price_new, "150");
  const [[lvl, o]] = events(cap, "catalogue_duplicate_id");
  assert.deepEqual([lvl, o.tab, o.id], ["warn", "masterclass", "v1"]);
});

test("secrets and sheet URLs are never logged (failures, rejections, dropped rows)", async () => {
  const cap = capture();
  try {
    const f = router({ vasi: new Error("boom https://docs.google.com/spreadsheets/d/e/TOKVASI"), masterclass: new Response("x", { status: 500 }), certificati: mini("certificati", ["Bad", "a.jpg", "", "1"]) });
    await src.getCatalogue({ env: { ...env, CATALOGUE_WRITE_SECRET: "S3CRET-VALUE" }, fetchImpl: f, soldList: [], now: clock() });
  } finally {
    cap.restore();
  }
  assert.ok(cap.logs.length >= 3);
  const all = cap.logs.map(([, l]) => l).join("\n");
  for (const t of ["TOKVASI", "TOKMC", "TOKCERT", "S3CRET", "spreadsheets"]) assert.ok(!all.includes(t), t);
  assert.ok(all.includes("docs.google.com"), "host only");
});

// ---- write-back: script_outdated ---------------------------------------------

const WURL = "https://script.google.com/macros/s/AKFY123/exec";
const wenv = { CATALOGUE_WRITE_URL: WURL, CATALOGUE_WRITE_SECRET: "S3CRET-VALUE" };
const jsonRes = (o) => new Response(JSON.stringify(o), { status: 200 });

test("markSold: success needs ok === true AND sheet === 'Vasi'; an ok reply without it is script_outdated (no retry)", async () => {
  for (const reply of [{ ok: true, marked: ["v3"] }, { ok: true, marked: ["v3"], sheet: "Catalogue" }, { ok: true, sheet: "vasi" }]) {
    let n = 0;
    const r = await src.markSold(["v3"], { fetchImpl: async () => (n++, jsonRes(reply)), env: wenv, sleep: async () => {} });
    assert.deepEqual(r, { ok: false, reason: "script_outdated" });
    assert.equal(n, 1);
  }
  const ok = await src.markSold(["v3"], { fetchImpl: async () => jsonRes({ ok: true, marked: ["v3"], sheet: "Vasi" }), env: wenv, sleep: async () => {} });
  assert.deepEqual(ok, { ok: true, marked: ["v3"] });
  const err = await src.markSold(["v3"], { fetchImpl: async () => jsonRes({ ok: false, error: "bad_sheet" }), env: wenv, sleep: async () => {} });
  assert.deepEqual(err, { ok: false, reason: "bad_sheet" });
});

test("webhook: script_outdated -> warn sold_mark_failed, ACTION line with '(Apps Script needs updating)', still sold locally, 200", async () => {
  const sent = [];
  const cap = capture();
  let r;
  try {
    const stripe = {
      webhooks: { constructEvent: () => ({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid", metadata: { item_ids: "v3" }, amount_total: 100, currency: "eur" } } }) },
      checkout: { sessions: { listLineItems: async () => ({ data: [] }) } },
    };
    const h = makeWebhook({
      stripeFactory: () => stripe,
      env: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OWNER_NOTIFY_WEBHOOK_URL: "https://hook.example/x", ...wenv, ...env },
      notify: async (s) => sent.push(s),
      fetchImpl: async (url) => (String(url).startsWith("https://docs.google.com") ? new Response(TAB_CSV[Object.keys(U).find((k) => U[k] === String(url))], { status: 200 }) : jsonRes({ ok: true, marked: ["v3"] })),
    });
    r = await h({ httpMethod: "POST", headers: { "stripe-signature": "s" }, body: "{}" });
    const after = await src.getCatalogue({ env, fetchImpl: async (u) => new Response(TAB_CSV[Object.keys(U).find((k) => U[k] === String(u))], { status: 200 }), soldList: [] });
    assert.equal(after.items.v3.sold, true);
  } finally {
    cap.restore();
  }
  assert.equal(r.statusCode, 200);
  assert.ok(sent[0].endsWith("ACTION: mark v3 as sold in the sheet manually (Apps Script needs updating)"));
  const [[lvl, o]] = events(cap, "sold_mark_failed");
  assert.deepEqual([lvl, o.reason], ["warn", "script_outdated"]);
  assert.ok(!cap.logs.some(([, l]) => l.includes("S3CRET") || l.includes("AKFY123")));
});
