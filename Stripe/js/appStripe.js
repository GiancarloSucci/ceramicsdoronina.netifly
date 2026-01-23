// Stripe/js/appStripe.js
async function appInitStripe() {
  console.log("🚀 [APP/STRIPE] Inizializzazione app...");

  // lingua
  CD.i18n.initLanguage();
  const currentLang = CD.i18n.getCurrentLang();
  console.log("🔍 [APP/STRIPE] Lingua corrente:", currentLang);

  try {
    console.log("🔍 [APP/STRIPE] Caricamento dati in parallelo...");

    const [catalogueItems, masterclassItems, certificatiItems] = await Promise.all([
      CD.catalogue.loadCsv(),
      CD.masterclass ? CD.masterclass.loadCsv() : Promise.resolve([]),
      CD.certificati ? CD.certificati.loadCsv() : Promise.resolve([])
    ]);

    window.__catalogueData = catalogueItems;
    window.__masterclassData = masterclassItems;
    window.__certificatiData = certificatiItems;

    CD.catalogue.render(catalogueItems, currentLang);
    if (CD.masterclass) CD.masterclass.render(masterclassItems, currentLang);
    if (CD.certificati) CD.certificati.render(certificatiItems, currentLang);

    await new Promise((r) => setTimeout(r, 50));
    CD.catalogue.initBehaviour();

  } catch (err) {
    console.error("❌ [APP/STRIPE] Errore nel caricamento dei dati:", err);
    console.error("❌ [APP/STRIPE] Stack trace:", err && err.stack);
  }

  // UI
  CD.ui.initNavbarToggle();
  CD.ui.initNavbarAutoClose();
  CD.ui.initViewToggle();
  CD.ui.initCartOpenButton();

  // Precarica shop (Stripe-cart: init è sincrono / no-op)
  if (CD.shop?.init) await CD.shop.init();

  console.log("🎉 [APP/STRIPE] Inizializzazione completata!");

  // ─────────────────────────────────────────────
  // RITORNO DA STRIPE CHECKOUT (success/cancel)
  // ─────────────────────────────────────────────
  function getParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (_) {
      return null;
    }
  }

  const stripeSuccess = getParam("stripe_success");
  const stripeCancel = getParam("stripe_cancel");

  if (stripeSuccess === "1") {
    // ordine completato
    if (CD.shop?.resetCart) CD.shop.resetCart();

    const lang = CD.i18n.getCurrentLang();
    const dict = CD.i18n.messages[lang] || CD.i18n.messages.it;
    alert(dict.checkoutStatus?.success || "Ordine completato!");

    // pulizia url
    window.history.replaceState({}, "", window.location.origin + window.location.pathname + "#home");
  } else if (stripeCancel === "1") {
    const lang = CD.i18n.getCurrentLang();
    const dict = CD.i18n.messages[lang] || CD.i18n.messages.it;
    alert(dict.checkoutStatus?.fail || "Checkout annullato.");

    window.history.replaceState({}, "", window.location.origin + window.location.pathname + "#home");
  }

  // Safari/Chrome bfcache
  window.addEventListener("pageshow", async () => {
    if (CD.shop?.renderDrawer) CD.shop.renderDrawer();
  });
}

window.appInitStripe = appInitStripe;
