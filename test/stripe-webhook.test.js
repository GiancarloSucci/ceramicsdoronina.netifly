const test = require("node:test");
const assert = require("node:assert");
const { makeHandler, buildOrderSummary, notifyOwner, clean } = require("../functions/stripe-webhook.js");

const session = {
  id: "cs_1", amount_total: 12345, currency: "eur", payment_status: "paid", metadata: { item_ids: "v1,mc1" },
  customer_details: { email: "a@b.it", name: "Ann", phone: "+39", address: { line1: "Via Fatturazione 9", city: "Roma", postal_code: "00100", country: "IT" } },
  shipping_details: { name: "Ann", address: { line1: "Via 1", city: "Genova", postal_code: "16100", country: "IT" } },
  custom_fields: [{ key: "note", text: { value: "gift" } }],
};
const digital = { ...session, id: "cs_d", shipping_details: undefined, customer_details: { email: "d@b.it", name: "Dan", address: { country: "FR" } } };
const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" };
const evtOf = (type, obj = session) => ({ id: "evt_1", type, data: { object: obj } });

// constructEvent asserts the EXACT raw string it is given (signature verification depends on it)
const fake = (evt, { expectRaw, listFails } = {}) => ({
  webhooks: {
    constructEvent: (raw, sig, secret) => {
      if (expectRaw !== undefined) assert.strictEqual(raw, expectRaw);
      if (sig !== "good" || secret !== "whsec_x") throw Object.assign(new Error("No signatures found matching"), { type: "StripeSignatureVerificationError" });
      return evt;
    },
  },
  checkout: {
    sessions: {
      listLineItems: async () => {
        if (listFails) throw new Error("boom");
        return { data: [{ description: "Vaso", quantity: 1 }] };
      },
    },
  },
});
const req = (o = {}) => ({ httpMethod: "POST", headers: { "stripe-signature": "good" }, body: "{}", ...o });

function capture() {
  const logs = [];
  const orig = { e: console.error, i: console.info, w: console.warn };
  console.error = (m) => logs.push(["error", String(m)]);
  console.info = (m) => logs.push(["info", String(m)]);
  console.warn = (m) => logs.push(["warn", String(m)]);
  return { logs, restore: () => Object.assign(console, { error: orig.e, info: orig.i, warn: orig.w }) };
}
const parsed = (cap, ev) => cap.logs.filter(([, l]) => l.includes(`"event":"${ev}"`)).map(([lvl, l]) => [lvl, JSON.parse(l)]);

test("buildOrderSummary: paid physical order", () => {
  const s = buildOrderSummary(session, [{ description: "Vaso", quantity: 1 }], "v1,mc1");
  for (const part of ["New paid order", "cs_1", "a@b.it", "Ship to: Ann, Via 1, 16100 Genova, IT", "Billing: Ann, Via Fatturazione 9", "1 x Vaso", "v1,mc1", "123.45 EUR", "gift"]) assert.ok(s.includes(part), part);
  assert.ok(!s.includes("Shipping: none"));
});

test("digital order: says no shipping address, no 'Ship to', billing separate", () => {
  const s = buildOrderSummary(digital, [], "mc1");
  assert.ok(s.includes("Shipping: none (digital order)"));
  assert.ok(!s.includes("Ship to"));
  assert.ok(s.includes("Billing: Dan, FR"));
});

test("405, bad signature 400 (logs type/message), header case variants", async () => {
  const cap = capture();
  try {
    const h = makeHandler({ stripeFactory: () => fake(evtOf("other")), env, notify: async () => {} });
    assert.equal((await h({ httpMethod: "GET", headers: {} })).statusCode, 405);
    assert.equal((await h(req({ headers: { "stripe-signature": "bad" } }))).statusCode, 400);
    assert.equal((await h(req({ headers: { "Stripe-Signature": "good" } }))).statusCode, 200);
    assert.equal((await h(req({ headers: { "STRIPE-SIGNATURE": "good" } }))).statusCode, 200);
  } finally {
    cap.restore();
  }
  const [[, bad]] = parsed(cap, "webhook_bad_signature");
  assert.equal(bad.type, "StripeSignatureVerificationError");
  assert.ok(bad.message.includes("No signatures"));
  assert.ok(bad.request_id);
});

test("signature check receives the exact raw body: plain and base64, non-ASCII", async () => {
  const body = '{"id":"evt_1","name":"Zoë €  Ωmega ☕","n":1}';
  const sent = [];
  const evt = evtOf("checkout.session.completed");
  for (const mk of [
    () => req({ body }),
    () => req({ isBase64Encoded: true, body: Buffer.from(body, "utf8").toString("base64") }),
  ]) {
    const h = makeHandler({ stripeFactory: () => fake(evt, { expectRaw: body }), env, notify: async (s) => sent.push(s) });
    assert.equal((await h(mk())).statusCode, 200);
  }
  assert.equal(sent.length, 2);
});

test("completed event notifies owner; other events ignored", async () => {
  const sent = [];
  const h = makeHandler({ stripeFactory: () => fake(evtOf("checkout.session.completed")), env, notify: async (s) => sent.push(s) });
  const r = await h(req());
  assert.equal(r.statusCode, 200);
  assert.ok(r.headers["x-request-id"]);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith("New paid order") && sent[0].includes("cs_1"));
  const h2 = makeHandler({ stripeFactory: () => fake({ id: "e", type: "other", data: { object: {} } }), env, notify: async (s) => sent.push(s) });
  assert.equal((await h2(req())).statusCode, 200);
  assert.equal(sent.length, 1);
});

test("unpaid completed -> AWAITING PAYMENT; async succeeded -> paid; async failed -> failure", async () => {
  const run = async (type, obj) => {
    const sent = [];
    const h = makeHandler({ stripeFactory: () => fake(evtOf(type, obj)), env, notify: async (s) => sent.push(s) });
    assert.equal((await h(req())).statusCode, 200);
    return sent[0];
  };
  const unpaid = { ...session, payment_status: "unpaid" };
  let s = await run("checkout.session.completed", unpaid);
  assert.ok(s.startsWith("AWAITING PAYMENT, do not ship") && !s.includes("New paid order"));
  s = await run("checkout.session.async_payment_succeeded", session);
  assert.ok(s.startsWith("New paid order"));
  s = await run("checkout.session.async_payment_succeeded", unpaid);
  assert.ok(s.startsWith("New paid order"), "async_payment_succeeded event itself confirms payment");
  s = await run("checkout.session.async_payment_failed", unpaid);
  assert.ok(s.startsWith("PAYMENT FAILED, do not ship"));
  s = await run("checkout.session.completed", { ...session, payment_status: "no_payment_required", amount_total: 0 });
  assert.ok(s.startsWith("New paid order"), "100% promo code order is not blocked");
});

test("missing STRIPE_WEBHOOK_SECRET or key -> 500; stripeFactory throwing -> generic 500", async () => {
  const cap = capture();
  try {
    for (const e of [{ STRIPE_SECRET_KEY: "sk_test_x" }, { STRIPE_WEBHOOK_SECRET: "whsec_x" }]) {
      const r = await makeHandler({ stripeFactory: () => fake({}), env: e, notify: async () => {} })(req());
      assert.equal(r.statusCode, 500);
      assert.ok(!r.body.includes("STRIPE") && !r.body.includes("whsec"));
    }
    const r = await makeHandler({ stripeFactory: () => { throw new Error("Cannot find module 'stripe' sk_test_LEAK"); }, env, notify: async () => {} })(req());
    assert.equal(r.statusCode, 500);
    assert.equal(JSON.parse(r.body).error, "server_error");
  } finally {
    cap.restore();
  }
  const [[lvl, u]] = parsed(cap, "unexpected_error");
  assert.equal(lvl, "error");
  assert.ok(!JSON.stringify(u).includes("LEAK"));
  assert.ok(parsed(cap, "config_missing").every(([l]) => l === "error"));
});

test("listLineItems failure still notifies and returns 200", async () => {
  const sent = [];
  const cap = capture();
  let r;
  try {
    const h = makeHandler({ stripeFactory: () => fake(evtOf("checkout.session.completed"), { listFails: true }), env, notify: async (s) => sent.push(s) });
    r = await h(req());
  } finally {
    cap.restore();
  }
  assert.equal(r.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("v1,mc1"));
  assert.equal(parsed(cap, "list_line_items_failed").length, 1);
});

test("notify failure -> 500 so Stripe retries; log has name+truncated redacted message", async () => {
  const cap = capture();
  let r;
  try {
    const h = makeHandler({ stripeFactory: () => fake(evtOf("checkout.session.completed")), env, notify: async () => { throw new Error("x sk_live_ABC " + "y".repeat(500)); } });
    r = await h(req());
  } finally {
    cap.restore();
  }
  assert.equal(r.statusCode, 500);
  const [[, o]] = parsed(cap, "webhook_processing_failed");
  assert.equal(o.name, "Error");
  assert.ok(o.message.length <= 200 && !o.message.includes("sk_live_ABC"));
  assert.equal(o.session_id, "cs_1");
  assert.ok(o.request_id);
});

test("notifyOwner: non-ok status throws; posts with timeout signal and redirect error", async () => {
  await assert.rejects(
    notifyOwner("hello", { OWNER_NOTIFY_WEBHOOK_URL: "https://hook.example/x" }, async () => ({ ok: false, status: 503 })),
    /notify_webhook_status_503/
  );
  const posts = [];
  const delivered = await notifyOwner("hello", { OWNER_NOTIFY_WEBHOOK_URL: "https://hook.example/x" }, async (u, o) => { posts.push([u, o]); return { ok: true }; }, "rid");
  assert.equal(delivered, true);
  assert.equal(JSON.parse(posts[0][1].body).summary, "hello");
  assert.equal(posts[0][1].redirect, "error");
  assert.ok(posts[0][1].signal instanceof AbortSignal);
});

test("notifyOwner: non-https URL is skipped with notify_config_invalid; no fetch", async () => {
  const cap = capture();
  let called = false;
  let delivered;
  try {
    delivered = await notifyOwner("hello", { OWNER_NOTIFY_WEBHOOK_URL: "http://hook.example/x" }, async () => { called = true; return { ok: true }; }, "rid");
  } finally {
    cap.restore();
  }
  assert.equal(delivered, false);
  assert.equal(called, false);
  assert.equal(parsed(cap, "notify_config_invalid").length, 1);
});

test("notifyOwner: fetch failure rethrown without the URL", async () => {
  const err = Object.assign(new TypeError("fetch failed https://hook.example/SECRETPATH"), { cause: { code: "ECONNREFUSED" } });
  let thrown;
  try {
    await notifyOwner("hello", { OWNER_NOTIFY_WEBHOOK_URL: "https://hook.example/SECRETPATH" }, async () => { throw err; });
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown.name, "NotifyFetchError");
  assert.equal(thrown.code, "ECONNREFUSED");
  assert.ok(!String(thrown.message).includes("SECRETPATH"));
  // through the handler: log has name/code only
  const cap = capture();
  try {
    const h = makeHandler({
      stripeFactory: () => fake(evtOf("checkout.session.completed")),
      env: { ...env, OWNER_NOTIFY_WEBHOOK_URL: "https://hook.example/SECRETPATH" },
      notify: (s, e) => notifyOwner(s, e, async () => { throw err; }),
    });
    assert.equal((await h(req())).statusCode, 500);
  } finally {
    cap.restore();
  }
  assert.ok(!cap.logs.map((l) => l[1]).join("\n").includes("SECRETPATH"));
  const [[, o]] = parsed(cap, "webhook_processing_failed");
  assert.equal(o.name, "NotifyFetchError");
  assert.equal(o.code, "ECONNREFUSED");
  assert.equal(o.message, undefined);
});

test("no OWNER_NOTIFY_WEBHOOK_URL: owner_notify_not_configured warn with ids, no PII; PII-free line kept", async () => {
  const cap = capture();
  try {
    const h = makeHandler({ stripeFactory: () => fake(evtOf("checkout.session.completed")), env, notify: async () => {} });
    assert.equal((await h(req())).statusCode, 200);
    await makeHandler({ stripeFactory: () => fake(evtOf("checkout.session.completed", digital)), env })(req()); // real notifyOwner: log line only
  } finally {
    cap.restore();
  }
  const ev = parsed(cap, "owner_notify_not_configured");
  assert.equal(ev.length, 2);
  const [lvl, o] = ev[0];
  assert.equal(lvl, "warn");
  assert.deepEqual(
    { session_id: o.session_id, event_id: o.event_id, item_ids: o.item_ids, amount_total: o.amount_total, currency: o.currency, payment_status: o.payment_status, country: o.country },
    { session_id: "cs_1", event_id: "evt_1", item_ids: "v1,mc1", amount_total: 12345, currency: "eur", payment_status: "paid", country: "IT" }
  );
  assert.equal(ev[1][1].country, "FR");
  const all = cap.logs.map((l) => l[1]).join("\n");
  for (const pii of ["Ann", "a@b.it", "+39", "Via 1", "Genova", "gift", "Dan", "d@b.it"]) assert.ok(!all.includes(pii), "PII leaked: " + pii);
  assert.ok(parsed(cap, "owner_notification").length >= 1);
  assert.ok(parsed(cap, "order_completed").length >= 1);
});

test("with a valid OWNER_NOTIFY_WEBHOOK_URL there is no not-configured warning", async () => {
  const cap = capture();
  try {
    const h = makeHandler({ stripeFactory: () => fake(evtOf("checkout.session.completed")), env: { ...env, OWNER_NOTIFY_WEBHOOK_URL: "https://hook.example/x" }, notify: async () => true });
    assert.equal((await h(req())).statusCode, 200);
  } finally {
    cap.restore();
  }
  assert.equal(parsed(cap, "owner_notify_not_configured").length, 0);
});

test("every webhook log line carries request_id (header or generated)", async () => {
  const cap = capture();
  try {
    const h = makeHandler({ stripeFactory: () => fake(evtOf("checkout.session.completed")), env });
    await h(req({ headers: { "stripe-signature": "good", "x-nf-request-id": "nf-123" } }));
    await h(req({ headers: { "stripe-signature": "bad" } }));
  } finally {
    cap.restore();
  }
  assert.ok(cap.logs.length >= 4);
  for (const [, l] of cap.logs) assert.ok(JSON.parse(l).request_id, l);
  assert.ok(cap.logs.some(([, l]) => JSON.parse(l).request_id === "nf-123"));
});

test("customer text is neutralised and capped", () => {
  assert.equal(clean("<!channel> <@U123> <http://x.io|click> & @here"), "&lt;!channel&gt; &lt;@U123&gt; &lt;http://x.io|click&gt; &amp; @​here");
  assert.equal(clean("@channel hi"), "@​channel hi");
  assert.equal(clean("a@b.it"), "a@b.it");
  assert.equal(clean("x".repeat(300)).length, 200);
  assert.equal(clean("x".repeat(900), 500).length, 500);
  const evil = {
    ...session,
    customer_details: { name: "<!channel>" + "n".repeat(300), email: "<http://evil|x>@a.it", phone: "p".repeat(300), address: { line1: "<@U1>", country: "IT" } },
    shipping_details: { name: "@everyone", address: { line1: "L".repeat(400), city: "<!here>", country: "IT" } },
    custom_fields: [{ key: "note", text: { value: "<!channel> " + "z".repeat(900) } }],
  };
  const s = buildOrderSummary(evil, [], "v1");
  assert.ok(!s.includes("<!") && !s.includes("<http") && !s.includes("<@"));
  const cust = s.split("\n").find((l) => l.startsWith("Customer:"));
  assert.ok(cust.length < "Customer: ".length + 200 + 4 * 6 /* escapes */ + 200 + 200 + 20 + 200);
  assert.ok(!s.includes("n".repeat(201)) && !s.includes("p".repeat(201)) && !s.includes("L".repeat(201)));
  const note = s.split("\n").find((l) => l.startsWith("Note:"));
  assert.ok(note.length <= "Note: ".length + 500 + 16);
  assert.ok(s.includes("@​everyone"));
});

// ---- marking unique pieces as sold ---------------------------------------

const catSrc = require("../functions/_catalogue-source.js");
const CAT = {
  v1: { type: "physical", maxQty: 1, priceCents: 100, sold: false },
  v3: { type: "physical", maxQty: 1, priceCents: 100, sold: false },
  vm: { type: "physical", maxQty: 2, priceCents: 100, sold: false }, // multi-piece physical: not unique
  mc1: { type: "digital", maxQty: 6, priceCents: 100, sold: false },
  "gc-50": { type: "digital", maxQty: 10, priceCents: 100, sold: false },
  dg: { type: "digital", maxQty: 1, priceCents: 100, sold: false }, // digital one-off: not a physical piece
};
const getCatalogue = async () => ({ items: CAT, source: "sheet" });
const SECRET = "S3CRET-VALUE-XYZ";
const wenv = { ...env, CATALOGUE_WRITE_URL: "https://script.google.com/macros/s/AKFY123/exec", CATALOGUE_WRITE_SECRET: SECRET };
const sess = (ids, over = {}) => ({ ...session, metadata: { item_ids: ids }, ...over });

async function run(type, obj, { markSold, e = wenv } = {}) {
  const sent = [];
  const marked = [];
  const local = [];
  const cap = capture();
  let r;
  try {
    const h = makeHandler({
      stripeFactory: () => fake(evtOf(type, obj)),
      env: e,
      notify: async (s) => sent.push(s),
      getCatalogue,
      markSold: markSold || (async (ids) => { marked.push(ids); return { ok: true, marked: ids }; }),
      markSoldLocal: (ids) => local.push(ids),
    });
    r = await h(req());
  } finally {
    cap.restore();
  }
  return { r, sent, marked, local, cap };
}

test("paid order marks only unique physical pieces, in order, deduped", async () => {
  const { r, sent, marked, local, cap } = await run("checkout.session.completed", sess("v3,mc1,v1,gc-50,vm,dg,v3,unknown"));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(marked, [["v3", "v1"]]);
  assert.deepEqual(local, [["v3", "v1"]]);
  assert.ok(!sent[0].includes("ACTION"));
  const [[lvl, o]] = parsed(cap, "sold_marked");
  assert.equal(lvl, "info");
  assert.deepEqual([o.ids, o.session_id, o.event_id], [["v3", "v1"], "cs_1", "evt_1"]);
});

test("async_payment_succeeded marks too; unpaid completed / async failed do not", async () => {
  let x = await run("checkout.session.async_payment_succeeded", sess("v3", { payment_status: "unpaid" }));
  assert.deepEqual(x.marked, [["v3"]]);
  for (const [type, obj] of [["checkout.session.completed", sess("v3", { payment_status: "unpaid" })], ["checkout.session.async_payment_failed", sess("v3", { payment_status: "unpaid" })], ["checkout.session.completed", sess("v3", { payment_status: "requires_payment_method" })]]) {
    x = await run(type, obj);
    assert.equal(x.r.statusCode, 200);
    assert.deepEqual([x.marked, x.local], [[], []], type + " " + obj.payment_status);
    assert.ok(!x.sent[0].includes("ACTION"));
  }
});

test("masterclass, gift cards and multi-piece/digital items never trigger marking", async () => {
  const x = await run("checkout.session.completed", sess("mc1,gc-50,vm,dg"));
  assert.equal(x.r.statusCode, 200);
  assert.deepEqual([x.marked, x.local], [[], []]);
  assert.ok(!x.sent[0].includes("ACTION"));
  assert.equal(parsed(x.cap, "sold_mark_failed").length + parsed(x.cap, "sold_mark_not_configured").length, 0);
});

test("mark failure: still 200, local mark kept, warn event, ACTION line for the owner, secret never logged", async () => {
  for (const mk of [async () => ({ ok: false, reason: "forbidden" }), async () => { throw new Error(`boom ${SECRET}`); }]) {
    const x = await run("checkout.session.completed", sess("v3,v1"), { markSold: mk });
    assert.equal(x.r.statusCode, 200);
    assert.deepEqual(x.local, [["v3", "v1"]]);
    assert.ok(x.sent[0].startsWith("New paid order"));
    assert.ok(x.sent[0].endsWith("ACTION: mark v3, v1 as sold in the sheet manually"));
    const [[lvl, o]] = parsed(x.cap, "sold_mark_failed");
    assert.equal(lvl, "warn");
    assert.deepEqual(o.ids, ["v3", "v1"]);
    assert.ok(o.reason);
    assert.ok(!x.cap.logs.some(([, l]) => l.includes(SECRET)), "secret leaked in logs");
    assert.ok(!x.sent[0].includes(SECRET) && !x.r.body.includes(SECRET));
  }
});

test("not configured: warn sold_mark_not_configured once, ACTION line, local mark, 200", async () => {
  const sent = [];
  const local = [];
  let calls = 0;
  const cap = capture();
  let r;
  try {
    const h = makeHandler({ stripeFactory: () => fake(evtOf("checkout.session.completed", sess("v3"))), env, notify: async (s) => sent.push(s), getCatalogue, markSoldLocal: (i) => local.push(i), markSold: (ids, o) => { calls++; return catSrc.markSold(ids, { ...o, fetchImpl: async () => { throw new Error("must not fetch"); } }); } });
    r = await h(req());
  } finally {
    cap.restore();
  }
  assert.equal(r.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(parsed(cap, "sold_mark_not_configured").length, 1);
  assert.equal(parsed(cap, "sold_mark_failed").length, 0);
  assert.ok(sent[0].endsWith("ACTION: mark v3 as sold in the sheet manually"));
  assert.deepEqual(local, [["v3"]]);
});

test("end to end with the real markSold and a fake Apps Script fetch (redirect follow, retry on 5xx)", async () => {
  catSrc._reset();
  const posts = [];
  let n = 0;
  const fetchImpl = async (url, o) => {
    posts.push([url, o]);
    return ++n === 1 ? new Response("err", { status: 503 }) : new Response(JSON.stringify({ ok: true, marked: ["v3"], sheet: "Vasi" }), { status: 200 });
  };
  const sent = [];
  const cap = capture();
  let r;
  try {
    const h = makeHandler({
      stripeFactory: () => fake(evtOf("checkout.session.completed", sess("v3,mc1"))),
      env: wenv, notify: async (s) => sent.push(s), getCatalogue, fetchImpl,
      markSold: (ids, o) => catSrc.markSold(ids, { ...o, sleep: async () => {} }),
    });
    r = await h(req());
  } finally {
    cap.restore();
  }
  assert.equal(r.statusCode, 200);
  assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(posts[1][1].body), { secret: SECRET, ids: ["v3"] });
  assert.equal(posts[1][1].redirect, "follow");
  assert.ok(!sent[0].includes("ACTION"));
  assert.equal(parsed(cap, "sold_marked").length, 1);
  assert.ok(!cap.logs.some(([, l]) => l.includes(SECRET) || l.includes("AKFY123")), "no secret or script URL token in logs");
  catSrc._reset();
});

test("a just-marked piece is sold immediately in the catalogue source, even if the sheet lags", async () => {
  catSrc._reset();
  const csv = "id,type,name_it,name_en,name_ru,price,image,maxQty,sold\nv3,physical,A,A,A,10,,1,";
  const h = makeHandler({
    stripeFactory: () => fake(evtOf("checkout.session.completed", sess("v3"))),
    env: { ...wenv, CATALOGUE_CSV_URL: "https://docs.google.com/spreadsheets/d/e/T/pub?output=csv" },
    notify: async () => {},
    fetchImpl: async (url) => (String(url).includes("docs.google.com") ? new Response(csv, { status: 200 }) : new Response(JSON.stringify({ ok: true, marked: ["v3"], sheet: "Vasi" }), { status: 200 })),
  });
  const cap = capture();
  try {
    assert.equal((await h(req())).statusCode, 200);
    const after = await catSrc.getCatalogue({ env: { CATALOGUE_CSV_URL: "https://docs.google.com/spreadsheets/d/e/T/pub?output=csv" }, fetchImpl: async () => new Response(csv, { status: 200 }), soldList: [] });
    assert.equal(after.items.v3.sold, true);
  } finally {
    cap.restore();
    catSrc._reset();
  }
});
