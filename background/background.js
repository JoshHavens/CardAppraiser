/*
 * Background message router.
 *
 * Content scripts talk to this via runtime.sendMessage. All network work
 * (PriceCharting scrape, Anthropic Vision) lives here so it runs off the page,
 * free of the page's CSP/CORS. Firefox MV3 event page: DOMParser is available
 * here (unlike a Chrome service worker).
 */

(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  // ---- session cache (product URL -> full price breakdown) -----------------
  const priceCache = new Map();
  const CACHE_TTL_MS = 15 * 60 * 1000;

  // PriceCharting's photo endpoint has a sustained per-IP rate limit. On a 429
  // we stop scanning until this time to let it recover.
  let photoBackoffUntil = 0;

  /**
   * Resolve as soon as any task yields a match with distance < threshold;
   * otherwise resolve with the best once all settle. Collects per-task
   * diagnostics. Each task resolves to { label, r, crop } or { label, skipped }.
   */
  function raceGoodMatch(tasks, threshold) {
    return new Promise((resolve) => {
      const attempts = [];
      let best = null, remaining = tasks.length, done = false;
      const finish = () => { if (!done) { done = true; resolve({ best, attempts }); } };
      tasks.forEach((t) =>
        t.then((res) => {
          if (res && res.r && res.r.results && res.r.results.length) {
            const top = res.r.results[0];
            const d = res.r.bestDistance != null ? res.r.bestDistance : 1;
            attempts.push({ label: res.label, name: top.title, set: top.set, distance: res.r.bestDistance });
            if (!best || d < best.d) best = { res, d };
            if (d < threshold) return finish();
          } else {
            attempts.push({ label: res ? res.label : "?", skipped: !!(res && res.skipped), error: res && res.error });
          }
          if (--remaining === 0) finish();
        }).catch((e) => {
          attempts.push({ label: "?", error: String(e && e.message ? e.message : e) });
          if (--remaining === 0) finish();
        })
      );
      if (!tasks.length) finish();
    });
  }

  async function getSettings() {
    const defaults = {
      engine: "ocr", // "ocr" (card-name OCR, default) | "photo" (PriceCharting CV) | "vision"
      apiKey: "",
      model: "claude-haiku-4-5",
      pollInterval: 1000,
      highlightGrade: "Ungraded",
      diffThreshold: 12,
      photoLanguage: "english", // "english" (default) | "japanese" | "" = All. Most cards shown are English.
      ocrMaskTop: 0,     // default no mask; content script sets it per platform (eBay captions)
      ocrMaxW: 1000,     // downscale width for OCR (OCR runs in a worker, so this isn't the lag source)
      debug: false,
    };
    const stored = await api.storage.local.get(defaults);
    return Object.assign(defaults, stored);
  }

  // ---- text search via a hidden tab ----------------------------------------
  // PriceCharting's /search-products is behind Cloudflare's JS challenge, which
  // a background fetch can't pass. A real navigation passes it, so we drive a
  // hidden (tabs.hide) background tab: navigate it to the search, wait for the
  // results table to render, then read the rows back with scripting. Invisible
  // to the user; results still show inline in the panel.
  //
  // IMPORTANT: the background is a non-persistent event page — when it suspends
  // it loses in-memory state, so an in-memory tab id alone leaked a NEW tab on
  // every wake ("opens a million tabs" -> severe lag). We instead track our
  // created tab ids in storage (survives suspend), reuse the one still alive,
  // and close every extra — including ones leaked by older versions.
  let searchTabId = null;

  async function getTracked() {
    try { const s = await api.storage.local.get("__searchTabs"); return Array.isArray(s.__searchTabs) ? s.__searchTabs : []; }
    catch (e) { return []; }
  }
  async function setTracked(arr) {
    try { await api.storage.local.set({ __searchTabs: arr }); } catch (e) {}
  }

  async function getSearchTab() {
    // Reuse the first tracked tab that still exists; close the rest.
    let keep = null;
    const alive = [];
    for (const id of await getTracked()) {
      try {
        await api.tabs.get(id);
        if (keep == null) { keep = id; alive.push(id); }
        else { try { await api.tabs.remove(id); } catch (e) {} }
      } catch (e) { /* already closed */ }
    }
    if (keep == null) {
      const tab = await api.tabs.create({ url: "https://www.pricecharting.com/", active: false });
      try { await api.tabs.hide(tab.id); } catch (e) { /* needs tabHide perm; ok if visible */ }
      keep = tab.id;
      alive.push(tab.id);
    }
    searchTabId = keep;
    await setTracked(alive);

    // Sweep up any hidden PriceCharting tabs leaked by older builds (untracked).
    try {
      const hidden = await api.tabs.query({ hidden: true, url: "*://*.pricecharting.com/*" });
      for (const t of hidden) { if (t.id !== keep) { try { await api.tabs.remove(t.id); } catch (e) {} } }
    } catch (e) {}

    return keep;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function textSearchViaTab(query) {
    const tabId = await getSearchTab();
    const url = "https://www.pricecharting.com/search-products?q=" +
      encodeURIComponent(query) + "&type=prices";
    await api.tabs.update(tabId, { url });

    // Wait for the results table (or a redirected product page) to appear —
    // the Cloudflare "Just a moment" page auto-reloads to the real page.
    const deadline = Date.now() + 20000;
    let rows = [];
    while (Date.now() < deadline) {
      await sleep(500);
      let out;
      try {
        [out] = await api.scripting.executeScript({ target: { tabId }, func: scrapeSearch });
      } catch (e) { continue; } // challenge page can block scripting briefly
      if (out && out.result && out.result.ready) { rows = out.result.rows; break; }
    }
    return rows.map((r) => Object.assign(r, {
      number: self.PriceCharting.extractNumber(r.href) || self.PriceCharting.extractNumber(r.title),
      edition: self.PriceCharting.extractEdition(r.title),
      inline: {},
    }));
  }

  // Runs INSIDE the hidden tab (must be self-contained).
  function scrapeSearch() {
    const BASE = "https://www.pricecharting.com";
    if (/Just a moment/i.test(document.title)) return { ready: false, rows: [] };
    const trs = Array.from(document.querySelectorAll("#games_table tbody tr"));
    const rows = [];
    for (const tr of trs) {
      const link = tr.querySelector("td.title a, a[href*='/game/']");
      if (!link) continue;
      const href = link.getAttribute("href") || "";
      const titleCell = tr.querySelector("td.title");
      const setCell = tr.querySelector("td.console");
      const img = tr.querySelector("td.image img");
      rows.push({
        title: (titleCell || link).textContent.trim().replace(/\s+/g, " "),
        set: setCell ? setCell.textContent.trim().replace(/\s+/g, " ") : "",
        url: href.startsWith("http") ? href : BASE + href,
        href,
        image: img ? (img.getAttribute("src") || "").replace(/\/60\.jpg$/, "/240.jpg") : "",
      });
    }
    // Exact match redirects straight to a product page.
    if (!rows.length && document.getElementById("product_name")) {
      const canon = (document.querySelector('link[rel="canonical"]') || {}).href || location.href;
      rows.push({
        title: document.getElementById("product_name").textContent.trim().replace(/\s+/g, " "),
        set: "", url: canon, href: canon, image: "",
      });
    }
    const ready = rows.length > 0 || !!document.getElementById("product_name");
    return { ready, rows };
  }

  /** Full lookup: identity -> ranked results -> full prices for best match. */
  async function lookupByIdentity(identity) {
    const query = buildQuery(identity);
    if (!query) throw new Error("Nothing to search for.");
    const results = await textSearchViaTab(query);
    if (!results.length) return { query, results: [], best: null, prices: null };

    const ranked = self.PriceCharting.rankResults(results, identity);
    const best = ranked[0];
    const prices = await pricesForUrl(best.url, best);
    return { query, results: ranked, best, prices };
  }

  function buildQuery(identity) {
    const parts = [];
    if (identity.name) parts.push(identity.name);
    if (identity.set) parts.push(identity.set);
    if (identity.number && !/base set 2/i.test(identity.set || "")) {
      // number helps narrow, but PriceCharting search matches loosely
      parts.push(identity.number);
    }
    let q = parts.join(" ").trim() || (identity.query || "").trim();
    // Keep results in the Pokémon domain so garbled OCR can't match, e.g., a
    // Skylanders figure. Skip only if the user explicitly typed another game.
    if (q && !/pok[eé]mon/i.test(q)) q += " pokemon";
    return q;
  }

  async function pricesForUrl(url, fallbackRow) {
    const cached = priceCache.get(url);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
    try {
      const full = await self.PriceCharting.getProductPrices(url);
      priceCache.set(url, { at: Date.now(), data: full });
      return full;
    } catch (e) {
      // Fall back to the inline prices already parsed from the search row.
      if (fallbackRow && fallbackRow.inline) {
        return { title: fallbackRow.title, byLabel: fallbackRow.inline, partial: true };
      }
      throw e;
    }
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case "getSettings":
            sendResponse({ ok: true, settings: await getSettings() });
            break;

          case "searchRaw": {
            const results = await self.PriceCharting.search(msg.query);
            sendResponse({ ok: true, results });
            break;
          }

          case "lookup": {
            // msg.identity: {name, set, number, edition, query}
            const data = await lookupByIdentity(msg.identity);
            sendResponse({ ok: true, ...data });
            break;
          }

          case "pricesForUrl": {
            const prices = await pricesForUrl(msg.url, msg.row || null);
            sendResponse({ ok: true, prices });
            break;
          }

          case "fetchImage": {
            // Fallback for when the Whatnot page CSP blocks loading the
            // PriceCharting image host directly: fetch it here (host perm)
            // and hand back a data: URL the panel can display.
            const r = await fetch(msg.url);
            if (!r.ok) { sendResponse({ ok: false, error: "img HTTP " + r.status }); break; }
            const blob = await r.blob();
            const dataUrl = await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = () => rej(new Error("read failed"));
              fr.readAsDataURL(blob);
            });
            sendResponse({ ok: true, dataUrl });
            break;
          }

          case "captureTab": {
            // Fallback still capture when the video canvas is cross-origin
            // tainted. Returns a jpeg data URL of the visible viewport; the
            // content script crops it to the video's bounding rect.
            const tabId = sender.tab ? sender.tab.id : undefined;
            const dataUrl = await api.tabs.captureVisibleTab(
              sender.tab ? sender.tab.windowId : undefined,
              { format: "jpeg", quality: 85 }
            );
            sendResponse({ ok: true, dataUrl, tabId });
            break;
          }

          case "warmSession": {
            // Fire-and-forget: obtain/refresh PriceCharting cookies when the
            // Whatnot page loads, so the first scan isn't slowed by the warm-up.
            self.PriceCharting.ensureSession();
            sendResponse({ ok: true });
            break;
          }

          case "warmOcr": {
            // Spin up the Tesseract worker (loads the bundled wasm + traineddata)
            // ahead of the first scan so it isn't slow. Best-effort.
            if (self.CardOCR) self.CardOCR.getWorker().catch(() => {});
            sendResponse({ ok: true });
            break;
          }

          case "identifyHybrid": {
            // OCR-GATED Photo API. The card's own NAME is the precision gate:
            //  1. Read the name on-device (cheap, local). If the frame isn't
            //     sharp enough to read a real species, DON'T guess and DON'T
            //     call the photo API — this kills blurry-frame false positives
            //     (the Bulbasaur/Mew confident-wrong bug) AND cuts the work that
            //     was lagging the browser (no photo requests on bad frames).
            //  2. Only once a name is read, use the photo API to pin the SPECIFIC
            //     card (number + variants). Prefer candidates matching the read
            //     species; if the photo API didn't frame it, trust the name and
            //     text-search it. Either way the species is OCR-verified.
            const stillH = msg.dataUrl;
            if (Date.now() < photoBackoffUntil) {
              sendResponse({ ok: true, rateLimited: true, results: [], best: null, prices: null });
              break;
            }
            const sH = await getSettings();

            // 1) OCR gate. Single pass by default (fast); thorough (2-pass) only
            // on a manual Re-scan.
            let ocrH = null;
            try {
              ocrH = await self.CardOCR.identifyName(stillH, {
                maskTop: msg.maskTop, maxW: sH.ocrMaxW, twoPass: !!msg.thorough,
              });
            } catch (e) { /* treat as no-name */ }
            if (!ocrH || !ocrH.isCard) {
              // Not a sharp card frame (blurry/motion) — don't guess, don't hit
              // the photo API. This is the precision gate AND a big load saver.
              sendResponse({ ok: true, best: null, results: [], prices: null, ocr: ocrH, noName: true });
              break;
            }
            const species = ocrH.name ? ocrH.name.toLowerCase() : null;

            // 2) Photo API on two lower-biased crops (card is held up from the
            // bottom; the top of the frame is background clutter).
            const HCROPS = [
              { x: 0.10, y: 0.20, w: 0.80, h: 0.78 }, // lower-wide
              { x: 0.20, y: 0.24, w: 0.58, h: 0.68 }, // lower-center (tighter)
            ];
            await self.PriceCharting.ensureSession();
            let collected = [], rl = false;
            for (const frac of HCROPS) {
              try {
                const crop = await self.CardCV.cropFrac(stillH, frac, 720);
                const r = await self.PriceCharting.photoSearch(crop, "pokemon-cards", sH.photoLanguage || "english");
                if (r.results && r.results.length) collected.push(...r.results);
              } catch (e) {
                if (/HTTP 429/.test(String(e && e.message ? e.message : e))) { rl = true; break; }
              }
            }
            if (rl) {
              photoBackoffUntil = Date.now() + 60000;
              sendResponse({ ok: true, rateLimited: true, best: null, results: [], prices: null, ocr: ocrH });
              break;
            }

            // Dedupe by product (best distance), drop sealed products.
            const byId = new Map();
            for (const r of collected) {
              const k = r.product_id || r.url;
              const d = r.distance != null ? r.distance : 1;
              const ex = byId.get(k);
              if (!ex || d < (ex.distance != null ? ex.distance : 1)) byId.set(k, r);
            }
            const SEALED = /\b(booster|box|packs?|bundle|tin|collection|elite\s*trainer|etb|case|blister|premium|build\s*&?\s*battle|deck)\b/i;
            let mergedH = [...byId.values()]
              .filter((r) => !SEALED.test(r.title || ""))
              .sort((a, b) => (a.distance != null ? a.distance : 1) - (b.distance != null ? b.distance : 1));

            // 3) If the species was read, prefer photo candidates matching it.
            const spHits = species ? mergedH.filter((r) => (r.title || "").toLowerCase().includes(species)) : [];
            if (spHits.length) {
              const bestH = spHits[0];
              const pricesH = await pricesForUrl(bestH.url, bestH);
              const ordered = spHits.concat(mergedH.filter((r) => !spHits.includes(r)));
              sendResponse({ ok: true, best: bestH, results: ordered, prices: pricesH, ocr: ocrH, corroborated: true, bestDistance: bestH.distance });
              break;
            }
            // Species read but the photo API didn't frame it → trust the name.
            if (species) {
              const nsH = await lookupByIdentity({ name: ocrH.name });
              if (nsH.best) {
                sendResponse({ ok: true, best: nsH.best, results: nsH.results, prices: nsH.prices, ocr: ocrH, corroborated: true, viaName: true, bestDistance: null });
                break;
              }
            }
            // No readable name, but it IS a sharp card frame (vocab gate passed)
            // and the photo API returned real cards → trust its top match. Not
            // corroborated, so the UI labels it "likely" and offers the picker.
            if (mergedH.length) {
              const bestH = mergedH[0];
              const pricesH = await pricesForUrl(bestH.url, bestH);
              sendResponse({ ok: true, best: bestH, results: mergedH, prices: pricesH, ocr: ocrH, corroborated: false, bestDistance: bestH.distance });
              break;
            }
            sendResponse({ ok: true, best: null, results: [], prices: null, ocr: ocrH, noName: false });
            break;
          }

          case "ocrIdentify": {
            // Free local identify: OCR the card name, fuzzy-match it to the
            // Pokémon species list, then run the existing name search. No API,
            // no rate limit. See background/ocr.js for the why.
            const sOcr = await getSettings();
            const ocr = await self.CardOCR.identifyName(msg.dataUrl, {
              // content script sends a platform-aware maskTop (0 on Whatnot,
              // a small band on eBay for burned-in captions); fall back to the
              // stored setting if it didn't.
              maskTop: msg.maskTop != null ? msg.maskTop : sOcr.ocrMaskTop,
              maxW: msg.maxW != null ? msg.maxW : sOcr.ocrMaxW,
            });
            if (!ocr.name) {
              sendResponse({ ok: true, name: null, ocr, results: [], best: null, prices: null });
              break;
            }
            const data = await lookupByIdentity({ name: ocr.name });
            sendResponse({ ok: true, name: ocr.name, score: ocr.score, ocr, ...data });
            break;
          }

          case "photoIdentifyFast": {
            // Identify via PriceCharting's photo CV. Their endpoint has a
            // SUSTAINED per-IP rate limit (a burst of 8 is fine, but many scans ×
            // many crops over a stream trip 429). So keep TOTAL requests low:
            // crops ordered center-first, run 2 at a time, and STOP as soon as one
            // is a confident match (< 0.42). On 429, back off for a minute.
            const still = msg.dataUrl;
            if (Date.now() < photoBackoffUntil) {
              sendResponse({ ok: true, results: [], best: null, prices: null, attempts: [], rateLimited: true });
              break;
            }
            const CROPS = [
              { label: "c0", frac: { x: 0.24, y: 0.16, w: 0.52, h: 0.64 } }, // center (most common)
              { label: "c1", frac: { x: 0.14, y: 0.08, w: 0.72, h: 0.84 } }, // large / close card
              { label: "c2", frac: { x: 0.05, y: 0.18, w: 0.52, h: 0.64 } }, // left
              { label: "c3", frac: { x: 0.43, y: 0.18, w: 0.52, h: 0.64 } }, // right
              { label: "c4", frac: { x: 0.24, y: 0.30, w: 0.52, h: 0.60 } }, // center-lower (card on a stand)
            ];
            const fastSettings = await getSettings();
            const lang = fastSettings.photoLanguage; // "" All | "english" | "japanese"
            await self.PriceCharting.ensureSession();

            const attempts = [];
            let best = null, rateLimited = false;
            // Two crops at a time; stop at the first confident match.
            for (let i = 0; i < CROPS.length && !rateLimited; i += 2) {
              const batch = CROPS.slice(i, i + 2);
              const rs = await Promise.all(batch.map(async (cc) => {
                try {
                  const crop = await self.CardCV.cropFrac(still, cc.frac, 760);
                  const r = await self.PriceCharting.photoSearch(crop, "pokemon-cards", lang);
                  return { cc, r, crop };
                } catch (e) {
                  return { cc, error: String(e && e.message ? e.message : e) };
                }
              }));
              let good = false;
              for (const xr of rs) {
                if (xr.error) {
                  attempts.push({ label: xr.cc.label, error: xr.error });
                  if (/HTTP 429/.test(xr.error)) rateLimited = true;
                  continue;
                }
                const top = xr.r.results[0];
                attempts.push({ label: xr.cc.label, name: top ? top.title : null, distance: xr.r.bestDistance });
                if (xr.r.results.length) {
                  const d = xr.r.bestDistance != null ? xr.r.bestDistance : 1;
                  if (!best || d < best.d) best = { res: xr.r, d, crop: xr.crop, label: xr.cc.label };
                  if (d < 0.42) good = true;
                }
              }
              if (good) break;
            }
            if (rateLimited) photoBackoffUntil = Date.now() + 60000;
            if (!best) { sendResponse({ ok: true, results: [], best: null, prices: null, attempts, rateLimited }); break; }
            const topF = best.res.results[0];
            const pricesF = await pricesForUrl(topF.url, topF);
            sendResponse({
              ok: true, results: best.res.results, best: topF, prices: pricesF,
              bestDistance: best.d, chosenLabel: best.label, chosenCropImage: best.crop, attempts,
            });
            break;
          }

          case "openOptions": {
            await api.runtime.openOptionsPage();
            sendResponse({ ok: true });
            break;
          }

          case "visionIdentify": {
            const settings = await getSettings();
            if (!settings.apiKey) {
              sendResponse({ ok: false, error: "No API key configured." });
              break;
            }
            const identity = await self.Vision.identify(msg.dataUrl, {
              apiKey: settings.apiKey,
              model: settings.model,
            });
            sendResponse({ ok: true, identity });
            break;
          }

          default:
            sendResponse({ ok: false, error: "Unknown message type: " + msg.type });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true; // keep the channel open for the async response
  });
})();
