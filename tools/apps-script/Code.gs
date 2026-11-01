// Reference copy of the Google Apps Script bound to the catalogue Google Sheet (documentation:
// the live copy is pasted in Extensions > Apps Script; keep both in sync).
// Web app: Execute as Me, Who has access: Anyone. Script property SECRET must equal
// CATALOGUE_WRITE_SECRET in Netlify. Contract v3:
//   POST {"secret": "...", "session_id": "cs_...", "ids": ["v3", ...], "bookings": [{"id": "mc1", "seats": 2}, ...],
//         "customer": {"email": "...", "name": "...", "locale": "it|en|ru"}}   (customer: optional, all fields optional)
//   -> {"ok":true,"version":3,"sheet":"Vasi","marked":[...],
//       "booked":[{"id":"mc1","seats":2,"booked_after":2,"total":8,"overbooked":false,"duplicate":false,
//                  "calendar":{"status":"created|exists|skipped|failed","reason":"..."}}]}
//    | {"ok":false,"error":"forbidden|bad_json|bad_ids|bad_bookings|bad_sheet|bad_columns|bad_orders"}
// ids: unique pieces, marked venduto = 'si' in the tab Vasi. bookings: in the tab Masterclass the column
// seats_booked of the row with that id grows by `seats` (blank = 0), once per (session_id, id): the tab
// Ordini (created if missing; session_id, item_id, seats, at, event_id) remembers what was applied, so a Stripe
// retry reports duplicate:true and changes nothing. overbooked = booked_after > seats_total (a number; blank = 8): the booking
// is still recorded and the owner is told to refund or move it. Only ids are stored in the sheet, never customer data.
// Calendar: every booking gets ITS OWN event in the owner's calendar (never added to another booking's event),
// inviting the customer and the colleagues in the script property OWNER_GUEST_EMAIL (comma separated). Guests
// cannot see each other. A calendar problem never undoes the booking: it is reported in `calendar`. A retry of a
// booking whose event_id is still empty tries again. Run authorize() once from the editor to grant the permission.
// The Netlify function trusts an ok reply only when it names the sheet "Vasi" and, when bookings were
// sent, version 2 or later (an older script replies without them and is reported as "script_outdated").
var SHEET_NAME = 'Vasi'; // tab holding the vases
var ID_HEADER = 'id'; // column used to find the row
var SOLD_HEADER = 'venduto'; // column that receives the sold marker
var SOLD_VALUE = 'si';
var MC_SHEET_NAME = 'Masterclass'; // tab holding the workshops
var SEATS_BOOKED_HEADER = 'seats_booked'; // column that receives the booked seats
var SEATS_TOTAL_HEADER = 'seats_total';
var ORDERS_SHEET_NAME = 'Ordini'; // idempotency log: one row per applied booking
var ORDERS_HEADERS = ['session_id', 'item_id', 'seats', 'at', 'event_id'];
var EVENT_ID_COL = 5; // 1-based column of event_id in Ordini
var TIME_ZONE = 'Europe/Rome';
var DEFAULT_DURATION_MS = 2 * 3600 * 1000; // a single time 'HH:MM' lasts 2 hours
var EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
var LOCALES = ['it', 'en', 'ru'];
var MAX_EMAIL = 254;
var MAX_NAME = 100;
var ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
var MAX_ITEMS = 30; // cap on ids and on bookings per call
var MAX_SEATS = 20; // largest group the script accepts (the Netlify function currently sells 1..8)
var DEFAULT_SEATS_TOTAL = 8; // blank seats_total: same default as the Netlify function (keep both in sync)
var VERSION = 3; // CONTRACT version (what the Netlify function checks), not the Apps Script deployment number

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'bad_json' });
  }
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || !body || body.secret !== secret) return out_({ ok: false, error: 'forbidden' });
  var ids = body.ids === undefined ? [] : body.ids;
  if (!Array.isArray(ids) || ids.length > MAX_ITEMS || !ids.every(validId_)) return out_({ ok: false, error: 'bad_ids' });
  var bookings = body.bookings === undefined ? [] : body.bookings;
  if (!Array.isArray(bookings) || bookings.length > MAX_ITEMS || !bookings.every(validBooking_)) return out_({ ok: false, error: 'bad_bookings' });
  if (bookings.length && (typeof body.session_id !== 'string' || !body.session_id || body.session_id.length > 200)) return out_({ ok: false, error: 'bad_bookings' });

  var customer = cleanCustomer_(body.customer);

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActive();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) return out_({ ok: false, error: 'bad_sheet' });
    var marked = [];
    if (ids.length) {
      var data = sheet.getDataRange().getValues();
      var idCol = data[0].indexOf(ID_HEADER);
      var soldCol = data[0].indexOf(SOLD_HEADER);
      if (idCol < 0 || soldCol < 0) return out_({ ok: false, error: 'bad_columns' });
      for (var i = 1; i < data.length; i++) {
        if (ids.indexOf(String(data[i][idCol])) >= 0) {
          sheet.getRange(i + 1, soldCol + 1).setValue(SOLD_VALUE);
          marked.push(String(data[i][idCol]));
        }
      }
    }
    var booked = [];
    if (bookings.length) {
      var res = book_(ss, String(body.session_id), bookings, customer);
      if (res.error) return out_({ ok: false, error: res.error });
      booked = res.booked;
    }
    return out_({ ok: true, version: VERSION, sheet: SHEET_NAME, marked: marked, booked: booked });
  } finally {
    lock.releaseLock();
  }
}

function validId_(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// Customer data is only used for the calendar event: never logged, never written to the sheet.
function cleanCustomer_(c) {
  c = c && typeof c === 'object' ? c : {};
  var str = function (v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
  };
  return { email: str(c.email, MAX_EMAIL), name: str(c.name, MAX_NAME), locale: LOCALES.indexOf(c.locale) >= 0 ? c.locale : 'it' };
}

function validBooking_(b) {
  return b && typeof b === 'object' && validId_(b.id) && typeof b.seats === 'number' && b.seats % 1 === 0 && b.seats >= 1 && b.seats <= MAX_SEATS;
}

// Applies the bookings (call inside the script lock). Returns {booked: [...]} or {error}.
// A booking whose id is not in the tab Masterclass is simply not reported: the function then tells the owner.
function book_(ss, sessionId, bookings, customer) {
  var mc = ss.getSheetByName(MC_SHEET_NAME);
  if (!mc) return { error: 'bad_sheet' };
  var data = mc.getDataRange().getValues();
  var idCol = data[0].indexOf(ID_HEADER);
  var bookedCol = data[0].indexOf(SEATS_BOOKED_HEADER);
  var totalCol = data[0].indexOf(SEATS_TOTAL_HEADER);
  if (idCol < 0 || bookedCol < 0) return { error: 'bad_columns' };
  var orders = ss.getSheetByName(ORDERS_SHEET_NAME);
  if (!orders) {
    orders = ss.insertSheet(ORDERS_SHEET_NAME);
    orders.appendRow(ORDERS_HEADERS);
  }
  var odata = orders.getDataRange().getValues();
  var head = odata[0].join(',');
  var legacy = ORDERS_HEADERS.slice(0, 4).join(',');
  if (head === legacy) orders.getRange(1, EVENT_ID_COL).setValue(ORDERS_HEADERS[4]); // migration: v2 tab had no event_id
  else if (head !== ORDERS_HEADERS.join(',')) return { error: 'bad_orders' };
  var done = {}; // session|item -> {row: sheet row in Ordini, event: event_id or ''}
  for (var j = 1; j < odata.length; j++) done[String(odata[j][0]) + '|' + String(odata[j][1])] = { row: j + 1, event: String(odata[j][4] || '') };
  var nextRow = odata.length + 1;
  var disp = null; // display values of the tab Masterclass, read once and only when an event is needed
  var eventFor = function (rowIdx, b) {
    if (!disp) disp = mc.getDataRange().getDisplayValues();
    return createEvent_(disp, rowIdx, b, sessionId, customer);
  };
  var booked = [];
  for (var k = 0; k < bookings.length; k++) {
    var b = bookings[k];
    var row = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === b.id) {
        row = i;
        break;
      }
    }
    if (row < 0) continue;
    // seats_total blank (or no such column) means DEFAULT_SEATS_TOTAL, as in the Netlify function; any other non-number: unknown
    var cell = totalCol >= 0 ? data[row][totalCol] : '';
    var total = cell === '' ? DEFAULT_SEATS_TOTAL : typeof cell === 'number' ? cell : null;
    var current = Number(data[row][bookedCol]);
    if (isNaN(current)) current = 0; // blank or text counts as 0
    var prev = done[sessionId + '|' + b.id];
    if (prev) {
      var cal;
      if (prev.event) cal = { status: 'exists' };
      else {
        cal = eventFor(row, b); // a failed first attempt is retried here
        if (cal.eventId) {
          orders.getRange(prev.row, EVENT_ID_COL).setValue(cal.eventId);
          prev.event = cal.eventId;
        }
      }
      booked.push({ id: b.id, seats: b.seats, booked_after: current, total: total, overbooked: total !== null && current > total, duplicate: true, calendar: publicCal_(cal) });
      continue;
    }
    var after = current + b.seats;
    mc.getRange(row + 1, bookedCol + 1).setValue(after);
    data[row][bookedCol] = after; // the same id twice in one call adds up
    orders.appendRow([sessionId, b.id, b.seats, new Date().toISOString(), '']);
    var entry = { row: nextRow++, event: '' };
    done[sessionId + '|' + b.id] = entry;
    var made = eventFor(row, b); // after the booking is recorded: a calendar problem never undoes it
    if (made.eventId) {
      orders.getRange(entry.row, EVENT_ID_COL).setValue(made.eventId);
      entry.event = made.eventId;
    }
    booked.push({ id: b.id, seats: b.seats, booked_after: after, total: total, overbooked: total !== null && after > total, duplicate: false, calendar: publicCal_(made) });
  }
  return { booked: booked };
}

function publicCal_(c) {
  return c.reason ? { status: c.status, reason: c.reason } : { status: c.status };
}

// Owner colleagues invited to every event: script property OWNER_GUEST_EMAIL, comma separated, each validated.
function ownerGuests_() {
  var raw = PropertiesService.getScriptProperties().getProperty('OWNER_GUEST_EMAIL') || '';
  return raw.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return EMAIL_RE.test(x); });
}

// Day-first dates (dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy) or yyyy-mm-dd -> {y, m, d}, null when unparsable.
function parseDay_(text) {
  var m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/.exec(text);
  var y, mo, d;
  if (m) {
    d = +m[1]; mo = +m[2]; y = +m[3];
  } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else return null;
  var check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { y: y, m: mo, d: d };
}

// 'HH:MM-HH:MM' (hyphen or en/em dash, spaces allowed) or 'HH:MM' -> {start: [h, m], end: [h, m] | null}
function parseTimes_(text) {
  var m = /^(\d{1,2}):(\d{2})(?:\s*[-\u2013\u2014]\s*(\d{1,2}):(\d{2}))?$/.exec(text);
  if (!m) return null;
  var t = { start: [+m[1], +m[2]], end: m[3] === undefined ? null : [+m[3], +m[4]] };
  var okTime = function (x) { return !x || (x[0] < 24 && x[1] < 60); };
  return okTime(t.start) && okTime(t.end) ? t : null;
}

function pad_(n) {
  return (n < 10 ? '0' : '') + n;
}

function parseLocal_(day, hm) {
  return Utilities.parseDate(day.y + '-' + pad_(day.m) + '-' + pad_(day.d) + ' ' + pad_(hm[0]) + ':' + pad_(hm[1]), TIME_ZONE, 'yyyy-MM-dd HH:mm');
}

function personsLabel_(n, locale) {
  if (locale === 'en') return n === 1 ? '1 person' : n + ' people';
  if (locale === 'ru') return n + (n === 1 ? ' \u0447\u0435\u043b\u043e\u0432\u0435\u043a' : n >= 2 && n <= 4 ? ' \u0447\u0435\u043b\u043e\u0432\u0435\u043a\u0430' : ' \u0447\u0435\u043b\u043e\u0432\u0435\u043a');
  return n === 1 ? '1 persona' : n + ' persone';
}

// Creates the event of ONE booking in the owner's calendar (never touches an existing event, so independent groups
// never see each other). Never throws. Returns {status: created|skipped|failed, reason?, eventId?}.
function createEvent_(disp, rowIdx, b, sessionId, customer) {
  try {
    var cell = function (header) {
      var c = disp[0].indexOf(header);
      return c < 0 ? '' : String(disp[rowIdx][c]).trim();
    };
    var day = parseDay_(cell('date'));
    var times = parseTimes_(cell('time'));
    if (!day || !times) return { status: 'skipped', reason: 'bad_date' };
    var start = parseLocal_(day, times.start);
    var end = times.end ? parseLocal_(day, times.end) : new Date(start.getTime() + DEFAULT_DURATION_MS);
    if (end.getTime() <= start.getTime()) return { status: 'skipped', reason: 'bad_date' };
    if (start.getTime() <= Date.now()) return { status: 'skipped', reason: 'date_in_past' };

    var loc = customer.locale;
    var name = cell('name_' + loc) || cell('name_it') || cell('name_en') || cell('name_ru') || b.id;
    var title = name + ' (' + personsLabel_(b.seats, loc) + ')';
    var description = ['Masterclass: ' + b.id, 'Persons: ' + b.seats];
    if (customer.name) description.push('Customer: ' + customer.name);
    if (customer.email) description.push('Email: ' + customer.email);
    description.push('Booking reference: ' + sessionId.slice(-8));

    var guests = [];
    var notes = [];
    if (EMAIL_RE.test(customer.email)) guests.push(customer.email);
    else notes.push(customer.email ? 'customer_email_invalid' : 'no_customer_email');
    var owners = ownerGuests_();
    if (!owners.length) notes.unshift('owner_guest_missing');
    owners.forEach(function (g) {
      var dup = guests.some(function (x) { return x.toLowerCase() === g.toLowerCase(); });
      if (!dup) guests.push(g);
    });

    var calId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    var cal = calId ? CalendarApp.getCalendarById(calId) : CalendarApp.getDefaultCalendar();
    var event = cal.createEvent(title, start, end, { guests: guests.join(','), sendInvites: true, description: description.join('\n') });
    var eventId = event.getId();
    try {
      event.setGuestsCanSeeGuests(false);
      event.setGuestsCanInviteOthers(false);
      event.setGuestsCanModify(false);
    } catch (err) {
      notes.push('privacy_flags_failed'); // the event exists and is recorded; the owner can set them by hand
    }
    var res = { status: 'created', eventId: eventId };
    if (notes.length) res.reason = notes.join(',');
    return res;
  } catch (err) {
    return { status: 'failed', reason: 'calendar_error' };
  }
}

// Public health check: opening the /exec URL in a browser shows which code is deployed. No secret, no data, only the version.
function doGet() {
  return out_({ ok: true, script: 'ceramicsdoronina-catalogue', version: VERSION });
}

// Run once from the editor (Run > authorize) to grant the Google Calendar permission; returns the calendar name.
function authorize() {
  return CalendarApp.getDefaultCalendar().getName();
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
