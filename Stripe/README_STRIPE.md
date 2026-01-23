# Ceramics Doronina – Variante Stripe (carrello locale + Stripe Checkout)

Questa cartella aggiunge una **seconda entrypoint** (`indexStripe.html`) che:
- mantiene il sito statico (ODS + rendering client-side)
- sostituisce Shopify con **carrello locale** (localStorage)
- per il pagamento usa **Stripe Checkout** tramite una funzione serverless (Netlify)

## Cosa cambia rispetto a Shopify
- Il carrello è gestito interamente nel browser.
- Il checkout **non può essere “solo statico”**: Stripe Checkout richiede una chiamata server-side per creare la sessione (secret key).

## Come provarlo
1. Apri `indexStripe.html` (in locale o sul tuo hosting) e prova ad aggiungere un prodotto al carrello.
2. Il bottone Checkout prova a chiamare:
   - `/.netlify/functions/create-checkout`

## Deploy consigliato
- Mantieni il sito principale su GitHub Pages.
- Pubblica la variante Stripe su **Netlify** (o altro hosting con funzioni serverless).

### Netlify (semplice)
1. Metti la repo su GitHub.
2. Crea un sito su Netlify dalla repo.
3. Imposta la variabile d'ambiente:
   - `STRIPE_SECRET_KEY` = la tua secret key Stripe (test o live)
4. Netlify rileva automaticamente `netlify/functions`.

## Note importanti
- In questa demo usiamo `price_data` creato al volo: va bene per iniziare.
  Se vuoi una gestione più pulita (IVA, inventario, report), conviene creare i **Products/Prices** su Stripe e usare `price` IDs.
- Per vasi unici (pezzi singoli), Stripe Checkout va benissimo: quantità massima per item è forzata a 1.

## File principali
- `indexStripe.html`
- `Stripe/js/catalogueStripe.js` (usa `price_new` e `id` del vaso)
- `Stripe/js/uiStripe.js` (carrello locale + checkout)
- `Stripe/netlify/functions/create-checkout.js`
