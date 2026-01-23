// Stripe/js/catalogueStripe.js
// Versione "Stripe" del catalogue: mantiene layout e modali, ma i pulsanti Compra
// aggiungono al carrello locale (CD.shop) invece che a Shopify.
(function () {

  // Carica il file ODS (identico)
  async function loadCsv() {
    try {
      const res = await fetch("catalogue/vasi.ods", { cache: "no-store" });
      if (!res.ok) {
        console.error("Impossibile caricare vasi.ods");
        return [];
      }

      const arrayBuffer = await res.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];

      const data = XLSX.utils.sheet_to_json(worksheet, {
        raw: false,
        defval: ""
      });

      console.log("Dati caricati dal file ODS:", data.length, "righe");
      return data;

    } catch (error) {
      console.error("Errore nel caricamento del file ODS:", error);
      return [];
    }
  }

  function pickFieldByLang(vase, baseKey, lang) {
    if (lang === "en") return (vase[`${baseKey}-en`] || "").trim();
    if (lang === "ru") return (vase[`${baseKey}-ru`] || "").trim();
    return (vase[baseKey] || "").trim();
  }

  function getLang() {
    return (
      window.CD?.i18n?.getCurrentLang?.() ||
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

  function parseEuroToCents(v) {
    const s = String(v || "").trim();
    if (!s || s === "-") return null;
    // gestisce "1.234,56" e "1234.56"
    const norm = s.replace(/\./g, "").replace(",", ".");
    const n = Number(norm);
    if (!isFinite(n)) return null;
    return Math.round(n * 100);
  }

  function firstImgPath(vase) {
    const fn = [vase.img1, vase.img2, vase.img3, vase.img4, vase.img5, vase.img6]
      .find(x => x && x !== "-");
    return fn ? `images/catalogue/${fn}` : "images/placeholder.jpg";
  }

  // Rende il catalogo nella griglia e crea i modali
  function render(items, lang) {
    const grid = document.getElementById("catalogue-grid");
    const modalRoot = document.getElementById("modal-container");

    if (!grid) {
      console.warn("catalogue-grid non trovato nel DOM");
      return;
    }

    const allMessages = window.CD && CD.i18n && CD.i18n.messages ? CD.i18n.messages : null;
    if (!allMessages) {
      console.warn("Messaggi di traduzione non disponibili");
      return;
    }
    const msgs = allMessages[lang] || allMessages.it;

    // ordina: prima non venduti
    items.sort((a, b) => {
      const aSold = (a.venduto || "").trim().toLowerCase() === "si";
      const bSold = (b.venduto || "").trim().toLowerCase() === "si";
      if (aSold === bSold) return 0;
      return aSold ? 1 : -1;
    });

    grid.innerHTML = "";
    if (modalRoot) modalRoot.innerHTML = "";

    // registra prodotti per Stripe-cart
    window.CD = window.CD || {};
    window.CD.shop = window.CD.shop || {};
    window.CD.shop.products = window.CD.shop.products || {};

    items.forEach(vase => {
      const name  = vase[`name_${lang}`]  && vase[`name_${lang}`]  !== "-" ? vase[`name_${lang}`]  : vase.name_ru;
      const short = vase[`short_${lang}`] && vase[`short_${lang}`] !== "-" ? vase[`short_${lang}`] : vase.short_ru;
      const long  = vase[`long_${lang}`]  && vase[`long_${lang}`]  !== "-" ? vase[`long_${lang}`]  : vase.long_ru;

      const sold = (vase.venduto || "").trim().toLowerCase() === "si";
      const priceOldStr = vase.price_old && vase.price_old !== "-" ? vase.price_old : null;
      const priceNewStr = vase.price_new && vase.price_new !== "-" ? vase.price_new : null;

      const priceCents = sold ? null : parseEuroToCents(priceNewStr);

      const productId = String(vase.id || "").trim();
      const img = firstImgPath(vase);

      if (productId) {
        window.CD.shop.products[productId] = {
          id: productId,
          sold: !!sold,
          priceCents,
          currency: "EUR",
          img,
          nameByLang: {
            it: (vase.name_it && vase.name_it !== "-") ? vase.name_it : (vase.name_ru || ""),
            en: (vase.name_en && vase.name_en !== "-") ? vase.name_en : (vase.name_ru || ""),
            ru: (vase.name_ru && vase.name_ru !== "-") ? vase.name_ru : ""
          }
        };
      }

      let discount = null;
      if (!sold && priceOldStr && priceNewStr) {
        const oldNum = parseFloat(String(priceOldStr).replace(",", "."));
        const newNum = parseFloat(String(priceNewStr).replace(",", "."));
        if (!isNaN(oldNum) && !isNaN(newNum) && oldNum > newNum) {
          discount = Math.round((1 - newNum / oldNum) * 100);
        }
      }

      let cardStatusBlock = "";
      if (sold) {
        cardStatusBlock = `
          <p class="card-status card-status-sold">
            ${msgs.status.sold}
          </p>
        `;
      } else if (priceNewStr) {
        const discountBlock = discount !== null
          ? `<span class="price-discount">-${discount}%</span>`
          : "";
        if (priceOldStr) {
          cardStatusBlock = `
            <div class="card-price">
              <span class="price-old">${priceOldStr}€</span>
              <span class="price-current">${priceNewStr}€</span>
              ${discountBlock}
            </div>
          `;
        } else {
          cardStatusBlock = `
            <div class="card-price">
              <span class="price-current">${priceNewStr}€</span>
              ${discountBlock}
            </div>
          `;
        }
      }

      const primaryLabel   = msgs.catalogue.addToCart;
      const secondaryLabel = msgs.catalogue.viewPhotos;

      // immagini card
      const cardImgs = [
        vase.img1, vase.img2, vase.img3,
        vase.img4, vase.img5, vase.img6
      ].filter(x => x && x !== "-")
       .map(fn => `images/catalogue/${fn}`);

      const cardGalleryHtml = cardImgs.length
        ? cardImgs.map((src, idx) => `
            <img src="${src}" alt="${name} ${idx + 1}" class="card-img ${idx === 0 ? "active" : ""}">
          `).join("")
        : `<img src="images/placeholder.jpg" alt="${name}" class="card-img active">`;

      const hasMultiple = cardImgs.length > 1;

      let actionsHtml = "";
      if (sold) {
        actionsHtml = `
          <div class="card-actions">
            <button class="card-btn secondary" data-modal-target="modal-${vase.id}">
              ${secondaryLabel}
            </button>
          </div>`;
      } else {
        // ✅ Vendibile via Stripe solo se ho id + prezzo
        const canSell = !!(productId && priceCents != null && priceCents > 0);

        if (!canSell) {
          actionsHtml = `
            <div class="card-actions">
              <button class="card-btn secondary" data-modal-target="modal-${vase.id}">
                ${secondaryLabel}
              </button>
            </div>`;
        } else {
          actionsHtml = `
            <div class="card-actions">
              <button class="card-btn primary"
                      type="button"
                      data-add-to-cart="${productId}"
                      data-vase-name="${name}">
                ${primaryLabel}
              </button>
              <button class="card-btn secondary" data-modal-target="modal-${vase.id}">
                ${secondaryLabel}
              </button>
            </div>`;
        }
      }

      const card = document.createElement("article");
      card.className = "card";

      card.innerHTML = `
        <div class="media media-carousel" data-card-gallery="${vase.id}">
          <div class="card-gallery">
            ${cardGalleryHtml}
          </div>

          ${hasMultiple ? `
            <button type="button" class="card-gallery-btn prev" data-card-prev="${vase.id}" aria-label="Previous image">‹</button>
            <button type="button" class="card-gallery-btn next" data-card-next="${vase.id}" aria-label="Next image">›</button>
            <div class="card-gallery-counter" data-card-counter="${vase.id}">1/${cardImgs.length}</div>
          ` : ``}
        </div>

        <div class="body">
          <h4>${name}</h4>
          <p>${short}</p>
          ${cardStatusBlock}
          ${actionsHtml}
        </div>
      `;

      grid.appendChild(card);

      // ---------- MODALE ----------
      if (!modalRoot) return;

      const imgs = cardImgs;

      const modal = document.createElement("div");
      modal.className = "modal";
      modal.id = `modal-${vase.id}`;

      let priceBlock = "";
      if (sold) {
        priceBlock = `
          <div class="vase-price-row">
            <span class="vase-price">${msgs.status.sold}</span>
          </div>
        `;
      } else if (priceNewStr) {
        const discountBlock = discount !== null
          ? `<span class="vase-discount">-${discount}%</span>`
          : "";
        if (priceOldStr) {
          priceBlock = `
            <div class="vase-price-row">
              <span class="vase-old-price">${priceOldStr}€</span>
              <span class="vase-price">${priceNewStr}€</span>
              ${discountBlock}
            </div>
          `;
        } else {
          priceBlock = `
            <div class="vase-price-row">
              <span class="vase-price">${priceNewStr}€</span>
              ${discountBlock}
            </div>
          `;
        }
      }

      const spec = msgs.catalogue.spec;

      const galleryImgsHtml = imgs.map((src, idx) => `
        <img src="${src}" alt="${name} ${idx + 1}" data-index="${idx}" class="${idx === 0 ? "active" : ""}">
      `).join("");

      const canSellModal = !!(productId && priceCents != null && priceCents > 0 && !sold);

      modal.innerHTML = `
        <div class="modal-dialog">
          <div class="modal-header">
            <h2 class="vase-title">${name}</h2>
            <button type="button" data-modal-close>×</button>
          </div>
          <div class="modal-body">
            <div class="modal-body-inner">
              <div class="vase-detail-panel">
                <h3 class="vase-subtitle">${short}</h3>
                ${priceBlock}
                <div class="vase-actions">
                  ${canSellModal ? `
                    <button type="button" class="vase-btn-primary"
                            data-add-to-cart="${productId}"
                            data-vase-name="${name}">
                      ${primaryLabel}
                    </button>
                  ` : ""}
                  <button class="vase-btn-outline">${secondaryLabel}</button>
                </div>

                <button class="accordion-header" data-acc-target="desc-${vase.id}">
                  <span>${msgs.detail.description}</span>
                  <span>›</span>
                </button>
                <div class="accordion-panel" id="desc-${vase.id}">
                  <p>${long}</p>
                </div>

                <button class="accordion-header" data-acc-target="spec-${vase.id}">
                  <span>${msgs.detail.characteristics}</span>
                  <span>›</span>
                </button>
                <div class="accordion-panel" id="spec-${vase.id}">
                  <div class="vase-specs">
                    <dl>
                      ${vase.height && vase.height !== "-" ? `<dt>${spec.height}</dt><dd>${vase.height}</dd>` : ""}
                      ${vase.diameter && vase.diameter !== "-" ? `<dt>${spec.diameter}</dt><dd>${vase.diameter}</dd>` : ""}
                      ${(() => {
                        const v = pickFieldByLang(vase, "material", lang);
                        return v && v !== "-" ? `<dt>${spec.material}</dt><dd>${v}</dd>` : "";
                      })()}
                      ${(() => {
                        const v = pickFieldByLang(vase, "technique", lang);
                        return v && v !== "-" ? `<dt>${spec.technique}</dt><dd>${v}</dd>` : "";
                      })()}
                      ${(() => {
                        const v = pickFieldByLang(vase, "finish", lang);
                        return v && v !== "-" ? `<dt>${spec.finish}</dt><dd>${v}</dd>` : "";
                      })()}
                    </dl>
                  </div>
                </div>

                <button class="accordion-header" data-acc-target="del-${vase.id}">
                  <span>${msgs.detail.delivery}</span>
                  <span>›</span>
                </button>
                <div class="accordion-panel" id="del-${vase.id}">
                  <p>${msgs.detail.deliveryText}</p>
                </div>
              </div>

              <div class="modal-gallery">
                <div class="modal-gallery-main">
                  ${galleryImgsHtml}
                </div>
                <div class="modal-gallery-counter" data-gallery-counter="${vase.id}">
                  ${imgs.length ? `1 / ${imgs.length}` : ""}
                </div>
                <div class="modal-gallery-controls" data-gallery-controls="${vase.id}">
                  <button type="button" data-gallery-prev>←</button>
                  <button type="button" data-gallery-next>→</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;

      modalRoot.appendChild(modal);
    });

    // aggiorna testi del drawer (es: cambio lingua)
    if (window.CD?.shop?.renderDrawer) window.CD.shop.renderDrawer();
  }

  // --- Card galleries (identico alla tua logica, con protezioni) ---
  function initCardGalleries() {
    document.querySelectorAll(".media-carousel").forEach(block => {
      const id = block.getAttribute("data-card-gallery");
      const imgs = Array.from(block.querySelectorAll(".card-img"));
      const counter = block.querySelector(`[data-card-counter="${id}"]`);
      if (imgs.length <= 1) return;

      let index = 0;
      const show = (i) => {
        if (i < 0) i = imgs.length - 1;
        if (i >= imgs.length) i = 0;
        index = i;
        imgs.forEach((img, k) => img.classList.toggle("active", k === index));
        if (counter) counter.textContent = `${index + 1}/${imgs.length}`;
      };

      block.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest("a")) return;
        if (e.target.closest(".card-actions")) return;

        const rect = block.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const isLeft = x < rect.width * 0.33;

        e.preventDefault();
        e.stopPropagation();

        if (isLeft) show(index - 1);
        else show(index + 1);
      });

      let touchStartX = 0;
      let touchEndX = 0;

      block.addEventListener("touchstart", (e) => {
        touchStartX = e.changedTouches[0].clientX;
      }, { passive: true });

      block.addEventListener("touchend", (e) => {
        touchEndX = e.changedTouches[0].clientX;
        const delta = touchEndX - touchStartX;
        const threshold = 30;
        if (Math.abs(delta) < threshold) return;
        if (delta > 0) show(index - 1);
        else show(index + 1);
      }, { passive: true });
    });
  }

  // Modali con delegazione eventi (come il tuo)
  function initModals() {
    console.log("🔍 [CATALOGUE/STRIPE] Inizializzazione modali con delegazione eventi...");

    document.removeEventListener("click", handleModalClick);
    document.addEventListener("click", handleModalClick);

    console.log("✅ [CATALOGUE/STRIPE] Modali inizializzati con delegazione");
  }

  function handleModalClick(e) {
    const target = e.target;

    const modalTrigger = target.closest("[data-modal-target]");
    if (modalTrigger) {
      e.preventDefault();
      e.stopPropagation();
      const id = modalTrigger.dataset.modalTarget;
      const modal = document.getElementById(id);
      if (modal) modal.classList.add("open");
      return;
    }

    const closeBtn = target.closest("[data-modal-close]");
    if (closeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const modal = closeBtn.closest(".modal");
      if (modal) modal.classList.remove("open");
      return;
    }

    if (target.classList.contains("modal")) {
      target.classList.remove("open");
    }
  }

  function initAccordions() {
    document.querySelectorAll(".accordion-header").forEach(btn => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.accTarget;
        const panel = document.getElementById(targetId);
        if (!panel) return;
        const isOpen = panel.classList.contains("active");
        document.querySelectorAll(".accordion-panel").forEach(p => p.classList.remove("active"));
        if (!isOpen) panel.classList.add("active");
      });
    });
  }

  function initGalleries() {
    document.querySelectorAll(".modal").forEach(modal => {
      const imgs = Array.from(modal.querySelectorAll(".modal-gallery-main img"));
      if (!imgs.length) return;

      const counterEl = modal.querySelector("[data-gallery-counter]");
      const controls = modal.querySelector("[data-gallery-controls]");
      const galleryMain = modal.querySelector(".modal-gallery-main");
      if (!controls) return;

      function getCurrentIndex() {
        return imgs.findIndex(img => img.classList.contains("active"));
      }

      function updateGallery(newIndex) {
        if (newIndex < 0) newIndex = imgs.length - 1;
        if (newIndex >= imgs.length) newIndex = 0;

        imgs.forEach(img => img.classList.remove("active"));
        imgs[newIndex].classList.add("active");

        if (counterEl) counterEl.textContent = `${newIndex + 1} / ${imgs.length}`;
      }

      const prevBtn = controls.querySelector("[data-gallery-prev]");
      const nextBtn = controls.querySelector("[data-gallery-next]");

      if (prevBtn) {
        prevBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          updateGallery(getCurrentIndex() - 1);
        });
      }

      if (nextBtn) {
        nextBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          updateGallery(getCurrentIndex() + 1);
        });
      }

      if (galleryMain) {
        galleryMain.addEventListener("click", (e) => {
          e.stopPropagation();
          updateGallery(getCurrentIndex() + 1);
        });
        galleryMain.style.cursor = "pointer";
      }
    });
  }

  // Bottone Compra: delegazione (compatibile col tuo markup)
  function initStripeCartButtons() {
    if (window.__cd_stripe_btns_inited) return;
    window.__cd_stripe_btns_inited = true;

    console.log("🛒 [STRIPE] initCartButtons attach");

    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-add-to-cart]");
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      const productId = (btn.dataset.addToCart || "").trim();
      const vaseName  = (btn.dataset.vaseName || "").trim();

      console.log("🛒 [STRIPE] click Compra:", { vaseName, productId });

      if (!productId || productId === "-") return;

      if (!window.CD?.shop?.addVariant) {
        console.error("❌ [STRIPE] CD.shop.addVariant non disponibile (uiStripe.js non caricato?)");
        return;
      }

      try {
        const res = await window.CD.shop.addVariant(productId, 1);
        if (res) console.log("[STRIPE] Aggiunto al carrello:", productId);
        else console.warn("[STRIPE] Non aggiunto:", productId);
      } catch (err) {
        console.error("[STRIPE] Errore add-to-cart", err);
      }
    }, false);
  }

  function initBehaviour() {
    console.log("🔍 [CATALOGUE/STRIPE] Inizializzazione comportamenti...");
    initModals();
    initAccordions();
    initGalleries();
    initCardGalleries();
    initStripeCartButtons();
    console.log("✅ [CATALOGUE/STRIPE] Comportamenti inizializzati");
  }

  window.CD = window.CD || {};
  window.CD.catalogue = {
    loadCsv,
    render,
    initBehaviour
  };

})();
