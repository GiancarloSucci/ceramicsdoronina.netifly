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
    ["import-navbar",     "Stripe/partials/netlify_navbar.html"],
    ["import-hero",       "Stripe/partials/netlify_hero.html"],
    ["import-about",      "Stripe/partials/netlify_about.html"],
    ["import-catalogue",  "Stripe/partials/netlify_catalogue.html"],
    ["import-workshops",  "Stripe/partials/netlify_workshops.html"],
    ["import-giftcards",  "Stripe/partials/netlify_giftcards.html"],
    ["import-modals",     "Stripe/partials/netlify_modals.html"],
    ["import-contact",    "Stripe/partials/netlify_contact.html"],
    ["import-footer",     "Stripe/partials/netlify_footer.html"],
    ["import-view-toggle", "Stripe/partials/netlify_view-toggle.html"],
  ];

  await Promise.all(imports.map(([id, file]) => importHTML(id, file)));

  if (window.appInitStripe) {
    window.appInitStripe();
  }
});
