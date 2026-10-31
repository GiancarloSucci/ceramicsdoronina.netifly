// functions/catalogue.js
// GET /.netlify/functions/catalogue -> public, read-only catalogue for the site:
//   {version:1, source:"sheet"|"stale"|"snapshot", items:[{id,type,name_it,name_en,name_ru,priceCents,image,maxQty,sold}]}
// Same data create-checkout charges from (see _catalogue-source.js), so the shop page
// and the checkout cannot disagree. Public data, GET only, hence CORS "*".
const crypto = require("crypto");
const { getCatalogue: defaultGetCatalogue } = require("./_catalogue-source.js");
const { safeText } = require("./_shared.js");

const FIELDS = ["type", "name_it", "name_en", "name_ru", "priceCents", "image", "maxQty", "sold"];

function makeHandler({ env = process.env, getCatalogue = defaultGetCatalogue, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  return async function handler(event) {
    const requestId = (event.headers && event.headers["x-nf-request-id"]) || crypto.randomUUID();
    const base = { "x-request-id": requestId, "Access-Control-Allow-Origin": "*" };
    const json = (statusCode, body, extra) => ({
      statusCode,
      headers: { "Content-Type": "application/json", ...base, ...extra },
      body: JSON.stringify(body),
    });

    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: { ...base, "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" }, body: "" };
    }
    if (event.httpMethod !== "GET") {
      return json(405, { error: "method_not_allowed" }, { Allow: "GET,OPTIONS" });
    }
    try {
      const { items, source } = await getCatalogue({ fetchImpl, now, env });
      // Explicit allowlist of fields: nothing else can ever leak through this endpoint.
      const list = Object.keys(items)
        .sort()
        .map((id) => {
          const o = { id };
          for (const k of FIELDS) o[k] = items[id][k];
          return o;
        });
      return json(200, { version: 1, source, items: list }, { "Cache-Control": "public, max-age=60" });
    } catch (err) {
      console.error(JSON.stringify({ event: "unexpected_error", request_id: requestId, name: err && err.name, message: safeText(err && err.message, 200) }));
      return json(500, { error: "server_error" });
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
