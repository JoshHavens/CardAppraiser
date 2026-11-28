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

  // Words that appear on (English) Pokémon cards. Used as a "this is a sharp
  // card frame" signal: a blurry frame reads ~none of these, so even when the
  // name itself can't be read we can tell a real card from motion-blur garbage.
  const CARD_VOCAB = [
    "pokemon", "pokmon", "basic", "stage", "weakness", "resistance", "retreat",
    "ability", "attack", "evolves", "trainer", "energy", "illus", "nintendo",
    "creatures", "damage", "prize", "bench", "active", "discard", "opponent",
    "flip", "coin", "asleep", "draw", "rule", "holo",
  ];

  function vocabHits(text) {
    const toks = new Set(text.toLowerCase().match(/[a-z]{3,}/g) || []);
    let h = 0;
    for (const v of CARD_VOCAB) {
      for (const t of toks) {
        if (t === v || (t.length >= 5 && v.length >= 5 && (t.includes(v) || v.includes(t)))) { h++; break; }
      }
    }
    return h;
  }

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
  // { name, tok, norm } or null. `norm` = editDistance / nameLength (lower is
  // tighter). Thresholds scale with name length — longer names tolerate more
  // absolute OCR slips — and we also try aligning on the name's suffix, since
  // glare mangles leading letters ("Wobbuffet" -> "vwobbuffet"/"yvyobbuffet").
  // Still tight enough that garbled art text / background cards rarely hit.
  function matchSpecies(text, list) {
    const raw = text.toLowerCase().match(/[a-z]{3,}/g) || [];
    const tokSet = new Set();
    for (const t of raw) {
      tokSet.add(t);
      // Strip a trailing TCG suffix so "mewex"/"pikachugx"/"mewvmax" also match
      // the base species (ex/gx/v cards are common among valuable cards).
      const m = t.match(/^(.*?)(ex|gx|vmax|vstar|v)$/);
      if (m && m[1].length >= 3) tokSet.add(m[1]);
    }
    const toks = [...tokSet];
    let best = null;
    for (const t of toks) {
      for (const name of list) {
        if (Math.abs(name.length - t.length) > 3) continue;
        // Short names (Mew, Muk, Abra…) must match EXACTLY — they're far too
        // easy to hit from garbled/blurry OCR, which caused confident wrong IDs.
        const cap = name.length >= 8 ? 0.30
          : name.length >= 6 ? 0.25
          : name.length >= 5 ? 0.20
          : 0; // <=4 chars: exact only
        let norm = lev(t, name) / name.length;
        if (t.length > name.length && name.length >= 6) {
          // leading junk on a long-enough name: compare the token's tail
          // ("rwebbuffet" -> "wobbuffet"). Not for short names (false-match risk).
          norm = Math.min(norm, lev(t.slice(t.length - name.length), name) / name.length);
        }
        if (norm > cap) continue;
        if (
          !best ||
          norm < best.norm ||
          (norm === best.norm && name.length > best.name.length)
        ) {
          best = { name, tok: t, norm };
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
        const maskTop = opts.maskTop != null ? opts.maskTop : 0;
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

  async function recognizeText(w, canvas, psm) {
    await w.setParameters({ tessedit_pageseg_mode: String(psm) });
    const { data } = await w.recognize(canvas);
    return data.text || "";
  }

  /**
   * Identify the card's species name from a still (data URL).
   * Returns { name, score, tok, tokens }. name is null when nothing matched.
   *
   * Two passes: PSM 11 (sparse) first — fast and best for clean names; if it
   * finds nothing, PSM 6 (uniform block) often rescues stylized names over
   * busy full-art (e.g. "Wobbuffet" -> "rwebbuffet"). Combine both texts.
   */
  async function identifyName(dataUrl, opts) {
    opts = opts || {};
    const list = await loadNames();
    const w = await getWorker();
    const canvas = await prep(dataUrl, { maxW: opts.maxW || 1000, maskTop: opts.maskTop });

    let text = await recognizeText(w, canvas, 11);
    let m = matchSpecies(text, list);
    // A second PSM-6 pass rescues some stylized full-art names but doubles the
    // CPU cost, so only do it when asked (manual Re-scan) — the auto loop stays
    // single-pass to keep the browser responsive.
    if (!m && opts.twoPass) {
      text += " " + (await recognizeText(w, canvas, 6));
      m = matchSpecies(text, list);
    }
    const tokens = [...new Set((text.toLowerCase().match(/[a-z]{3,}/g) || []))].slice(0, 30);
    const vocab = vocabHits(text);
    return {
      name: m ? cap(m.name) : null,
      score: m ? +(1 - m.norm).toFixed(2) : 0,
      tok: m ? m.tok : null,
      vocab,
      // A real, sharp card frame: either we read the species, or we saw enough
      // card vocabulary. Blurry/motion frames fail both -> don't guess on them.
      isCard: !!m || vocab >= 2,
      tokens,
    };
  }

  self.CardOCR = { identifyName, getWorker, loadNames, matchSpecies, _lev: lev };
})();
