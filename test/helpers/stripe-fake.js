// Test helper (not a test): a fake Stripe client that enforces the Stripe API
// rules most likely to be broken by a code change, so the unit tests fail the way
// the real API would.
const assert = require("node:assert");

const isHttps = (u) => /^https:\/\/[^\s]+$/.test(u);

function assertMetadata(md, label) {
  const keys = Object.keys(md);
  assert.ok(keys.length <= 50, `${label}: more than 50 metadata keys`);
  for (const k of keys) {
    assert.ok(k.length <= 40, `${label}: metadata key too long: ${k}`);
    assert.equal(typeof md[k], "string", `${label}: metadata value must be a string: ${k}`);
    assert.ok(md[k].length <= 500, `${label}: metadata value > 500 chars: ${k}`);
  }
}

// params: what is passed to stripe.checkout.sessions.create. opts.catalogue lets
// the helper check that shipping_rate_data is present only for physical carts.
function assertStripeRules(params, { now = Date.now(), catalogue } = {}) {
  const nowSec = Math.floor(now / 1000);
  assert.ok(params.expires_at >= nowSec + 1800 && params.expires_at <= nowSec + 86400, "expires_at must be within [now+30min, now+24h]");
  assert.ok(isHttps(params.success_url) && isHttps(params.cancel_url), "success/cancel urls must be absolute https");
  assert.ok(params.success_url.includes("{CHECKOUT_SESSION_ID}"), "success_url must carry the session placeholder");
  for (const f of params.custom_fields || []) {
    assert.ok(f.key && f.key.length <= 200, "custom field key");
    assert.ok(f.label.custom.length <= 50, `custom_fields label.custom > 50 chars: ${f.label.custom.length}`);
  }
  assertMetadata(params.metadata || {}, "session");
  assert.ok(Array.isArray(params.line_items) && params.line_items.length >= 1 && params.line_items.length <= 100, "line_items 1..100");
  let physical = false;
  for (const li of params.line_items) {
    const pd = li.price_data.product_data;
    assert.ok(Number.isInteger(li.price_data.unit_amount) && li.price_data.unit_amount >= 50, "unit_amount integer >= 50");
    assert.equal(li.price_data.currency, "eur");
    assert.ok(Number.isInteger(li.quantity) && li.quantity >= 1, "quantity integer >= 1");
    assert.ok(pd.name && pd.name.length <= 250, "product name");
    if (pd.images !== undefined) {
      assert.ok(pd.images.length <= 8, "images <= 8");
      for (const u of pd.images) assert.ok(isHttps(u) && !/\s/.test(u), `image must be absolute https and encoded: ${u}`);
    }
    assertMetadata(pd.metadata || {}, "product");
    if (catalogue && pd.metadata && catalogue[pd.metadata.item_id]?.type === "physical") physical = true;
  }
  if (catalogue) {
    assert.equal(!!params.shipping_options, physical, "shipping_options only for physical carts");
    assert.equal(!!params.shipping_address_collection, physical, "address collection only for physical carts");
  }
  if (params.shipping_options) {
    for (const o of params.shipping_options) {
      const r = o.shipping_rate_data;
      assert.equal(r.type, "fixed_amount");
      assert.ok(r.display_name && r.display_name.length <= 100);
      assert.ok(Number.isInteger(r.fixed_amount.amount) && r.fixed_amount.amount >= 0);
    }
  }
}

// Fake Stripe client. Records every create() call after validating it.
function makeStripeFake({ catalogue, now, throwErr, session = { id: "cs_1", url: "https://checkout.stripe.com/c/1" } } = {}) {
  const calls = [];
  const client = {
    checkout: {
      sessions: {
        create: async (p) => {
          assertStripeRules(p, { now: typeof now === "function" ? now() : now, catalogue });
          calls.push(p);
          if (throwErr) throw throwErr;
          return session;
        },
      },
    },
  };
  return { client, calls };
}

module.exports = { assertStripeRules, makeStripeFake };
