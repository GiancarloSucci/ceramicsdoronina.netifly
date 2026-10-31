const test = require("node:test");
const assert = require("node:assert");
const { makeHandler, isOriginAllowed, parseAllowedOrigins, computeShippingCents, validateBody, buildLineItems, buildSessionParams, normalizeSiteUrl, SHIPPING } = require("../functions/create-checkout.js");
const { assertStripeRules, makeStripeFake } = require("./helpers/stripe-fake.js");

const catalogue = {
  v1: { type: "physical", name_it: "Vaso", name_en: "Vase", name_ru: "Ваза", priceCents: 10000, sold: false, image: "images/catalogue/a b.jpg", maxQty: 1 },
  v2: { type: "physical", name_it: "Vaso2", priceCents: 30000, sold: false, image: "images/catalogue/b.jpg", maxQty: 1 },
  v3: { type: "physical", name_it: "Vaso3", priceCents: 19999, sold: false, image: "", maxQty: 1 },
  v4: { type: "physical", name_it: "Vaso4", priceCents: 20000, sold: false, image: "", maxQty: 1 },
  v5: { type: "physical", name_it: "Vaso5", priceCents: 49999, sold: false, image: "", maxQty: 1 },
  v6: { type: "physical", name_it: "Vaso6", priceCents: 50000, sold: false, image: "", maxQty: 1 },
  vs: { type: "physical", name_it: "Sold", priceCents: 100, sold: true, image: "", maxQty: 1 },
  vm: { type: "physical", name_it: "Manual", priceCents: 100, sold: false, image: "", maxQty: 1 },
  mc1: { type: "digital", name_it: "MC", name_en: "MC en", priceCents: 10000, sold: false, image: "x.jpg", maxQty: 6 },
  gc: { type: "digital", name_it: "GC", priceCents: 5000, sold: false, image: "", maxQty: 10 },
};
const ORIGIN = "https://ceramicsdoronina.it";

function setup(over = {}) {
  // The fake enforces Stripe API rules (expires_at window, label/metadata limits, ...) on every call.
  const { client: fake, calls } = makeStripeFake({ catalogue, now: () => 1_000_000_000_000, throwErr: over.throwErr });
  const env = { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_SECRETVALUE", ...over.env };
  const handler = makeHandler({ stripeFactory: () => fake, env, catalogue, soldList: ["vm"], now: () => 1_000_000_000_000 });
  return { calls, handler };
}
const post = (body, o = {}) => ({
  httpMethod: "POST",
  headers: o.headers || { origin: ORIGIN },
  body: typeof body === "string" || body === undefined ? body : JSON.stringify(body),
});
const ship = (p) => p.shipping_options?.[0]?.shipping_rate_data.fixed_amount.amount;

test("computeShippingCents boundaries", () => {
  assert.equal(computeShippingCents(19999), 4000);
  assert.equal(computeShippingCents(20000), 2000);
  assert.equal(computeShippingCents(49999), 2000);
  assert.equal(computeShippingCents(50000), 0);
});

for (const [id, exp] of [["v3", 4000], ["v4", 2000], ["v5", 2000], ["v6", 0]]) {
  test(`shipping via handler ${id} -> ${exp}`, async () => {
    const { handler, calls } = setup();
    const r = await handler(post({ items: [{ id, quantity: 1 }] }));
    assert.equal(r.statusCode, 200);
    assert.equal(ship(calls[0]), exp);
    assert.ok(!calls[0].line_items.some((l) => l.price_data.product_data.name === "Shipping"));
  });
}

test("digital-only cart has no shipping and no address collection", async () => {
  const { handler, calls } = setup();
  const r = await handler(post({ items: [{ id: "mc1", quantity: 2 }, { id: "gc", quantity: 1 }] }));
  assert.equal(r.statusCode, 200);
  assert.equal(calls[0].shipping_options, undefined);
  assert.equal(calls[0].shipping_address_collection, undefined);
});

test("mixed cart: tier on physical subtotal only", async () => {
  const { handler, calls } = setup();
  await handler(post({ items: [{ id: "v1", quantity: 1 }, { id: "mc1", quantity: 6 }] })); // physical 10000, total 70000
  assert.equal(ship(calls[0]), 4000);
  assert.ok(calls[0].shipping_address_collection.allowed_countries.includes("CH"));
});

test("tampered client fields ignored; price from catalogue, eur forced", async () => {
  const { handler, calls } = setup();
  const r = await handler(post({
    items: [{ id: "v1", quantity: 1, unit_amount: 1, price: 1, currency: "usd", requires_shipping: false, name: "x", image: "http://evil" }],
    return_base: "https://evil.example", origin: "https://evil.example",
  }));
  assert.equal(r.statusCode, 200);
  const li = calls[0].line_items[0];
  assert.equal(li.price_data.unit_amount, 10000);
  assert.equal(li.price_data.currency, "eur");
  assert.equal(li.price_data.product_data.name, "Vaso");
  assert.equal(li.price_data.product_data.metadata.item_id, "v1");
  assert.equal(ship(calls[0]), 4000);
  assert.equal(calls[0].success_url, "https://ceramicsdoronina.it/stripe-success.html?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(calls[0].cancel_url, "https://ceramicsdoronina.it/stripe-cancel.html");
});

test("SITE_URL env used, trailing slash stripped", async () => {
  const { handler, calls } = setup({ env: { SITE_URL: "https://shop.example/" } });
  await handler(post({ items: [{ id: "v1", quantity: 1 }] }));
  assert.ok(calls[0].success_url.startsWith("https://shop.example/stripe-success.html"));
});

test("400 table: exact error codes and item_id", async () => {
  const { handler, calls } = setup();
  const bad = [
    [{ items: [{ id: "nope", quantity: 1 }] }, "unknown_item", "nope"],
    [{ items: [{ id: "vs", quantity: 1 }] }, "item_sold", "vs"],
    [{ items: [{ id: "vm", quantity: 1 }] }, "item_sold", "vm"], // sold.json
    [{ items: [{ id: "v1", quantity: 2 }] }, "quantity_too_high", "v1"],
    [{ items: [{ id: "mc1", quantity: 7 }] }, "quantity_too_high", "mc1"],
    [{ items: [{ id: "v1", quantity: 1 }, { id: "v1", quantity: 1 }] }, "quantity_too_high", "v1"], // merged
    [{ items: [{ id: "v1", quantity: 0 }] }, "invalid_quantity", "v1"],
    [{ items: [{ id: "v1", quantity: -1 }] }, "invalid_quantity", "v1"],
    [{ items: [{ id: "v1", quantity: 1.5 }] }, "invalid_quantity", "v1"],
    [{ items: [{ id: "v1", quantity: "1" }] }, "invalid_quantity", "v1"],
    [{ items: [{ id: "../x", quantity: 1 }] }, "invalid_id", undefined],
    [{ items: [{ id: 5, quantity: 1 }] }, "invalid_id", undefined],
    [{ items: "abc" }, "invalid_items", undefined],
    [{ items: [] }, "invalid_items", undefined],
    [{ items: [null] }, "invalid_item", undefined],
    [{ items: Array(31).fill({ id: "gc", quantity: 1 }) }, "invalid_items", undefined],
    [null, "invalid_body", undefined],
    [[], "invalid_body", undefined],
  ];
  for (const [b, code, itemId] of bad) {
    const r = await handler(post(JSON.stringify(b)));
    assert.equal(r.statusCode, 400, JSON.stringify(b)?.slice(0, 60));
    const body = JSON.parse(r.body);
    assert.equal(body.error, code, JSON.stringify(b)?.slice(0, 60));
    assert.equal(body.item_id, itemId, code);
    assert.ok(body.request_id);
    assert.ok(r.headers["Access-Control-Allow-Origin"]);
  }
  for (const raw of ["{not json", "", undefined]) {
    const r = await handler(post(raw));
    assert.equal(r.statusCode, 400);
    assert.equal(JSON.parse(r.body).error, "invalid_json");
    assert.ok(!("item_id" in JSON.parse(r.body)));
  }
  assert.equal(calls.length, 0);
});

test("base64 POST body and 30 distinct items accepted", async () => {
  const { handler, calls } = setup();
  const body = JSON.stringify({ items: [{ id: "v1", quantity: 1 }], locale: "ru" });
  const r = await handler({ httpMethod: "POST", headers: { origin: ORIGIN }, isBase64Encoded: true, body: Buffer.from(body, "utf8").toString("base64") });
  assert.equal(r.statusCode, 200);
  assert.equal(calls[0].locale, "ru");
  const big = {};
  for (let i = 0; i < 30; i++) big["p" + i] = { type: "digital", name_it: "P" + i, priceCents: 5000, sold: false, image: "", maxQty: 1 };
  const items = Object.keys(big).map((id) => ({ id, quantity: 1 }));
  const { calls: c2, client } = (() => { const f = makeStripeFake({ catalogue: big, now: 1_000_000_000_000 }); return { calls: f.calls, client: f.client }; })();
  const h2 = makeHandler({ stripeFactory: () => client, env: { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_x" }, catalogue: big, soldList: [], now: () => 1_000_000_000_000 });
  assert.equal((await h2(post({ items }))).statusCode, 200);
  assert.equal(c2[0].line_items.length, 30);
});

test("origin handling", async () => {
  let r = await setup({ env: { ALLOWED_ORIGINS: "" } }).handler(post({ items: [{ id: "v1", quantity: 1 }] }));
  assert.equal(r.statusCode, 500);
  assert.ok(!r.body.includes("ALLOWED"));
  const { handler } = setup({ env: { ALLOWED_ORIGINS: "https://ceramicsdoronina.it/, https://www.ceramicsdoronina.it" } });
  const body = { items: [{ id: "v1", quantity: 1 }] };
  assert.equal((await handler(post(body, { headers: { origin: "https://evil.example" } }))).statusCode, 403);
  assert.equal((await handler(post(body, { headers: { origin: "https://CeramicsDoronina.it/" } }))).statusCode, 200);
  assert.equal((await handler(post(body, { headers: { origin: "https://www.ceramicsdoronina.it" } }))).statusCode, 200);
  const nowww = setup();
  assert.equal((await nowww.handler(post(body, { headers: { origin: "https://www.ceramicsdoronina.it" } }))).statusCode, 403);
  r = await nowww.handler(post(body, { headers: {} }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.headers["Access-Control-Allow-Origin"], undefined);
});

test("isOriginAllowed / parseAllowedOrigins", () => {
  assert.deepEqual(parseAllowedOrigins("A.com/ ,b.com"), ["a.com", "b.com"]);
  assert.equal(isOriginAllowed("https://x.it/", ["https://x.it"]), true);
  assert.equal(isOriginAllowed("", ["https://x.it"]), false);
  assert.equal(isOriginAllowed("https://x.it", []), false);
});

test("OPTIONS preflight and 405", async () => {
  const { handler } = setup();
  let r = await handler({ httpMethod: "OPTIONS", headers: { origin: ORIGIN } });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers["Access-Control-Allow-Origin"], ORIGIN);
  r = await handler({ httpMethod: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(r.statusCode, 403);
  assert.equal(r.headers["Access-Control-Allow-Origin"], undefined);
  r = await handler({ httpMethod: "GET", headers: { origin: ORIGIN } });
  assert.equal(r.statusCode, 405);
});

test("missing STRIPE_SECRET_KEY -> generic 500", async () => {
  const r = await setup({ env: { STRIPE_SECRET_KEY: "" } }).handler(post({ items: [{ id: "v1", quantity: 1 }] }));
  assert.equal(r.statusCode, 500);
  assert.ok(!r.body.includes("STRIPE"));
});

test("images only absolute https, encoded", async () => {
  const { handler, calls } = setup();
  await handler(post({ items: [{ id: "v1", quantity: 1 }] }));
  assert.deepEqual(calls[0].line_items[0].price_data.product_data.images, ["https://ceramicsdoronina.it/images/catalogue/a%20b.jpg"]);
  // http (localhost dev) never yields images; checked on the pure builder because the fake enforces https URLs
  const local = buildSessionParams({ items: [{ id: "v1", quantity: 1 }], locale: "it", catalogue, siteUrl: "http://localhost:8888" });
  assert.equal(local.params.line_items[0].price_data.product_data.images, undefined);
  const none = setup();
  await none.handler(post({ items: [{ id: "v3", quantity: 1 }] }));
  assert.equal("images" in none.calls[0].line_items[0].price_data.product_data, false);
});

test("Stripe failure -> 502 with generic body, no secrets in logs", async () => {
  const logs = [];
  const orig = { e: console.error, i: console.info, w: console.warn };
  console.error = console.info = console.warn = (m) => logs.push(String(m));
  try {
    const err = Object.assign(new Error("Invalid URL sk_test_SECRETVALUE leaked"), { type: "StripeInvalidRequestError", code: "url_invalid", statusCode: 400, requestId: "req_1" });
    const r = await setup({ throwErr: err }).handler(post({ items: [{ id: "v1", quantity: 1 }] }));
    assert.equal(r.statusCode, 502);
    assert.ok(!r.body.includes("Invalid URL") && !r.body.includes("sk_"));
    assert.ok(r.headers["x-request-id"]);
    assert.ok(logs.some((l) => l.includes("stripe_error") && l.includes("url_invalid")));
    assert.ok(!logs.join("\n").includes("SECRETVALUE"));
  } finally {
    Object.assign(console, { error: orig.e, info: orig.i, warn: orig.w });
  }
});

test("session params: expires_at, locale, label, metadata, flags", async () => {
  for (const [loc, label] of [["it", "Note per la consegna / regalo"], ["en", "Delivery / gift note"], ["ru", "Примечание к доставке / подарку"]]) {
    const { handler, calls } = setup();
    const r = await handler(post({ items: [{ id: "v1", quantity: 1 }, { id: "mc1", quantity: 1 }], locale: loc }));
    const p = calls[0];
    assert.equal(p.locale, loc);
    assert.equal(p.custom_fields[0].label.custom, label);
    assert.equal(p.expires_at, 1_000_000_000 + 1800 + 60);
    assert.equal(p.metadata.item_ids, "v1,mc1");
    assert.equal(p.mode, "payment");
    assert.equal(p.billing_address_collection, "required");
    assert.deepEqual(p.phone_number_collection, { enabled: true });
    assert.equal(p.allow_promotion_codes, true);
    assert.deepEqual(JSON.parse(r.body).session_id, "cs_1");
    assert.equal(JSON.parse(r.body).url, "https://checkout.stripe.com/c/1");
  }
  const { handler, calls } = setup();
  await handler(post({ items: [{ id: "v1", quantity: 1 }], locale: "xx" }));
  assert.equal(calls[0].locale, undefined);
  assert.equal(calls[0].line_items[0].price_data.product_data.name, "Vaso");
});

test("locale picks product name", () => {
  const li = buildLineItems([{ id: "v1", quantity: 1 }], catalogue, "https://s.it", "en");
  assert.equal(li[0].price_data.product_data.name, "Vase");
  assert.throws(() => validateBody({ items: [{ id: "zz", quantity: 1 }] }, catalogue, []), { name: "ValidationError" });
});

// ---- R-006 / R-013 additions ----

function captureLogs() {
  const logs = [];
  const orig = { e: console.error, i: console.info, w: console.warn };
  console.error = (m) => logs.push(["error", String(m)]);
  console.info = (m) => logs.push(["info", String(m)]);
  console.warn = (m) => logs.push(["warn", String(m)]);
  return { logs, restore: () => Object.assign(console, { error: orig.e, info: orig.i, warn: orig.w }) };
}

test("OPTIONS without origin -> 400, no CORS", async () => {
  const r = await setup().handler({ httpMethod: "OPTIONS", headers: {} });
  assert.equal(r.statusCode, 400);
  assert.equal(r.headers["Access-Control-Allow-Origin"], undefined);
});

test("shipping display_name is localised", async () => {
  for (const [loc, name] of [["it", "Spedizione"], ["en", "Shipping"], ["ru", "Доставка"], [undefined, "Spedizione"]]) {
    const { handler, calls } = setup();
    await handler(post({ items: [{ id: "v1", quantity: 1 }], locale: loc }));
    assert.equal(calls[0].shipping_options[0].shipping_rate_data.display_name, name);
  }
  assert.deepEqual(SHIPPING.displayNames, { it: "Spedizione", en: "Shipping", ru: "Доставка" });
});

test("buildSessionParams called directly: pure, validates locale via validateBody", () => {
  const { items, locale } = validateBody({ items: [{ id: "v1", quantity: 1 }], locale: "xx" }, catalogue, []);
  assert.equal(locale, null);
  const out = buildSessionParams({ items, locale: "en", catalogue, siteUrl: "https://s.it", now: () => 5_000_000 });
  assert.equal(out.params.locale, "en");
  assert.equal(out.params.expires_at, 5000 + 1860);
  assert.equal(out.shippingCents, 4000);
  assert.equal(out.subtotalCents, 10000);
  assert.equal(out.itemIds, "v1");
  assertStripeRules(out.params, { now: 5_000_000, catalogue });
});

test("metadata item_ids never cut mid-id: 20 long ids", async () => {
  const cat = {};
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const id = ("long-id-" + String(i).padStart(2, "0") + "-").padEnd(40, "x");
    ids.push(id);
    cat[id] = { type: "digital", name_it: "N", priceCents: 5000, sold: false, image: "", maxQty: 1 };
  }
  const items = ids.map((id) => ({ id, quantity: 1 }));
  const out = buildSessionParams({ items, locale: "it", catalogue: cat, siteUrl: "https://s.it" });
  const v = out.params.metadata.item_ids;
  assert.ok(v.length <= 500);
  assert.equal(out.itemIdsTruncated, true);
  const kept = v.split(",");
  assert.equal(kept.length, 12); // 12*40 + 11 commas = 491; a 13th id would need 532
  for (const k of kept) assert.ok(ids.includes(k), "cut id: " + k);
  assert.deepEqual(kept, ids.slice(0, 12));
  // short ids: nothing dropped
  const short = buildSessionParams({ items: [{ id: "v1", quantity: 1 }], locale: "it", catalogue, siteUrl: "https://s.it" });
  assert.equal(short.itemIdsTruncated, false);
  // handler logs a warning
  const cap = captureLogs();
  try {
    const f = makeStripeFake({ catalogue: cat, now: 1_000_000_000_000 });
    const h = makeHandler({ stripeFactory: () => f.client, env: { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_x" }, catalogue: cat, soldList: [], now: () => 1_000_000_000_000 });
    assert.equal((await h(post({ items }))).statusCode, 200);
  } finally {
    cap.restore();
  }
  assert.ok(cap.logs.some(([lvl, l]) => lvl === "warn" && l.includes("metadata_item_ids_truncated")));
});

test("SITE_URL validation: https required, localhost http only, else config_invalid 500", async () => {
  assert.equal(normalizeSiteUrl(undefined), "https://ceramicsdoronina.it");
  assert.equal(normalizeSiteUrl("https://x.example/"), "https://x.example");
  assert.equal(normalizeSiteUrl("http://localhost:8888"), "http://localhost:8888");
  for (const bad of ["http://insecure.example", "not a url", "ftp://x.example", "https://x.example/?a=1", "javascript:alert(1)"]) {
    assert.equal(normalizeSiteUrl(bad), null, bad);
    const cap = captureLogs();
    let r;
    try {
      const { handler, calls } = setup({ env: { SITE_URL: bad } });
      r = await handler(post({ items: [{ id: "v1", quantity: 1 }] }));
      assert.equal(calls.length, 0);
    } finally {
      cap.restore();
    }
    assert.equal(r.statusCode, 500, bad);
    assert.equal(JSON.parse(r.body).error, "server_error");
    assert.ok(!r.body.includes("SITE_URL"));
    assert.ok(cap.logs.some(([lvl, l]) => lvl === "error" && l.includes("config_invalid")));
  }
});

test("logging: origin_rejected truncated, config_missing error, item_id in validation_failed, 405 and missing-origin info, stripe_error param/message redacted", async () => {
  const cap = captureLogs();
  try {
    const { handler } = setup();
    const long = "https://evil.example/" + "a".repeat(500);
    await handler(post({ items: [{ id: "v1", quantity: 1 }] }, { headers: { origin: long } }));
    await handler(post({ items: [{ id: "nope", quantity: 1 }] }));
    await handler({ httpMethod: "GET", headers: { origin: ORIGIN } });
    await handler({ httpMethod: "POST", headers: {}, body: "{}" });
    await setup({ env: { ALLOWED_ORIGINS: "" } }).handler(post({}));
    await setup({ env: { STRIPE_SECRET_KEY: "" } }).handler(post({ items: [{ id: "v1", quantity: 1 }] }));
    const err = Object.assign(new Error("Bad param whsec_ABCDEF123 here"), { type: "StripeInvalidRequestError", code: "c", param: "line_items[0]", statusCode: 400 });
    await setup({ throwErr: err }).handler(post({ items: [{ id: "v1", quantity: 1 }] }));
  } finally {
    cap.restore();
  }
  const find = (ev) => cap.logs.filter(([, l]) => l.includes(`"event":"${ev}"`)).map(([lvl, l]) => [lvl, JSON.parse(l)]);
  const [[lv1, rej]] = find("origin_rejected");
  assert.equal(lv1, "warn");
  assert.ok(rej.origin.length <= 200 && rej.origin.startsWith("https://evil.example/"));
  assert.equal(find("validation_failed")[0][1].item_id, "nope");
  assert.equal(find("method_not_allowed")[0][0], "info");
  assert.equal(find("origin_missing")[0][0], "info");
  const cm = find("config_missing");
  assert.equal(cm.length, 2);
  assert.ok(cm.every(([lvl]) => lvl === "error"));
  const se = find("stripe_error")[0][1];
  assert.equal(se.param, "line_items[0]");
  assert.ok(se.message.includes("[redacted]") && !se.message.includes("ABCDEF123"));
});

test("unexpected_error logs truncated message and stack, response stays generic", async () => {
  const cap = captureLogs();
  let r;
  try {
    const bomb = { ...catalogue, v1: { ...catalogue.v1, priceCents: undefined, get name_it() { throw new Error("boom sk_live_ZZZ " + "x".repeat(400)); } } };
    const h = makeHandler({ stripeFactory: () => makeStripeFake().client, env: { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_x" }, catalogue: bomb, soldList: [] });
    r = await h(post({ items: [{ id: "v1", quantity: 1 }] }));
  } finally {
    cap.restore();
  }
  assert.equal(r.statusCode, 500);
  assert.equal(JSON.parse(r.body).error, "server_error");
  const line = cap.logs.find(([, l]) => l.includes("unexpected_error"));
  assert.ok(line);
  const o = JSON.parse(line[1]);
  assert.ok(o.message.length <= 200 && !o.message.includes("ZZZ"));
  assert.ok(typeof o.stack === "string" && o.stack.length <= 600);
});

test("live catalogue: sheet-sold item is rejected, sheet price is what Stripe is charged", async () => {
  const src = require("../functions/_catalogue-source.js");
  src._reset();
  const HEAD = "id,type,name_it,name_en,name_ru,price,image,maxQty,sold";
  const csv = [HEAD, 'va,physical,Uno,One,Один,"120,50",images/a.jpg,1,', "vb,physical,Due,Two,Два,80,,1,TRUE", "vc,digital,Tre,Three,Три,10,,5,"].join("\n");
  const env = { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_x", CATALOGUE_CSV_URL: "https://docs.google.com/spreadsheets/d/e/T/pub?output=csv" };
  const fetchImpl = async () => new Response(csv, { status: 200 });
  const live = { va: { type: "physical", priceCents: 12050, maxQty: 1, sold: false, name_it: "Uno", image: "images/a.jpg" }, vb: { type: "physical", priceCents: 8000, maxQty: 1, sold: false, name_it: "Due", image: "" }, vc: { type: "digital", priceCents: 1000, maxQty: 5, sold: false, name_it: "Tre", image: "" } };
  const f = makeStripeFake({ catalogue: live, now: () => 1_000_000_000_000 });
  const h = makeHandler({ stripeFactory: () => f.client, env, fetchImpl, now: () => 1_000_000_000_000 });
  const sold = await h(post({ items: [{ id: "vb", quantity: 1 }] }));
  assert.equal(sold.statusCode, 400);
  assert.deepEqual([JSON.parse(sold.body).error, JSON.parse(sold.body).item_id], ["item_sold", "vb"]);
  const over = await h(post({ items: [{ id: "vc", quantity: 6 }] }));
  assert.equal(JSON.parse(over.body).error, "quantity_too_high");
  const unknown = await h(post({ items: [{ id: "v1", quantity: 1 }] })); // only in the snapshot, not in the sheet
  assert.equal(JSON.parse(unknown.body).error, "unknown_item");
  const ok = await h(post({ items: [{ id: "va", quantity: 1 }] }));
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(f.calls[0].line_items[0].price_data.unit_amount, 12050);
  // a piece marked sold locally (just paid) is rejected before the published CSV catches up
  src.markSoldLocal(["va"]);
  const again = await h(post({ items: [{ id: "va", quantity: 1 }] }));
  assert.equal(JSON.parse(again.body).error, "item_sold");
  src._reset();
});

test("live catalogue: sheet unreachable falls back to the snapshot (checkout keeps working)", async () => {
  const src = require("../functions/_catalogue-source.js");
  src._reset();
  const env = { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_x", CATALOGUE_CSV_URL: "https://docs.google.com/spreadsheets/d/e/T/pub?output=csv" };
  const snap = require("../functions/catalogue.json");
  const f = makeStripeFake({ catalogue: snap, now: () => 1_000_000_000_000 });
  const orig = console.warn;
  console.warn = () => {};
  try {
    const h = makeHandler({ stripeFactory: () => f.client, env, fetchImpl: async () => { throw new Error("down"); }, now: () => 1_000_000_000_000 });
    const r = await h(post({ items: [{ id: "gc-50", quantity: 1 }] }));
    assert.equal(r.statusCode, 200, r.body);
  } finally {
    console.warn = orig;
    src._reset();
  }
});
