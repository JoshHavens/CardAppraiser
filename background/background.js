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
      engine: "photo", // "photo" | "ocr" | "vision"
      apiKey: "",
      model: "claude-haiku-4-5",
      pollInterval: 1000,
      highlightGrade: "Ungraded",
      diffThreshold: 12,
      debug: false,
    };
    const stored = await api.storage.local.get(defaults);
    return Object.assign(defaults, stored);
  }

  /** Full lookup: identity -> ranked results -> full prices for best match. */
  async function lookupByIdentity(identity) {
    const query = buildQuery(identity);
    if (!query) throw new Error("Nothing to search for.");
    const results = await self.PriceCharting.search(query);
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

          case "photoIdentifyFast": {
            // Run PriceCharting's photo CV on several crops IN PARALLEL, then
            // ENSEMBLE: every crop returns ranked candidates, and cards that
            // multiple crops independently agree on win over a single low-distance
            // outlier. Crops range from generous (avoid clipping the card) to
            // tight (small/far cards). ~1-2s. Cookies handled by ensureSession.
            const still = msg.dataUrl;
            const CENTER_CROPS = [
              { label: "c0", frac: { x: 0.24, y: 0.18, w: 0.54, h: 0.62 } }, // medium center
              { label: "c1", frac: { x: 0.30, y: 0.22, w: 0.56, h: 0.62 } }, // center-right
              { label: "c2", frac: { x: 0.16, y: 0.10, w: 0.68, h: 0.78 } }, // large
              { label: "c3", frac: { x: 0.10, y: 0.06, w: 0.80, h: 0.88 } }, // very large (no clip)
              { label: "c4", frac: { x: 0.30, y: 0.26, w: 0.44, h: 0.52 } }, // tight (small/far card)
            ];
            await self.PriceCharting.ensureSession();
            const settled = await Promise.all(CENTER_CROPS.map(async (cc) => {
              try {
                const crop = await self.CardCV.cropFrac(still, cc.frac, 760);
                const r = await self.PriceCharting.photoSearch(crop);
                return { label: cc.label, crop, results: r.results, bestDistance: r.bestDistance };
              } catch (e) {
                return { label: cc.label, error: String(e && e.message ? e.message : e) };
              }
            }));

            const attempts = settled.map((s) => ({
              label: s.label,
              distance: s.bestDistance,
              name: s.results && s.results[0] ? s.results[0].title : null,
              error: s.error,
            }));

            // Aggregate candidates across crops by product. Track each product's
            // best (lowest) distance, how often it was a crop's #1 (top1 votes),
            // and the crop image where it scored best.
            const byProduct = new Map();
            for (const s of settled) {
              if (!s.results) continue;
              s.results.forEach((res, rank) => {
                const pid = res.product_id;
                const dist = res.distance != null ? res.distance : 1;
                let cur = byProduct.get(pid);
                if (!cur) { cur = { result: res, minDist: dist, top1: 0, cropImage: rank === 0 ? s.crop : null }; byProduct.set(pid, cur); }
                if (dist < cur.minDist) { cur.minDist = dist; cur.result = res; cur.cropImage = s.crop; }
                if (rank === 0) cur.top1 += 1;
              });
            }
            if (byProduct.size === 0) { sendResponse({ ok: true, results: [], best: null, prices: null, attempts }); break; }

            // Consensus score: lower distance is better; each crop that ranked
            // this product #1 shaves 0.05 off (agreement beats a lone outlier).
            const ranked = [...byProduct.values()]
              .map((v) => ({ ...v, score: v.minDist - 0.05 * v.top1 }))
              .sort((a, b) => a.score - b.score)
              .slice(0, 8);
            const winner = ranked[0];
            const best = winner.result;
            const prices = await pricesForUrl(best.url, best);
            sendResponse({
              ok: true,
              results: ranked.map((v) => v.result),
              best, prices,
              bestDistance: winner.minDist,
              votes: winner.top1,
              chosenLabel: "ensemble",
              chosenCropImage: winner.cropImage,
              attempts,
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
