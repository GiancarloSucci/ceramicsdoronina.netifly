# ceramicsdoronina checkout functions

Netlify Functions that create Stripe Checkout sessions for the ceramicsdoronina.it shop.

## Repos and hosts
- Site (static): GitHub Pages repo `ceramicsdoronina`, served at https://ceramicsdoronina.it
- This repo (`ceramicsdoronina.netifly`, folder name has a historical typo): deployed on Netlify; only `functions/` is served. `publish` is the placeholder folder `public/` so source files are not published.
- Endpoints: `/.netlify/functions/create-checkout`, `/.netlify/functions/stripe-webhook`

## Environment variables (names only; set in Netlify; this README is the canonical list)
- `STRIPE_SECRET_KEY`: Stripe secret key (test `sk_test_...` or live `sk_live_...`)
- `STRIPE_WEBHOOK_SECRET`: signing secret of the webhook endpoint
- `ALLOWED_ORIGINS`: comma/space separated, no trailing slash, include www if used. Empty or unset means the function refuses everything (fail closed, logged as `config_missing`)
- `SITE_URL`: default `https://ceramicsdoronina.it`; the only source of success/cancel URLs and image URLs. Must be a valid `https://` URL without query/hash (`http://localhost` is accepted for local development only); otherwise the function logs `config_invalid` and answers a generic 500
- `OWNER_NOTIFY_WEBHOOK_URL`: optional but see "Owner notification" below. Must be `https://`; the order summary is POSTed there as JSON `{text, summary}` (5 s timeout, redirects refused)

## Contract: POST create-checkout
Request JSON: `{"items":[{"id":"v1","quantity":1}], "locale":"it"|"en"|"ru"}`. Any other field (price, name, currency, image, return_base, origin, ...) is ignored; an unknown locale is treated as missing (Stripe auto-detects, Italian copy). Ids are catalogue ids (vases `v1..`, masterclass `mc1..`, gift cards `gc-50`, `gc-150`, `gc-200`, `gc-300`). Limits: 1..30 items (the catalogue has 23 products), quantity 1..`maxQty` (vases 1; masterclass = seats from the `spots` column of masterclass.ods, default 6; gift cards 10); repeated ids are merged.

Responses (all carry header `x-request-id`; CORS headers only when the origin is allowed):
- 200 `{"url","session_id","request_id"}`
- 400 `{"error":<code>,"request_id","item_id"?}`: bad JSON/shape, unknown id, sold item, bad quantity; also missing Origin. `item_id` (the catalogue id string) is present for `unknown_item`, `item_sold`, `quantity_too_high`, `invalid_quantity` and absent for body-level errors. The site removes that line from the cart and tells the customer
- 403 origin not allowed; 405 wrong method; 502 Stripe error; 500 generic/misconfiguration

Checkout sessions expire after 31 minutes (`expires_at`; Stripe's minimum is 30). Stripe line item metadata key is `item_id`; session metadata `item_ids` is a comma list of whole ids (ids that would exceed Stripe's 500 character limit are dropped from the end and a `metadata_item_ids_truncated` warning is logged).

Shipping: 40 EUR if physical subtotal < 200 EUR, 20 EUR if < 500 EUR, else free; digital items never count; digital-only carts get no address or shipping. The shipping rate label is localised (it "Spedizione", en "Shipping", ru "Доставка"). Shipping is a Stripe shipping option, so promo codes do not discount it. The allowed country list (`ALLOWED_COUNTRIES`, EU + Norway + Switzerland) is pending owner confirmation; the delivery copy on the site (`messages.js`) and `ALLOWED_COUNTRIES` must always change together.

Code layout: `functions/create-checkout.js` (`validateBody`, pure `buildSessionParams({items, locale, catalogue, siteUrl, now})`, handler), `functions/_shared.js` (Stripe client factory and pinned API version, body decoding, log redaction; the underscore keeps Netlify from deploying it as a function).

## Catalogue and sold items: runbook "sell a vase / change a price"
- The ODS files in the site repo (`catalogue/vasi.ods`, `masterclass.ods`, `certificati.ods`) are CANONICAL. `functions/catalogue.json` is DERIVED: never edit it by hand.
- Prices come from `price_new` (vases), `price` (masterclass), `amount_eur` (gift cards); sold state from `venduto`; masterclass seats from `spots`.
- To sell a vase or change a price: edit the ODS (set `venduto` / change the price) in the site repo, then regenerate here and publish both repos:

      python3 -B -I tools/build-catalogue.py            # regenerate functions/catalogue.json
      python3 -B -I tools/build-catalogue.py --check    # run before publishing: exits 1 with a diff when catalogue.json is out of date

  (`-B` and `-I` keep Python from writing `__pycache__` and from importing stray local modules.) The generator is fatal on any duplicate id, any ambiguous or non-positive price, and any image file that is missing under the site folder. Image folders: vases `images/catalogue/`, masterclass `images/masterclass/`, gift cards `images/certificati/`.
- `functions/sold.json` is a MANUAL EMERGENCY override (array of ids, e.g. `["v3"]`): an id sold in either place is rejected by the function (400 `item_sold`). It does not change what the site displays, which only follows the ODS `venduto` column, so set `venduto` in the ODS afterwards and empty `sold.json` again.
- Obsolete, do not use: `catalogue/shipping.ods`, `vasi.xlsx`, `vasi.1.csv` (site repo).

## Tests
`npm test` (runs `node --test`; Stripe is faked, no dependencies needed). The fake client enforces Stripe API rules (expires_at window, custom field label length, metadata limits, unit amounts, https URLs, shipping only for physical carts). Tests that need the site folder (`../ceramicsdoronina`) or `python3` skip themselves with a reason when absent; the `defaultStripeFactory` smoke test skips when the `stripe` package is not installed. CI: `.github/workflows/test.yml`. `test/fixtures/price-cases.json` holds the price-string cases shared with the site's JS money parser.

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
- [ ] `python3 -B -I tools/build-catalogue.py --check` passes
- [ ] Confirm the Netlify site is bound to this repo and that the deployed commit is current
- [ ] Confirm served countries (`ALLOWED_COUNTRIES` and the site delivery copy)
