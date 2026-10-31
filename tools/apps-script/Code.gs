// Reference copy of the Google Apps Script bound to the catalogue sheet (documentation:
// the live copy is pasted in Extensions > Apps Script; keep both in sync).
// Web app: Execute as Me, Who has access: Anyone. Script property SECRET must equal
// CATALOGUE_WRITE_SECRET in Netlify. Contract:
//   POST {"secret": "...", "ids": ["v3", ...]}
//   -> {"ok":true,"marked":[...]} | {"ok":false,"error":"forbidden|bad_json|bad_ids|bad_columns"}
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
    var sheet = SpreadsheetApp.getActive().getSheetByName('Catalogue');
    var data = sheet.getDataRange().getValues();
    var idCol = data[0].indexOf('id');
    var soldCol = data[0].indexOf('sold');
    if (idCol < 0 || soldCol < 0) return out_({ ok: false, error: 'bad_columns' });
    var marked = [];
    for (var i = 1; i < data.length; i++) {
      if (body.ids.indexOf(String(data[i][idCol])) >= 0) {
        sheet.getRange(i + 1, soldCol + 1).setValue(true);
        marked.push(String(data[i][idCol]));
      }
    }
    return out_({ ok: true, marked: marked });
  } finally {
    lock.releaseLock();
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
