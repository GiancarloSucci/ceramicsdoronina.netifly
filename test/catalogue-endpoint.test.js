const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { makeHandler } = require("../functions/catalogue.js");
const src = require("../functions/_catalogue-source.js");
const snapshot = require("../functions/catalogue.json");

const CSV = fs.readFileSync(path.join(__dirname, "fixtures", "catalogue-sheet.csv"), "utf8");
const get = (o = {}) => ({ httpMethod: "GET", headers: {}, ...o });
const FIELDS = ["id", "image", "maxQty", "name_en", "name_it", "name_ru", "priceCents", "sold", "type"];

test.beforeEach(() => src._reset());

test("200: shape, ordered by id, headers, CORS, no extra fields (snapshot source)", async () => {
  // extra properties on the catalogue entries must never reach the response
  const items = { b: { ...snapshot.v1, secret: "x", sold: false }, a: { ...snapshot.v2, internal: 1 } };
  const h = makeHandler({ getCatalogue: async () => ({ items, source: "snapshot" }) });
  const r = await h(get());
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["Content-Type"], "application/json");
  assert.equal(r.headers["Cache-Control"], "public, max-age=60");
  assert.equal(r.headers["Access-Control-Allow-Origin"], "*");
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body), ["version", "source", "sources", "items", "tabs"]);
  assert.equal(body.version, 2);
  assert.equal(body.source, "snapshot");
  assert.deepEqual(body.items.map((i) => i.id), ["a", "b"]);
  for (const it of body.items) assert.deepEqual(Object.keys(it).sort(), FIELDS);
  assert.ok(!r.body.includes("secret") && !r.body.includes("internal"));
});

test("real source: sheet via fake fetch, sold marked locally is reflected", async () => {
  const fetchImpl = async () => new Response(CSV, { status: 200 });
  const env = { CATALOGUE_CSV_URL: "https://docs.google.com/spreadsheets/d/e/T/pub?output=csv" };
  const h = makeHandler({ env, fetchImpl, now: () => 5000 });
  let body = JSON.parse((await h(get())).body);
  assert.equal(body.source, "sheet");
  assert.equal(body.items.length, Object.keys(snapshot).length);
  assert.equal(body.items.find((i) => i.id === "v3").sold, false);
  src.markSoldLocal(["v3"], { now: () => 5000 });
  body = JSON.parse((await h(get())).body);
  assert.equal(body.items.find((i) => i.id === "v3").sold, true);
  assert.ok(!JSON.stringify(body).includes("docs.google.com"));
});

test("no env: snapshot", async () => {
  const body = JSON.parse((await makeHandler({ env: {} })(get())).body);
  assert.equal(body.source, "snapshot");
  assert.deepEqual(body.items.map((i) => i.id), Object.keys(snapshot).sort());
});

test("OPTIONS 204 with CORS, other methods 405 with Allow", async () => {
  const h = makeHandler({ env: {} });
  const o = await h({ httpMethod: "OPTIONS", headers: {} });
  assert.equal(o.statusCode, 204);
  assert.equal(o.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(o.headers["Access-Control-Allow-Methods"], "GET,OPTIONS");
  assert.equal(o.body, "");
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
    const r = await h({ httpMethod: m, headers: {} });
    assert.equal(r.statusCode, 405, m);
    assert.equal(r.headers.Allow, "GET,OPTIONS");
    assert.equal(JSON.parse(r.body).error, "method_not_allowed");
  }
});

test("unexpected failure -> generic 500", async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await makeHandler({ getCatalogue: async () => { throw new Error("boom sk_live_ABC"); } })(get());
    assert.equal(r.statusCode, 500);
    assert.equal(JSON.parse(r.body).error, "server_error");
    assert.ok(!r.body.includes("sk_live"));
  } finally {
    console.error = orig;
  }
});
