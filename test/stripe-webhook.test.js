const test = require("node:test");
const assert = require("node:assert");
const { makeHandler, buildOrderSummary, notifyOwner } = require("../functions/stripe-webhook.js");

const session = {
  id: "cs_1", amount_total: 12345, currency: "eur", metadata: { item_ids: "v1,mc1" },
  customer_details: { email: "a@b.it", name: "Ann", phone: "+39" },
  shipping_details: { name: "Ann", address: { line1: "Via 1", city: "Genova", postal_code: "16100", country: "IT" } },
  custom_fields: [{ key: "note", text: { value: "gift" } }],
};
const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" };
const fake = (evt) => ({
  webhooks: { constructEvent: (raw, sig, secret) => { if (sig !== "good" || secret !== "whsec_x") throw new Error("bad"); return evt; } },
  checkout: { sessions: { listLineItems: async () => ({ data: [{ description: "Vaso", quantity: 1 }] }) } },
});
const req = (o = {}) => ({ httpMethod: "POST", headers: { "stripe-signature": "good" }, body: "{}", ...o });

test("buildOrderSummary", () => {
  const s = buildOrderSummary(session, [{ description: "Vaso", quantity: 1 }], "v1,mc1");
  for (const part of ["cs_1", "a@b.it", "Via 1", "1 x Vaso", "v1,mc1", "123.45 EUR", "gift"]) assert.ok(s.includes(part), part);
});

test("405, bad signature 400", async () => {
  const h = makeHandler({ stripeFactory: () => fake({}), env, notify: async () => {} });
  assert.equal((await h({ httpMethod: "GET", headers: {} })).statusCode, 405);
  assert.equal((await h(req({ headers: { "stripe-signature": "bad" } }))).statusCode, 400);
});

test("completed event notifies owner; base64 body; other events ignored", async () => {
  const sent = [];
  const evt = { id: "evt_1", type: "checkout.session.completed", data: { object: session } };
  const h = makeHandler({ stripeFactory: () => fake(evt), env, notify: async (s) => sent.push(s) });
  const r = await h(req({ isBase64Encoded: true, body: Buffer.from("{}").toString("base64") }));
  assert.equal(r.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("cs_1"));
  const h2 = makeHandler({ stripeFactory: () => fake({ id: "e", type: "other", data: { object: {} } }), env, notify: async (s) => sent.push(s) });
  assert.equal((await h2(req())).statusCode, 200);
  assert.equal(sent.length, 1);
});

test("notify failure -> 500 so Stripe retries; notifyOwner posts when URL set", async () => {
  const evt = { id: "evt_1", type: "checkout.session.completed", data: { object: session } };
  const h = makeHandler({ stripeFactory: () => fake(evt), env, notify: async () => { throw new Error("x"); } });
  assert.equal((await h(req())).statusCode, 500);
  const posts = [];
  await notifyOwner("hello", { OWNER_NOTIFY_WEBHOOK_URL: "https://hook.example/x" }, async (u, o) => { posts.push([u, o]); return { ok: true }; });
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0][1].body).summary, "hello");
});
