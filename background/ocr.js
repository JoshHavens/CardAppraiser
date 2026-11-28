/*
 * Card-name OCR identify (free, local).
 *
 * Why this exists: PriceCharting's photo-CV cannot identify cards from glary
 * toploader stream frames (every crop returns the wrong card, distance >~0.57),
 * and the stylized card NUMBER font defeats Tesseract. The one reliable free
 * signal is the card NAME: large, standard font, high contrast. We OCR the
 * frame, fuzzy-match tokens against the Pokémon species list, and feed the best
 * species into the existing name search. Validated on real stream frames:
 * Petilil + Ralts read exactly; a Japanese card correctly yields no false match.
 *
 * Runs in the background event page (Firefox MV3 gives it a real DOM, so
 * Image + <canvas> work here). Tesseract.js is bundled under vendor/ and loaded
 * entirely from extension URLs — no network, no API key, no cost.
 */
(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  let worker = null;
  let workerPromise = null;
  let names = null;
  let namesPromise = null;

  const WHITELIST =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ";

  async function loadNames() {
    if (names) return names;
    if (namesPromise) return namesPromise;
    namesPromise = (async () => {
      const url = api.runtime.getURL("vendor/pokemon-names.json");
      names = await (await fetch(url)).json();
      return names;
    })();
    return namesPromise;
  }

  // Lazily create a single Tesseract worker and keep it warm for the session.
  async function getWorker() {
    if (worker) return worker;
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      const T = self.Tesseract;
      if (!T) throw new Error("Tesseract not loaded");
      const w = await T.createWorker("eng", 1, {
        workerPath: api.runtime.getURL("vendor/worker.min.js"),
        corePath: api.runtime.getURL("vendor/"),
        langPath: api.runtime.getURL("vendor/tessdata"),
        workerBlobURL: false, // load the worker straight from the extension URL (CSP-safe)
        gzip: true,           // eng.traineddata.gz
      });
      await w.setParameters({
        tessedit_char_whitelist: WHITELIST,
        tessedit_pageseg_mode: "11", // sparse text — find words anywhere
      });
      worker = w;
      return w;
    })();
    return workerPromise;
  }

  // Levenshtein edit distance (small strings).
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      let cur = [i];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[n];
  }

  // Fuzzy-match OCR tokens against the species list. Returns the best
  // { name, tok, dist, norm } or null. `norm` = editDistance / nameLength; a
  // lower norm is a tighter match. We keep the threshold tight so garbled art
  // text / background cards don't produce false hits.
  function matchSpecies(text, list) {
    const toks = [...new Set((text.toLowerCase().match(/[a-z]{3,}/g) || []))];
    let best = null;
    for (const t of toks) {
      for (const name of list) {
        if (Math.abs(name.length - t.length) > 2) continue;
        const d = lev(t, name);
        const norm = d / name.length;
        if (norm > 0.25) continue;
        if (
          !best ||
          norm < best.norm ||
          (norm === best.norm && name.length > best.name.length)
        ) {
          best = { name, tok: t, dist: d, norm };
        }
      }
    }
    return best;
  }

  function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // Draw the still to a canvas, downscale to maxW, and mask the top band to
  // black. The mask removes burned-in captions / platform banners (e.g. eBay
  // Live closed captions) without disturbing the card-area geometry, so the
  // card-name OCR is unchanged. Validated: masking kills caption false-matches
  // while keeping real card names.
  function prep(dataUrl, opts) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let dw = img.naturalWidth, dh = img.naturalHeight;
        const maxW = opts.maxW || 900;
        if (dw > maxW) { const s = maxW / dw; dw = Math.round(dw * s); dh = Math.round(dh * s); }
        const c = document.createElement("canvas");
        c.width = dw; c.height = dh;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, dw, dh);
        const maskTop = opts.maskTop != null ? opts.maskTop : 0.14;
        if (maskTop > 0) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, dw, Math.round(dh * maskTop));
        }
        resolve(c);
      };
      img.onerror = () => reject(new Error("OCR: image load failed"));
      img.src = dataUrl;
    });
  }

  /**
   * Identify the card's species name from a still (data URL).
   * Returns { name, score, tok, tokens }. name is null when nothing matched.
   */
  async function identifyName(dataUrl, opts) {
    opts = opts || {};
    const list = await loadNames();
    const w = await getWorker();
    const canvas = await prep(dataUrl, { maxW: opts.maxW || 900, maskTop: opts.maskTop });
    const { data } = await w.recognize(canvas);
    const m = matchSpecies(data.text || "", list);
    const tokens = [...new Set(((data.text || "").toLowerCase().match(/[a-z]{3,}/g) || []))].slice(0, 30);
    return {
      name: m ? cap(m.name) : null,
      score: m ? +(1 - m.norm).toFixed(2) : 0,
      tok: m ? m.tok : null,
      tokens,
    };
  }

  self.CardOCR = { identifyName, getWorker, loadNames, matchSpecies, _lev: lev };
})();
