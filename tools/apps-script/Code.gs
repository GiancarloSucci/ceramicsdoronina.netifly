// Reference copy of the Google Apps Script bound to the catalogue Google Sheet (documentation:
// the live copy is pasted in Extensions > Apps Script; keep both in sync).
// Web app: Execute as Me, Who has access: Anyone. Script property SECRET must equal
// CATALOGUE_WRITE_SECRET in Netlify. Contract:
//   POST {"secret": "...", "ids": ["v3", ...]}
//   -> {"ok":true,"marked":[...],"sheet":"Vasi"}
//    | {"ok":false,"error":"forbidden|bad_json|bad_ids|bad_sheet|bad_columns"}
// The Netlify function trusts an ok reply only when it names the sheet "Vasi" (an older script
// replies without it and is reported as "script_outdated").
var SHEET_NAME = 'Vasi'; // tab holding the vases
var ID_HEADER = 'id'; // column used to find the row
var SOLD_HEADER = 'venduto'; // column that receives the sold marker
var SOLD_VALUE = 'si';

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'bad_json' });
  }
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || !body || body.secret !== secret) return out_({ ok: false, error: 'forbidden' });
  if (!Array.isArray(body.ids)) return out_({ ok: false, error: 'bad_ids' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sheet) return out_({ ok: false, error: 'bad_sheet' });
    var data = sheet.getDataRange().getValues();
    var idCol = data[0].indexOf(ID_HEADER);
    var soldCol = data[0].indexOf(SOLD_HEADER);
    if (idCol < 0 || soldCol < 0) return out_({ ok: false, error: 'bad_columns' });
    var marked = [];
    for (var i = 1; i < data.length; i++) {
      if (body.ids.indexOf(String(data[i][idCol])) >= 0) {
        sheet.getRange(i + 1, soldCol + 1).setValue(SOLD_VALUE);
        marked.push(String(data[i][idCol]));
      }
    }
    return out_({ ok: true, marked: marked, sheet: SHEET_NAME });
  } finally {
    lock.releaseLock();
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
