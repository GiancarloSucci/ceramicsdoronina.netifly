# ceramicsdoronina checkout functions

Netlify Functions that create Stripe Checkout sessions for the ceramicsdoronina.it shop.

## Repos and hosts
- Site (static): GitHub Pages repo `ceramicsdoronina`, served at https://ceramicsdoronina.it
- This repo (`ceramicsdoronina.netifly`, folder name has a historical typo): deployed on Netlify; only `functions/` is served. `publish` is the placeholder folder `public/` so source files are not published.
- Endpoints: `/.netlify/functions/create-checkout`, `/.netlify/functions/stripe-webhook`

## Environment variables (names only; set in Netlify)
- `STRIPE_SECRET_KEY`: Stripe secret key (test `sk_test_...` or live `sk_live_...`)
- `STRIPE_WEBHOOK_SECRET`: signing secret of the webhook endpoint
- `ALLOWED_ORIGINS`: comma/space separated, no trailing slash, include www if used. Empty or unset means the function refuses everything (fail closed)
- `SITE_URL`: default `https://ceramicsdoronina.it`; the only source of success/cancel URLs and image URLs
- `OWNER_NOTIFY_WEBHOOK_URL`: optional; the order summary is POSTed there as JSON `{text, summary}`. Without it the owner notification is only a log line (no email provider is configured)

## Contract: POST create-checkout
Request JSON: `{"items":[{"id":"v1","quantity":1}], "locale":"it"|"en"|"ru"}`. Any other field (price, name, currency, image, return_base, origin, ...) is ignored. Ids are catalogue ids (vases `v1..`, masterclass `mc1..`, gift cards `gc-50`, `gc-150`, `gc-200`, `gc-300`). Limits: 1..20 items, quantity 1..`maxQty` (vases 1, masterclass 6, gift cards 10); repeated ids are merged.

Responses (all carry header `x-request-id`; CORS headers only when the origin is allowed):
- 200 `{"url","session_id","request_id"}`
- 400 `{"error":<code>,"request_id"}` bad JSON/shape, unknown id, sold item, bad quantity; also missing Origin
- 403 origin not allowed; 405 wrong method; 502 Stripe error; 500 generic/misconfiguration

Shipping: 40 EUR if physical subtotal < 200 EUR, 20 EUR if < 500 EUR, else free; digital items never count; digital-only carts get no address or shipping. Shipping is a Stripe shipping option, so promo codes do not discount it. The allowed country list (`ALLOWED_COUNTRIES`) is pending owner confirmation.

## Catalogue and sold items
`functions/catalogue.json` is generated from the site's ODS files:

    python3 -I tools/build-catalogue.py [path/to/ceramicsdoronina/catalogue]

It reads `price_new` (vases), `price` (masterclass), `amount_eur` (gift cards) and `venduto`. It fails on duplicate ids (temporary special case: a second `v8` becomes `v9` with a warning). `functions/sold.json` is an array of ids the owner marks sold manually (e.g. `["v3"]`); an id sold in either place is rejected. Regenerate and redeploy after any price change.

## Tests
`npm test` (runs `node --test`; no dependencies needed, Stripe is faked).

## Stripe webhook setup
Stripe Dashboard > Developers > Webhooks > add endpoint `https://<netlify-site>/.netlify/functions/stripe-webhook`, event `checkout.session.completed`; copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Deliveries are stateless and may repeat; the notification is informational, so duplicates are harmless (`event_id` is logged).

## Pre-launch checklist
- Decide test vs live: use the key matching the mode of the webhook endpoint; do a test-mode purchase first
- Run `npm install` once and commit the generated `package-lock.json` (not generated offline)
- Set `ALLOWED_ORIGINS` (no trailing slash, include www if used), `SITE_URL`, `STRIPE_WEBHOOK_SECRET`
- Confirm the Netlify site is bound to this repo and that the deployed commit is current
- Confirm served countries and owner notification channel
