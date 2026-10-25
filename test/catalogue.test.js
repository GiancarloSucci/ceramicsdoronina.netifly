// Tests on the real functions/catalogue.json and on tools/build-catalogue.py.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "..", "ceramicsdoronina");
const SITE_PRESENT = fs.existsSync(path.join(SITE, "catalogue")) && fs.existsSync(path.join(SITE, "images"));
const SITE_SKIP = SITE_PRESENT ? false : "site folder ../ceramicsdoronina not present (run next to the site repo to enable)";
const catalogue = require("../functions/catalogue.json");
const soldJson = require("../functions/sold.json");
const fixture = require("./fixtures/price-cases.json");

const PY_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
const hasPython = spawnSync("python3", ["-B", "-I", "--version"], { env: PY_ENV }).status === 0;
const PY_SKIP = hasPython ? false : "python3 not available";
const SCRIPT = path.join(ROOT, "tools", "build-catalogue.py");

function py(code, input) {
  return spawnSync("python3", ["-B", "-I", "-c", code, SCRIPT], { input, encoding: "utf8", env: PY_ENV });
}
// Loads tools/build-catalogue.py as a module (hyphenated name, -I has no cwd on sys.path).
const LOAD = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("bc", sys.argv[1])
bc = importlib.util.module_from_spec(spec); spec.loader.exec_module(bc)
`;

test("catalogue schema", () => {
  const ids = Object.keys(catalogue);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const p = catalogue[id];
    assert.match(id, /^[A-Za-z0-9_-]{1,40}$/, "id pattern: " + id);
    assert.ok(Number.isInteger(p.priceCents) && p.priceCents >= 50 && p.priceCents <= 1e7, `${id} priceCents`);
    assert.ok(p.type === "physical" || p.type === "digital", `${id} type`);
    assert.ok(Number.isInteger(p.maxQty) && p.maxQty >= 1, `${id} maxQty`);
    assert.equal(typeof p.sold, "boolean", `${id} sold`);
    for (const k of ["name_it", "name_en", "name_ru"]) assert.ok(typeof p[k] === "string" && p[k].trim(), `${id} ${k}`);
    if (p.type === "physical") assert.equal(p.maxQty, 1, `${id}: one-off vases have maxQty 1`);
    assert.equal(typeof p.image, "string");
  }
  for (const id of soldJson) assert.ok(id in catalogue, "sold.json id not in catalogue: " + id);
});

test("every catalogue image exists under the site folder", { skip: SITE_SKIP }, () => {
  for (const [id, p] of Object.entries(catalogue)) {
    if (!p.image) continue;
    assert.ok(!p.image.startsWith("/") && !p.image.includes(".."), `${id}: image must be a relative path`);
    assert.ok(fs.existsSync(path.join(SITE, p.image)), `${id}: missing image ${p.image}`);
  }
});

test("catalogue.json matches the ODS files (build-catalogue.py --check)", { skip: SITE_SKIP || PY_SKIP }, () => {
  const r = spawnSync("python3", ["-B", "-I", SCRIPT, "--check"], { encoding: "utf8", env: PY_ENV });
  assert.equal(r.status, 0, r.stderr);
});

test("python cents(): shared price fixture", { skip: PY_SKIP }, () => {
  const cases = { valid: fixture.valid, numbers: fixture.numbers, reject: fixture.reject, jsOnly: fixture.jsOnly.map((c) => c[0]), quirks: fixture.pythonQuirks };
  const r = py(LOAD + `
cases = json.load(sys.stdin)
def run(v):
    try: return bc.cents(v)
    except ValueError: return "ERR"
out = {k: [run(x[0] if isinstance(x, list) else x) for x in v] for k, v in cases.items()}
print(json.dumps(out))
`, JSON.stringify(cases));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.valid, fixture.valid.map((c) => c[1]));
  assert.deepEqual(out.numbers, fixture.numbers.map((c) => c[1]));
  assert.ok(out.reject.every((x) => x === "ERR"), "reject cases must raise ValueError: " + JSON.stringify(out.reject));
  assert.ok(out.jsOnly.every((x) => x === "ERR"), "jsOnly formats are intentionally rejected by the build script");
  assert.deepEqual(out.quirks, [0, 0]); // accepted by cents(), then FATAL non-positive in the generator
});

test("python: duplicate id is FATAL (also across files), missing image is FATAL", { skip: PY_SKIP }, () => {
  let r = py(LOAD + `
cat = {}
bc.add_unique(cat, "v1", {})
bc.add_unique(cat, "mc1", {})
try:
    bc.add_unique(cat, "v1", {})
except SystemExit as e:
    print(e)
    sys.exit(0)
sys.exit(3)
`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /FATAL duplicate id: v1/);
  r = py(LOAD + `
import tempfile
d = tempfile.mkdtemp()
try:
    bc.check_images({"x": {"image": "images/none.jpg"}, "y": {"image": ""}}, d)
except SystemExit as e:
    print(e)
    sys.exit(0)
sys.exit(3)
`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /FATAL missing image files[\s\S]*x: images\/none\.jpg/);
  assert.ok(!/y:/.test(r.stdout));
});

test("python: image dirs per source", { skip: PY_SKIP }, () => {
  const r = py(LOAD + `
print(json.dumps([bc.img({"img1": "a.jpg"}, "vasi"), bc.img({"img1": "b.jpg"}, "masterclass"), bc.img({"img1": "c.jpg"}, "certificati"), bc.img({"img1": "-"}, "vasi")]))
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ["images/catalogue/a.jpg", "images/masterclass/b.jpg", "images/certificati/c.jpg", ""]);
});

test("contract: every catalogue id x locales (incl. invalid) builds a valid Stripe session", async () => {
  const { makeHandler } = require("../functions/create-checkout.js");
  const { makeStripeFake } = require("./helpers/stripe-fake.js");
  const unsold = Object.fromEntries(Object.entries(catalogue).map(([id, p]) => [id, { ...p, sold: false }]));
  const ORIGIN = "https://ceramicsdoronina.it";
  const now = 1_700_000_000_000;
  for (const locale of ["it", "en", "ru", "xx"]) {
    for (const id of Object.keys(unsold)) {
      const f = makeStripeFake({ catalogue: unsold, now });
      const h = makeHandler({ stripeFactory: () => f.client, env: { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_x" }, catalogue: unsold, soldList: [], now: () => now });
      const r = await h({ httpMethod: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ items: [{ id, quantity: 1 }], locale }) });
      assert.equal(r.statusCode, 200, `${id} ${locale}: ${r.body}`);
      assert.equal(f.calls.length, 1);
    }
  }
  // the whole catalogue in one cart (<= MAX_ITEMS)
  const f = makeStripeFake({ catalogue: unsold, now });
  const h = makeHandler({ stripeFactory: () => f.client, env: { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_x" }, catalogue: unsold, soldList: [], now: () => now });
  const items = Object.keys(unsold).map((id) => ({ id, quantity: 1 }));
  const r = await h({ httpMethod: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ items, locale: "it" }) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(f.calls[0].line_items.length, items.length);
});

test("contract: real sold ids are rejected with item_sold + item_id", async () => {
  const { makeHandler } = require("../functions/create-checkout.js");
  const ORIGIN = "https://ceramicsdoronina.it";
  const h = makeHandler({ stripeFactory: () => { throw new Error("must not be called"); }, env: { ALLOWED_ORIGINS: ORIGIN, STRIPE_SECRET_KEY: "sk_test_x" } });
  const sold = [...Object.keys(catalogue).filter((id) => catalogue[id].sold), ...soldJson];
  for (const id of sold) {
    const r = await h({ httpMethod: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ items: [{ id, quantity: 1 }] }) });
    assert.equal(r.statusCode, 400);
    assert.deepEqual([JSON.parse(r.body).error, JSON.parse(r.body).item_id], ["item_sold", id]);
  }
});
