// Stripe/js/importerStripe.js
async function importHTML(id, file) {
  const container = document.getElementById(id);
  if (!container) return;
  const res = await fetch(file, { cache: "no-store" });
  const html = await res.text();
  container.innerHTML = html;
}

document.addEventListener("DOMContentLoaded", async () => {
  const imports = [
    ["import-navbar",     "Stripe/partials/navbar.html"],
    ["import-hero",       "Stripe/partials/hero.html"],
    ["import-about",      "Stripe/partials/about.html"],
    ["import-catalogue",  "Stripe/partials/catalogue.html"],
    ["import-workshops",  "Stripe/partials/workshops.html"],
    ["import-giftcards",  "Stripe/partials/giftcards.html"],
    ["import-modals",     "Stripe/partials/modals.html"],
    ["import-contact",    "Stripe/partials/contact.html"],
    ["import-footer",     "Stripe/partials/footer.html"],
    ["import-view-toggle", "Stripe/partials/view-toggle.html"],
  ];

  await Promise.all(imports.map(([id, file]) => importHTML(id, file)));

  if (window.appInitStripe) {
    window.appInitStripe();
  }
});
