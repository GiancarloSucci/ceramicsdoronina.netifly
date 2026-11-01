// functions/_catalogue-source.js
// Live catalogue source: ONE Google Sheet with three tabs (Vasi, Masterclass, Certificati),
// each published as CSV (CATALOGUE_VASI_CSV_URL / CATALOGUE_MASTERCLASS_CSV_URL /
// CATALOGUE_CERTIFICATI_CSV_URL), read server-side with an in-memory cache and fallbacks, plus
// the write-back of the "sold" marker through a Google Apps Script web app (CATALOGUE_WRITE_URL).
// The tabs have the same headers as the old ODS files and are the single source of truth for
// commerce data (type, price, maxQty, image, sold: derived like tools/build-catalogue.py) AND
// display data (whitelisted columns, exposed by functions/catalogue.js).
// Masterclass tab, two schemas: the seat/group-price schema (columns seats_total, seats_booked,
// price_1..price_8: the price is per BOOKING SIZE, not linear) and the LEGACY one (spots, price:
// linear price, no seat tracking). Seats booked after a payment are written by the Apps Script and
// also kept locally for 15 minutes, until the published CSV catches up.
// The leading underscore keeps Netlify from treating this file as a function.
//
// getCatalogue() never throws. Per tab: sheet (fresh, <= 60 s) -> sheet (stale, <= 24 h) ->
// bundled snapshot items of that type (functions/catalogue.json). functions/sold.json and the
// ids marked locally after a payment are merged on top in every case.
// Mode: any of the three tab variables set -> tabs; else CATALOGUE_CSV_URL (DEPRECATED single
// 9-column sheet) -> legacy; else snapshot.
// Env: the variables above (https, docs.google.com only), CATALOGUE_WRITE_URL (https,
// script.google.com only), CATALOGUE_WRITE_SECRET. Secrets and full URLs are never logged,
// only the host.

const CSV_HOST = "docs.google.com";
const WRITE_HOST = "script.google.com";
const CACHE_TTL_MS = 60 * 1000;
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
const FAIL_BACKOFF_MS = 15 * 1000; // after a failed fetch, do not hammer the sheet
const LOCAL_SOLD_TTL_MS = 15 * 60 * 1000; // Google's CSV publish lags a few minutes
const FETCH_TIMEOUT_MS = 5000;
const MAX_CSV_BYTES = 256 * 1024;
const WRITE_RETRIES = 2;
const WRITE_BACKOFF_MS = 250;

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_PRICE_CENTS = 10000 * 100;
const MAX_QTY = 100;
const MAX_GROUP = 8; // masterclass booking size: 1..8 persons
const MAX_SEATS_BOOKED = 9999;
const NAME_COLS = ["name_it", "name_en", "name_ru"];
const PRICE_COLS = Array.from({ length: MAX_GROUP }, (_, i) => "price_" + (i + 1));
const COLUMNS = ["id", "type", "name_it", "name_en", "name_ru", "price", "image", "maxQty", "sold"];
const SOLD_WORDS = ["true", "1", "yes", "si", "x"];
const MAX_LOGGED_IDS = 20;
const SHEET_NAME = "Vasi"; // the tab the Apps Script marks; its reply must name it
const IMAGE_RE = /^[^.\u0000-\u001f][^\\/:?#\u0000-\u001f]*\.(?:jpe?g|png|webp|svg)$/i;

// Whitelisted headers per tab (display data). Anything else in the sheet (notes, and
// shopify_variant_id) is never read or exposed. `required` columns missing -> the tab fails.
const TABS = {
  vasi: {
    env: "CATALOGUE_VASI_CSV_URL",
    dir: "images/catalogue/",
    headers: "id,name_ru,name_it,name_en,short_ru,short_it,short_en,long_ru,long_it,long_en,height,diameter,material,material-en,material-ru,technique,technique-en,technique-ru,finish,finish-en,finish-ru,img1,img2,img3,img4,img5,img6,venduto,price_old,price_new".split(","),
    required: ["id", "name_it", "name_en", "name_ru", "img1", "venduto", "price_new"],
  },
  masterclass: {
    env: "CATALOGUE_MASTERCLASS_CSV_URL",
    dir: "images/masterclass/",
    headers: "id,name_it,name_en,name_ru,short_it,short_en,short_ru,long_it,long_en,long_ru,date,time,level,spots,price,seats_total,seats_booked,price_1,price_2,price_3,price_4,price_5,price_6,price_7,price_8,img1".split(","),
    // legacy schema (no price_1 column); the seat schema needs only id, img1, price_1 and one name_*
    required: ["id", "name_it", "name_en", "name_ru", "img1", "spots", "price"],
  },
  certificati: {
    env: "CATALOGUE_CERTIFICATI_CSV_URL",
    dir: "images/certificati/",
    headers: "id,name_it,name_en,name_ru,short_it,short_en,short_ru,long_it,long_en,long_ru,img1,amount_eur".split(","),
    required: ["id", "name_it", "name_en", "name_ru", "img1", "amount_eur"],
  },
};
const TAB_KEYS = Object.keys(TABS);
const RANK = { sheet: 0, stale: 1, snapshot: 2 };

// One fetch slot (cache, back-off, shared in-flight request) per sheet: "legacy" or a tab key.
const state = { slots: {}, local: new Map(), booked: new Map(), warned: new Set() };
const slotOf = (name) => state.slots[name] || (state.slots[name] = { cache: null, failedAt: 0, inflight: null });

function logLine(level, obj) {
  console[level](JSON.stringify(obj));
}

function warnOnce(key, obj) {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  logLine("warn", obj);
}

// Test helper: forget caches, failure back-off, local sold ids, local bookings and one-time warnings.
function _reset() {
  state.slots = {};
  state.local.clear();
  state.booked.clear();
  state.warned.clear();
}

// ---- URL allowlist ---------------------------------------------------------

// Returns {url, host} or {reason} ("not_configured" | "invalid_url" | "not_https" | "host_not_allowed").
function checkUrl(raw, allowedHost) {
  if (!raw || !String(raw).trim()) return { reason: "not_configured" };
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch (_) {
    return { reason: "invalid_url" };
  }
  if (u.protocol !== "https:") return { reason: "not_https" };
  if (u.username || u.password) return { reason: "invalid_url" };
  if (u.hostname.toLowerCase() !== allowedHost) return { reason: "host_not_allowed" };
  return { url: u.toString(), host: u.hostname.toLowerCase() };
}

// ---- CSV -------------------------------------------------------------------

// RFC 4180 parser: quoted fields, "" escapes, embedded commas/newlines, CRLF/LF/CR,
// leading BOM. Returns an array of rows (arrays of strings); blank lines are skipped.
// Throws on an unterminated quote.
function parseCsv(text) {
  let s = String(text == null ? "" : text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let atFieldStart = true;
  const endField = () => {
    row.push(field);
    field = "";
    atFieldStart = true;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (c === ",") {
      endField();
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
      atFieldStart = false;
    }
  }
  if (inQuotes) throw new Error("csv_unterminated_quote");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

// Same strict rules as tools/build-catalogue.py cents() and test/fixtures/price-cases.json
// ("valid"/"reject"; the browser-only "jsOnly" formats are rejected): whole or decimal euros
// with at most 2 decimals, "," or "." separator, optional euro sign and spaces.
// Returns integer cents or null. Range checks are done by the row validator.
function parsePriceCents(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v == null ? "" : v).trim().replace(/€/g, "").replace(/ /g, "");
  if (/^\d+(,\d{1,2})?$/.test(s) || /^\d+(\.\d{1,2})?$/.test(s)) return Math.round(parseFloat(s.replace(",", ".")) * 100);
  return null;
}

function parseSold(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return SOLD_WORDS.includes(s);
}

// Relative path under the site root: no leading slash, no "..", no scheme/query/fragment/backslash.
function validImage(img) {
  return img === "" || (!/^[\\/]/.test(img) && !img.includes("..") && !/[:?#\\]/.test(img));
}

// Validates one row object. Returns {id, item} or {id, error}.
function validateRow(r) {
  const id = String(r.id || "").trim();
  if (!ID_RE.test(id)) return { id, error: "id" };
  const type = String(r.type || "").trim().toLowerCase();
  if (type !== "physical" && type !== "digital") return { id, error: "type" };
  const priceCents = parsePriceCents(r.price);
  if (priceCents === null || priceCents <= 0 || priceCents > MAX_PRICE_CENTS) return { id, error: "price" };
  const qty = String(r.maxQty || "").trim();
  const maxQty = /^\d{1,4}$/.test(qty) ? Number(qty) : NaN;
  if (!Number.isInteger(maxQty) || maxQty < 1 || maxQty > MAX_QTY) return { id, error: "maxQty" };
  const names = {};
  for (const k of ["name_it", "name_en", "name_ru"]) names[k] = String(r[k] || "").trim();
  const fallback = names.name_it || names.name_en || names.name_ru;
  if (!fallback) return { id, error: "name" };
  for (const k of Object.keys(names)) if (!names[k]) names[k] = fallback;
  const image = String(r.image || "").trim();
  if (!validImage(image)) return { id, error: "image" };
  return { id, item: { type, ...names, priceCents, image, maxQty, sold: parseSold(r.sold) } };
}

// Linear seat fields (legacy masterclass rows and snapshot items): N persons cost N x price, no
// seat tracking (nothing booked), at most maxQty (and 8) persons per booking.
function linearSeatFields(priceCents, maxQty) {
  const tiersCents = Array.from({ length: MAX_GROUP }, (_, i) => (i < maxQty ? priceCents * (i + 1) : null));
  return { tiersCents, seatsTotal: maxQty, seatsBooked: 0, seatsFree: maxQty };
}

// Optional non-negative integer cell; blank = `dflt`. Returns NaN when malformed.
function intCell(v, dflt, min, max) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return dflt;
  const n = /^\d{1,4}$/.test(s) ? Number(s) : NaN;
  return n >= min && n <= max ? n : NaN;
}

// Validates one row of the seat schema of the Masterclass tab. price_N = TOTAL price of a booking
// of N persons (blank = N persons not bookable). Returns {id, item} or {id, error}.
function validateSeatsRow(r, tab) {
  const id = String(r.id || "").trim();
  if (!ID_RE.test(id)) return { id, error: "id" };
  const cells = PRICE_COLS.map((h) => String(r[h] == null ? "" : r[h]).trim());
  const tiersCents = cells.map((c) => (c ? parsePriceCents(c) : null));
  // a filled but unparsable or out-of-range cell invalidates the row (a typo must not silently close a group size)
  if (tiersCents.some((c, i) => (cells[i] && c === null) || (c !== null && (c <= 0 || c > MAX_PRICE_CENTS)))) return { id, error: "price" };
  const defined = tiersCents.filter((c) => c !== null);
  if (!defined.length) return { id, error: "price" };
  const seatsTotal = intCell(r.seats_total, MAX_GROUP, 1, MAX_GROUP);
  if (Number.isNaN(seatsTotal)) return { id, error: "seats_total" };
  const seatsBooked = intCell(r.seats_booked, 0, 0, MAX_SEATS_BOOKED);
  if (Number.isNaN(seatsBooked)) return { id, error: "seats_booked" };
  const names = {};
  for (const k of NAME_COLS) names[k] = String(r[k] || "").trim();
  const fallback = names.name_it || names.name_en || names.name_ru;
  if (!fallback) return { id, error: "name" };
  for (const k of NAME_COLS) if (!names[k]) names[k] = fallback;
  const file = String(r.img1 || "").trim();
  if (file && file !== "-" && (!IMAGE_RE.test(file) || file.includes(".."))) return { id, error: "image" };
  const image = file && file !== "-" ? tab.dir + file : "";
  const maxGroup = tiersCents.reduce((m, c, i) => (c !== null ? i + 1 : m), 0);
  const seatsFree = Math.max(0, seatsTotal - seatsBooked);
  return {
    id,
    item: {
      type: "digital", ...names, priceCents: tiersCents[0] !== null ? tiersCents[0] : Math.min(...defined), image,
      maxQty: Math.min(MAX_GROUP, seatsFree, maxGroup), sold: seatsFree === 0,
      tiersCents, seatsTotal, seatsBooked, seatsFree, tracked: true, maxGroup, // tracked/maxGroup: internal, never exposed
    },
  };
}

// Validates one row of a tab (object keyed by whitelisted headers); derivation mirrors
// tools/build-catalogue.py. `seats`: the Masterclass tab uses the seat schema. Returns {id, item} or {id, error}.
function validateTabRow(key, r, seats = false) {
  const tab = TABS[key];
  if (seats) return validateSeatsRow(r, tab);
  const id = String(r.id || "").trim();
  if (!ID_RE.test(id)) return { id, error: "id" };
  const priceCents = parsePriceCents(key === "vasi" ? r.price_new : key === "masterclass" ? r.price : r.amount_eur);
  if (priceCents === null || priceCents <= 0 || priceCents > MAX_PRICE_CENTS) return { id, error: "price" };
  let maxQty = 1; // vasi: one-off pieces
  if (key === "masterclass") {
    const m = /\d+/.exec(String(r.spots || ""));
    maxQty = m ? Number(m[0]) : 6; // "Max 6 persone" -> 6; no number -> 6 (as build-catalogue.py)
  } else if (key === "certificati") {
    maxQty = 10;
  }
  if (!Number.isInteger(maxQty) || maxQty < 1 || maxQty > MAX_QTY) return { id, error: "maxQty" };
  const names = {};
  for (const k of ["name_it", "name_en", "name_ru"]) names[k] = String(r[k] || "").trim();
  const fallback = names.name_it || names.name_en || names.name_ru;
  if (!fallback) return { id, error: "name" };
  for (const k of Object.keys(names)) if (!names[k]) names[k] = fallback;
  const file = String(r.img1 || "").trim();
  if (file && file !== "-" && (!IMAGE_RE.test(file) || file.includes(".."))) return { id, error: "image" };
  const image = file && file !== "-" ? tab.dir + file : "";
  const item = { type: key === "vasi" ? "physical" : "digital", ...names, priceCents, image, maxQty, sold: key === "vasi" ? parseSold(r.venduto) : false };
  if (key === "masterclass") Object.assign(item, linearSeatFields(priceCents, Math.min(maxQty, MAX_QTY))); // legacy: linear tiers
  return { id, item };
}

class SheetError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SheetError";
    this.reason = reason;
  }
}

// Turns CSV text into {items: {id: entry}, dropped: [ids]}. Throws SheetError when the
// sheet as a whole must not be trusted: bad header, duplicate ids, zero valid rows or
// more than half of the rows invalid.
function parseCatalogueCsv(text) {
  let rows;
  try {
    rows = parseCsv(text);
  } catch (_) {
    throw new SheetError("csv_malformed");
  }
  if (!rows.length) throw new SheetError("csv_empty");
  const head = rows[0].map((h) => h.trim());
  const idx = {};
  for (const col of COLUMNS) {
    idx[col] = head.findIndex((h) => h.toLowerCase() === col.toLowerCase());
    if (idx[col] < 0) throw new SheetError("missing_column_" + col);
  }
  const seen = new Set();
  const items = {};
  const dropped = [];
  let total = 0;
  for (const cells of rows.slice(1)) {
    if (cells.every((c) => !c.trim())) continue;
    total++;
    const obj = {};
    for (const col of COLUMNS) obj[col] = cells[idx[col]] || "";
    const id = obj.id.trim();
    if (id) {
      if (seen.has(id)) throw new SheetError("duplicate_id");
      seen.add(id);
    }
    const v = validateRow(obj);
    if (v.error) dropped.push(id || "(empty)");
    else items[v.id] = v.item;
  }
  const valid = Object.keys(items).length;
  if (valid === 0) throw new SheetError("no_valid_rows");
  if (dropped.length * 2 > total) throw new SheetError("too_many_invalid_rows");
  return { items, dropped };
}

// Turns the CSV of one tab into {items: {id: item}, rows: [{id, row}], headers, dropped: [ids], seats}
// (seats: true for the seat schema of the Masterclass tab).
// `row` holds only the whitelisted headers present in the sheet, values as in the sheet (BOM and
// CR stripped). Throws SheetError when the tab as a whole must not be trusted: missing required
// column, duplicate id inside the tab, zero valid rows or more than half of the rows invalid.
function parseTabCsv(key, text) {
  const tab = TABS[key];
  let rows;
  try {
    rows = parseCsv(text);
  } catch (_) {
    throw new SheetError("csv_malformed");
  }
  if (!rows.length) throw new SheetError("csv_empty");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const h of tab.headers) {
    const i = head.indexOf(h);
    if (i >= 0) idx[h] = i;
  }
  const seats = key === "masterclass" && "price_1" in idx; // seat schema; else legacy (spots, price)
  if (seats) {
    for (const h of ["id", "img1"]) if (!(h in idx)) throw new SheetError("missing_column_" + h);
    if (!NAME_COLS.some((h) => h in idx)) throw new SheetError("missing_column_name");
  } else {
    for (const h of tab.required) if (!(h in idx)) throw new SheetError("missing_column_" + h);
  }
  const headers = tab.headers.filter((h) => h in idx).sort((a, b) => idx[a] - idx[b]);
  const seen = new Set();
  const items = {};
  const out = [];
  const dropped = [];
  let total = 0;
  for (const cells of rows.slice(1)) {
    if (cells.every((c) => !c.trim())) continue;
    total++;
    const obj = {};
    for (const h of headers) obj[h] = String(cells[idx[h]] || "").replace(/\r/g, "");
    const id = obj.id.trim();
    if (id) {
      if (seen.has(id)) throw new SheetError("duplicate_id");
      seen.add(id);
    }
    const v = validateTabRow(key, obj, seats);
    if (v.error) {
      dropped.push(id || "(empty)");
    } else {
      items[v.id] = v.item;
      out.push({ id: v.id, row: obj });
    }
  }
  if (!out.length) throw new SheetError("no_valid_rows");
  if (dropped.length * 2 > total) throw new SheetError("too_many_invalid_rows");
  return { items, rows: out, headers, dropped, seats };
}

// ---- fetching --------------------------------------------------------------

// Runs fn(signal) with an abort timer that also covers reading the body.
async function withTimeout(ms, fn) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

function failureReason(err) {
  if (err && err.name === "AbortError") return "timeout";
  if (err && err.reason) return err.reason;
  return "network";
}

async function readCapped(res, max) {
  const len = Number(res.headers && res.headers.get && res.headers.get("content-length"));
  if (len > max) throw new SheetError("too_large");
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        reader.cancel().catch(() => {});
        throw new SheetError("too_large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const t = await res.text();
  if (Buffer.byteLength(t, "utf8") > max) throw new SheetError("too_large");
  return t;
}

async function fetchSheet(url, fetchImpl, timeoutMs, parse) {
  return withTimeout(timeoutMs, async (signal) => {
    const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal, headers: { Accept: "text/csv" } });
    if (!res.ok) throw new SheetError("http_" + res.status);
    return parse(await readCapped(res, MAX_CSV_BYTES));
  });
}

// ---- catalogue -------------------------------------------------------------

let snapshotCache = null;
// The bundled snapshot; masterclass items get the same seat fields as live legacy rows (linear tiers).
function snapshotItems() {
  if (!snapshotCache) {
    snapshotCache = {};
    for (const [id, p] of Object.entries(require("./catalogue.json"))) {
      const mc = p.type === "digital" && String(p.image).startsWith(TABS.masterclass.dir);
      snapshotCache[id] = mc ? { ...p, ...linearSeatFields(p.priceCents, p.maxQty) } : p;
    }
  }
  return snapshotCache;
}

// Snapshot items of one tab: vases are the physical ones, the digital ones are told apart by
// their image folder (masterclass vs gift cards), as build-catalogue.py wrote them.
function snapshotTabItems(key) {
  const out = {};
  for (const [id, p] of Object.entries(snapshotItems())) {
    const k = p.type === "physical" ? "vasi" : String(p.image).startsWith(TABS.masterclass.dir) ? "masterclass" : "certificati";
    if (k === key) out[id] = p;
  }
  return out;
}

function purgeLocal(nowMs) {
  for (const [id, until] of state.local) if (until <= nowMs) state.local.delete(id);
  for (const [k, b] of state.booked) if (b.until <= nowMs) state.booked.delete(k);
}

// Seats booked locally (paid, not yet in the published CSV) per masterclass id.
function localBookedSeats(nowMs) {
  purgeLocal(nowMs);
  const sums = new Map();
  for (const b of state.booked.values()) sums.set(b.id, (sums.get(b.id) || 0) + b.seats);
  return sums;
}

function isSold(id, p, soldList) {
  return !!p.sold || (Array.isArray(soldList) && soldList.includes(id)) || state.local.has(id);
}

// Public item. Masterclass items (tiersCents) also carry the seat fields; for seat-schema rows
// `localBooked` (seats booked locally, not yet in the CSV) is added to the sheet's seats_booked.
function publicItem(p, sold, localBooked = 0) {
  const o = { type: p.type, name_it: p.name_it, name_en: p.name_en, name_ru: p.name_ru, priceCents: p.priceCents, image: p.image, maxQty: p.maxQty, sold };
  if (!p.tiersCents) return o;
  let { seatsBooked, seatsFree } = p;
  if (p.tracked) {
    seatsBooked += localBooked;
    seatsFree = Math.max(0, p.seatsTotal - seatsBooked);
    o.maxQty = Math.min(MAX_GROUP, seatsFree, p.maxGroup);
    o.sold = sold || seatsFree === 0;
  }
  return Object.assign(o, { tiersCents: p.tiersCents.slice(), seatsTotal: p.seatsTotal, seatsBooked, seatsFree });
}

// Copies the items and applies sold.json plus the locally marked ids.
function withSold(items, soldList, nowMs) {
  purgeLocal(nowMs);
  const out = {};
  for (const [id, p] of Object.entries(items)) out[id] = publicItem(p, isSold(id, p, soldList));
  return out;
}

// Returns {data, source} with the fresh or last good content of one sheet (slot `name`, env
// variable `varName`, parser `parse`), or null (with the reason logged).
async function loadSource(name, varName, parse, env, fetchImpl, nowMs, timeoutMs) {
  const tag = name === "legacy" ? {} : { tab: name };
  const chk = checkUrl(env[varName], CSV_HOST);
  if (!chk.url) {
    const ev = chk.reason === "not_configured" ? "catalogue_source_not_configured" : "catalogue_source_rejected";
    warnOnce(ev + varName + chk.reason, { event: ev, variable: varName, reason: chk.reason, fallback: "snapshot" });
    return null;
  }
  const slot = slotOf(name);
  if (slot.cache && nowMs - slot.cache.at < CACHE_TTL_MS) return { data: slot.cache.data, source: "sheet" };
  const staleOk = slot.cache && nowMs - slot.cache.at <= STALE_MAX_MS;
  const stale = () => (staleOk ? { data: slot.cache.data, source: "stale" } : null);
  if (slot.failedAt && nowMs - slot.failedAt < FAIL_BACKOFF_MS) return stale();
  if (!fetchImpl) return stale();
  if (!slot.inflight) {
    slot.inflight = fetchSheet(chk.url, fetchImpl, timeoutMs, parse).finally(() => {
      slot.inflight = null;
    });
  }
  try {
    const data = await slot.inflight;
    slot.cache = { data, at: nowMs };
    slot.failedAt = 0;
    if (data.dropped.length) logLine("warn", { event: "catalogue_rows_dropped", ...tag, count: data.dropped.length, ids: data.dropped.slice(0, MAX_LOGGED_IDS) });
    return { data, source: "sheet" };
  } catch (err) {
    slot.failedAt = nowMs;
    const fallback = staleOk ? "stale" : "snapshot";
    logLine("warn", { event: "catalogue_fetch_failed", ...tag, host: chk.host, reason: failureReason(err), fallback });
    return stale();
  }
}

// Three-tab mode: every tab falls back on its own (stale copy, then snapshot items of its type).
// Merges the tabs in order vasi, masterclass, certificati: an id already taken by an earlier tab
// is rejected from the later one (warn, id only). Returns the getCatalogue() result.
async function getTabbed(env, fetchImpl, nowMs, timeoutMs, soldList) {
  const loaded = await Promise.all(
    TAB_KEYS.map(async (key) => {
      try {
        return await loadSource(key, TABS[key].env, (t) => parseTabCsv(key, t), env, fetchImpl, nowMs, timeoutMs);
      } catch (err) {
        logLine("warn", { event: "catalogue_fetch_failed", tab: key, reason: failureReason(err), fallback: "snapshot" });
        return null;
      }
    })
  );
  const booked = localBookedSeats(nowMs);
  const items = {};
  const sources = {};
  const tabs = {};
  TAB_KEYS.forEach((key, i) => {
    const l = loaded[i];
    const own = l ? l.data.items : snapshotTabItems(key);
    sources[key] = l ? l.source : "snapshot";
    const taken = new Set();
    for (const [id, p] of Object.entries(own)) {
      if (Object.prototype.hasOwnProperty.call(items, id)) {
        warnOnce("dup" + key + id, { event: "catalogue_duplicate_id", tab: key, id });
        continue;
      }
      taken.add(id);
      items[id] = publicItem(p, isSold(id, p, soldList), booked.get(id) || 0);
    }
    if (!l) {
      tabs[key] = null; // the site falls back to its own ODS files
      return;
    }
    const rows = l.data.rows.filter((r) => taken.has(r.id)).map((r) => {
      const row = { ...r.row };
      // effective sold state (sheet OR sold.json OR marked locally), so the site needs no other logic
      if (key === "vasi") row.venduto = items[r.id].sold ? "si" : String(row.venduto || "").trim() ? row.venduto : "no";
      // seat schema: effective seats_booked (sheet + local) and the one computed field, seats_free
      if (l.data.seats) {
        row.seats_booked = String(items[r.id].seatsBooked);
        row.seats_free = String(items[r.id].seatsFree);
      }
      return row;
    });
    tabs[key] = { headers: l.data.headers.slice(), rows };
  });
  const source = Object.values(sources).reduce((w, s) => (RANK[s] > RANK[w] ? s : w), "sheet");
  return { items, source, sources, tabs };
}

// Returns {items: {id: {type,name_it,name_en,name_ru,priceCents,image,maxQty,sold[,tiersCents,
// seatsTotal,seatsBooked,seatsFree: masterclass only]}}, source,
// sources: {vasi,masterclass,certificati}, tabs: {vasi,masterclass,certificati}} with source
// "sheet" | "stale" | "snapshot" (worst of the tabs) and tabs.<tab> = {headers, rows} (display
// data, null when that tab is served from the snapshot). Never throws.
async function getCatalogue({ fetchImpl = globalThis.fetch, now = Date.now, env = process.env, soldList, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const nowMs = now();
  const sold = soldList === undefined ? require("./sold.json") : soldList;
  env = env || {};
  const same = (source) => ({ source, sources: { vasi: source, masterclass: source, certificati: source }, tabs: { vasi: null, masterclass: null, certificati: null } });
  try {
    if (TAB_KEYS.some((k) => env[TABS[k].env] && String(env[TABS[k].env]).trim())) return await getTabbed(env, fetchImpl, nowMs, timeoutMs, sold);
    if (env.CATALOGUE_CSV_URL && String(env.CATALOGUE_CSV_URL).trim()) {
      // DEPRECATED single 9-column sheet, only when none of the tab variables is set.
      const l = await loadSource("legacy", "CATALOGUE_CSV_URL", parseCatalogueCsv, env, fetchImpl, nowMs, timeoutMs);
      if (l) return { items: withSold(l.data.items, sold, nowMs), ...same(l.source) };
    } else {
      warnOnce("not_configured", { event: "catalogue_source_not_configured", variable: TAB_KEYS.map((k) => TABS[k].env).join(","), reason: "not_configured", fallback: "snapshot" });
    }
  } catch (err) {
    logLine("warn", { event: "catalogue_fetch_failed", reason: failureReason(err), fallback: "snapshot" });
  }
  return { items: withSold(snapshotItems(), sold, nowMs), ...same("snapshot") };
}

// Treat these ids as sold immediately, before the published CSV catches up.
function markSoldLocal(ids, { now = Date.now } = {}) {
  const until = now() + LOCAL_SOLD_TTL_MS;
  for (const id of ids || []) if (ID_RE.test(String(id))) state.local.set(String(id), until);
}

// Treat these bookings ([{id, seats}], seats = persons) as made at once, before the published CSV
// catches up. Keyed by session id + item id, so Stripe retries never count a booking twice.
function markBookedLocal(bookings, { now = Date.now, sessionId } = {}) {
  const until = now() + LOCAL_SOLD_TTL_MS;
  for (const b of bookings || []) {
    if (!b || !ID_RE.test(String(b.id)) || !Number.isInteger(b.seats) || b.seats < 1 || b.seats > MAX_GROUP) continue;
    state.booked.set(`${sessionId || "?"}|${b.id}`, { id: String(b.id), seats: b.seats, until });
  }
}

// ---- write-back (Google Apps Script web app) -------------------------------

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One POST attempt. Resolves {ok:true, marked} or {ok:false, reason, retry}.
// `v2`: bookings were sent, so the reply must also carry version 2.
async function postOnce(url, payload, fetchImpl, timeoutMs, v2) {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      // Apps Script answers 302 to a googleusercontent URL; following it (POST -> GET) returns the JSON.
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        redirect: "follow",
        signal,
      });
      if (res.status >= 500) return { ok: false, reason: "http_" + res.status, retry: true };
      let body;
      try {
        body = JSON.parse(await res.text());
      } catch (_) {
        return { ok: false, reason: "non_json", retry: true };
      }
      // An ok reply that does not name the Vasi tab (or, with bookings, is not version 2) comes from an old, not yet redeployed script.
      if (body && body.ok === true) {
        if (body.sheet !== SHEET_NAME || (v2 && body.version !== 2)) return { ok: false, reason: "script_outdated", retry: false };
        return { ok: true, marked: Array.isArray(body.marked) ? body.marked : [], booked: cleanBooked(body.booked) };
      }
      if (body && typeof body.error === "string" && /^[a-z_]{1,30}$/.test(body.error)) return { ok: false, reason: body.error, retry: false };
      return { ok: false, reason: res.ok ? "rejected" : "http_" + res.status, retry: !res.ok && res.status >= 500 };
    });
  } catch (err) {
    return { ok: false, reason: failureReason(err), retry: true };
  }
}

// Keeps only well-formed entries of the script's `booked` reply.
function cleanBooked(list) {
  if (!Array.isArray(list)) return [];
  const num = (v) => (Number.isFinite(v) ? v : null);
  return list
    .filter((b) => b && typeof b === "object" && ID_RE.test(String(b.id)))
    .map((b) => ({ id: String(b.id), seats: num(b.seats), booked_after: num(b.booked_after), total: num(b.total), overbooked: b.overbooked === true, duplicate: b.duplicate === true }));
}

// Marks ids as sold and books masterclass seats ({id, seats} in `bookings`, with the Stripe
// `sessionId` for idempotency) in the sheet, in ONE call. Never throws. Resolves
//   {ok:true, marked[, booked]}  |  {ok:false, reason}  (reason "not_configured" when env is unset,
//   "script_outdated" when an ok reply does not name the Vasi tab or, with bookings, is not version 2)
// Retries (up to 2, short backoff) only on network errors, timeouts, 5xx and non-JSON answers.
async function markSold(ids, { fetchImpl = globalThis.fetch, env = process.env, sleep = defaultSleep, timeoutMs = FETCH_TIMEOUT_MS, bookings, sessionId } = {}) {
  const secret = env && env.CATALOGUE_WRITE_SECRET;
  const chk = checkUrl(env && env.CATALOGUE_WRITE_URL, WRITE_HOST);
  if (!chk.url || !secret) {
    const reason = !chk.url && chk.reason !== "not_configured" ? chk.reason : "not_configured";
    if (reason !== "not_configured") warnOnce("write_rejected" + reason, { event: "catalogue_write_rejected", variable: "CATALOGUE_WRITE_URL", reason });
    return { ok: false, reason };
  }
  if (!fetchImpl) return { ok: false, reason: "no_fetch" };
  const book = (bookings || []).filter((b) => b && ID_RE.test(String(b.id)) && Number.isInteger(b.seats) && b.seats >= 1 && b.seats <= MAX_GROUP).map((b) => ({ id: String(b.id), seats: b.seats }));
  // Contract v2 adds session_id and bookings; with ids only the payload is the one of the first version.
  const payload = JSON.stringify(book.length ? { secret, session_id: String(sessionId || ""), ids: [...ids], bookings: book } : { secret, ids: [...ids] });
  let last = { ok: false, reason: "network" };
  for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
    last = await postOnce(chk.url, payload, fetchImpl, timeoutMs, book.length > 0);
    if (last.ok || !last.retry) break;
    if (attempt < WRITE_RETRIES) await sleep(WRITE_BACKOFF_MS * (attempt + 1));
  }
  if (!last.ok) return { ok: false, reason: last.reason };
  return book.length ? { ok: true, marked: last.marked, booked: last.booked } : { ok: true, marked: last.marked };
}

module.exports = {
  getCatalogue,
  markSold,
  markSoldLocal,
  markBookedLocal,
  parseCsv,
  parseCatalogueCsv,
  parseTabCsv,
  parsePriceCents,
  parseSold,
  checkUrl,
  SheetError,
  _reset,
  CACHE_TTL_MS,
  STALE_MAX_MS,
  LOCAL_SOLD_TTL_MS,
  FAIL_BACKOFF_MS,
  MAX_CSV_BYTES,
};
