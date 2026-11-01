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

function script(sheets, secret = "S", { props = {}, calendar = fakeCalendar() } = {}) {
  const mk = (name) => {
    const d = sheets[name];
    return {
      getDataRange: () => ({ getValues: () => d.map((r) => r.slice()), getDisplayValues: () => d.map((r) => r.map((c) => (c instanceof Date ? "DATE-OBJECT" : String(c)))) }),
      getRange: (r, c) => ({ setValue: (v) => { d[r - 1][c - 1] = v; } }),
      appendRow: (r) => d.push(r),
    };
  };
  const ss = { getSheetByName: (n) => (sheets[n] ? mk(n) : null), insertSheet: (n) => { sheets[n] = []; return mk(n); } };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === "SECRET" ? secret : props[k] === undefined ? null : props[k]) }) },
    CalendarApp: calendar,
    Utilities: { parseDate: parseRome },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActive: () => ss },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => s }), MimeType: { JSON: 1 } },
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } }));
  call.calendar = calendar;
  call.authorize = () => ctx.authorize();
  call.get = () => JSON.parse(ctx.doGet());
  return call;
}
const SKIP = { status: "skipped", reason: "bad_date" }; // the default fixture has no date/time columns
const fresh = () => ({
  Vasi: [["id", "venduto"], ["v1", ""], ["v3", ""]],
  Masterclass: [["id", "seats_total", "seats_booked"], ["mc1", 8, ""], ["mc2", 4, 3], ["mc3", "", 7]],
});

test("marks vases and books seats in one call (v2 reply)", () => {
  const s = fresh();
  const r = script(s)({ secret: "S", session_id: "cs_1", ids: ["v3"], bookings: [{ id: "mc1", seats: 2 }, { id: "mc2", seats: 2 }, { id: "nope", seats: 1 }] });
  assert.deepEqual(r, {
    ok: true, version: 8, sheet: "Vasi", marked: ["v3"],
    booked: [
      { id: "mc1", seats: 2, booked_after: 2, total: 8, overbooked: false, duplicate: false, calendar: SKIP }, // blank seats_booked = 0
      { id: "mc2", seats: 2, booked_after: 5, total: 4, overbooked: true, duplicate: false, calendar: SKIP }, // recorded anyway
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
  assert.deepEqual(v, { ok: true, version: 8, sheet: "Vasi", marked: ["v1"], booked: [] });
});

test("limited seats_total above 8 and seats 20 work; seats 21 is rejected", () => {
  const s = { ...fresh(), Masterclass: [["id", "seats_total", "seats_booked"], ["mc1", 30, 5]] };
  const call = script(s);
  const r = call({ secret: "S", session_id: "cs_1", ids: [], bookings: [{ id: "mc1", seats: 20 }] });
  assert.deepEqual([r.booked[0].booked_after, r.booked[0].total, r.booked[0].overbooked], [25, 30, false]);
  assert.equal(call({ secret: "S", session_id: "cs_2", ids: [], bookings: [{ id: "mc1", seats: 6 }] }).booked[0].overbooked, true);
  assert.equal(call({ secret: "S", session_id: "cs_3", ids: [], bookings: [{ id: "mc1", seats: 21 }] }).error, "bad_bookings");
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
  for (const b of [{ id: "mc1", seats: 0 }, { id: "mc1", seats: 21 }, { id: "mc1", seats: 1.5 }, { id: "mc1", seats: "2" }, { id: "MC1", seats: 1 }, { id: "mc1" }, null]) assert.equal(bk(b), "bad_bookings", JSON.stringify(b));
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
  assert.deepEqual(r, { ok: true, script: "ceramicsdoronina-catalogue", version: 8 });
});
