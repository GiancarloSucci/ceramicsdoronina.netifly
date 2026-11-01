// Tests for functions/_catalogue-source.js with an injected fake fetch (no network).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const src = require("../functions/_catalogue-source.js");
const snapshot = require("../functions/catalogue.json");
const price = require("./fixtures/price-cases.json");

const CSV = fs.readFileSync(path.join(__dirname, "fixtures", "catalogue-sheet.csv"), "utf8");
const URL_OK = "https://docs.google.com/spreadsheets/d/e/TOKEN123/pub?output=csv";
const HEAD = "id,type,name_it,name_en,name_ru,price,image,maxQty,sold";
const row = (o = {}) => {
  const r = { id: "v1", type: "physical", n: "Vaso", price: "100", image: "images/a.jpg", maxQty: "1", sold: "", ...o };
  return [r.id, r.type, r.n, r.n, r.n, JSON.stringify(r.price), r.image, r.maxQty, r.sold].join(",");
};
const csvOf = (...rows) => [HEAD, ...rows].join("\n");

function capture() {
  const logs = [];
  const orig = { e: console.error, i: console.info, w: console.warn };
  console.error = (m) => logs.push(["error", String(m)]);
  console.info = (m) => logs.push(["info", String(m)]);
  console.warn = (m) => logs.push(["warn", String(m)]);
  return { logs, restore: () => Object.assign(console, { error: orig.e, info: orig.i, warn: orig.w }) };
}
const events = (cap, ev) => cap.logs.filter(([, l]) => l.includes(`"event":"${ev}"`)).map(([lvl, l]) => [lvl, JSON.parse(l)]);

// fake fetch: responses is a list consumed in order (last one repeats); items are strings, Response-likes or Errors
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r(opts);
    if (typeof r === "string") return new Response(r, { status: 200 });
    return r;
  };
  fn.calls = calls;
  return fn;
}
const env = { CATALOGUE_CSV_URL: URL_OK };
const clock = (t0 = 1_000_000) => {
  let t = t0;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
};

test.beforeEach(() => src._reset());

test("parseCsv: quotes, embedded commas/newlines, escaped quotes, BOM, CRLF/LF/CR, blank lines", () => {
  assert.deepEqual(src.parseCsv('a,b\r\n"x,1","y ""q"""\r\n'), [["a", "b"], ["x,1", 'y "q"']]);
  assert.deepEqual(src.parseCsv('﻿a,b\n"l1\nl2",c'), [["a", "b"], ["l1\nl2", "c"]]);
  assert.deepEqual(src.parseCsv("a,b\rc,d"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(src.parseCsv("a,b\n\n\nc,d\n\n"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(src.parseCsv("a,,\n,,"), [["a", "", ""], ["", "", ""]]);
  assert.deepEqual(src.parseCsv('a,"",c'), [["a", "", "c"]]);
  assert.deepEqual(src.parseCsv('a"b,c'), [['a"b', "c"]]); // quote inside an unquoted field is literal
  assert.deepEqual(src.parseCsv(""), []);
  assert.throws(() => src.parseCsv('a,"open'), /unterminated/);
});

test("fixture CSV (no trailing newline, CRLF or LF, Cyrillic, euro) matches the bundled snapshot", () => {
  for (const text of [CSV, CSV.replace(/\r\n/g, "\n"), "﻿" + CSV]) {
    const { items, dropped } = src.parseCatalogueCsv(text);
    assert.deepEqual(dropped, []);
    assert.deepEqual(items, JSON.parse(JSON.stringify(snapshot)));
  }
  assert.ok(src.parseCatalogueCsv(CSV).items.v1.name_ru.includes("Морская"));
  assert.ok(src.parseCatalogueCsv(CSV).items["gc-150"].name_it.includes("€"));
});

test("price parsing: same cases as the shared price fixture (strict, no jsOnly formats)", () => {
  for (const [s, cents] of price.valid) assert.equal(src.parsePriceCents(s), cents, s);
  for (const [n, cents] of price.numbers) assert.equal(src.parsePriceCents(n), cents, String(n));
  for (const s of price.reject) assert.equal(src.parsePriceCents(s), null, JSON.stringify(s));
  for (const [s] of price.jsOnly) assert.equal(src.parsePriceCents(s), null, s);
  for (const s of price.pythonQuirks) assert.equal(src.parsePriceCents(s), 0, s);
});

test("row validation: price range, quirks, type, maxQty, id, sold words, image", () => {
  const good = row({ id: "ok" });
  const bad = [
    row({ id: "p0", price: "0" }), row({ id: "p00", price: "0,00" }), row({ id: "pbig", price: "10000,01" }), row({ id: "pjs", price: "1.234,56" }),
    row({ id: "pneg", price: "-5" }), row({ id: "t", type: "service" }), row({ id: "q0", maxQty: "0" }), row({ id: "q101", maxQty: "101" }),
    row({ id: "qf", maxQty: "1.5" }), row({ id: "Upper" }), row({ id: "1abc" }), row({ id: "i1", image: "../x.jpg" }), row({ id: "i2", image: "/abs.jpg" }),
    row({ id: "i3", image: "https://evil/x.jpg" }), row({ id: "n", n: "" }),
  ];
  // keep invalid rows below 50%: pad with valid ones
  const pad = Array.from({ length: bad.length + 1 }, (_, i) => row({ id: "pad" + i }));
  const cap = capture();
  let r;
  try {
    r = src.parseCatalogueCsv(csvOf(good, ...pad, ...bad));
  } finally {
    cap.restore();
  }
  assert.equal(Object.keys(r.items).length, 1 + pad.length);
  assert.deepEqual(r.dropped.sort(), ["p0", "p00", "pbig", "pjs", "pneg", "t", "q0", "q101", "qf", "Upper", "1abc", "i1", "i2", "i3", "n"].sort());
  const edge = src.parseCatalogueCsv(csvOf(row({ id: "a", price: "10000" }), row({ id: "b", price: "0,01" }), row({ id: "c", maxQty: "100", price: "120,50" }))).items;
  assert.deepEqual([edge.a.priceCents, edge.b.priceCents, edge.c.priceCents, edge.c.maxQty], [1000000, 1, 12050, 100]);
  for (const [v, want] of [["TRUE", true], ["true", true], ["1", true], ["yes", true], ["si", true], ["sì", true], ["Sì", true], ["x", true], ["", false], ["no", false], ["0", false], ["FALSE", false]]) {
    assert.equal(src.parseSold(v), want, v);
  }
  const names = src.parseCatalogueCsv(`${HEAD}\nv1,physical,Solo IT,,,10,,1,`).items.v1;
  assert.deepEqual([names.name_en, names.name_ru, names.image], ["Solo IT", "Solo IT", ""]);
});

test("duplicate ids reject the whole sheet; missing column, empty, >50% invalid, zero valid also fail", () => {
  const reason = (text) => { try { src.parseCatalogueCsv(text); } catch (e) { return e.reason; } };
  assert.equal(reason(csvOf(row({ id: "a" }), row({ id: "a", price: "5" }))), "duplicate_id");
  assert.equal(reason(csvOf(row({ id: "a" }), row({ id: "b" }), row({ id: "a", type: "bad" }))), "duplicate_id");
  assert.equal(reason("id,type\na,physical"), "missing_column_name_it");
  assert.equal(reason(""), "csv_empty");
  assert.equal(reason(HEAD), "no_valid_rows");
  assert.equal(reason(csvOf(row({ id: "a" }), row({ id: "b", price: "x" }), row({ id: "c", price: "x" }))), "too_many_invalid_rows");
  assert.equal(reason(csvOf(row({ id: "a" }), row({ id: "b", price: "x" }))), undefined); // exactly 50% is tolerated
  assert.equal(reason('id,type\n"open'), "csv_malformed");
});

test("getCatalogue: sheet source, shape, header order/case insensitive, dropped rows logged with ids only", async () => {
  const f = fakeFetch(csvOf(row({ id: "a" }), row({ id: "b" }), row({ id: "c", price: "oops" })).replace("maxQty", "MAXQTY"));
  const cap = capture();
  let r;
  try {
    r = await src.getCatalogue({ fetchImpl: f, env, now: clock(), soldList: [] });
  } finally {
    cap.restore();
  }
  assert.equal(r.source, "sheet");
  assert.deepEqual(Object.keys(r.items), ["a", "b"]);
  assert.deepEqual(Object.keys(r.items.a).sort(), ["image", "maxQty", "name_en", "name_it", "name_ru", "priceCents", "sold", "type"]);
  const [[lvl, d]] = events(cap, "catalogue_rows_dropped");
  assert.equal(lvl, "warn");
  assert.deepEqual(d.ids, ["c"]);
  assert.ok(!cap.logs.some(([, l]) => l.includes("TOKEN123")));
  assert.equal(f.calls[0].opts.redirect, "follow");
  assert.ok(f.calls[0].opts.signal instanceof AbortSignal);
});

test("cache: second call within 60 s does not fetch; after 60 s it refetches", async () => {
  const f = fakeFetch(csvOf(row({ id: "a", price: "10" })), csvOf(row({ id: "a", price: "20" })));
  const now = clock();
  const opts = { fetchImpl: f, env, now, soldList: [] };
  assert.equal((await src.getCatalogue(opts)).items.a.priceCents, 1000);
  now.advance(src.CACHE_TTL_MS - 1);
  assert.equal((await src.getCatalogue(opts)).items.a.priceCents, 1000);
  assert.equal(f.calls.length, 1);
  now.advance(2);
  assert.equal((await src.getCatalogue(opts)).items.a.priceCents, 2000);
  assert.equal(f.calls.length, 2);
});

test("concurrent calls share one fetch", async () => {
  const f = fakeFetch(csvOf(row({ id: "a" })));
  const opts = { fetchImpl: f, env, now: clock(), soldList: [] };
  await Promise.all([src.getCatalogue(opts), src.getCatalogue(opts), src.getCatalogue(opts)]);
  assert.equal(f.calls.length, 1);
});

test("stale on error (up to 24 h), then snapshot; failure back-off avoids hammering", async () => {
  const f = fakeFetch(csvOf(row({ id: "a", price: "10" })), new Error("boom https://docs.google.com/TOKEN123"));
  const now = clock();
  const opts = { fetchImpl: f, env, now, soldList: [] };
  await src.getCatalogue(opts);
  const cap = capture();
  try {
    now.advance(src.CACHE_TTL_MS + 1);
    let r = await src.getCatalogue(opts);
    assert.equal(r.source, "stale");
    assert.equal(r.items.a.priceCents, 1000);
    assert.equal(f.calls.length, 2);
    now.advance(1000);
    r = await src.getCatalogue(opts); // inside the back-off: no new fetch
    assert.equal(r.source, "stale");
    assert.equal(f.calls.length, 2);
    now.advance(src.STALE_MAX_MS);
    r = await src.getCatalogue(opts);
    assert.equal(r.source, "snapshot");
    assert.deepEqual(Object.keys(r.items), Object.keys(snapshot));
  } finally {
    cap.restore();
  }
  const ev = events(cap, "catalogue_fetch_failed");
  assert.equal(ev.length, 2);
  assert.deepEqual([ev[0][1].host, ev[0][1].reason, ev[0][1].fallback], ["docs.google.com", "network", "stale"]);
  assert.equal(ev[1][1].fallback, "snapshot");
  assert.ok(!cap.logs.some(([, l]) => l.includes("TOKEN123")), "full URL / token must not be logged");
});

test("snapshot when the first fetch fails: HTTP error, bad CSV, duplicate ids, oversize, timeout", async () => {
  const big = "id," + "x".repeat(src.MAX_CSV_BYTES);
  const slow = (opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const cases = [
    [new Response("nope", { status: 503 }), "http_503"],
    ["id,type\nx", "missing_column_name_it"],
    [csvOf(row({ id: "a" }), row({ id: "a" })), "duplicate_id"],
    [big, "too_large"],
    [new Response("x", { status: 200, headers: { "content-length": String(src.MAX_CSV_BYTES + 1) } }), "too_large"],
    [slow, "timeout"],
  ];
  for (const [resp, reason] of cases) {
    src._reset();
    const cap = capture();
    let r;
    try {
      r = await src.getCatalogue({ fetchImpl: fakeFetch(resp), env, now: clock(), soldList: [], timeoutMs: 20 });
    } finally {
      cap.restore();
    }
    assert.equal(r.source, "snapshot", reason);
    assert.equal(events(cap, "catalogue_fetch_failed")[0][1].reason, reason);
  }
});

test("env unset: snapshot, one warn event only, no fetch; invalid/non-allowlisted hosts fall back with a warning", async () => {
  const f = fakeFetch(CSV);
  const cap = capture();
  try {
    for (let i = 0; i < 3; i++) {
      const r = await src.getCatalogue({ fetchImpl: f, env: {}, now: clock(), soldList: [] });
      assert.equal(r.source, "snapshot");
    }
    assert.equal(events(cap, "catalogue_source_not_configured").length, 1);
    for (const bad of ["http://docs.google.com/x", "https://evil.example/x", "https://docs.google.com.evil.example/x", "https://u:p@docs.google.com/x", "not a url", "https://script.google.com/x"]) {
      const r = await src.getCatalogue({ fetchImpl: f, env: { CATALOGUE_CSV_URL: bad }, now: clock(), soldList: [] });
      assert.equal(r.source, "snapshot", bad);
    }
  } finally {
    cap.restore();
  }
  assert.equal(f.calls.length, 0);
  assert.equal(events(cap, "catalogue_source_rejected").length, 3); // one per distinct reason
  assert.ok(events(cap, "catalogue_source_rejected").every(([lvl, d]) => lvl === "warn" && !JSON.stringify(d).includes("evil")));
});

test("sold.json override and locally marked ids are merged; local ids expire after 15 min", async () => {
  const f = fakeFetch(csvOf(row({ id: "a" }), row({ id: "b" }), row({ id: "c", sold: "TRUE" })));
  const now = clock();
  const opts = { fetchImpl: f, env, now, soldList: ["b"] };
  let r = await src.getCatalogue(opts);
  assert.deepEqual([r.items.a.sold, r.items.b.sold, r.items.c.sold], [false, true, true]);
  src.markSoldLocal(["a", "BAD ID", "zz"], { now });
  r = await src.getCatalogue(opts);
  assert.equal(r.items.a.sold, true);
  assert.ok(!("zz" in r.items) && !("BAD ID" in r.items));
  now.advance(src.LOCAL_SOLD_TTL_MS + 1);
  r = await src.getCatalogue(opts);
  assert.equal(r.items.a.sold, false);
  // also applies to the snapshot
  src.markSoldLocal(["v9"], { now });
  r = await src.getCatalogue({ env: {}, now, soldList: [] });
  assert.equal(r.items.v9.sold, true);
  assert.equal(snapshot.v9.sold, false, "snapshot module data must not be mutated");
});

test("snapshot honours the default sold.json", async () => {
  const sold = require("../functions/sold.json");
  const r = await src.getCatalogue({ env: {}, now: clock() });
  for (const id of sold) assert.equal(r.items[id].sold, true);
});

// ---- markSold --------------------------------------------------------------

const WURL = "https://script.google.com/macros/s/AKFY123/exec";
const wenv = { CATALOGUE_WRITE_URL: WURL, CATALOGUE_WRITE_SECRET: "S3CRET-VALUE" };
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status });
const nosleep = async () => {};

test("markSold: POSTs {secret, ids} with redirect follow and accepts ok:true JSON", async () => {
  const f = fakeFetch(jsonRes({ ok: true, marked: ["v3"], sheet: "Vasi" }));
  const r = await src.markSold(["v3"], { fetchImpl: f, env: wenv, sleep: nosleep });
  assert.deepEqual(r, { ok: true, marked: ["v3"] });
  assert.equal(f.calls.length, 1);
  const { url, opts } = f.calls[0];
  assert.equal(url, WURL);
  assert.equal(opts.method, "POST");
  assert.equal(opts.redirect, "follow");
  assert.deepEqual(JSON.parse(opts.body), { secret: "S3CRET-VALUE", ids: ["v3"] });
  assert.ok(opts.signal instanceof AbortSignal);
});

test("markSold: not configured / bad host / http -> no fetch", async () => {
  const f = fakeFetch(jsonRes({ ok: true }));
  const cap = capture();
  const out = [];
  try {
    out.push(await src.markSold(["v3"], { fetchImpl: f, env: {}, sleep: nosleep }));
    out.push(await src.markSold(["v3"], { fetchImpl: f, env: { CATALOGUE_WRITE_URL: WURL }, sleep: nosleep })); // no secret
    out.push(await src.markSold(["v3"], { fetchImpl: f, env: { ...wenv, CATALOGUE_WRITE_URL: "https://evil.example/exec" }, sleep: nosleep }));
    out.push(await src.markSold(["v3"], { fetchImpl: f, env: { ...wenv, CATALOGUE_WRITE_URL: "http://script.google.com/exec" }, sleep: nosleep }));
  } finally {
    cap.restore();
  }
  assert.deepEqual(out.map((o) => o.reason), ["not_configured", "not_configured", "host_not_allowed", "not_https"]);
  assert.equal(f.calls.length, 0);
  assert.ok(!cap.logs.some(([, l]) => l.includes("S3CRET") || l.includes("evil")));
});

test("markSold: retries network errors, 5xx and non-JSON (max 2 retries), succeeds on a later attempt", async () => {
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  let f = fakeFetch(new Error("ECONNRESET"), new Response("<html>oops</html>", { status: 200 }), jsonRes({ ok: true, marked: ["v3"], sheet: "Vasi" }));
  assert.equal((await src.markSold(["v3"], { fetchImpl: f, env: wenv, sleep })).ok, true);
  assert.equal(f.calls.length, 3);
  assert.equal(waits.length, 2);
  f = fakeFetch(new Response("x", { status: 502 }));
  let r = await src.markSold(["v3"], { fetchImpl: f, env: wenv, sleep });
  assert.deepEqual(r, { ok: false, reason: "http_502" });
  assert.equal(f.calls.length, 3, "1 attempt + 2 retries");
  f = fakeFetch(new Response("not json", { status: 200 }));
  r = await src.markSold(["v3"], { fetchImpl: f, env: wenv, sleep });
  assert.deepEqual(r, { ok: false, reason: "non_json" });
  assert.equal(f.calls.length, 3);
});

test("markSold: definitive ok:false answers are not retried (forbidden, bad_ids, ...)", async () => {
  for (const error of ["forbidden", "bad_json", "bad_ids", "bad_columns"]) {
    const f = fakeFetch(jsonRes({ ok: false, error }));
    const r = await src.markSold(["v3"], { fetchImpl: f, env: wenv, sleep: nosleep });
    assert.deepEqual(r, { ok: false, reason: error });
    assert.equal(f.calls.length, 1);
  }
  const f = fakeFetch(jsonRes({ ok: "yes" }));
  assert.equal((await src.markSold(["v3"], { fetchImpl: f, env: wenv, sleep: nosleep })).ok, false, "only ok === true is success");
});

test("markSold: timeout via AbortController is retried then reported", async () => {
  const hang = (opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const f = fakeFetch(hang);
  const r = await src.markSold(["v3"], { fetchImpl: f, env: wenv, sleep: nosleep, timeoutMs: 15 });
  assert.deepEqual(r, { ok: false, reason: "timeout" });
  assert.equal(f.calls.length, 3);
});
