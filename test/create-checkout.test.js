const test = require("node:test");
const assert = require("node:assert");
const { makeHandler, isOriginAllowed, parseAllowedOrigins, computeShippingCents, validateBody, buildLineItems } = require("../functions/create-checkout.js");

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
  const calls = [];
  const fake = { checkout: { sessions: { create: async (p) => { calls.push(p); if (over.throwErr) throw over.throwErr; return { id: "cs_1", url: "https://checkout.stripe.com/c/1" }; } } } };
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
  assert.equal(li.price_data.product_data.metadata.vase_id, "v1");
  assert.equal(ship(calls[0]), 4000);
  assert.equal(calls[0].success_url, "https://ceramicsdoronina.it/stripe-success.html?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(calls[0].cancel_url, "https://ceramicsdoronina.it/stripe-cancel.html");
});

test("SITE_URL env used, trailing slash stripped", async () => {
  const { handler, calls } = setup({ env: { SITE_URL: "https://shop.example/" } });
  await handler(post({ items: [{ id: "v1", quantity: 1 }] }));
  assert.ok(calls[0].success_url.startsWith("https://shop.example/stripe-success.html"));
});

test("400 cases", async () => {
  const { handler, calls } = setup();
  const bad = [
    { items: [{ id: "nope", quantity: 1 }] },
    { items: [{ id: "vs", quantity: 1 }] },
    { items: [{ id: "vm", quantity: 1 }] }, // sold.json
    { items: [{ id: "v1", quantity: 2 }] },
    { items: [{ id: "mc1", quantity: 7 }] },
    { items: [{ id: "v1", quantity: 1 }, { id: "v1", quantity: 1 }] }, // merged -> 2 > maxQty
    { items: [{ id: "v1", quantity: 0 }] },
    { items: [{ id: "v1", quantity: -1 }] },
    { items: [{ id: "v1", quantity: 1.5 }] },
    { items: [{ id: "v1", quantity: "1" }] },
    { items: [{ id: "../x", quantity: 1 }] },
    { items: "abc" },
    { items: [] },
    { items: [null] },
    { items: Array(21).fill({ id: "gc", quantity: 1 }) },
    null,
    [],
  ];
  for (const b of bad) {
    const r = await handler(post(JSON.stringify(b)));
    assert.equal(r.statusCode, 400, JSON.stringify(b)?.slice(0, 60));
    assert.ok(r.headers["Access-Control-Allow-Origin"]);
  }
  for (const raw of ["{not json", "", undefined]) {
    assert.equal((await handler(post(raw))).statusCode, 400);
  }
  assert.equal(calls.length, 0);
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
  const http = setup({ env: { SITE_URL: "http://insecure.example" } });
  await http.handler(post({ items: [{ id: "v1", quantity: 1 }] }));
  assert.equal(http.calls[0].line_items[0].price_data.product_data.images, undefined);
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
