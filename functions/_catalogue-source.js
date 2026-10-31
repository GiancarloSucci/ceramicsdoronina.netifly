// functions/_catalogue-source.js
// Live catalogue source: a Google Sheet published as CSV (CATALOGUE_CSV_URL), read
// server-side with an in-memory cache and fallbacks, plus the write-back of the
// "sold" marker through a Google Apps Script web app (CATALOGUE_WRITE_URL).
// The leading underscore keeps Netlify from treating this file as a function.
//
// getCatalogue() never throws: sheet (fresh, <= 60 s) -> sheet (stale, <= 24 h)
// -> bundled snapshot (functions/catalogue.json). functions/sold.json and the ids
// marked locally after a payment are merged on top in every case.
// Env: CATALOGUE_CSV_URL (https, docs.google.com only), CATALOGUE_WRITE_URL (https,
// script.google.com only), CATALOGUE_WRITE_SECRET. Secrets and full URLs are never
// logged, only the host.

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
const COLUMNS = ["id", "type", "name_it", "name_en", "name_ru", "price", "image", "maxQty", "sold"];
const SOLD_WORDS = ["true", "1", "yes", "si", "x"];
const MAX_LOGGED_IDS = 20;

const state = { cache: null, failedAt: 0, inflight: null, local: new Map(), warned: new Set() };

function logLine(level, obj) {
  console[level](JSON.stringify(obj));
}

function warnOnce(key, obj) {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  logLine("warn", obj);
}

// Test helper: forget cache, failure back-off, local sold ids and one-time warnings.
function _reset() {
  state.cache = null;
  state.failedAt = 0;
  state.inflight = null;
  state.local.clear();
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

async function fetchSheet(url, fetchImpl, timeoutMs) {
  return withTimeout(timeoutMs, async (signal) => {
    const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal, headers: { Accept: "text/csv" } });
    if (!res.ok) throw new SheetError("http_" + res.status);
    return parseCatalogueCsv(await readCapped(res, MAX_CSV_BYTES));
  });
}

// ---- catalogue -------------------------------------------------------------

function snapshotItems() {
  return require("./catalogue.json");
}

// Copies the items and applies sold.json plus the locally marked ids.
function withSold(items, soldList, nowMs) {
  for (const [id, until] of state.local) if (until <= nowMs) state.local.delete(id);
  const out = {};
  for (const [id, p] of Object.entries(items)) {
    const sold = !!p.sold || (Array.isArray(soldList) && soldList.includes(id)) || state.local.has(id);
    out[id] = { type: p.type, name_it: p.name_it, name_en: p.name_en, name_ru: p.name_ru, priceCents: p.priceCents, image: p.image, maxQty: p.maxQty, sold };
  }
  return out;
}

// Returns the fresh or last good sheet content, or null (with the reason logged).
async function loadSheet(env, fetchImpl, nowMs, timeoutMs) {
  const chk = checkUrl(env.CATALOGUE_CSV_URL, CSV_HOST);
  if (!chk.url) {
    const ev = chk.reason === "not_configured" ? "catalogue_source_not_configured" : "catalogue_source_rejected";
    warnOnce(ev + chk.reason, { event: ev, variable: "CATALOGUE_CSV_URL", reason: chk.reason, fallback: "snapshot" });
    return null;
  }
  if (state.cache && nowMs - state.cache.at < CACHE_TTL_MS) return { sheet: state.cache, source: "sheet" };
  const staleOk = state.cache && nowMs - state.cache.at <= STALE_MAX_MS;
  const stale = () => (staleOk ? { sheet: state.cache, source: "stale" } : null);
  if (state.failedAt && nowMs - state.failedAt < FAIL_BACKOFF_MS) return stale();
  if (!fetchImpl) return stale();
  if (!state.inflight) {
    state.inflight = fetchSheet(chk.url, fetchImpl, timeoutMs).finally(() => {
      state.inflight = null;
    });
  }
  try {
    const { items, dropped } = await state.inflight;
    state.cache = { items, at: nowMs };
    state.failedAt = 0;
    if (dropped.length) logLine("warn", { event: "catalogue_rows_dropped", count: dropped.length, ids: dropped.slice(0, MAX_LOGGED_IDS) });
    return { sheet: state.cache, source: "sheet" };
  } catch (err) {
    state.failedAt = nowMs;
    const fallback = staleOk ? "stale" : "snapshot";
    logLine("warn", { event: "catalogue_fetch_failed", host: chk.host, reason: failureReason(err), fallback });
    return stale();
  }
}

// Returns {items: {id: {type,name_it,name_en,name_ru,priceCents,image,maxQty,sold}}, source}
// with source "sheet" | "stale" | "snapshot". Never throws.
async function getCatalogue({ fetchImpl = globalThis.fetch, now = Date.now, env = process.env, soldList, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const nowMs = now();
  const sold = soldList === undefined ? require("./sold.json") : soldList;
  let loaded = null;
  try {
    loaded = await loadSheet(env || {}, fetchImpl, nowMs, timeoutMs);
  } catch (err) {
    logLine("warn", { event: "catalogue_fetch_failed", reason: failureReason(err), fallback: "snapshot" });
  }
  if (loaded) return { items: withSold(loaded.sheet.items, sold, nowMs), source: loaded.source };
  return { items: withSold(snapshotItems(), sold, nowMs), source: "snapshot" };
}

// Treat these ids as sold immediately, before the published CSV catches up.
function markSoldLocal(ids, { now = Date.now } = {}) {
  const until = now() + LOCAL_SOLD_TTL_MS;
  for (const id of ids || []) if (ID_RE.test(String(id))) state.local.set(String(id), until);
}

// ---- write-back (Google Apps Script web app) -------------------------------

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One POST attempt. Resolves {ok:true, marked} or {ok:false, reason, retry}.
async function postOnce(url, payload, fetchImpl, timeoutMs) {
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
      if (body && body.ok === true) return { ok: true, marked: Array.isArray(body.marked) ? body.marked : [] };
      if (body && typeof body.error === "string" && /^[a-z_]{1,30}$/.test(body.error)) return { ok: false, reason: body.error, retry: false };
      return { ok: false, reason: res.ok ? "rejected" : "http_" + res.status, retry: !res.ok && res.status >= 500 };
    });
  } catch (err) {
    return { ok: false, reason: failureReason(err), retry: true };
  }
}

// Marks ids as sold in the sheet. Never throws. Resolves
//   {ok:true, marked}  |  {ok:false, reason}  (reason "not_configured" when env is unset)
// Retries (up to 2, short backoff) only on network errors, timeouts, 5xx and non-JSON answers.
async function markSold(ids, { fetchImpl = globalThis.fetch, env = process.env, sleep = defaultSleep, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const secret = env && env.CATALOGUE_WRITE_SECRET;
  const chk = checkUrl(env && env.CATALOGUE_WRITE_URL, WRITE_HOST);
  if (!chk.url || !secret) {
    const reason = !chk.url && chk.reason !== "not_configured" ? chk.reason : "not_configured";
    if (reason !== "not_configured") warnOnce("write_rejected" + reason, { event: "catalogue_write_rejected", variable: "CATALOGUE_WRITE_URL", reason });
    return { ok: false, reason };
  }
  if (!fetchImpl) return { ok: false, reason: "no_fetch" };
  const payload = JSON.stringify({ secret, ids: [...ids] });
  let last = { ok: false, reason: "network" };
  for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
    last = await postOnce(chk.url, payload, fetchImpl, timeoutMs);
    if (last.ok || !last.retry) break;
    if (attempt < WRITE_RETRIES) await sleep(WRITE_BACKOFF_MS * (attempt + 1));
  }
  return last.ok ? { ok: true, marked: last.marked } : { ok: false, reason: last.reason };
}

module.exports = {
  getCatalogue,
  markSold,
  markSoldLocal,
  parseCsv,
  parseCatalogueCsv,
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
