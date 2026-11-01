// Reference copy of the Google Apps Script bound to the catalogue Google Sheet (documentation:
// the live copy is pasted in Extensions > Apps Script; keep both in sync).
// Web app: Execute as Me, Who has access: Anyone. Script property SECRET must equal
// CATALOGUE_WRITE_SECRET in Netlify. Contract v2:
//   POST {"secret": "...", "session_id": "cs_...", "ids": ["v3", ...], "bookings": [{"id": "mc1", "seats": 2}, ...]}
//   -> {"ok":true,"version":2,"sheet":"Vasi","marked":[...],
//       "booked":[{"id":"mc1","seats":2,"booked_after":2,"total":8,"overbooked":false,"duplicate":false}]}
//    | {"ok":false,"error":"forbidden|bad_json|bad_ids|bad_bookings|bad_sheet|bad_columns|bad_orders"}
// ids: unique pieces, marked venduto = 'si' in the tab Vasi. bookings: in the tab Masterclass the column
// seats_booked of the row with that id grows by `seats` (blank = 0), once per (session_id, id): the tab
// Ordini (created if missing; session_id, item_id, seats, at) remembers what was applied, so a Stripe retry
// reports duplicate:true and changes nothing. overbooked = booked_after > seats_total (a number; blank = 8): the booking
// is still recorded and the owner is told to refund or move it. No customer data is stored, only ids.
// The Netlify function trusts an ok reply only when it names the sheet "Vasi" and, when bookings were
// sent, version 2 (an older script replies without them and is reported as "script_outdated").
var SHEET_NAME = 'Vasi'; // tab holding the vases
var ID_HEADER = 'id'; // column used to find the row
var SOLD_HEADER = 'venduto'; // column that receives the sold marker
var SOLD_VALUE = 'si';
var MC_SHEET_NAME = 'Masterclass'; // tab holding the workshops
var SEATS_BOOKED_HEADER = 'seats_booked'; // column that receives the booked seats
var SEATS_TOTAL_HEADER = 'seats_total';
var ORDERS_SHEET_NAME = 'Ordini'; // idempotency log: one row per applied booking
var ORDERS_HEADERS = ['session_id', 'item_id', 'seats', 'at'];
var ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
var MAX_ITEMS = 30; // cap on ids and on bookings per call
var MAX_SEATS = 8;

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
      var res = book_(ss, String(body.session_id), bookings);
      if (res.error) return out_({ ok: false, error: res.error });
      booked = res.booked;
    }
    return out_({ ok: true, version: 2, sheet: SHEET_NAME, marked: marked, booked: booked });
  } finally {
    lock.releaseLock();
  }
}

function validId_(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function validBooking_(b) {
  return b && typeof b === 'object' && validId_(b.id) && typeof b.seats === 'number' && b.seats % 1 === 0 && b.seats >= 1 && b.seats <= MAX_SEATS;
}

// Applies the bookings (call inside the script lock). Returns {booked: [...]} or {error}.
// A booking whose id is not in the tab Masterclass is simply not reported: the function then tells the owner.
function book_(ss, sessionId, bookings) {
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
  if (odata[0].join(',') !== ORDERS_HEADERS.join(',')) return { error: 'bad_orders' };
  var done = {};
  for (var j = 1; j < odata.length; j++) done[String(odata[j][0]) + '|' + String(odata[j][1])] = true;
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
    // seats_total blank (or no such column) means 8, as in the Netlify function; any other non-number: unknown
    var cell = totalCol >= 0 ? data[row][totalCol] : '';
    var total = cell === '' ? MAX_SEATS : typeof cell === 'number' ? cell : null;
    var current = Number(data[row][bookedCol]);
    if (isNaN(current)) current = 0; // blank or text counts as 0
    if (done[sessionId + '|' + b.id]) {
      booked.push({ id: b.id, seats: b.seats, booked_after: current, total: total, overbooked: total !== null && current > total, duplicate: true });
      continue;
    }
    var after = current + b.seats;
    mc.getRange(row + 1, bookedCol + 1).setValue(after);
    data[row][bookedCol] = after; // the same id twice in one call adds up
    orders.appendRow([sessionId, b.id, b.seats, new Date().toISOString()]);
    done[sessionId + '|' + b.id] = true;
    booked.push({ id: b.id, seats: b.seats, booked_after: after, total: total, overbooked: total !== null && after > total, duplicate: false });
  }
  return { booked: booked };
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
