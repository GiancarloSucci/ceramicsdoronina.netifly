// Runs the reference copy tools/apps-script/Code.gs in a vm against an in-memory spreadsheet
// (no Google services), to check the v3 contract: marking, seat booking, Ordini idempotency, safety checks, calendar events.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CODE = fs.readFileSync(path.join(__dirname, "..", "tools", "apps-script", "Code.gs"), "utf8");

// Europe/Rome: UTC+2 from the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC, else UTC+1.
const lastSunday = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0, 1)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime(); };
function parseRome(text, zone, fmt) {
  assert.equal(zone, "Europe/Rome");
  assert.equal(fmt, "yyyy-MM-dd HH:mm");
  const [, y, mo, d, h, mi] = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const summer = asUtc - 2 * 3600e3 >= lastSunday(y, 2) && asUtc - 3600e3 < lastSunday(y, 9);
  return new Date(asUtc - (summer ? 2 : 1) * 3600e3);
}
// Fake calendar: only getName/createEvent exist, so touching or fetching an existing event would throw.
function fakeCalendar() {
  const created = [];
  return {
    created,
    failWith: null,
    getDefaultCalendar() {
      const self = this;
      return {
        getName: () => "Owner",
        createEvent(title, start, end, opts) {
          if (self.failWith) throw new Error(self.failWith);
          const ev = { id: "ev" + (created.length + 1), flags: [], getId() { return this.id; } };
          for (const f of ["SeeGuests", "InviteOthers", "Modify"]) ev["setGuestsCan" + f] = (v) => ev.flags.push([f, v]);
          created.push({ title, start, end, opts, ev });
          return ev;
        },
      };
    },
  };
}

// `others`: other spreadsheets by id for SpreadsheetApp.openById (ORDERS_SPREADSHEET_ID); SpreadsheetApp.create adds new ones
// (`created`, ids auto1, auto2, ...). `meta` records formats, bold, frozen rows, filters and backgrounds per tab (key: spreadsheet id + ":" + tab).
// Locks and properties are fakes; `logs` collects Logger.log; `failCreate` / `failOpen` make Google refuse.
function script(sheets, secret = "S", { props = {}, calendar = fakeCalendar(), others = {}, meta = {}, failCreate = false, failOpen = false } = {}) {
  const created = [];
  const logs = [];
  const locks = { held: 0, taken: 0 };
  const book = (tabs, tag, id) => {
    const mk = (name) => {
      const d = tabs[name];
      const m = (meta[tag + name] = meta[tag + name] || { formats: {}, bold: [], frozen: 0, filters: [], backgrounds: {} });
      return {
        getDataRange: () => ({ getValues: () => d.map((r) => r.slice()), getDisplayValues: () => d.map((r) => r.map((c) => (c instanceof Date ? "DATE-OBJECT" : String(c)))) }),
        getRange: (r, c, nr = 1, nc = 1) => ({
          setValue: (v) => { d[r - 1][c - 1] = v; },
          setValues: (vs) => vs.forEach((row, i) => { while (d.length < r + i) d.push([]); row.forEach((v, j) => { d[r - 1 + i][c - 1 + j] = v; }); }),
          setNumberFormat: (f) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) m.formats[`${r + i},${c + j}`] = f; },
          setFontWeight: (w) => m.bold.push([r, c, nr, nc, w]),
          setBackground: (color) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) m.backgrounds[`${r + i},${c + j}`] = color; },
          createFilter: () => m.filters.push([r, c, nc]),
        }),
        appendRow: (r) => d.push(r),
        getLastRow: () => d.length,
        getMaxRows: () => 1000,
        setFrozenRows: (n) => { m.frozen = n; },
        getName: () => name,
      };
    };
    return {
      getSheetByName: (n) => (tabs[n] ? mk(n) : null),
      insertSheet: (n) => { tabs[n] = []; return mk(n); },
      getSheets: () => Object.keys(tabs).map(mk),
      deleteSheet: (sh) => { delete tabs[sh.getName()]; },
      getId: () => id,
      getUrl: () => "https://docs.google.com/spreadsheets/d/" + id + "/edit",
    };
  };
  const ss = book(sheets, "", "bound");
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === "SECRET" ? secret : props[k] === undefined ? null : props[k]), setProperty: (k, v) => { props[k] = v; } }) },
    CalendarApp: calendar,
    Utilities: { parseDate: parseRome },
    LockService: { getScriptLock: () => ({ waitLock() { locks.taken++; locks.held++; }, releaseLock() { locks.held--; } }) },
    Logger: { log: (m) => logs.push(String(m)) },
    SpreadsheetApp: {
      getActive: () => ss,
      openById: (id) => { if (failOpen || !others[id]) throw new Error("no access to " + id); return book(others[id], id + ":", id); },
      create: (name) => {
        if (failCreate) throw new Error("drive refused");
        const id = "auto" + (created.length + 1);
        others[id] = { Sheet1: [] }; // Google gives a new file one empty default sheet
        created.push({ id, name });
        return book(others[id], id + ":", id);
      },
    },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => s }), MimeType: { JSON: 1 } },
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } }));
  call.calendar = calendar;
  call.authorize = () => ctx.authorize();
  call.get = () => JSON.parse(ctx.doGet());
  call.meta = meta;
  call.props = props;
  call.created = created;
  call.logs = logs;
  call.locks = locks;
  call.orderTabs = () => others[props.ORDERS_SPREADSHEET_ID]; // tabs of the separate orders spreadsheet
  return call;
}
const NO_ORDER = { status: "skipped", reason: "no_order", rows: 0 }; // calls without `order` (an older Netlify function)
const SKIP = { status: "skipped", reason: "bad_date" }; // the default fixture has no date/time columns
const fresh = () => ({
  Vasi: [["id", "venduto"], ["v1", ""], ["v3", ""]],
  Masterclass: [["id", "seats_total", "seats_booked"], ["mc1", 8, ""], ["mc2", 4, 3], ["mc3", "", 7]],
});

test("marks vases and books seats in one call (v2 reply)", () => {
  const s = fresh();
  const r = script(s)({ secret: "S", session_id: "cs_1", ids: ["v3"], bookings: [{ id: "mc1", seats: 2 }, { id: "mc2", seats: 2 }, { id: "nope", seats: 1 }] });
  assert.deepEqual(r, {
    ok: true, version: 11, sheet: "Vasi", marked: ["v3"], oversold: [], orders: NO_ORDER,
    booked: [
      { id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: false, calendar: SKIP }, // blank seats_booked = 0
      { id: "mc2", seats: 2, booked_after: 5, total: 4, overbooked: true, duplicate: false, calendar: SKIP }, // recorded anyway
    ],
  });
  assert.equal(s.Vasi[2][1], "si");
  assert.deepEqual([s.Masterclass[1][2], s.Masterclass[2][2]], [2, 5]);
  assert.deepEqual(s.Ordini.slice(0, 3).map((x) => x.slice(0, 3)), [["session_id", "item_id", "seats"], ["cs_1", "v3", 0], ["cs_1", "mc1", 2]]); // the piece is logged first
  assert.match(s.Ordini[2][3], /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.Ordini.length, 4, "header + the piece + 2 known bookings; the unknown booking id is not recorded");
});

test("idempotent per session and item: a retry reports duplicate and changes nothing; another session adds up", () => {
  const s = fresh();
  const call = script(s);
  call({ secret: "S", session_id: "cs_1", ids: [], bookings: [{ id: "mc1", seats: 2 }] });
  const again = call({ secret: "S", session_id: "cs_1", ids: [], bookings: [{ id: "mc1", seats: 2 }] });
  assert.deepEqual(again.booked, [{ id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: true, calendar: SKIP }]);
  assert.equal(s.Masterclass[1][2], 2);
  assert.equal(s.Ordini.length, 2);
  const other = call({ secret: "S", session_id: "cs_2", ids: [], bookings: [{ id: "mc1", seats: 6 }] });
  assert.deepEqual([other.booked[0].booked_after, other.booked[0].overbooked], [8, false]);
  assert.equal(call({ secret: "S", session_id: "cs_3", ids: [], bookings: [{ id: "mc1", seats: 1 }] }).booked[0].overbooked, true);
});

test("blank seats_total (or no column) means unlimited: total null, never overbooked; vase-only calls keep working", () => {
  const s = fresh();
  const r = script(s)({ secret: "S", session_id: "cs_1", ids: ["v1"], bookings: [{ id: "mc3", seats: 20 }] });
  assert.deepEqual([r.booked[0].booked_after, r.booked[0].total, r.booked[0].overbooked], [27, null, false]);
  const again = script(s)({ secret: "S", session_id: "cs_1", ids: [], bookings: [{ id: "mc3", seats: 20 }] });
  assert.deepEqual([again.booked[0].total, again.booked[0].overbooked, again.booked[0].duplicate], [null, false, true]);
  const noCol = { ...fresh(), Masterclass: [["id", "seats_booked"], ["mc1", 100]] };
  const n = script(noCol)({ secret: "S", session_id: "cs_2", ids: [], bookings: [{ id: "mc1", seats: 1 }] });
  assert.deepEqual([n.booked[0].booked_after, n.booked[0].total, n.booked[0].overbooked], [101, null, false]);
  const text = { ...fresh(), Masterclass: [["id", "seats_total", "seats_booked"], ["mc1", "many", 5]] };
  assert.deepEqual([script(text)({ secret: "S", session_id: "cs_3", ids: [], bookings: [{ id: "mc1", seats: 1 }] }).booked[0].total], [null], "non-numeric cell: unknown");
  const v = script(fresh())({ secret: "S", ids: ["v1"] });
  assert.deepEqual(v, { ok: true, version: 11, sheet: "Vasi", marked: ["v1"], oversold: [], booked: [], orders: NO_ORDER });
});

test("limited seats_total above 8 and seats 20 work; seats up to 999 are valid, 1000 is rejected", () => {
  const s = { ...fresh(), Masterclass: [["id", "seats_total", "seats_booked"], ["mc1", 30, 5]] };
  const call = script(s);
  const r = call({ secret: "S", session_id: "cs_1", ids: [], bookings: [{ id: "mc1", seats: 20 }] });
  assert.deepEqual([r.booked[0].booked_after, r.booked[0].total, r.booked[0].overbooked], [25, 30, false]);
  assert.equal(call({ secret: "S", session_id: "cs_2", ids: [], bookings: [{ id: "mc1", seats: 6 }] }).booked[0].overbooked, true);
  assert.equal(call({ secret: "S", session_id: "cs_3", ids: [], bookings: [{ id: "mc1", seats: 1000 }] }).error, "bad_bookings");
  assert.equal(call({ secret: "S", session_id: "cs_4", ids: [], bookings: [{ id: "mc1", seats: 999 }] }).booked[0].overbooked, true, "999 accepted (and overbooks 30 seats)");
  const free = script({ ...fresh(), Masterclass: [["id", "seats_total", "seats_booked"], ["mc1", "", 0]] });
  assert.deepEqual([21, 150, 999].map((n, i) => free({ secret: "S", session_id: "cs_u" + i, ids: [], bookings: [{ id: "mc1", seats: n }] }).booked[0].overbooked), [false, false, false]);
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
  for (const b of [{ id: "mc1", seats: 0 }, { id: "mc1", seats: 1000 }, { id: "mc1", seats: 1.5 }, { id: "mc1", seats: "2" }, { id: "MC1", seats: 1 }, { id: "mc1" }, null]) assert.equal(bk(b), "bad_bookings", JSON.stringify(b));
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

// ---- calendar ----
const MCH = ["id", "name_it", "name_en", "name_ru", "date", "time", "seats_total", "seats_booked"];
const cal = (extra = {}) => ({
  Vasi: [["id", "venduto"]],
  Masterclass: [MCH, ["mc1", "Corso base", "Basic class", "Базовый курс", "15.06.2099", "10:00-13:30", 8, ""], ["mc2", "", "Only EN", "", "2099-06-16", "18:30", 8, ""]],
  ...extra,
});
const OWNER = { OWNER_GUEST_EMAIL: "colleague@example.com" };
const book = (call, sid, id, seats, customer = { email: "ann@example.com", name: "Ann", locale: "it" }) =>
  call({ secret: "S", session_id: sid, ids: [], bookings: [{ id, seats }], customer }).booked[0];

test("calendar: one event per booking, two bookings of the same workshop never share an event or guests", () => {
  const s = cal();
  const call = script(s, "S", { props: OWNER });
  const a = book(call, "cs_aaaaaaaa11111111", "mc1", 2, { email: "ann@example.com", name: "Ann", locale: "it" });
  const b = book(call, "cs_bbbbbbbb22222222", "mc1", 3, { email: "bob@example.com", name: "Bob", locale: "en" });
  assert.deepEqual([a.calendar, b.calendar], [{ status: "created" }, { status: "created" }]);
  const c = call.calendar.created;
  assert.equal(c.length, 2);
  assert.notEqual(c[0].ev.id, c[1].ev.id);
  assert.equal(c[0].opts.guests, "ann@example.com,colleague@example.com");
  assert.equal(c[1].opts.guests, "bob@example.com,colleague@example.com");
  assert.ok(!c[0].opts.description.includes("bob") && !c[1].opts.description.includes("ann@"));
  assert.deepEqual([c[0].start.getTime(), c[0].end.getTime()], [c[1].start.getTime(), c[1].end.getTime()], "same time slot");
  assert.deepEqual(s.Ordini.map((r) => r[4]), ["event_id", "ev1", "ev2"]);
});

test("calendar: event options, privacy flags, description is booking facts only", () => {
  const call = script(cal(), "S", { props: OWNER });
  book(call, "cs_aaaaaaaa11111111", "mc1", 2);
  const { title, opts, ev } = call.calendar.created[0];
  assert.equal(title, "Corso base (2 persone)");
  assert.equal(opts.sendInvites, true);
  assert.deepEqual(ev.flags, [["SeeGuests", false], ["InviteOthers", false], ["Modify", false]]);
  assert.equal(opts.description, "Masterclass: mc1\nPersons: 2\nCustomer: Ann\nEmail: ann@example.com\nBooking reference: 11111111");
});

test("calendar: owner guests come from OWNER_GUEST_EMAIL (list, validated, deduplicated); missing property still creates", () => {
  let call = script(cal(), "S", { props: { OWNER_GUEST_EMAIL: " a@x.it, not-an-email ,b@x.it,ANN@example.com" } });
  book(call, "cs_1", "mc1", 1);
  assert.equal(call.calendar.created[0].opts.guests, "ann@example.com,a@x.it,b@x.it");
  for (const props of [{}, { OWNER_GUEST_EMAIL: "" }, { OWNER_GUEST_EMAIL: "junk" }]) {
    call = script(cal(), "S", { props });
    const r = book(call, "cs_1", "mc1", 1);
    assert.deepEqual(r.calendar, { status: "created", reason: "owner_guest_missing" });
    assert.equal(call.calendar.created[0].opts.guests, "ann@example.com");
  }
});

test("calendar: invalid or missing customer email invites only the owner guest and is reported", () => {
  let call = script(cal(), "S", { props: OWNER });
  let r = book(call, "cs_1", "mc1", 1, { email: "no at sign", name: "X", locale: "it" });
  assert.deepEqual(r.calendar, { status: "created", reason: "customer_email_invalid" });
  assert.equal(call.calendar.created[0].opts.guests, "colleague@example.com");
  call = script(cal(), "S", { props: OWNER });
  r = call({ secret: "S", session_id: "cs_2", ids: [], bookings: [{ id: "mc1", seats: 1 }] }).booked[0];
  assert.equal(r.calendar.reason, "no_customer_email");
  assert.equal(call.calendar.created[0].opts.guests, "colleague@example.com");
});

test("calendar: titles by locale with fallbacks and Russian plurals; customer fields are capped", () => {
  const titles = (locale, seats, id = "mc1") => {
    const call = script(cal(), "S", { props: OWNER });
    book(call, "cs_1", id, seats, { email: "a@b.it", locale });
    return call.calendar.created[0].title;
  };
  assert.equal(titles("it", 1), "Corso base (1 persona)");
  assert.equal(titles("en", 1), "Basic class (1 person)");
  assert.equal(titles("en", 5), "Basic class (5 people)");
  assert.equal(titles("ru", 1), "Базовый курс (1 человек)");
  assert.equal(titles("ru", 2), "Базовый курс (2 человека)");
  assert.equal(titles("ru", 4), "Базовый курс (4 человека)");
  assert.equal(titles("ru", 5), "Базовый курс (5 человек)");
  assert.equal(titles("ru", 8), "Базовый курс (8 человек)");
  for (const [n, w] of [[11, "человек"], [12, "человек"], [21, "человек"], [22, "человека"], [25, "человек"], [101, "человек"], [111, "человек"], [112, "человек"], [122, "человека"], [999, "человек"]]) assert.equal(titles("ru", n), `Базовый курс (${n} ${w})`, "ru " + n);
  assert.equal(titles("en", 150), "Basic class (150 people)");
  assert.equal(titles("it", 150), "Corso base (150 persone)");
  assert.equal(titles("xx", 2), "Corso base (2 persone)", "unknown locale = it");
  assert.equal(titles("it", 2, "mc2"), "Only EN (2 persone)", "fallback it, en, ru");
  const s = cal();
  s.Masterclass.push(["mc9", "", "", "", "15.06.2099", "10:00", 8, ""]);
  const call = script(s, "S", { props: OWNER });
  book(call, "cs_1", "mc9", 2, { email: "a@b.it" });
  assert.equal(call.calendar.created[0].title, "mc9 (2 persone)", "id when no title at all");
  const long = script(cal(), "S", { props: OWNER });
  book(long, "cs_2", "mc1", 1, { email: "a@b.it", name: "N".repeat(500) });
  assert.equal(long.calendar.created[0].opts.description.split("\n")[2], "Customer: " + "N".repeat(100));
});

test("calendar: date and time formats, Europe/Rome time zone (summer and winter)", () => {
  const when = (date, time) => {
    const s = cal();
    s.Masterclass[1][4] = date;
    s.Masterclass[1][5] = time;
    const call = script(s, "S", { props: OWNER });
    const r = book(call, "cs_1", "mc1", 1);
    return { r, ev: call.calendar.created[0] };
  };
  const iso = (d) => d.toISOString();
  let x = when("15.06.2099", "10:00-13:30");
  assert.deepEqual([iso(x.ev.start), iso(x.ev.end)], ["2099-06-15T08:00:00.000Z", "2099-06-15T11:30:00.000Z"]);
  for (const d of ["15/06/2099", "15-06-2099", "2099-06-15", "5.6.2099"]) {
    x = when(d, "10:00");
    const day = d === "5.6.2099" ? "05" : "15";
    assert.equal(iso(x.ev.start), `2099-06-${day}T08:00:00.000Z`, d);
    assert.equal(iso(x.ev.end), `2099-06-${day}T10:00:00.000Z`, "single time lasts 2 h");
  }
  for (const t of ["10:00 – 13:30", "10:00\u201313:30", "10:00 - 13:30", "10:00\u201413:30"]) assert.equal(iso(when("15.06.2099", t).ev.end), "2099-06-15T11:30:00.000Z", t);
  x = when("15.12.2099", "10:00");
  assert.equal(iso(x.ev.start), "2099-12-15T09:00:00.000Z", "winter = UTC+1");
});

test("calendar: unparsable date or time and past date skip the event without touching the booking", () => {
  const run = (date, time) => {
    const s = cal();
    s.Masterclass[1][4] = date;
    s.Masterclass[1][5] = time;
    const call = script(s, "S", { props: OWNER });
    const r = book(call, "cs_1", "mc1", 2);
    return { r, call, s };
  };
  for (const [d, t] of [["soon", "10:00"], ["31.02.2099", "10:00"], ["15.06.2099", "late"], ["15.06.2099", "25:00"], ["15.06.2099", "13:00-10:00"], ["", ""]]) {
    const { r, call, s } = run(d, t);
    assert.deepEqual(r.calendar, { status: "skipped", reason: "bad_date" }, `${d} ${t}`);
    assert.equal(call.calendar.created.length, 0);
    assert.equal(s.Masterclass[1][7], 2, "seats still booked");
    assert.equal(s.Ordini[1][4], "", "no event id");
  }
  const past = run("15.06.2000", "10:00");
  assert.deepEqual(past.r.calendar, { status: "skipped", reason: "date_in_past" });
  assert.equal(past.call.calendar.created.length, 0);
  const typed = cal();
  typed.Masterclass[1][4] = new Date(2099, 5, 15); // a Date-typed cell: read as display text, here not parsable
  assert.equal(script(typed, "S", { props: OWNER })({ secret: "S", session_id: "c", ids: [], bookings: [{ id: "mc1", seats: 1 }] }).booked[0].calendar.status, "skipped");
});

test("calendar: retry of a booking without event_id creates the event; with event_id reports exists", () => {
  const s = cal();
  const call = script(s, "S", { props: OWNER });
  call.calendar.failWith = "Calendar service down";
  const first = book(call, "cs_1", "mc1", 2);
  assert.deepEqual(first.calendar, { status: "failed", reason: "calendar_error" });
  assert.equal(s.Masterclass[1][7], 2, "calendar failure does not undo the seat booking");
  assert.equal(s.Ordini[1][1], "mc1");
  assert.equal(s.Ordini[1][4], "");
  call.calendar.failWith = null;
  const retry = book(call, "cs_1", "mc1", 2);
  assert.deepEqual([retry.duplicate, retry.calendar], [true, { status: "created" }]);
  assert.equal(retry.booked_after, 2);
  assert.equal(s.Masterclass[1][7], 2, "seats not added twice");
  assert.equal(s.Ordini[1][4], "ev1");
  const again = book(call, "cs_1", "mc1", 2);
  assert.deepEqual(again.calendar, { status: "exists" });
  assert.equal(call.calendar.created.length, 1, "no second event");
  assert.equal(s.Ordini.length, 2);
});

test("calendar: Ordini with the old 4 columns is migrated, other headers are still rejected", () => {
  const s = cal({ Ordini: [["session_id", "item_id", "seats", "at"], ["cs_old", "mc1", 1, "2099-01-01T00:00:00Z"]] });
  const call = script(s, "S", { props: OWNER });
  const old = book(call, "cs_old", "mc1", 1);
  assert.equal(s.Ordini[0][4], "event_id");
  assert.deepEqual([old.duplicate, old.calendar.status], [true, "created"], "old row has no event: created now");
  assert.equal(s.Ordini[1][4], "ev1");
  const fresh1 = book(call, "cs_new", "mc1", 1);
  assert.equal(fresh1.duplicate, false);
  assert.equal(s.Ordini[2][4], "ev2");
  for (const bad of [["session_id", "item_id", "seats"], ["session_id", "item_id", "seats", "at", "other"], ["x", "y", "z", "w"]]) {
    const t = cal({ Ordini: [bad] });
    assert.equal(script(t, "S", { props: OWNER })({ secret: "S", session_id: "c", ids: [], bookings: [{ id: "mc1", seats: 1 }] }).error, "bad_orders", bad.join());
    assert.equal(t.Masterclass[1][7], "");
  }
});

test("calendar: CALENDAR_ID selects another calendar; authorize() reads the default calendar name", () => {
  const used = [];
  const calendar = fakeCalendar();
  calendar.getCalendarById = (id) => { used.push(id); return calendar.getDefaultCalendar(); };
  const call = script(cal(), "S", { props: { ...OWNER, CALENDAR_ID: "x@group.calendar.google.com" }, calendar });
  assert.equal(book(call, "cs_1", "mc1", 1).calendar.status, "created");
  assert.deepEqual(used, ["x@group.calendar.google.com"]);
  assert.equal(call.authorize(), "Owner");
});

test("calendar: no customer data in Ordini or in the reply", () => {
  const s = cal();
  const call = script(s, "S", { props: OWNER });
  const raw = JSON.stringify(call({ secret: "S", session_id: "cs_1", ids: [], bookings: [{ id: "mc1", seats: 1 }], customer: { email: "ann@example.com", name: "Ann" } }));
  assert.ok(!raw.includes("ann@example.com") && !raw.includes("Ann"));
  assert.ok(!JSON.stringify(s.Ordini).includes("ann@example.com"));
});

test("doGet names the deployed contract version and nothing else (no secret, no sheet data)", () => {
  const r = script(fresh(), "TOPSECRET").get();
  assert.deepEqual(r, { ok: true, script: "ceramicsdoronina-catalogue", version: 11 });
});

// ---- order log (contract v4): private tabs per kind in a SEPARATE spreadsheet, full customer record, four consents ----
const HEAD = ["data_ora", "session_id", "tipo", "nome", "email", "telefono", "consenso_email", "consenso_altri_canali", "consenso_terzi", "consenso_ordine", "item_id", "prodotto", "quantita", "persone", "importo_riga", "valuta", "totale_ordine", "fatt_indirizzo", "fatt_cap", "fatt_citta", "fatt_provincia", "fatt_paese", "sped_nome", "sped_indirizzo", "sped_cap", "sped_citta", "sped_provincia", "sped_paese", "lingua", "versione_informativa", "data_consenso", "calendar_event_id"];
const COL = Object.fromEntries(HEAD.map((h, i) => [h, i]));
const CUST = {
  email: "ann@example.com", name: "Ann Rossi", phone: "+39 380 632 7838", locale: "it",
  billing: { line1: "Via Roma 1", line2: "int. 4", city: "Genova", postal_code: "16123", state: "GE", country: "IT" },
  shipping: { name: "Ann R.", line1: "Via Po 2", city: "Torino", postal_code: "10100", country: "IT" },
};
const CONSENT = { privacy: true, email_marketing: true, other_channels: false, third_party: false, privacy_version: "2026-11-04", at: "2026-11-04T10:00:00.000Z" };
const line = (id, kind, o = {}) => ({ id, kind, name: id + " name", quantity: 1, amount_cents: 10000, ...o });
const ORD = (lines, o = {}) => ({ total_cents: 31000, currency: "eur", created_iso: "2026-11-04T09:59:00.000Z", lines, ...o });
const send = (call, order, o = {}) => call({ secret: "S", session_id: "cs_ord1", ids: [], bookings: [], customer: CUST, order, consent: CONSENT, ...o });
const withOrders = (extra = {}) => ({ props: { ORDERS_SPREADSHEET_ID: "ord1" }, others: { ord1: {} }, ...extra }); // an existing separate file
const TABS3 = ["Ordini_Certificati", "Ordini_Masterclass", "Ordini_Vasi"];

test("order log: one row per line in the private tab of its kind, columns in the agreed order, header bold, frozen and filtered", () => {
  const s = fresh();
  const opts = withOrders();
  const call = script(s, "S", opts);
  const r = send(call, ORD([line("v1", "vasi"), line("mc1", "masterclass", { seats: 3, amount_cents: 18000 }), line("gc-50", "certificati", { amount_cents: 5000 })]), { ids: ["v1"] });
  assert.deepEqual(r.orders, { status: "ok", rows: 3 });
  const o = opts.others.ord1;
  assert.deepEqual(Object.keys(o).sort(), TABS3);
  assert.deepEqual(o.Ordini_Vasi[0], HEAD);
  assert.deepEqual(HEAD.slice(0, 10), ["data_ora", "session_id", "tipo", "nome", "email", "telefono", "consenso_email", "consenso_altri_canali", "consenso_terzi", "consenso_ordine"]);
  assert.deepEqual(o.Ordini_Vasi[1], [
    "2026-11-04T09:59:00.000Z", "cs_ord1", "vasi", "Ann Rossi", "ann@example.com", "+39 380 632 7838", "SI", "NO", "NO", "SI",
    "v1", "v1 name", 1, "", 100, "EUR", 310,
    "Via Roma 1, int. 4", "16123", "Genova", "GE", "IT",
    "Ann R.", "Via Po 2", "10100", "Torino", "", "IT",
    "it", "2026-11-04", "2026-11-04T10:00:00.000Z", "",
  ]);
  assert.deepEqual([o.Ordini_Masterclass[1][COL.quantita], o.Ordini_Masterclass[1][COL.persone], o.Ordini_Masterclass[1][COL.importo_riga]], [1, 3, 180], "persons in persone, euros in importo_riga");
  assert.equal(o.Ordini_Certificati[1][COL.item_id], "gc-50");
  const m = call.meta["ord1:Ordini_Vasi"];
  assert.deepEqual([m.frozen, m.bold.length, m.filters.length], [1, 1, 1]);
  assert.deepEqual(m.filters[0].slice(0, 2), [1, 1], "filter starts at the header row, column A");
  assert.equal(m.formats["2,6"], "@", "phone column (6th) is plain text");
  assert.ok(!Object.keys(s).some((k) => k.startsWith("Ordini_")), "nothing in the bound spreadsheet");
});

test("order log: four consents as SI/NO; light red when email is refused, light green when other channels or third parties are allowed", () => {
  const opts = withOrders();
  const call = script(fresh(), "S", opts);
  send(call, ORD([line("v1", "vasi")]), { session_id: "cs_a", consent: { ...CONSENT, email_marketing: false } }); // refuses email
  send(call, ORD([line("v3", "vasi")]), { session_id: "cs_b", consent: { ...CONSENT, other_channels: true, third_party: true } }); // allows everything
  send(call, ORD([line("v1", "vasi")]), { session_id: "cs_c", consent: undefined }); // old session, nothing recorded
  send(call, ORD([line("v3", "vasi")]), { session_id: "cs_d", consent: { privacy: true, marketing_optout: false } }); // payload of the previous contract: not objected
  const t = opts.others.ord1.Ordini_Vasi;
  const flags = (r) => [t[r][COL.consenso_email], t[r][COL.consenso_altri_canali], t[r][COL.consenso_terzi], t[r][COL.consenso_ordine]];
  assert.deepEqual(flags(1), ["NO", "NO", "NO", "SI"]);
  assert.deepEqual(flags(2), ["SI", "SI", "SI", "SI"]);
  assert.deepEqual(flags(3), ["NO", "NO", "NO", "NO"], "nothing recorded: no right, privacy not recorded");
  assert.deepEqual(flags(4), ["SI", "NO", "NO", "SI"], "marketing_optout false maps to email allowed");
  assert.deepEqual([t[3][COL.versione_informativa], t[3][COL.data_consenso]], ["", ""]);
  const bg = call.meta["ord1:Ordini_Vasi"].backgrounds;
  assert.deepEqual(bg, { "2,7": "#fde2e2", "3,8": "#e2f3e2", "3,9": "#e2f3e2", "4,7": "#fde2e2" });
});

test("order log: idempotent per (session_id, item_id); a retry reports the same rows and writes nothing; another session adds rows", () => {
  const opts = withOrders();
  const call = script(fresh(), "S", opts);
  const order = ORD([line("v1", "vasi"), line("v3", "vasi")]);
  assert.deepEqual(send(call, order).orders, { status: "ok", rows: 2 });
  assert.deepEqual(send(call, order).orders, { status: "ok", rows: 2 });
  const t = opts.others.ord1.Ordini_Vasi;
  assert.equal(t.length, 3);
  send(call, ORD([line("v1", "vasi")]), { session_id: "cs_ord2" });
  assert.equal(t.length, 4);
  send(call, ORD([line("v1", "vasi"), line("v1", "vasi")]), { session_id: "cs_ord3" });
  assert.equal(t.length, 5, "the same id twice in one call is logged once");
  assert.equal(call.meta["ord1:Ordini_Vasi"].filters.length, 1, "the filter is created once, with the tab");
});

test("order log: formula injection is neutralised (apostrophe on = + - @ after trimming tab/CR); the phone is plain text and keeps its +", () => {
  const opts = withOrders();
  const evil = { ...CUST, name: '=HYPERLINK("http://x","y")', email: "@evil.it", locale: "it", billing: { line1: "+1+1", city: "-2", postal_code: "\t=2", country: "\r" }, shipping: { name: "=1", line1: "@x" }, phone: "+39 380" };
  const call = script(fresh(), "S", opts);
  send(call, ORD([line("v1", "vasi", { name: "=cmd|' /C calc'!A0" })]), { customer: evil });
  const t = opts.others.ord1.Ordini_Vasi;
  const row = t[1];
  assert.equal(row[COL.prodotto], "'=cmd|' /C calc'!A0");
  assert.deepEqual([row[COL.nome], row[COL.email], row[COL.fatt_indirizzo], row[COL.fatt_citta], row[COL.fatt_cap], row[COL.fatt_paese], row[COL.sped_nome], row[COL.sped_indirizzo]], ["'=HYPERLINK(\"http://x\",\"y\")", "'@evil.it", "'+1+1", "'-2", "'=2", "", "'=1", "'@x"]);
  assert.equal(row[COL.telefono], "+39 380", "phone: no apostrophe, the cell is plain text");
  assert.equal(call.meta["ord1:Ordini_Vasi"].formats["2,6"], "@");
  send(call, ORD([line("v3", "vasi")]), { session_id: "cs_ph", customer: { ...CUST, phone: "=1+1" } });
  assert.equal(t[2][COL.telefono], "'=1+1");
  assert.deepEqual([row[COL.quantita], row[COL.importo_riga], row[COL.valuta]], [1, 100, "EUR"]);
});

test("order log: the master class line carries the calendar event id of its booking; old tab Ordini is untouched in shape", () => {
  const s = cal();
  const opts = withOrders({ props: { ...OWNER, ORDERS_SPREADSHEET_ID: "ord1" } });
  const call = script(s, "S", opts);
  const r = send(call, ORD([line("mc1", "masterclass", { seats: 2 })]), { session_id: "cs_aaaaaaaa11111111", bookings: [{ id: "mc1", seats: 2 }] });
  assert.deepEqual([r.booked[0].calendar.status, r.orders], ["created", { status: "ok", rows: 1 }]);
  const t = opts.others.ord1.Ordini_Masterclass;
  assert.equal(t[1][COL.calendar_event_id], "ev1");
  assert.deepEqual(s.Ordini[0], ["session_id", "item_id", "seats", "at", "event_id"]);
  send(call, ORD([line("mc1", "masterclass", { seats: 2 })]), { session_id: "cs_aaaaaaaa11111111", bookings: [{ id: "mc1", seats: 2 }] });
  assert.equal(t.length, 2);
  assert.equal(call.calendar.created.length, 1);
});

test("separate spreadsheet: without ORDERS_SPREADSHEET_ID one private file is created, its id stored, its URL only in Logger; never the bound sheet", () => {
  const s = fresh();
  const call = script(s);
  const r = send(call, ORD([line("v1", "vasi")]), { ids: ["v1"] });
  assert.deepEqual(r.orders, { status: "ok", rows: 1 });
  assert.deepEqual(call.created, [{ id: "auto1", name: "Ceramics Doronina - Ordini" }]);
  assert.equal(call.props.ORDERS_SPREADSHEET_ID, "auto1");
  assert.equal(call.orderTabs().Ordini_Vasi.length, 2);
  assert.ok(!Object.keys(s).some((k) => k.startsWith("Ordini_")), "nothing in the bound spreadsheet");
  assert.equal(s.Vasi[1][1], "si", "marking still done");
  assert.equal(call.logs.length, 1);
  assert.ok(call.logs[0].includes("https://docs.google.com/spreadsheets/d/auto1/edit"));
  assert.ok(!JSON.stringify(r).includes("auto1") && !JSON.stringify(r).includes("docs.google"), "the URL never reaches the HTTP reply");
  send(call, ORD([line("v3", "vasi")]), { session_id: "cs_2" });
  assert.equal(call.created.length, 1, "the second call reuses the stored id");
  assert.equal(call.logs.length, 1, "the URL is logged once, at creation");
  assert.equal(call.orderTabs().Ordini_Vasi.length, 3);
});

test("separate spreadsheet: created under the script lock and re-checked after it (no second file when another call won the race)", () => {
  const call = script(fresh(), "S", { props: {} });
  send(call, ORD([line("v1", "vasi")]));
  assert.equal(call.locks.held, 0, "lock released");
  // race: the property appears while the script waits for the lock (another execution created the file first)
  const racing = script(fresh(), "S", { props: {}, others: { winner: {} } });
  let reads = 0;
  Object.defineProperty(racing.props, "ORDERS_SPREADSHEET_ID", { configurable: true, get() { reads++; return reads >= 2 ? "winner" : undefined; }, set() {} });
  const r = send(racing, ORD([line("v1", "vasi")]));
  assert.deepEqual(r.orders, { status: "ok", rows: 1 });
  assert.equal(racing.created.length, 0, "no second file");
});

test("authorize(): creates the orders file AND its three tabs (header bold, frozen, filtered), removes the empty default sheet, returns the calendar name", () => {
  const a = script(fresh());
  assert.equal(a.authorize(), "Owner");
  assert.deepEqual([a.created.length, a.props.ORDERS_SPREADSHEET_ID, a.locks.taken, a.locks.held], [1, "auto1", 1, 0]);
  const tabs = a.orderTabs();
  assert.deepEqual(Object.keys(tabs).sort(), TABS3, "Sheet1 (the empty default) is gone");
  for (const name of TABS3) {
    assert.deepEqual(tabs[name], [HEAD], name + ": header row only");
    const m = a.meta["auto1:" + name];
    assert.deepEqual([m.frozen, m.bold.length, m.filters.length], [1, 1, 1], name);
  }
  // second run: same file, nothing duplicated or reset
  tabs.Ordini_Vasi.push(["keep"]);
  assert.equal(a.authorize(), "Owner");
  assert.equal(a.created.length, 1);
  assert.deepEqual(tabs.Ordini_Vasi, [HEAD, ["keep"]]);
  // the first order then simply appends rows (tabs already there)
  const r = send(a, ORD([line("v1", "vasi")]));
  assert.deepEqual(r.orders, { status: "ok", rows: 1 });
  assert.equal(a.meta["auto1:Ordini_Vasi"].filters.length, 1);
  // an existing file given by the owner works too and keeps its sheets
  const own = withOrders();
  own.others.ord1.Notes = [["x"]];
  own.others.ord1.Sheet1 = [["not empty"]];
  assert.equal(script(fresh(), "S", own).authorize(), "Owner");
  assert.deepEqual(Object.keys(own.others.ord1).sort(), ["Notes", ...TABS3, "Sheet1"].sort(), "a non-empty Sheet1 is never deleted");
  assert.throws(() => script(fresh(), "S", { props: { ORDERS_SPREADSHEET_ID: "nope" } }).authorize(), /no access/);
  assert.throws(() => script(fresh(), "S", { failCreate: true }).authorize(), /drive refused/);
});

test("authorize(): a default sheet is deleted only when it is empty and another sheet exists", () => {
  const only = withOrders();
  only.others.ord1.Sheet1 = [];
  assert.equal(script(fresh(), "S", only).authorize(), "Owner");
  assert.deepEqual(Object.keys(only.others.ord1).sort(), TABS3, "empty Sheet1 deleted once the three tabs exist");
  const italian = withOrders();
  italian.others.ord1.Foglio1 = [];
  script(fresh(), "S", italian).authorize();
  assert.ok(!("Foglio1" in italian.others.ord1));
});

test("separate spreadsheet: unavailable (cannot open or create) fails the log only, never falls back to the bound sheet", () => {
  for (const o of [{ props: { ORDERS_SPREADSHEET_ID: "nope" } }, { failCreate: true }, { ...withOrders(), failOpen: true }]) {
    const s = fresh();
    const call = script(s, "S", o);
    const r = send(call, ORD([line("v1", "vasi")]), { ids: ["v1"] });
    assert.deepEqual([r.ok, r.marked, r.orders], [true, ["v1"], { status: "failed", reason: "orders_sheet_unavailable", rows: 0 }], JSON.stringify(Object.keys(o)));
    assert.ok(!Object.keys(s).some((k) => k.startsWith("Ordini_")), "no fallback to the bound spreadsheet");
    assert.equal(s.Vasi[1][1], "si", "marking still done");
  }
});

test("a tab whose header differs (an older layout) is never written to: orders_layout_outdated, no row anywhere, marking still done", () => {
  const bad = withOrders();
  bad.others.ord1.Ordini_Vasi = [["data_ora", "session_id", "tipo", "item_id", "prodotto"]]; // v9 style header
  const s = fresh();
  const call = script(s, "S", bad);
  const r = send(call, ORD([line("v1", "vasi"), line("gc-50", "certificati")]), { ids: ["v1"] });
  assert.deepEqual([r.ok, r.marked, r.orders], [true, ["v1"], { status: "failed", reason: "orders_layout_outdated", rows: 0 }]);
  assert.deepEqual(bad.others.ord1.Ordini_Vasi, [["data_ora", "session_id", "tipo", "item_id", "prodotto"]], "left alone");
  assert.ok(!("Ordini_Certificati" in bad.others.ord1) || bad.others.ord1.Ordini_Certificati.length === 1, "no order row written in the other tab either");
  assert.equal(s.Vasi[1][1], "si");
  // after deleting the old tab and running authorize the log works again
  delete bad.others.ord1.Ordini_Vasi;
  delete bad.others.ord1.Ordini_Certificati;
  const again = script(fresh(), "S", bad);
  again.authorize();
  assert.deepEqual(send(again, ORD([line("v1", "vasi")])).orders, { status: "ok", rows: 1 });
});

test("order log: malformed or oversized orders fail the log only; bad lines are dropped (partial); nothing to log is skipped", () => {
  const s = fresh();
  const opts = withOrders();
  const call = script(s, "S", opts);
  for (const order of [null, "x", { lines: "no" }, ORD(Array(51).fill(line("v1", "vasi")))]) {
    const r = send(call, order, { ids: ["v1"] });
    assert.deepEqual([r.ok, r.marked, r.orders], [true, ["v1"], { status: "failed", reason: "bad_order", rows: 0 }], JSON.stringify(order)?.slice(0, 30));
  }
  assert.deepEqual(opts.others.ord1, {});
  assert.deepEqual(send(call, ORD([])).orders, { status: "skipped", reason: "no_lines", rows: 0 });
  const p = send(call, ORD([line("v1", "vasi"), line("V9", "vasi"), line("v3", "unknown")]), { session_id: "cs_p" });
  assert.deepEqual(p.orders, { status: "ok", rows: 1, reason: "partial" });
  assert.equal(send(call, ORD([line("v1", "vasi")]), { session_id: "" }).orders.status, "failed");
});

test("order log: strings are cut to 200 characters", () => {
  const opts = withOrders();
  const call = script(fresh(), "S", opts);
  send(call, ORD([line("v1", "vasi", { name: "n".repeat(500) })]), { customer: { ...CUST, name: "x".repeat(500) } });
  const t = opts.others.ord1.Ordini_Vasi;
  assert.equal(t[1][COL.prodotto].length, 200);
  assert.equal(t[1][COL.nome].length, 100, "customer name keeps its 100 character cap");
});

test("order log: no customer data in the catalogue tabs or in the reply", () => {
  const s = fresh();
  const r = send(script(s, "S", withOrders()), ORD([line("v1", "vasi")]), { ids: ["v1"] });
  const reply = JSON.stringify(r);
  for (const pii of ["ann@example.com", "Ann Rossi", "Via Roma", "380"]) assert.ok(!reply.includes(pii), pii);
  assert.ok(!JSON.stringify(s.Vasi).includes("Ann") && !JSON.stringify(s.Masterclass).includes("Ann"));
});

// ── oversold: a unique piece that was already sold when this session marked it ──
test("oversold: the piece was already 'si' before another session marked it -> listed; first sale and retries are not", () => {
  const s = fresh();
  const call = script(s);
  const first = call({ secret: "S", session_id: "cs_a", ids: ["v1"] });
  assert.deepEqual([first.marked, first.oversold], [["v1"], []]);
  const second = call({ secret: "S", session_id: "cs_b", ids: ["v1", "v3"] });
  assert.deepEqual([second.marked, second.oversold], [["v1", "v3"], ["v1"]], "v1 was already sold by cs_a; v3 is a first sale");
  assert.equal(s.Vasi[1][1], "si");
  // retries of the same sessions: the first sale stays clean, the oversold session repeats its warning (the first reply may have been lost)
  assert.deepEqual(call({ secret: "S", session_id: "cs_a", ids: ["v1"] }).oversold, []);
  assert.deepEqual(call({ secret: "S", session_id: "cs_b", ids: ["v1", "v3"] }).oversold, ["v1"]);
  assert.deepEqual(s.Ordini.slice(1).map((x) => x.slice(0, 3)), [["cs_a", "v1", 0], ["cs_b", "v1", "oversold"], ["cs_b", "v3", 0]], "one log row per (session, piece), no duplicates on retry");
});

test("oversold: venduto written as ' SI ' counts as sold; a piece sold by hand before the first payment is reported", () => {
  const s = fresh();
  s.Vasi[1][1] = " SI ";
  assert.deepEqual(script(s)({ secret: "S", session_id: "cs_1", ids: ["v1"] }).oversold, ["v1"]);
});

test("oversold: without a session_id a retry cannot be told from a second sale, so nothing is flagged and nothing is logged", () => {
  const s = fresh();
  const call = script(s);
  call({ secret: "S", ids: ["v1"] });
  const r = call({ secret: "S", ids: ["v1"] });
  assert.deepEqual([r.ok, r.marked, r.oversold], [true, ["v1"], []]);
  assert.equal(s.Ordini, undefined);
});

test("oversold: a damaged Ordini header never blocks marking, it only disables the detection", () => {
  const s = fresh();
  s.Ordini = [["x", "y"]];
  const r = script(s)({ secret: "S", session_id: "cs_1", ids: ["v1"] });
  assert.deepEqual([r.ok, r.marked, r.oversold], [true, ["v1"], []]);
  assert.equal(s.Vasi[1][1], "si");
});

test("oversold: a booking in the same session as a piece keeps working (the log rows do not collide)", () => {
  const s = fresh();
  const call = script(s);
  call({ secret: "S", session_id: "cs_1", ids: ["v1"], bookings: [{ id: "mc1", seats: 2 }] });
  const again = call({ secret: "S", session_id: "cs_1", ids: ["v1"], bookings: [{ id: "mc1", seats: 2 }] });
  assert.deepEqual([again.oversold, again.booked[0].duplicate, s.Masterclass[1][2]], [[], true, 2]);
});
