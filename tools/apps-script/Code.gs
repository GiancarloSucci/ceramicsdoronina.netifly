// Reference copy of the Google Apps Script bound to the catalogue Google Sheet (documentation:
// the live copy is pasted in Extensions > Apps Script; keep both in sync).
// Web app: Execute as Me, Who has access: Anyone. Script property SECRET must equal
// CATALOGUE_WRITE_SECRET in Netlify. Contract v5 (v4 + oversold):
//   POST {"secret": "...", "session_id": "cs_...", "ids": ["v3", ...], "bookings": [{"id": "mc1", "seats": 2}, ...],
//         "customer": {"email", "name", "phone", "locale": "it|en|ru", "billing": {line1,line2,city,postal_code,state,country},
//                      "shipping": {name,line1,line2,city,postal_code,state,country}},        (customer: optional, all fields optional)
//         "order": {"total_cents", "currency", "created_iso", "lines": [{"id","kind":"vasi|masterclass|certificati","name","quantity","seats?","amount_cents"}]},
//         "consent": {"privacy": true, "email_marketing": true, "other_channels": false, "third_party": false,
//                     "privacy_version": "2026-11-04", "at": "ISO"}}   (order, consent: optional)
//   -> {"ok":true,"version":11,"sheet":"Vasi","marked":[...],"oversold":["v3"],
//       "booked":[{"id":"mc1","seats":2,"booked_after":2,"total":8,"overbooked":false,"duplicate":false,
//                  "calendar":{"status":"created|exists|skipped|failed","reason":"..."}}],
//       "orders":{"status":"ok|skipped|failed","reason":"...","rows":3}}
//    | {"ok":false,"error":"forbidden|bad_json|bad_ids|bad_sheet|bad_columns|bad_orders|bad_bookings"}
// ids: unique pieces, marked venduto = 'si' in the tab Vasi. `oversold` lists the ids that were ALREADY 'si' before this session
// marked them, i.e. someone else got the piece first (two customers paid for the same unique piece): the owner must refund this
// order. A Stripe retry of the same session is not a second sale: the tab Ordini remembers (session_id, id) for pieces too (seats
// cell 0, or the text 'oversold' when the session was flagged, so a retry repeats the warning if the first reply never arrived).
// Without session_id the sale cannot be told from a retry, so nothing is flagged. bookings: in the tab Masterclass the column
// seats_booked of the row with that id grows by `seats` (blank = 0), once per (session_id, id): the tab
// Ordini (created if missing; session_id, item_id, seats, at, event_id) remembers what was applied, so a Stripe
// retry reports duplicate:true and changes nothing. overbooked = booked_after > seats_total (a number; blank = unlimited): the booking
// is still recorded and the owner is told to refund or move it.
// ORDER LOG (v4): when `order` is sent, one row per order line goes to the PRIVATE tabs Ordini_Vasi, Ordini_Masterclass and
// Ordini_Certificati (created on first use) with the whole customer record (name, email, phone, billing and shipping address),
// the privacy consent and the marketing opposition. These tabs live ONLY in a separate spreadsheet, never in this one (this one
// may be published to the web): script property ORDERS_SPREADSHEET_ID names it (openById); when the property is missing the script
// creates a file named 'Ceramics Doronina - Ordini' in the owner's My Drive (private by default), stores its id in that property and
// logs its URL with Logger.log only. If that file cannot be opened or created the reply says orders failed (orders_sheet_unavailable);
// the order is never written to the bound spreadsheet. Never share that file publicly or publish it to the web.
// First columns of every order tab: data_ora, session_id, tipo, nome, email, telefono, consenso_email, consenso_altri_canali,
// consenso_terzi, consenso_ordine (SI/NO each). consenso_email = NO is highlighted light red, consenso_altri_canali / consenso_terzi = SI
// light green; basic filter on the header. authorize() creates the orders file AND the three tabs (header bold, frozen, filtered) and
// removes the empty default first sheet, so the owner sees the finished file before the first order; creating a tab on the first
// order stays as a fallback. A tab whose header differs from the expected one is never written to: orders failed, reason
// orders_layout_outdated (delete the old order tabs and run authorize again).
// A line already logged for (session_id, item_id) is skipped, so a Stripe retry never duplicates rows. Text cells that start with
// = + - @ (or a tab/CR) get a leading apostrophe so a customer cannot plant a spreadsheet formula. A problem with the order
// log never undoes marking or booking: it is reported in `orders`. `order` missing (older Netlify function) = orders skipped.
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
var OVERSOLD_MARK = 'oversold'; // text in the seats cell of the Ordini row of a piece that was already sold
var EVENT_ID_COL = 5; // 1-based column of event_id in Ordini
var TIME_ZONE = 'Europe/Rome';
var DEFAULT_DURATION_MS = 2 * 3600 * 1000; // a single time 'HH:MM' lasts 2 hours
var EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
var LOCALES = ['it', 'en', 'ru'];
var MAX_EMAIL = 254;
var MAX_NAME = 100;
var MAX_FIELD = 200; // any other customer or order text
var MAX_LINES = 50; // order lines per call
var ORDER_TABS = { vasi: 'Ordini_Vasi', masterclass: 'Ordini_Masterclass', certificati: 'Ordini_Certificati' };
var ORDERS_FILE_NAME = 'Ceramics Doronina - Ordini';
var ORDERS_ID_PROPERTY = 'ORDERS_SPREADSHEET_ID';
var ORDER_HEADERS = ['data_ora', 'session_id', 'tipo', 'nome', 'email', 'telefono', 'consenso_email', 'consenso_altri_canali', 'consenso_terzi', 'consenso_ordine',
  'item_id', 'prodotto', 'quantita', 'persone', 'importo_riga', 'valuta', 'totale_ordine',
  'fatt_indirizzo', 'fatt_cap', 'fatt_citta', 'fatt_provincia', 'fatt_paese',
  'sped_nome', 'sped_indirizzo', 'sped_cap', 'sped_citta', 'sped_provincia', 'sped_paese',
  'lingua', 'versione_informativa', 'data_consenso', 'calendar_event_id'];
var SESSION_COL = 2; // 1-based columns used for idempotency
var ITEM_COL = 11;
var EMAIL_COL = 7; // consenso_email; consenso_altri_canali = 8, consenso_terzi = 9, consenso_ordine = 10
var NO_COLOR = '#fde2e2'; // consenso_email = NO
var YES_COLOR = '#e2f3e2'; // consenso_altri_canali / consenso_terzi = SI
var DEFAULT_SHEET_NAMES = ['Foglio1', 'Sheet1', 'Foglio 1', 'Sheet 1', 'Лист1'];
var PHONE_COL = 6; // 1-based column of telefono: plain-text format so a leading + or 0 survives
var ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
var MAX_ITEMS = 30; // cap on ids and on bookings per call
var MAX_SEATS = 999; // persons in ONE booking (1..999; linear pricing is not limited to 20)
var VERSION = 11; // Version

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
  var order = body.order === undefined ? undefined : cleanOrder_(body.order); // null = malformed
  var consent = cleanConsent_(body.consent);

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActive();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) return out_({ ok: false, error: 'bad_sheet' });
    var marked = [];
    var oversold = [];
    if (ids.length) {
      var data = sheet.getDataRange().getValues();
      var idCol = data[0].indexOf(ID_HEADER);
      var soldCol = data[0].indexOf(SOLD_HEADER);
      if (idCol < 0 || soldCol < 0) return out_({ ok: false, error: 'bad_columns' });
      // The idempotency log tells a retry of this session from a second sale; a log problem only disables the detection.
      var log = typeof body.session_id === 'string' && body.session_id && body.session_id.length <= 200 ? openLog_(ss) : { error: 'no_session' };
      for (var i = 1; i < data.length; i++) {
        var pid = String(data[i][idCol]);
        if (ids.indexOf(pid) < 0) continue;
        var wasSold = String(data[i][soldCol]).trim().toLowerCase() === SOLD_VALUE;
        sheet.getRange(i + 1, soldCol + 1).setValue(SOLD_VALUE);
        marked.push(pid);
        if (log.error) continue;
        var key = body.session_id + '|' + pid;
        var seen = log.done[key];
        if (seen) {
          if (seen.seats === OVERSOLD_MARK) oversold.push(pid);
        } else {
          log.sheet.appendRow([body.session_id, pid, wasSold ? OVERSOLD_MARK : 0, new Date().toISOString(), '']);
          log.done[key] = { row: log.next++, event: '', seats: wasSold ? OVERSOLD_MARK : '0' };
          if (wasSold) oversold.push(pid);
        }
      }
    }
    var booked = [];
    var events = {};
    if (bookings.length) {
      var res = book_(ss, String(body.session_id), bookings, customer);
      if (res.error) return out_({ ok: false, error: res.error });
      booked = res.booked;
      events = res.events;
    }
    var orders = order === undefined ? { status: 'skipped', reason: 'no_order', rows: 0 } : logOrder_(body.session_id, order, customer, consent, events);
    return out_({ ok: true, version: VERSION, sheet: SHEET_NAME, marked: marked, oversold: oversold, booked: booked, orders: orders });
  } finally {
    lock.releaseLock();
  }
}

function validId_(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// Customer data goes into the calendar event (email, name, locale) and, with `order`, into the PRIVATE order tabs.
// Never logged, never written to the catalogue tabs.
function cleanCustomer_(c) {
  c = c && typeof c === 'object' ? c : {};
  var str = function (v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
  };
  var addr = function (a, withName) {
    a = a && typeof a === 'object' ? a : {};
    var o = {};
    ['line1', 'line2', 'city', 'postal_code', 'state', 'country'].concat(withName ? ['name'] : []).forEach(function (k) {
      o[k] = str(a[k], MAX_FIELD);
    });
    return o;
  };
  return {
    email: str(c.email, MAX_EMAIL), name: str(c.name, MAX_NAME), locale: LOCALES.indexOf(c.locale) >= 0 ? c.locale : 'it',
    phone: str(c.phone, MAX_FIELD), billing: addr(c.billing, false), shipping: addr(c.shipping, true)
  };
}

// {total_cents, currency, created_iso, lines:[{id, kind, name, quantity, seats, amount_cents}]} or null when malformed
// (not an object, lines not an array, more than MAX_LINES). `skipped` counts the lines that were dropped as invalid.
function cleanOrder_(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.lines) || o.lines.length > MAX_LINES) return null;
  var int = function (v, max) {
    return typeof v === 'number' && v % 1 === 0 && v >= 0 && v <= max ? v : 0;
  };
  var lines = [];
  var skipped = 0;
  o.lines.forEach(function (l) {
    if (!l || typeof l !== 'object' || !validId_(l.id) || !ORDER_TABS.hasOwnProperty(l.kind)) {
      skipped++;
      return;
    }
    lines.push({
      id: l.id, kind: l.kind, name: typeof l.name === 'string' ? l.name.trim().slice(0, MAX_FIELD) : '',
      quantity: Math.max(1, int(l.quantity, 1000000)), seats: int(l.seats, MAX_SEATS), amount_cents: int(l.amount_cents, 1000000000)
    });
  });
  return {
    total_cents: int(o.total_cents, 1000000000), currency: typeof o.currency === 'string' ? o.currency.trim().slice(0, 10).toUpperCase() : '',
    created_iso: typeof o.created_iso === 'string' ? o.created_iso.trim().slice(0, 40) : '', lines: lines, skipped: skipped
  };
}

// Consent record: privacy (order processing), email (email marketing), channels (other channels), third (third parties).
// A payload from the previous contract (marketing_optout, no email_marketing) maps to email = not objected.
function cleanConsent_(c) {
  c = c && typeof c === 'object' ? c : {};
  var str = function (v) {
    return typeof v === 'string' ? v.trim().slice(0, 40) : '';
  };
  var email = c.email_marketing !== undefined ? c.email_marketing === true : c.marketing_optout !== undefined ? c.marketing_optout === false : false;
  return { privacy: c.privacy === true, email: email, channels: c.other_channels === true, third: c.third_party === true, version: str(c.privacy_version), at: str(c.at) };
}

function validBooking_(b) {
  return b && typeof b === 'object' && validId_(b.id) && typeof b.seats === 'number' && b.seats % 1 === 0 && b.seats >= 1 && b.seats <= MAX_SEATS;
}

// The idempotency tab Ordini (created if missing): {sheet, done, next} or {error:'bad_orders'}. done maps 'session|item' to
// {row, event, seats} (seats as text); next is the first free row. Call inside the script lock.
function openLog_(ss) {
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
  var done = {};
  for (var j = 1; j < odata.length; j++) done[String(odata[j][0]) + '|' + String(odata[j][1])] = { row: j + 1, event: String(odata[j][4] || ''), seats: String(odata[j][2]) };
  return { sheet: orders, done: done, next: odata.length + 1 };
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
  var lg = openLog_(ss);
  if (lg.error) return { error: lg.error };
  var orders = lg.sheet;
  var done = lg.done; // session|item -> {row: sheet row in Ordini, event: event_id or '', seats}
  var nextRow = lg.next;
  var disp = null; // display values of the tab Masterclass, read once and only when an event is needed
  var eventFor = function (rowIdx, b) {
    if (!disp) disp = mc.getDataRange().getDisplayValues();
    return createEvent_(disp, rowIdx, b, sessionId, customer);
  };
  var booked = [];
  var events = {}; // booking id -> calendar event id, for the order log
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
    // seats_total blank (or no such column) means unlimited, as in the Netlify function: total null, never overbooked;
    // any other non-number: unknown (null too)
    var cell = totalCol >= 0 ? data[row][totalCol] : '';
    var total = typeof cell === 'number' ? cell : null;
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
      if (prev.event) events[b.id] = prev.event;
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
    if (entry.event) events[b.id] = entry.event;
    booked.push({ id: b.id, seats: b.seats, booked_after: after, total: total, overbooked: total !== null && after > total, duplicate: false, calendar: publicCal_(made) });
  }
  return { booked: booked, events: events };
}

// Plain text cell: a leading = + - @ (or tab/CR) would be read as a formula, so it gets an apostrophe (consumed by Sheets, not shown).
function safeText_(v) {
  v = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

// The separate, private spreadsheet holding the order tabs (never the bound one). ORDERS_SPREADSHEET_ID when set; otherwise it is
// created once in the owner's My Drive, its id stored in that property and its URL logged with Logger.log only. `locked`: the caller
// already holds the script lock (doPost); otherwise (authorize) the lock is taken here, so two concurrent calls never create two files.
function ordersSpreadsheet_(locked) {
  var props = PropertiesService.getScriptProperties();
  var open = function (id) {
    return SpreadsheetApp.openById(String(id).trim());
  };
  var id = props.getProperty(ORDERS_ID_PROPERTY);
  if (id) return open(id);
  var lock = locked ? null : LockService.getScriptLock();
  if (lock) lock.waitLock(10000);
  try {
    id = props.getProperty(ORDERS_ID_PROPERTY); // another call may have created it while we waited
    if (id) return open(id);
    var created = SpreadsheetApp.create(ORDERS_FILE_NAME);
    props.setProperty(ORDERS_ID_PROPERTY, created.getId());
    Logger.log('Orders spreadsheet created (private, in My Drive): ' + created.getUrl());
    return created;
  } finally {
    if (lock) lock.releaseLock();
  }
}

function joinAddress_(a) {
  return [a.line1, a.line2].filter(function (x) { return x; }).join(', ');
}

// Returns the order tab `name` of `target`, creating it (header bold, frozen, filtered) when it does not exist or is empty.
// {sh, layout:'ok'|'outdated'}: a tab whose header row differs from ORDER_HEADERS is left alone.
function ensureOrderTab_(target, name) {
  var sh = target.getSheetByName(name);
  var data = sh ? sh.getDataRange().getValues() : [];
  if (!sh) sh = target.insertSheet(name);
  if (!data.length || !data[0].length) {
    sh.getRange(1, 1, 1, ORDER_HEADERS.length).setValues([ORDER_HEADERS]);
    sh.getRange(1, 1, 1, ORDER_HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    try {
      sh.getRange(1, 1, sh.getMaxRows(), ORDER_HEADERS.length).createFilter(); // filter on the header row (covers the rows below)
    } catch (err) {
      // a missing filter is only cosmetic
    }
    return { sh: sh, data: [ORDER_HEADERS], layout: 'ok' };
  }
  return { sh: sh, data: data, layout: data[0].join(',') === ORDER_HEADERS.join(',') ? 'ok' : 'outdated' };
}

// Deletes the empty default first sheet (Foglio1 / Sheet1) of a freshly created file, only when other sheets exist.
function removeDefaultSheet_(target) {
  try {
    var sheets = target.getSheets();
    if (sheets.length < 2) return;
    sheets.forEach(function (sh) {
      if (DEFAULT_SHEET_NAMES.indexOf(sh.getName()) >= 0 && sh.getLastRow() === 0 && target.getSheets().length > 1) target.deleteSheet(sh);
    });
  } catch (err) {
    // cosmetic only
  }
}

// Writes one row per order line in the private tab of its kind. Never throws; returns {status, reason?, rows}:
//   ok (all lines logged or already there; reason 'partial' when some line was dropped or failed), skipped (nothing to log), failed.
// `rows` counts the lines that are in the tabs after the call (new ones and the ones a retry found already there).
function logOrder_(sessionId, order, customer, consent, events) {
  try {
    if (!order) return { status: 'failed', reason: 'bad_order', rows: 0 };
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return { status: 'failed', reason: 'bad_order', rows: 0 };
    if (!order.lines.length) return { status: 'skipped', reason: 'no_lines', rows: 0 };
    var target;
    try {
      target = ordersSpreadsheet_(true); // called inside doPost's script lock
    } catch (err) {
      return { status: 'failed', reason: 'orders_sheet_unavailable', rows: 0 };
    }
    var kinds = Object.keys(ORDER_TABS).filter(function (kind) {
      return order.lines.some(function (l) { return l.kind === kind; });
    });
    var tabs = {};
    for (var t = 0; t < kinds.length; t++) {
      var tab = ensureOrderTab_(target, ORDER_TABS[kinds[t]]);
      if (tab.layout !== 'ok') return { status: 'failed', reason: 'orders_layout_outdated', rows: 0 }; // nothing is written
      tabs[kinds[t]] = tab;
    }
    var rows = 0;
    var failed = order.skipped;
    var when = order.created_iso || new Date().toISOString();
    var money = function (cents) {
      return cents / 100;
    };
    kinds.forEach(function (kind) {
      var mine = order.lines.filter(function (l) { return l.kind === kind; });
      try {
        var sh = tabs[kind].sh;
        var data = tabs[kind].data;
        var done = {};
        for (var i = 1; i < data.length; i++) done[String(data[i][SESSION_COL - 1]) + '|' + String(data[i][ITEM_COL - 1])] = true;
        var fresh = [];
        mine.forEach(function (l) {
          var key = sessionId + '|' + l.id;
          if (done[key]) {
            rows++; // retry: already logged
            return;
          }
          done[key] = true; // the same id twice in one call is logged once
          var b = customer.billing;
          var sp = customer.shipping;
          var text = safeText_;
          var yn = function (v) {
            return v ? 'SI' : 'NO';
          };
          fresh.push([
            text(when), text(sessionId), text(kind), text(customer.name), text(customer.email), customer.phone, yn(consent.email), yn(consent.channels), yn(consent.third), yn(consent.privacy),
            text(l.id), text(l.name), l.quantity, l.seats || '', money(l.amount_cents), text(order.currency), money(order.total_cents),
            text(joinAddress_(b)), text(b.postal_code), text(b.city), text(b.state), text(b.country),
            text(sp.name), text(joinAddress_(sp)), text(sp.postal_code), text(sp.city), text(sp.state), text(sp.country),
            text(customer.locale), text(consent.version), text(consent.at), text(events[l.id] || '')
          ]);
        });
        if (fresh.length) {
          var first = sh.getLastRow() + 1;
          // the phone column is plain text (keeps +39 and leading zeros, never a formula); the value is written as is, without apostrophe
          sh.getRange(first, PHONE_COL, fresh.length, 1).setNumberFormat('@');
          fresh.forEach(function (r) {
            if (/^[=@\t\r]/.test(r[PHONE_COL - 1])) r[PHONE_COL - 1] = "'" + r[PHONE_COL - 1];
          });
          sh.getRange(first, 1, fresh.length, ORDER_HEADERS.length).setValues(fresh);
          fresh.forEach(function (r, k) {
            if (r[EMAIL_COL - 1] === 'NO') sh.getRange(first + k, EMAIL_COL, 1, 1).setBackground(NO_COLOR); // no email contact allowed: clearly visible
            if (r[EMAIL_COL] === 'SI') sh.getRange(first + k, EMAIL_COL + 1, 1, 1).setBackground(YES_COLOR); // other channels allowed
            if (r[EMAIL_COL + 1] === 'SI') sh.getRange(first + k, EMAIL_COL + 2, 1, 1).setBackground(YES_COLOR); // third parties allowed
          });
          rows += fresh.length;
        }
      } catch (err) {
        failed += mine.length;
      }
    });
    if (failed && !rows) return { status: 'failed', reason: 'write_error', rows: 0 };
    var res = { status: 'ok', rows: rows };
    if (failed) res.reason = 'partial';
    return res;
  } catch (err) {
    return { status: 'failed', reason: 'write_error', rows: 0 };
  }
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
  if (locale === 'ru') {
    // general Russian plural rule: n%10 and n%100 (1, 21, 101 singular; 2-4, 22-24 paucal; 5-20, 11-14, 25-30 genitive plural)
    var m10 = n % 10;
    var m100 = n % 100;
    return n + (m10 === 1 && m100 !== 11 ? ' \u0447\u0435\u043b\u043e\u0432\u0435\u043a' : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? ' \u0447\u0435\u043b\u043e\u0432\u0435\u043a\u0430' : ' \u0447\u0435\u043b\u043e\u0432\u0435\u043a');
  }
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
// Run it again after pasting a new version of this script: version 10 needs the permission to open other spreadsheets
// (the separate orders file, created on the first run with its three tabs: look for 'Ceramics Doronina - Ordini' in My Drive; its URL is in the execution log),
// and the deployed web app only works once that permission has been granted.
function authorize() {
  var target = ordersSpreadsheet_(false); // asks for the permission to create/open the separate orders file (and creates it on first run)
  Object.keys(ORDER_TABS).forEach(function (kind) {
    ensureOrderTab_(target, ORDER_TABS[kind]); // the three tabs exist, with their header, before the first order
  });
  removeDefaultSheet_(target); // the empty Foglio1 / Sheet1 of the new file
  return CalendarApp.getDefaultCalendar().getName();
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
