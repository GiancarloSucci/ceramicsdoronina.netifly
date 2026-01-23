// Stripe/js/uiStripe.js
(function () {
  // ─────────────────────────────────────────────
  // NAVBAR + VIEW TOGGLE (copiati dal tuo ui.js)
  // ─────────────────────────────────────────────
  function initNavbarToggle() {
    const body = document.body;
    const toggle = document.getElementById("nav-toggle") || document.querySelector(".nav-toggle-btn");
    const navUl = document.querySelector("header nav ul");

    if (!toggle || !navUl) {
      console.warn("[UI] nav toggle elements not found");
      return;
    }

    if (toggle.dataset.bound === "1") return;
    toggle.dataset.bound = "1";

    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isOpen = body.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
  }

  function initNavbarAutoClose() {
    document.addEventListener("click", (e) => {
      const body = document.body;
      if (!body.classList.contains("nav-open")) return;

      const clickedToggle = e.target.closest("#nav-toggle, .nav-toggle-btn");
      const clickedInsideMenu = e.target.closest("header nav ul");
      if (clickedToggle || clickedInsideMenu) return;

      body.classList.remove("nav-open");
    });

    document.addEventListener("click", (e) => {
      const link = e.target.closest("header nav a");
      if (!link) return;
      document.body.classList.remove("nav-open");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") document.body.classList.remove("nav-open");
    });
  }

  function setViewMode(mode) {
    if (mode === "mobile") document.body.classList.add("mobile-view");
    else document.body.classList.remove("mobile-view");
    localStorage.setItem("cd_view", mode);
  }

  function initViewToggle() {
    const saved = localStorage.getItem("cd_view");
    if (saved === "mobile" || saved === "desktop") setViewMode(saved);

    const btn = document.getElementById("view-toggle-btn");
    if (!btn) return;

    btn.addEventListener("click", () => {
      const now = document.body.classList.contains("mobile-view") ? "desktop" : "mobile";
      setViewMode(now);
      btn.textContent = now === "mobile" ? "Desktop" : "Mobile";
    });
  }

  // ─────────────────────────────────────────────
  // I18N helper
  // ─────────────────────────────────────────────
  function getLang() {
    return (
      window.CD?.i18n?.lang ||
      window.CD?.i18n?.currentLang ||
      document.documentElement.lang ||
      "it"
    );
  }

  function t(keyPath) {
    const lang = getLang();
    const all = window.CD?.i18n?.messages || {};
    const dict = all[lang] || all.it || {};
    return keyPath.split(".").reduce((o, k) => (o && o[k] != null ? o[k] : null), dict);
  }

  // ─────────────────────────────────────────────
  // STRIPE CART (client-side) + checkout via endpoint server-side
  // ─────────────────────────────────────────────
  const CART_KEY = "cd_stripe_cart_v1";
  const CHECKOUT_ENDPOINT = "/.netlify/functions/create-checkout"; // Netlify Functions

  function readCart() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function writeCart(arr) {
    localStorage.setItem(CART_KEY, JSON.stringify(arr));
  }

  function normalizeId(x) {
    return String(x || "").trim();
  }

  function formatMoney(amountCents, currency) {
    const c = (currency || "EUR").toUpperCase();
    const v = (Number(amountCents || 0) / 100).toFixed(2);
    // stile semplice (evita Intl per compat)
    return c === "EUR" ? `${v} €` : `${v} ${c}`;
  }

  async function createCheckoutSession(lineItems) {
    const res = await fetch(CHECKOUT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineItems, locale: getLang() })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Checkout API error: ${res.status} ${txt}`);
    }
    return res.json();
  }

  window.CD = window.CD || {};
  const existingShop = window.CD.shop || {};

  // Per minimizzare modifiche nel resto del sito, esponiamo un oggetto CD.shop
  // con le stesse API usate prima (addVariant, removeLineItem, renderDrawer, resetCart, etc.)
  window.CD.shop = Object.assign(existingShop, {
    isReady: true,

    // prod registry (popolato da catalogueStripe.js):
    // CD.shop.products[productId] = { id, titles, priceCents, currency, img }
    products: existingShop.products || {},

    async init() {
      // no-op (il carrello e' locale)
      return true;
    },

    async resetCart() {
      writeCart([]);
      await this.renderDrawer();
    },

    // In Shopify era variantId. Qui e' productId (vase.id)
    async addVariant(productId, qty = 1) {
      const id = normalizeId(productId);
      if (!id) return false;

      const p = this.products[id];
      if (!p) {
        console.warn("⚠️ [STRIPE] prodotto non registrato:", id);
        return false;
      }

      const cart = readCart();
      const idx = cart.findIndex(x => normalizeId(x.id) === id);
      if (idx >= 0) cart[idx].qty = Math.min(99, Number(cart[idx].qty || 1) + Number(qty || 1));
      else cart.push({ id, qty: Math.max(1, Number(qty || 1)) });

      writeCart(cart);
      await this.renderDrawer();
      this.openDrawer();
      return true;
    },

    async removeLineItem(productId) {
      const id = normalizeId(productId);
      const cart = readCart().filter(x => normalizeId(x.id) !== id);
      writeCart(cart);
      await this.renderDrawer();
    },

    async renderDrawer() {
      const itemsEl = document.getElementById("cart-items");
      const totalEl = document.getElementById("cart-total");
      const checkoutBtn = document.getElementById("cart-checkout-btn");
      if (!itemsEl || !totalEl || !checkoutBtn) return;

      const cart = readCart();
      if (!cart.length) {
        itemsEl.innerHTML = `<div style="color:var(--muted)">${t("cart.empty") || "Il carrello e' vuoto"}</div>`;
        totalEl.textContent = "0";
        checkoutBtn.textContent = t("cart.checkout") || "Checkout";
        checkoutBtn.setAttribute("href", "#");
        checkoutBtn.dataset.disabled = "1";
        return;
      }

      // calcolo totale
      let totalCents = 0;
      let currency = "EUR";

      const lang = getLang();
      const rows = cart.map((ci) => {
        const p = this.products[normalizeId(ci.id)];
        if (!p) return "";

        currency = p.currency || currency;
        const qty = Math.max(1, Number(ci.qty || 1));
        totalCents += (Number(p.priceCents || 0) * qty);

        const title = (p.titles && (p.titles[lang] || p.titles.it || p.titles.en || p.titles.ru)) || ci.id;
        const price = formatMoney(Number(p.priceCents || 0) * qty, currency);

        return `
          <div class="cart-item">
            ${p.img ? `<img class="cart-item__img" src="${p.img}" alt="">` : ""}
            <div class="cart-item__meta">
              <div class="cart-item__title">${title}</div>
              <div class="cart-item__sub">${t("cart.qty") || "Qty"}: ${qty} · ${price}</div>
              <button type="button" class="cart-item__remove" data-line-id="${ci.id}">
                ${t("cart.remove") || "Remove"}
              </button>
            </div>
          </div>
        `;
      }).filter(Boolean).join("");

      itemsEl.innerHTML = rows || `<div style="color:var(--muted)">${t("cart.empty") || "Il carrello e' vuoto"}</div>`;
      totalEl.textContent = formatMoney(totalCents, currency);

      checkoutBtn.textContent = t("cart.checkout") || "Checkout";
      checkoutBtn.setAttribute("href", "#");
      checkoutBtn.dataset.disabled = "0";

      // bind click una sola volta
      if (!checkoutBtn.dataset.boundStripeCheckout) {
        checkoutBtn.dataset.boundStripeCheckout = "1";
        checkoutBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();

          if (checkoutBtn.dataset.disabled === "1") return;

          try {
            // costruisci lineItems per backend
            const lineItems = readCart().map(ci => {
              const p = this.products[normalizeId(ci.id)];
              if (!p) return null;
              return {
                id: normalizeId(ci.id),
                quantity: Math.max(1, Number(ci.qty || 1)),
                // metadata utili per creare il prodotto in checkout
                name: (p.titles && (p.titles[getLang()] || p.titles.it || p.titles.en || p.titles.ru)) || normalizeId(ci.id),
                currency: (p.currency || "EUR").toLowerCase(),
                unit_amount: Number(p.priceCents || 0),
                image: p.img || ""
              };
            }).filter(Boolean);

            // tracking "best effort" come prima
            localStorage.setItem("cd_checkout_started", "1");
            localStorage.setItem("cd_checkout_ts", String(Date.now()));

            const out = await createCheckoutSession(lineItems);
            if (!out || !out.url) throw new Error("No checkout url from server");

            window.location.href = out.url;
          } catch (err) {
            console.error("❌ [STRIPE] checkout error:", err);
            alert("Errore checkout. Controlla configurazione Stripe/Netlify.");
          }
        });
      }
    },

    openDrawer() {
      const drawer = document.getElementById("cart-drawer");
      if (!drawer) return;
      drawer.classList.add("is-open");
      drawer.setAttribute("aria-hidden", "false");
    },

    closeDrawer() {
      const drawer = document.getElementById("cart-drawer");
      if (!drawer) return;
      drawer.classList.remove("is-open");
      drawer.setAttribute("aria-hidden", "true");
    }
  });

  // ─────────────────────────────────────────────
  // CART OPEN/CLOSE BUTTONS
  // ─────────────────────────────────────────────
  function initCartOpenButton() {
    const drawer = document.getElementById("cart-drawer");
    if (!drawer) {
      console.warn("[UI] #cart-drawer non trovato");
      return;
    }

    if (drawer.dataset.bound === "1") return;
    drawer.dataset.bound = "1";

    async function openCart(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      await window.CD.shop.init();
      await window.CD.shop.renderDrawer();
      window.CD.shop.openDrawer();
    }

    function closeCart(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      window.CD.shop.closeDrawer();
    }

    document.addEventListener("click", (e) => {
      const openBtn = e.target.closest("#cart-open-btn");
      if (openBtn) return openCart(e);

      const closeBtn = e.target.closest("#cart-close-btn");
      if (closeBtn) return closeCart(e);

      // click sullo sfondo: chiudi se clicchi fuori dal pannello
      if (e.target && e.target.id === "cart-drawer") return closeCart(e);
    }, false);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeCart(e);
    });
  }

  // delegazione remove item
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".cart-item__remove");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const lineId = btn.dataset.lineId;
    if (!lineId) return;
    await window.CD.shop.removeLineItem(lineId);
  });

  // ─────────────────────────────────────────────
  // EXPORT
  // ─────────────────────────────────────────────
  window.CD.ui = {
    initNavbarToggle,
    initNavbarAutoClose,
    initViewToggle,
    initCartOpenButton
  };
})();
