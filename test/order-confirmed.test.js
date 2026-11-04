// public/order-confirmed.html: static checks (no browser): self-contained, three languages, session id guard, no personal data.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "order-confirmed.html"), "utf8");

test("self-contained: no external script, stylesheet, font, image or form; one inline script", () => {
  assert.ok(!/<script[^>]*\ssrc\s*=/i.test(html), "no <script src>");
  assert.ok(!/<link\b/i.test(html), "no <link> (stylesheets, fonts, icons)");
  assert.ok(!/<(img|iframe|form|embed|object)\b/i.test(html));
  assert.ok(!/@import|url\(/i.test(html), "no CSS imports or url()");
  assert.equal((html.match(/<script\b/gi) || []).length, 1);
  assert.ok(!/https?:\/\/(?!ceramicsdoronina\.it\/)[^\s"')]+/i.test(html.replace(/<meta[^>]*>/g, "")), "only the site URL appears");
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /--accent: #7d0f0f/);
});

test("three languages are present with the agreed Italian message and a back button", () => {
  assert.ok(html.includes("Il tuo ordine è andato a buon fine. Ti contatteremo a breve per i passi successivi."));
  assert.ok(html.includes("Your order was successful. We will contact you shortly about the next steps."));
  assert.ok(html.includes("Ваш заказ успешно оформлен"));
  for (const k of ["it", "en", "ru"]) assert.match(html, new RegExp(`\\b${k}: \\{ doc:`));
  assert.ok(html.includes('id="back"'));
});

// Runs the page script against a tiny DOM stub for a given URL query and navigator language.
function render(search, language = "en-US") {
  const els = {};
  const doc = { documentElement: { lang: "it" }, title: "", getElementById: (id) => (els[id] = els[id] || { textContent: "", href: "" }) };
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  vm.runInNewContext(script, { document: doc, navigator: { language }, window: { location: { search } }, URLSearchParams });
  return { lang: doc.documentElement.lang, title: doc.title, heading: els.title.textContent, message: els.message.textContent, back: els.back.href, backText: els.back.textContent, els };
}

test("language: ?lang wins, then navigator.language, then Italian; document lang and title follow", () => {
  assert.deepEqual([render("?lang=ru").lang, render("?lang=en", "ru-RU").lang, render("?lang=it", "en-US").lang], ["ru", "en", "it"]);
  assert.equal(render("", "ru-RU").lang, "ru");
  assert.equal(render("?lang=xx", "en-GB").lang, "en", "unknown lang falls back on the browser language");
  assert.equal(render("?lang=xx", "de-DE").lang, "it");
  assert.equal(render("", "").lang, "it");
  const it = render("?lang=it");
  assert.deepEqual([it.title, it.heading, it.backText], ["Ordine confermato", "Grazie!", "Torna al sito"]);
  assert.match(render("?lang=ru").message, /Ваш заказ/);
});

test("back link: stripe-success.html with the id only when it matches /^cs_[A-Za-z0-9_]+$/, otherwise the site home", () => {
  assert.equal(render("?lang=it&session_id=cs_test_a1B2c3").back, "https://ceramicsdoronina.it/stripe-success.html?session_id=cs_test_a1B2c3");
  for (const bad of ["", "?session_id=", "?session_id=abc", "?session_id=cs_", "?session_id=cs_a-b", "?session_id=cs_a%20b", "?session_id=cs_a&session_id=x%22%3E", "?session_id=%3Cscript%3E", "?session_id=cs_a/../x", "?session_id=cs_a%0Ab", "?session_id=cs_a?x=1", "?session_id=cs_a%26b"]) {
    const href = render(bad).back;
    assert.ok(href === "https://ceramicsdoronina.it/" || /^https:\/\/ceramicsdoronina\.it\/stripe-success\.html\?session_id=cs_[A-Za-z0-9_]+$/.test(href), `${bad} -> ${href}`);
  }
  assert.equal(render("?session_id=javascript:alert(1)").back, "https://ceramicsdoronina.it/");
  assert.equal(render("?session_id=cs_ok&session_id=bad").back, "https://ceramicsdoronina.it/stripe-success.html?session_id=cs_ok", "the first value is the one used");
});

test("the session id and other query values are never printed on the page", () => {
  const r = render("?lang=en&session_id=cs_test_SECRETID&email=ann@example.com&name=Ann");
  const shown = [r.title, r.heading, r.message, r.backText].join("|");
  for (const leak of ["cs_test_SECRETID", "ann@example.com", "Ann"]) assert.ok(!shown.includes(leak), leak);
  assert.ok(!/\.(innerHTML|outerHTML|insertAdjacentHTML|write)\b|document\.write|eval\(/.test(html), "only textContent and href are set");
});

test("netlify.toml serves public/ and gives the page no-store, no-referrer and a restrictive CSP", () => {
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  assert.match(toml, /publish = "public"/);
  const block = toml.slice(toml.indexOf('for = "/order-confirmed.html"'));
  for (const h of ['Cache-Control = "no-store"', 'Referrer-Policy = "no-referrer"', "default-src 'none'"]) assert.ok(block.includes(h), h);
  assert.ok(!/script-src[^;"]*https?:/.test(block), "no external script source allowed");
});
