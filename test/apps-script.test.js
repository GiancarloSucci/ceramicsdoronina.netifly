// Runs the reference copy tools/apps-script/Code.gs in a vm against an in-memory spreadsheet
// (no Google services), to check the v2 contract: marking, seat booking, Ordini idempotency, safety checks.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CODE = fs.readFileSync(path.join(__dirname, "..", "tools", "apps-script", "Code.gs"), "utf8");

function script(sheets, secret = "S") {
  const mk = (name) => {
    const d = sheets[name];
    return {
      getDataRange: () => ({ getValues: () => d.map((r) => r.slice()) }),
      getRange: (r, c) => ({ setValue: (v) => { d[r - 1][c - 1] = v; } }),
      appendRow: (r) => d.push(r),
    };
  };
  const ss = { getSheetByName: (n) => (sheets[n] ? mk(n) : null), insertSheet: (n) => { sheets[n] = []; return mk(n); } };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => secret }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActive: () => ss },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => s }), MimeType: { JSON: 1 } },
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } }));
}
const fresh = () => ({
  Vasi: [["id", "venduto"], ["v1", ""], ["v3", ""]],
  Masterclass: [["id", "seats_total", "seats_booked"], ["mc1", 8, ""], ["mc2", 4, 3], ["mc3", "", 7]],
});

test("marks vases and books seats in one call (v2 reply)", () => {
  const s = fresh();
  const r = script(s)({ secret: "S", session_id: "cs_1", ids: ["v3"], bookings: [{ id: "mc1", seats: 2 }, { id: "mc2", seats: 2 }, { id: "nope", seats: 1 }] });
  assert.deepEqual(r, {
    ok: true, version: 2, sheet: "Vasi", marked: ["v3"],
    booked: [
      { id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: false }, // blank seats_booked = 0
      { id: "mc2", seats: 2, booked_after: 5, total: 4, overbooked: true, duplicate: false }, // recorded anyway
    ],
  });
  assert.equal(s.Vasi[2][1], "si");
  assert.deepEqual([s.Masterclass[1][2], s.Masterclass[2][2]], [2, 5]);
  assert.deepEqual(s.Ordini.slice(0, 2).map((x) => x.slice(0, 3)), [["session_id", "item_id", "seats"], ["cs_1", "mc1", 2]]);
  assert.match(s.Ordini[1][3], /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.Ordini.length, 3, "unknown id is not recorded");
});

test("idempotent per session and item: a retry reports duplicate and changes nothing; another session adds up", () => {
  const s = fresh();
  const call = script(s);
  call({ secret: "S", session_id: "cs_1", ids: [], bookings: [{ id: "mc1", seats: 2 }] });
  const again = call({ secret: "S", session_id: "cs_1", ids: [], bookings: [{ id: "mc1", seats: 2 }] });
  assert.deepEqual(again.booked, [{ id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: true }]);
  assert.equal(s.Masterclass[1][2], 2);
  assert.equal(s.Ordini.length, 2);
  const other = call({ secret: "S", session_id: "cs_2", ids: [], bookings: [{ id: "mc1", seats: 6 }] });
  assert.deepEqual([other.booked[0].booked_after, other.booked[0].overbooked], [8, false]);
  assert.equal(call({ secret: "S", session_id: "cs_3", ids: [], bookings: [{ id: "mc1", seats: 1 }] }).booked[0].overbooked, true);
});

test("blank seats_total counts as 8; vase-only calls keep working", () => {
  const s = fresh();
  const r = script(s)({ secret: "S", session_id: "cs_1", ids: ["v1"], bookings: [{ id: "mc3", seats: 2 }] });
  assert.deepEqual([r.booked[0].booked_after, r.booked[0].total, r.booked[0].overbooked], [9, 8, true]);
  const v = script(fresh())({ secret: "S", ids: ["v1"] });
  assert.deepEqual(v, { ok: true, version: 2, sheet: "Vasi", marked: ["v1"], booked: [] });
});

test("safety: secret, JSON, id shape, seats range and integer, array caps", () => {
  const s = fresh();
  const call = script(s);
  const err = (b) => call(b).error;
  assert.equal(err({ secret: "x", ids: [] }), "forbidden");
  assert.equal(err("{nope"), "bad_json");
  assert.equal(err({ secret: "S", ids: "v1" }), "bad_ids");
  assert.equal(err({ secret: "S", ids: ["V1"] }), "bad_ids");
  assert.equal(err({ secret: "S", ids: [5] }), "bad_ids");
  assert.equal(err({ secret: "S", ids: Array(31).fill("v1") }), "bad_ids");
  const bk = (b) => err({ secret: "S", session_id: "cs", ids: [], bookings: [b] });
  for (const b of [{ id: "mc1", seats: 0 }, { id: "mc1", seats: 9 }, { id: "mc1", seats: 1.5 }, { id: "mc1", seats: "2" }, { id: "MC1", seats: 1 }, { id: "mc1" }, null]) assert.equal(bk(b), "bad_bookings", JSON.stringify(b));
  assert.equal(err({ secret: "S", ids: [], bookings: [{ id: "mc1", seats: 1 }] }), "bad_bookings", "session_id required");
  assert.equal(err({ secret: "S", session_id: "cs", ids: [], bookings: Array(31).fill({ id: "mc1", seats: 1 }) }), "bad_bookings");
  assert.equal(s.Masterclass[1][2], "", "nothing written by rejected calls");
});

test("missing tabs or columns are reported, not guessed", () => {
  const noMc = { Vasi: fresh().Vasi };
  assert.equal(script(noMc)({ secret: "S", session_id: "c", ids: [], bookings: [{ id: "mc1", seats: 1 }] }).error, "bad_sheet");
  const noCol = fresh();
  noCol.Masterclass[0] = ["id", "seats_total"];
  assert.equal(script(noCol)({ secret: "S", session_id: "c", ids: [], bookings: [{ id: "mc1", seats: 1 }] }).error, "bad_columns");
  assert.equal(script({})({ secret: "S", ids: [] }).error, "bad_sheet");
});
