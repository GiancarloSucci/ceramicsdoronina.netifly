# ceramicsdoronina checkout functions

Netlify Functions that create Stripe Checkout sessions for the ceramicsdoronina.it shop.

## Repos and hosts
- Site (static): GitHub Pages repo `ceramicsdoronina`, served at https://ceramicsdoronina.it
- This repo (`ceramicsdoronina.netifly`, folder name has a historical typo): deployed on Netlify; only `functions/` is served. `publish` is the placeholder folder `public/` so source files are not published.
- Endpoints: `/.netlify/functions/create-checkout`, `/.netlify/functions/stripe-webhook`, `/.netlify/functions/catalogue` (public read-only catalogue, GET)

## Environment variables (names only; set in Netlify; this README is the canonical list)
- `STRIPE_SECRET_KEY`: Stripe secret key (test `sk_test_...` or live `sk_live_...`)
- `STRIPE_WEBHOOK_SECRET`: signing secret of the webhook endpoint
- `ALLOWED_ORIGINS`: comma/space separated, no trailing slash, include www if used. Empty or unset means the function refuses everything (fail closed, logged as `config_missing`)
- `SITE_URL`: default `https://ceramicsdoronina.it`; the only source of success/cancel URLs and image URLs. Must be a valid `https://` URL without query/hash (`http://localhost` is accepted for local development only); otherwise the function logs `config_invalid` and answers a generic 500
- `OWNER_NOTIFY_WEBHOOK_URL`: optional but see "Owner notification" below. Must be `https://`; the order summary is POSTed there as JSON `{text, summary}` (5 s timeout, redirects refused)
- `CATALOGUE_CSV_URL`: optional. The Google Sheet "Publish to web" CSV link. Must be `https://` on `docs.google.com` only; anything else is rejected (warn `catalogue_source_rejected`, snapshot used). Unset: the bundled snapshot is used and one warn `catalogue_source_not_configured` is logged. Only the host is ever logged, never the full URL
- `CATALOGUE_WRITE_URL`: optional. The Apps Script web app `/exec` URL used to mark a paid one-off piece as sold. `https://` on `script.google.com` only
- `CATALOGUE_WRITE_SECRET`: shared secret sent to that script (must equal the script property `SECRET`). Never logged
- How they fit together: `ALLOWED_ORIGINS` and `SITE_URL` only concern `create-checkout` (browser origin, redirect and image URLs); the `catalogue` endpoint is public and answers CORS `*`. The three `CATALOGUE_*` variables are read by all three functions through `functions/_catalogue-source.js`. Without them everything keeps working from the snapshot, but a sold piece must then be marked by hand

## Contract: POST create-checkout
Request JSON: `{"items":[{"id":"v1","quantity":1}], "locale":"it"|"en"|"ru"}`. Any other field (price, name, currency, image, return_base, origin, ...) is ignored; an unknown locale is treated as missing (Stripe auto-detects, Italian copy). Ids are catalogue ids (vases `v1..`, masterclass `mc1..`, gift cards `gc-50`, `gc-150`, `gc-200`, `gc-300`). Limits: 1..30 items (the catalogue has 23 products), quantity 1..`maxQty` (vases 1; masterclass = seats from the `spots` column of masterclass.ods, default 6; gift cards 10); repeated ids are merged.

Responses (all carry header `x-request-id`; CORS headers only when the origin is allowed):
- 200 `{"url","session_id","request_id"}`
- 400 `{"error":<code>,"request_id","item_id"?}`: bad JSON/shape, unknown id, sold item, bad quantity; also missing Origin. `item_id` (the catalogue id string) is present for `unknown_item`, `item_sold`, `quantity_too_high`, `invalid_quantity` and absent for body-level errors. The site removes that line from the cart and tells the customer
- 403 origin not allowed; 405 wrong method; 502 Stripe error; 500 generic/misconfiguration

Checkout sessions expire after 31 minutes (`expires_at`; Stripe's minimum is 30). Stripe line item metadata key is `item_id`; session metadata `item_ids` is a comma list of whole ids (ids that would exceed Stripe's 500 character limit are dropped from the end and a `metadata_item_ids_truncated` warning is logged).

Shipping: 40 EUR if physical subtotal < 200 EUR, 20 EUR if < 500 EUR, else free; digital items never count; digital-only carts get no address or shipping. The shipping rate label is localised (it "Spedizione", en "Shipping", ru "Доставка"). Shipping is a Stripe shipping option, so promo codes do not discount it. The allowed country list (`ALLOWED_COUNTRIES`, EU + Norway + Switzerland) is pending owner confirmation; the delivery copy on the site (`messages.js`) and `ALLOWED_COUNTRIES` must always change together.

Code layout: `functions/_catalogue-source.js` (sheet CSV reader, cache, fallbacks, sold write-back), `functions/catalogue.js` (public endpoint), `functions/create-checkout.js` (`validateBody`, pure `buildSessionParams({items, locale, catalogue, siteUrl, now})`, handler), `functions/_shared.js` (Stripe client factory and pinned API version, body decoding, log redaction; the underscore keeps Netlify from deploying it as a function).

## Catalogue and sold items: the Google Sheet is LIVE
The prices, names, types, images, `maxQty` and `sold` flags that `create-checkout` charges from, and that `GET /.netlify/functions/catalogue` publishes, come from a Google Sheet published as CSV (`CATALOGUE_CSV_URL`), read server-side. Columns (header row required): `id,type,name_it,name_en,name_ru,price,image,maxQty,sold`.
- `id` `^[a-z][a-z0-9-]{0,31}$`; `type` `physical|digital`; `price` whole or decimal euros in (0, 10000], `120` or `120,50` (same strict rules as `test/fixtures/price-cases.json`: at most 2 decimals, no thousands separators); `maxQty` integer 1..100; `sold` `TRUE/true/1/yes/si/sì/x` or empty; `image` a path relative to the site root.
- Invalid rows are dropped (warn `catalogue_rows_dropped`, ids only). A duplicate id, a missing column, zero valid rows or more than half invalid rows reject the WHOLE sheet, which then counts as a failed fetch.
- Cache: 60 s in memory per function instance. `GET catalogue` answers `Cache-Control: public, max-age=60`.
- `functions/catalogue.json` is now only the OFFLINE FALLBACK snapshot (generated by `tools/build-catalogue.py` from the ODS files, never edit by hand); `functions/sold.json` stays a manual emergency override (array of ids) merged on top of whatever source is used.

### Owner runbook: change a price, mark sold, add a product
- Change a price, rename, set `maxQty`, mark a piece sold or add a product: edit the sheet. Google's published CSV lags a few minutes, so the change reaches the shop (and checkout) after that delay.
- A piece paid through Stripe is marked sold automatically (the webhook calls the Apps Script) and is treated as sold at once by the functions for 15 minutes, until the published CSV catches up.
- Image FILES still need a git push to the site repo (`images/catalogue/...`); the sheet only holds the path.
- Optional, after bigger changes: refresh the offline snapshot with `python3 -B -I tools/build-catalogue.py` (it reads the ODS files, so keep them in step) and push.

### Google setup (once)
1. In the sheet: File > Share > Publish to web > sheet `Catalogue`, format CSV > Publish. Copy the link into `CATALOGUE_CSV_URL` (Netlify).
2. Extensions > Apps Script: paste `tools/apps-script/Code.gs` (reference copy of the script), save.
3. Project Settings > Script properties: add `SECRET` = a long random value; put the same value in `CATALOGUE_WRITE_SECRET` (Netlify).
4. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone. Copy the `/exec` URL into `CATALOGUE_WRITE_URL` (Netlify). After editing the script, create a new deployment version.
5. The tab must be named `Catalogue` and have the columns `id` and `sold`. Contract: `POST {"secret","ids":[...]}` answers `{"ok":true,"marked":[...]}` or `{"ok":false,"error":"forbidden|bad_json|bad_ids|bad_columns"}`; the function follows Apps Script's 302 and only trusts a final JSON body with `ok: true` (5 s timeout, up to 2 retries with short backoff on network errors, 5xx or non-JSON answers).

### Failure matrix
| What fails | Effect |
|---|---|
| Sheet unreachable, slow (5 s), over 256 KB, or rejected as invalid | last good copy is served for up to 24 h (`source: "stale"`), then the snapshot (`source: "snapshot"`); warn `catalogue_fetch_failed` with host and reason; retried at most every 15 s |
| `CATALOGUE_CSV_URL` unset, not https, or not `docs.google.com` | snapshot; warn once per cause |
| Marking write fails (or `CATALOGUE_WRITE_URL`/`SECRET` unset) | the piece is still treated as sold locally for 15 minutes; warn `sold_mark_failed` / `sold_mark_not_configured`; the owner notification gets the line `ACTION: mark <ids> as sold in the sheet manually`; the webhook still answers 200 to Stripe |
| Sheet is edited by hand and a locally marked piece is un-sold | stays sold for up to 15 minutes (local marker), then follows the sheet |

Only one-off pieces are marked: items with `type` physical and `maxQty` 1 in a PAID order (paid session, `no_payment_required`, or `async_payment_succeeded`); masterclass and gift cards never. Ids come from the session metadata `item_ids`. Stripe retries re-mark harmlessly.
- Obsolete, do not use: `catalogue/shipping.ods`, `vasi.xlsx`, `vasi.1.csv` (site repo).

## Tests
`npm test` (runs `node --test`; Stripe is faked, no dependencies needed). The fake client enforces Stripe API rules (expires_at window, custom field label length, metadata limits, unit amounts, https URLs, shipping only for physical carts). Tests that need the site folder (`../ceramicsdoronina`) or `python3` skip themselves with a reason when absent; the `defaultStripeFactory` smoke test skips when the `stripe` package is not installed. CI: `.github/workflows/test.yml`. `test/fixtures/price-cases.json` holds the price-string cases shared with the site's JS money parser; `test/fixtures/catalogue-sheet.csv` is a copy of the expected sheet CSV. The sheet and Apps Script calls are tested with an injected fake `fetch` (no network).

## Stripe webhook setup
Stripe Dashboard > Developers > Webhooks > add endpoint `https://<netlify-site>/.netlify/functions/stripe-webhook` and subscribe to exactly these events:
- `checkout.session.completed` (paid: "New paid order"; not yet paid, e.g. delayed payment methods: "AWAITING PAYMENT, do not ship")
- `checkout.session.async_payment_succeeded` (notified as paid)
- `checkout.session.async_payment_failed` (notified as failed, do not ship)

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. The signature is verified on the raw body. Deliveries are stateless and may repeat; the notification is informational, so duplicates are harmless (`event_id` is logged). If the owner notification cannot be sent (non-2xx or network error) the function answers 500 so Stripe retries. Customer text in the summary is length-capped and neutralised for chat markup; every log line carries `request_id`; no customer PII is logged.

## Owner notification (mandatory decision)
Without `OWNER_NOTIFY_WEBHOOK_URL` (or the Stripe Dashboard owner emails) there is NO owner notification: the only trace of an order is a `console.warn` event `owner_notify_not_configured` in the Netlify function log (session id, event id, catalogue ids, total, currency, payment status, country; no personal data) and the order in the Stripe Dashboard. Either set `OWNER_NOTIFY_WEBHOOK_URL` (Slack/Teams/Make/Zapier style endpoint that accepts `{text, summary}`) or enable Stripe Dashboard > Settings > Emails owner notifications for successful payments. The channel is the owner's choice.

## Pre-launch checklist
- [ ] MANDATORY: owner notification channel chosen and tested: `OWNER_NOTIFY_WEBHOOK_URL` set, or Stripe Dashboard owner payment emails enabled (see above)
- [ ] Enable customer receipts: Stripe Dashboard > Settings > Emails (the site tells customers that Stripe emails the receipt)
- [ ] Decide test vs live: use the key matching the mode of the webhook endpoint; do a test-mode purchase first (also try a sold item and a stale cart)
- [ ] Webhook endpoint subscribed to the three events listed above
- [ ] Run `npm install` once and commit the generated `package-lock.json` (not generated offline)
- [ ] Set `ALLOWED_ORIGINS` (no trailing slash, include www if used), `SITE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- [ ] `python3 -B -I tools/build-catalogue.py --check` passes (snapshot is current)
- [ ] Google Sheet published as CSV and Apps Script deployed (see "Google setup"); `CATALOGUE_CSV_URL`, `CATALOGUE_WRITE_URL`, `CATALOGUE_WRITE_SECRET` set; `GET /.netlify/functions/catalogue` answers `source: "sheet"`
- [ ] Confirm the Netlify site is bound to this repo and that the deployed commit is current
- [ ] Confirm served countries (`ALLOWED_COUNTRIES` and the site delivery copy)
