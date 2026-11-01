// functions/create-checkout.js
// Creates a Stripe Checkout Session from {items:[{id,quantity}], locale}.
// Prices, names, images and item type come ONLY from the server-side catalogue
// (the published Google Sheet via functions/_catalogue-source.js, falling back to the
// snapshot functions/catalogue.json). The client payload is never trusted for money. See README.md for the full contract.
// Masterclass items (catalogue item with tiersCents): `quantity` means PERSONS and the price is the
// tier of that group size (pricing 'table', sizes 1..20) or N x linearCents (pricing 'linear', 1..maxLinearPersons,
// within Stripe's maximum amount), charged as ONE Stripe line (quantity 1). Seats still free = seatsFree minus the
// seats held by other OPEN Checkout Sessions (metadata.bookings), so two customers cannot both take the last seats.
// Unlimited masterclasses (seatsFree null) skip the seat and holds checks.
const crypto = require("crypto");
const { STRIPE_API_VERSION, defaultStripeFactory, decodeBody, safeText, parseBookings, MAX_GROUP, STRIPE_MAX_CENTS, maxLinearPersons } = require("./_shared.js");
const { getCatalogue: defaultGetCatalogue } = require("./_catalogue-source.js");

const DEFAULT_SITE_URL = "https://ceramicsdoronina.it";
const MAX_ITEMS = 30; // > catalogue size (23); Stripe allows 100 line items
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const CHECKOUT_TTL_SECONDS = 30 * 60; // Stripe minimum for expires_at
const EXPIRY_SAFETY_SECONDS = 60;
const METADATA_VALUE_MAX = 500; // Stripe limit per metadata value
const HOLDS_LIST_LIMIT = 100; // open sessions inspected for seat holds

// Shipping tiers on the PHYSICAL subtotal only (EUR cents).
const SHIPPING = {
  tiers: [
    { below: 20000, cents: 4000 },
    { below: 50000, cents: 2000 },
  ],
  freeCents: 0,
  displayNames: { it: "Spedizione", en: "Shipping", ru: "Доставка" },
};

// Business decision pending owner confirmation: which countries are served.
const ALLOWED_COUNTRIES = [
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT",
  "LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","NO","CH",
];

const LOCALES = ["it", "en", "ru"];
const NOTE_LABELS = {
  it: "Note per la consegna / regalo",
  en: "Delivery / gift note",
  ru: "Примечание к доставке / подарку",
};

class ValidationError extends Error {
  constructor(code, itemId) {
    super(code);
    this.name = "ValidationError";
    this.code = code;
    if (itemId !== undefined) this.itemId = itemId; // catalogue id of the offending line
  }
}

function normalizeOrigin(o) {
  return String(o || "").trim().replace(/\/+$/, "").toLowerCase();
}

function parseAllowedOrigins(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map(normalizeOrigin)
    .filter(Boolean);
}

function isOriginAllowed(origin, allowedList) {
  const o = normalizeOrigin(origin);
  if (!o || !Array.isArray(allowedList)) return false;
  return allowedList.map(normalizeOrigin).includes(o);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// Returns the normalised site URL, or null when SITE_URL is invalid.
// https is required; http is accepted only for localhost (local development).
function normalizeSiteUrl(v) {
  const s = String(v || DEFAULT_SITE_URL).trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return null;
  }
  const localHttp = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !localHttp) return null;
  if (u.search || u.hash) return null;
  return s;
}

function isSold(id, catalogue, soldList) {
  return !!(catalogue[id] && catalogue[id].sold) || (Array.isArray(soldList) && soldList.includes(id));
}

// Masterclass items carry the price of each group size (tiersCents[N-1], null = not bookable).
function isMasterclass(p) {
  return !!p && Array.isArray(p.tiersCents);
}

// Total cents of a masterclass booking of `persons`: N x linearCents (linear) or the table tier (null = not bookable).
function groupCents(p, persons) {
  if (p.pricing === "linear") return persons <= maxLinearPersons(p.linearCents) ? p.linearCents * persons : null;
  return persons <= MAX_GROUP ? p.tiersCents[persons - 1] : null;
}

// Total cents of one cart line: the group price for a masterclass, price x quantity otherwise.
function lineCents(p, quantity) {
  return isMasterclass(p) ? groupCents(p, quantity) : p.priceCents * quantity;
}

// Validates one masterclass line (quantity = persons) against the tiers and the seats still free
// (`holds`: seats held by open sessions, per id). Distinct codes: sold_out, invalid_quantity,
// group_size_unavailable, not_enough_seats.
function validateGroup(it, catalogue, soldList, holds) {
  const p = catalogue[it.id];
  const unlimited = p.seatsFree === null; // seats_total blank: no seat check
  const seatsFree = Number.isInteger(p.seatsFree) ? p.seatsFree : 0;
  const free = unlimited ? Infinity : Math.max(0, seatsFree - (holds[it.id] || 0));
  if (isSold(it.id, catalogue, soldList) || free === 0) throw new ValidationError("sold_out", it.id);
  if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new ValidationError("invalid_quantity", it.id);
  const tier = groupCents(p, it.quantity);
  if (!Number.isInteger(tier) || tier <= 0 || tier > STRIPE_MAX_CENTS) throw new ValidationError("group_size_unavailable", it.id);
  if (it.quantity > free) throw new ValidationError("not_enough_seats", it.id);
}

// Validates the (already JSON-parsed) body. Returns {items:[{id,quantity}], locale}
// with duplicate ids merged (locale is null when missing/invalid: Stripe auto and
// Italian copy are used; a masterclass id may appear only once: duplicate_item); throws
// ValidationError on any client fault. Errors about a specific line carry itemId.
// `holds`: {masterclassId: seats held by open Checkout Sessions}.
function validateBody(body, catalogue = {}, soldList = [], holds = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("invalid_body");
  const { items } = body;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) throw new ValidationError("invalid_items");
  const merged = new Map();
  const groups = new Set();
  for (const it of items) {
    if (!it || typeof it !== "object" || Array.isArray(it)) throw new ValidationError("invalid_item");
    if (typeof it.id !== "string" || !ID_PATTERN.test(it.id)) throw new ValidationError("invalid_id");
    if (!Object.prototype.hasOwnProperty.call(catalogue, it.id)) throw new ValidationError("unknown_item", it.id);
    if (isMasterclass(catalogue[it.id])) {
      if (groups.has(it.id)) throw new ValidationError("duplicate_item", it.id);
      groups.add(it.id);
      validateGroup(it, catalogue, soldList, holds);
      merged.set(it.id, it.quantity);
      continue;
    }
    if (isSold(it.id, catalogue, soldList)) throw new ValidationError("item_sold", it.id);
    if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new ValidationError("invalid_quantity", it.id);
    merged.set(it.id, (merged.get(it.id) || 0) + it.quantity);
  }
  const out = [];
  for (const [id, quantity] of merged) {
    const max = Number.isInteger(catalogue[id].maxQty) ? catalogue[id].maxQty : 1;
    if (!groups.has(id) && quantity > max) throw new ValidationError("quantity_too_high", id);
    out.push({ id, quantity });
  }
  return { items: out, locale: LOCALES.includes(body.locale) ? body.locale : null };
}

function productName(p, locale, suffix = "") {
  return String(p["name_" + locale] || p.name_it || p.name || "Item").slice(0, 120 - suffix.length) + suffix;
}

// " (2 persone)" / " (1 person)" / " (5 человек)" for the Stripe product name of a masterclass booking.
function personsSuffix(n, locale) {
  if (locale === "en") return ` (${n} ${n === 1 ? "person" : "people"})`;
  if (locale === "ru") return ` (${n} ${n % 10 === 1 && n % 100 !== 11 ? "человек" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "человека" : "человек"})`;
  return ` (${n} ${n === 1 ? "persona" : "persone"})`;
}

function imageUrl(p, siteUrl) {
  if (!p.image) return null;
  const url = `${siteUrl}/${encodeURI(String(p.image).replace(/^\/+/, ""))}`;
  return /^https:\/\//.test(url) ? url : null;
}

function buildLineItems(items, catalogue, siteUrl, locale = "it") {
  return items.map(({ id, quantity }) => {
    const p = catalogue[id];
    const img = imageUrl(p, siteUrl);
    const group = isMasterclass(p);
    const product_data = { name: productName(p, locale, group ? personsSuffix(quantity, locale) : ""), metadata: { item_id: id } };
    if (group) product_data.metadata.seats = String(quantity);
    if (img) product_data.images = [img];
    if (group) {
      // ONE line for the whole group at the price of its size; quantity is persons, not units
      return { quantity: 1, price_data: { currency: "eur", unit_amount: groupCents(p, quantity), product_data } };
    }
    return {
      quantity,
      price_data: { currency: "eur", unit_amount: p.priceCents, product_data },
    };
  });
}

function computeShippingCents(physicalSubtotalCents) {
  for (const t of SHIPPING.tiers) if (physicalSubtotalCents < t.below) return t.cents;
  return SHIPPING.freeCents;
}

function physicalSubtotal(items, catalogue) {
  return items.reduce(
    (s, { id, quantity }) => (catalogue[id].type === "physical" ? s + catalogue[id].priceCents * quantity : s),
    0
  );
}

function json(statusCode, body, headers, requestId) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "x-request-id": requestId, ...headers },
    body: JSON.stringify({ ...body, request_id: requestId }),
  };
}

function logLine(level, obj) {
  console[level](JSON.stringify(obj));
}

// Pure builder of the Stripe Checkout Session params. siteUrl must already be
// validated (normalizeSiteUrl). Returns the params plus values used for logging.
function buildSessionParams({ items, locale, catalogue, siteUrl, now = Date.now }) {
  const loc = LOCALES.includes(locale) ? locale : null;
  const line_items = buildLineItems(items, catalogue, siteUrl, loc || "it");
  const physicalCents = physicalSubtotal(items, catalogue);
  const hasPhysical = items.some(({ id }) => catalogue[id].type === "physical");
  const subtotalCents = items.reduce((s, { id, quantity }) => s + lineCents(catalogue[id], quantity), 0);
  const shippingCents = hasPhysical ? computeShippingCents(physicalCents) : 0;

  // Metadata values are limited to 500 chars: keep only WHOLE ids that fit.
  const kept = [];
  let len = 0;
  for (const { id } of items) {
    const add = (kept.length ? 1 : 0) + id.length;
    if (len + add > METADATA_VALUE_MAX) break;
    kept.push(id);
    len += add;
  }
  const itemIdsTruncated = kept.length < items.length;
  // metadata.bookings "mc1:2,mc3:1" (masterclass id : persons), read back by the webhook and by the seat holds
  const bookings = [];
  let bookingsLen = 0;
  for (const { id, quantity } of items) {
    if (!isMasterclass(catalogue[id])) continue;
    const entry = `${id}:${quantity}`;
    const add = (bookings.length ? 1 : 0) + entry.length;
    if (bookingsLen + add > METADATA_VALUE_MAX) break;
    bookings.push(entry);
    bookingsLen += add;
  }
  const bookingsTruncated = bookings.length < items.filter(({ id }) => isMasterclass(catalogue[id])).length;

  const params = {
    mode: "payment",
    line_items,
    success_url: `${siteUrl}/stripe-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/stripe-cancel.html`,
    billing_address_collection: "required",
    phone_number_collection: { enabled: true },
    custom_fields: [
      {
        key: "note",
        label: { type: "custom", custom: NOTE_LABELS[loc || "it"] },
        type: "text",
        optional: true,
      },
    ],
    allow_promotion_codes: true,
    expires_at: Math.floor(now() / 1000) + CHECKOUT_TTL_SECONDS + EXPIRY_SAFETY_SECONDS,
    metadata: { item_ids: kept.join(",") },
  };
  if (bookings.length) params.metadata.bookings = bookings.join(",");
  if (loc) params.locale = loc;
  if (hasPhysical) {
    params.shipping_address_collection = { allowed_countries: ALLOWED_COUNTRIES };
    // Real shipping option (not a line item) so promo codes cannot discount it.
    params.shipping_options = [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          display_name: SHIPPING.displayNames[loc || "it"],
          fixed_amount: { amount: shippingCents, currency: "eur" },
          tax_behavior: "unspecified",
        },
      },
    ];
  }
  return {
    params,
    itemIds: items.map((i) => i.id).join(","),
    itemIdsTruncated,
    bookingsTruncated,
    subtotalCents,
    shippingCents,
  };
}

// Seats held by OPEN Checkout Sessions (not yet paid, not expired: at most 30 minutes) for the given
// masterclass ids. Returns {holds: {id: seats}, hasMore}. Throws when Stripe cannot be asked.
async function fetchHolds(stripe, ids) {
  const list = await stripe.checkout.sessions.list({ status: "open", limit: HOLDS_LIST_LIMIT });
  const holds = {};
  for (const s of (list && list.data) || []) {
    for (const b of parseBookings(s && s.metadata && s.metadata.bookings)) if (ids.has(b.id)) holds[b.id] = (holds[b.id] || 0) + b.seats;
  }
  return { holds, hasMore: !!(list && list.has_more) };
}

function logUnexpected(requestId, err) {
  logLine("error", {
    event: "unexpected_error",
    request_id: requestId,
    name: err && err.name,
    message: safeText(err && err.message, 200),
    stack: safeText(err && err.stack, 600),
  });
}

function makeHandler({
  stripeFactory = defaultStripeFactory,
  env = process.env,
  catalogue, // optional fixed catalogue (tests); default: live sheet via getCatalogue
  soldList, // optional sold ids used with a fixed catalogue; default sold.json
  getCatalogue = defaultGetCatalogue,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return async function handler(event) {
    const headers = event.headers || {};
    const requestId = headers["x-nf-request-id"] || crypto.randomUUID();
    const origin = headers.origin || headers.Origin || "";
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const originOk = isOriginAllowed(origin, allowed);
    const cors = originOk ? corsHeaders(origin) : {};

    if (event.httpMethod !== "OPTIONS" && event.httpMethod !== "POST") {
      logLine("info", { event: "method_not_allowed", request_id: requestId, method: safeText(event.httpMethod, 20) });
      return json(405, { error: "method_not_allowed" }, cors, requestId);
    }
    if (allowed.length === 0) {
      logLine("error", { event: "config_missing", request_id: requestId, variable: "ALLOWED_ORIGINS" });
      return json(500, { error: "server_error" }, {}, requestId);
    }
    if (!origin) {
      logLine("info", { event: "origin_missing", request_id: requestId });
      return json(400, { error: "bad_request" }, {}, requestId);
    }
    if (!originOk) {
      logLine("warn", { event: "origin_rejected", request_id: requestId, origin: safeText(origin, 200) });
      return json(403, { error: "origin_not_allowed" }, {}, requestId);
    }
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: { ...cors, "x-request-id": requestId }, body: "" };
    }

    const secretKey = env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      logLine("error", { event: "config_missing", request_id: requestId, variable: "STRIPE_SECRET_KEY" });
      return json(500, { error: "server_error" }, cors, requestId);
    }
    const siteUrl = normalizeSiteUrl(env.SITE_URL);
    if (!siteUrl) {
      logLine("error", { event: "config_invalid", request_id: requestId, variable: "SITE_URL" });
      return json(500, { error: "server_error" }, cors, requestId);
    }

    let items, locale, cat;
    try {
      let body;
      try {
        body = JSON.parse(decodeBody(event));
      } catch (_) {
        throw new ValidationError("invalid_json");
      }
      if (catalogue) {
        cat = catalogue;
      } else {
        ({ items: cat } = await getCatalogue({ fetchImpl, now, env, soldList }));
      }
      // Seat holds are looked up only when the cart has a masterclass. Fail open: if Stripe cannot be
      // asked, the sheet's seatsFree alone decides (a double booking is then caught by the webhook as OVERBOOKED).
      let holds = {};
      const groupIds = new Set(
        (Array.isArray(body && body.items) ? body.items : [])
          .map((it) => it && it.id)
          .filter((id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(cat, id) && isMasterclass(cat[id]) && cat[id].seatsFree !== null) // unlimited: no holds lookup
      );
      if (groupIds.size) {
        try {
          const r = await fetchHolds(stripeFactory(secretKey), groupIds);
          holds = r.holds;
          if (r.hasMore) logLine("warn", { event: "holds_list_truncated", request_id: requestId, limit: HOLDS_LIST_LIMIT });
        } catch (err) {
          logLine("warn", { event: "holds_unavailable", request_id: requestId, type: err && err.type, code: err && err.code, message: safeText(err && err.message, 200) });
        }
      }
      ({ items, locale } = validateBody(body, cat, catalogue ? soldList || require("./sold.json") : [], holds));
    } catch (err) {
      if (err instanceof ValidationError) {
        const log = { event: "validation_failed", request_id: requestId, code: err.code };
        const resp = { error: err.code };
        if (err.itemId !== undefined) {
          log.item_id = err.itemId;
          resp.item_id = err.itemId;
        }
        logLine("warn", log);
        return json(400, resp, cors, requestId);
      }
      logUnexpected(requestId, err);
      return json(500, { error: "server_error" }, cors, requestId);
    }

    try {
      const { params, itemIds, itemIdsTruncated, bookingsTruncated, subtotalCents, shippingCents } = buildSessionParams({
        items, locale, catalogue: cat, siteUrl, now,
      });
      if (itemIdsTruncated) {
        logLine("warn", { event: "metadata_item_ids_truncated", request_id: requestId, kept: params.metadata.item_ids });
      }

      if (bookingsTruncated) {
        logLine("warn", { event: "metadata_bookings_truncated", request_id: requestId, kept: params.metadata.bookings });
      }

      let session;
      try {
        const stripe = stripeFactory(secretKey);
        session = await stripe.checkout.sessions.create(params);
      } catch (err) {
        logLine("error", {
          event: "stripe_error",
          request_id: requestId,
          type: err && err.type,
          code: err && err.code,
          param: err && err.param,
          status_code: err && err.statusCode,
          stripe_request_id: err && err.requestId,
          message: safeText(err && err.message, 200),
        });
        return json(502, { error: "payment_provider_error" }, cors, requestId);
      }

      logLine("info", {
        event: "session_created",
        request_id: requestId,
        session_id: session.id,
        item_ids: itemIds,
        subtotal_cents: subtotalCents,
        shipping_cents: shippingCents,
      });
      return json(200, { url: session.url, session_id: session.id }, cors, requestId);
    } catch (err) {
      logUnexpected(requestId, err);
      return json(500, { error: "server_error" }, cors, requestId);
    }
  };
}

exports.handler = makeHandler();
exports.makeHandler = makeHandler;
exports.isOriginAllowed = isOriginAllowed;
exports.parseAllowedOrigins = parseAllowedOrigins;
exports.validateBody = validateBody;
exports.personsSuffix = personsSuffix;
exports.buildLineItems = buildLineItems;
exports.buildSessionParams = buildSessionParams;
exports.normalizeSiteUrl = normalizeSiteUrl;
exports.computeShippingCents = computeShippingCents;
exports.ValidationError = ValidationError;
exports.ALLOWED_COUNTRIES = ALLOWED_COUNTRIES;
exports.SHIPPING = SHIPPING;
exports.STRIPE_API_VERSION = STRIPE_API_VERSION;
exports.defaultStripeFactory = defaultStripeFactory;
exports.decodeBody = decodeBody;
