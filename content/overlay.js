/*
 * Overlay UI + orchestration (Whatnot page).
 *
 * Flow: find the stream <video> -> run the free frame-diff Detector -> on a new
 * card, capture a still -> identify (manual | OCR | Vision per settings) ->
 * scrape PriceCharting -> render the price panel. Everything is user-overridable
 * (editable identity fields, manual search, re-scan, match picker).
 */
(function () {
  "use strict";

  const CA = window.CardAppraiser;
  const { send, el } = CA;

  let settings = null;
  let detector = null;
  let video = null;
  let lastResults = [];       // ranked search results for the match picker
  let lastIdentity = null;
  let autoFilled = null; // snapshot of fields last set by photo ID
  let busy = false;
  let ui = {};

  // Automatic best-effort crops (fractions of the frame). PriceCharting's CV
  // needs the card filling most of the image, so we try several centered crops
  // from tight to full and let its own match-distance score pick the winner —
  // no manual box, no CV library. Ordered tight->loose (tight usually wins).
  const CANDIDATE_CROPS = [
    { x: 0.26, y: 0.22, w: 0.52, h: 0.58 }, // medium center
    { x: 0.30, y: 0.24, w: 0.54, h: 0.58 }, // center-right bias (hand from bottom-right)
    { x: 0.32, y: 0.28, w: 0.42, h: 0.50 }, // tight center (smaller/further card)
    { x: 0.18, y: 0.14, w: 0.64, h: 0.72 }, // large
    { x: 0.35, y: 0.32, w: 0.34, h: 0.42 }, // very tight
  ];

  // ---------------------------------------------------------------- panel ----
  function buildPanel() {
    const panel = el("div", { id: "ca-panel", class: "ca-panel" });

    const header = el("div", { class: "ca-header" }, [
      el("span", { class: "ca-title", text: "Card Appraiser" }),
      el("span", { class: "ca-status", id: "ca-status", text: "starting…" }),
      el("button", { class: "ca-btn ca-min", title: "Minimize", text: "–",
        onClick: () => panel.classList.toggle("ca-collapsed") }),
      el("button", { class: "ca-btn", title: "Settings", text: "⚙",
        onClick: () => send("openOptions").catch((e) => console.error("[CardAppraiser] openOptions:", e)) }),
    ]);

    const thumb = el("img", { class: "ca-thumb", id: "ca-thumb", alt: "" });

    // Editable identity row
    const idRow = el("div", { class: "ca-idrow" }, [
      el("input", { class: "ca-in", id: "ca-name", placeholder: "Card name" }),
      el("input", { class: "ca-in ca-num", id: "ca-number", placeholder: "#" }),
    ]);
    const idRow2 = el("div", { class: "ca-idrow" }, [
      el("input", { class: "ca-in", id: "ca-set", placeholder: "Set (optional)" }),
      el("input", { class: "ca-in", id: "ca-edition", placeholder: "Edition (optional)" }),
    ]);

    const actions = el("div", { class: "ca-actions" }, [
      el("button", { class: "ca-btn ca-primary", id: "ca-search", text: "Search",
        onClick: () => lookupFromFields() }),
      el("button", { class: "ca-btn", id: "ca-rescan", text: "Re-scan frame",
        onClick: () => triggerCapture(true) }),
    ]);

    const match = el("div", { class: "ca-match", id: "ca-match" });
    const matchImg = el("img", { class: "ca-matchimg", id: "ca-matchimg", alt: "" });
    matchImg.style.display = "none";
    const prices = el("div", { class: "ca-prices", id: "ca-prices" });
    const foot = el("div", { class: "ca-foot", id: "ca-foot" });

    panel.append(header, thumb, idRow, idRow2, actions, match, matchImg, prices, foot);
    document.body.appendChild(panel);
    makeDraggable(panel, header);

    ui = {
      panel,
      status: panel.querySelector("#ca-status"),
      thumb,
      name: panel.querySelector("#ca-name"),
      number: panel.querySelector("#ca-number"),
      set: panel.querySelector("#ca-set"),
      edition: panel.querySelector("#ca-edition"),
      match,
      matchImg,
      prices,
      foot,
    };
    ui.name.addEventListener("keydown", (e) => { if (e.key === "Enter") lookupFromFields(); });
    ui.name.addEventListener("input", onNameEdited);
  }

  function setStatus(text) { if (ui.status) ui.status.textContent = text; }

  function errMsg(e) {
    if (!e) return "unknown";
    if (typeof e === "string") return e;
    return e.message || e.reason || (() => { try { return JSON.stringify(e); } catch (_) { return String(e); } })();
  }

  function makeDraggable(panel, handle) {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".ca-btn")) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, e.clientX - dx) + "px";
      panel.style.top = Math.max(0, e.clientY - dy) + "px";
      panel.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { dragging = false; });
  }

  // ------------------------------------------------------------- video -------
  function findVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    // Prefer the largest playing video.
    let best = null, bestArea = 0;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function watchForVideo() {
    const found = findVideo();
    if (found && found !== video) attachVideo(found);
    const obs = new MutationObserver(() => {
      const v = findVideo();
      if (v && v !== video) attachVideo(v);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function attachVideo(v) {
    video = v;
    detector.setVideo(v);
    setStatus("watching stream");
  }

  // --------------------------------------------------------- capture ---------
  /** Capture a still of the current card. Tries direct canvas; falls back to
   *  captureVisibleTab (cropped to the video rect) when the canvas is tainted. */
  async function captureStill(maxDim) {
    if (!video || video.readyState < 2) return null;
    const direct = CA.frameToDataUrl(video, maxDim || 640);
    if (typeof direct === "string") return direct;

    // Tainted -> captureVisibleTab + crop.
    try {
      const resp = await send("captureTab");
      return cropDataUrlToVideo(resp.dataUrl, maxDim || 640);
    } catch (e) {
      return null;
    }
  }

  // Crop a fraction-rect out of an already-captured still (untainted, from our
  // own canvas), scaled so its longest edge is maxDim. Returns a jpeg data URL.
  function cropStill(dataUrl, frac, maxDim) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const sx = frac.x * iw, sy = frac.y * ih, sw = frac.w * iw, sh = frac.h * ih;
        const scale = Math.min(1, maxDim / Math.max(sw, sh));
        const cw = Math.max(1, Math.round(sw * scale)), ch = Math.max(1, Math.round(sh * scale));
        const c = document.createElement("canvas");
        c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
        resolve(c.toDataURL("image/jpeg", 0.9));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  function cropDataUrlToVideo(dataUrl, maxDim) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const rect = video.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const sx = Math.max(0, rect.left * dpr);
        const sy = Math.max(0, rect.top * dpr);
        const sw = rect.width * dpr;
        const sh = rect.height * dpr;
        const scale = Math.min(1, maxDim / Math.max(sw, sh));
        const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
        const c = document.createElement("canvas");
        c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  // --------------------------------------------------- identify + lookup -----
  async function triggerCapture(manual) {
    if (busy) return;
    busy = true;
    try {
      // Capture the current frame once; the background derives crops from it.
      const still = await captureStill(1200);
      if (!still) { setStatus("couldn't grab frame"); return; }
      ui.thumb.src = still;

      // Claude Vision engine (opt-in): identify -> then text lookup.
      if (settings.engine === "vision") {
        if (!settings.apiKey) { setStatus("Vision needs an API key — open ⚙ settings"); return; }
        setStatus("identifying (Vision)…");
        const resp = await send("visionIdentify", { dataUrl: still });
        const identity = resp.identity;
        if (!identity.is_trading_card && !manual) { setStatus("no card in frame"); return; }
        fillFields(identity);
        await lookupFromFields();
        return;
      }

      // Default engine: PriceCharting photo search. The background crops the
      // frame several ways and races them in PARALLEL for a fast (~1-2s) result.
      setStatus("identifying…");
      const t0 = performance.now();
      const resp = await send("photoIdentifyFast", { dataUrl: still });
      const secs = ((performance.now() - t0) / 1000).toFixed(1);

      // Diagnostics: each crop's best match + distance, plus total time.
      if (resp.attempts) {
        const firstErr = (resp.attempts.find((a) => a.error) || {}).error;
        ui.foot.textContent = `${secs}s · ` + resp.attempts.map((a) =>
          `${a.label}:${a.distance != null ? a.distance.toFixed(2) : (a.error ? "err" : "-")}`
        ).join(" ") + (firstErr ? ` · ${String(firstErr).slice(0, 60)}` : "");
      }

      if (!resp.best) {
        renderMatch(null); renderPrices(null); setMatchImage(null);
        setStatus("no photo match — see scores below");
        return;
      }
      // Show the winning crop so you see what was recognized.
      if (resp.chosenCropImage) ui.thumb.src = resp.chosenCropImage;
      lastResults = resp.results || [];
      fillFields({
        name: resp.best.title, number: resp.best.number, set: resp.best.set,
        edition: resp.best.edition, source: "photo",
        confidence: resp.bestDistance != null ? Math.max(0, 1 - resp.bestDistance) : null,
      });
      renderMatch(resp.best, lastResults);
      renderPrices(resp.prices);
      setMatchImage((resp.prices && resp.prices.image) || resp.best.image);
      const weak = resp.bestDistance != null && resp.bestDistance >= 0.6;
      const votes = resp.votes ? ` (${resp.votes}✓)` : ""; // crops that agreed
      setStatus((weak ? "⚠ verify: " : "photo: ") + (resp.best.title || "?") + votes);
    } catch (e) {
      console.error("[CardAppraiser] capture/identify error:", e);
      setStatus("error: " + errMsg(e));
    } finally {
      busy = false;
    }
  }

  function downscale(dataUrl, maxDim) {
    // stills are already small; return as-is (kept as a hook for tuning cost).
    return dataUrl;
  }

  function fillFields(identity) {
    lastIdentity = identity;
    if (identity.name) ui.name.value = identity.name;
    if (identity.number) ui.number.value = identity.number;
    if (identity.set) ui.set.value = identity.set;
    if (identity.edition) ui.edition.value = identity.edition;
    // Remember what was auto-filled so a manual name change can drop the stale
    // set/number/edition (see onNameEdited).
    autoFilled = {
      name: ui.name.value, number: ui.number.value,
      set: ui.set.value, edition: ui.edition.value,
    };
    const conf = identity.confidence != null ? ` (${Math.round(identity.confidence * 100)}%)` : "";
    setStatus(`${identity.source || "id"}: ${identity.name || "?"}${conf}`);
  }

  // When you type a different card name, clear the set/number/edition that the
  // last photo scan auto-filled — so a name search isn't polluted by stale
  // context. Fields you edited yourself are left alone.
  function onNameEdited() {
    if (!autoFilled) return;
    if (ui.name.value.trim() === (autoFilled.name || "").trim()) return;
    if (ui.number.value === (autoFilled.number || "")) ui.number.value = "";
    if (ui.set.value === (autoFilled.set || "")) ui.set.value = "";
    if (ui.edition.value === (autoFilled.edition || "")) ui.edition.value = "";
    autoFilled = null;
  }

  function currentIdentity() {
    return {
      name: ui.name.value.trim(),
      number: ui.number.value.trim(),
      set: ui.set.value.trim(),
      edition: ui.edition.value.trim(),
    };
  }

  async function lookupFromFields() {
    const identity = currentIdentity();
    if (!identity.name && !identity.set) { setStatus("enter a card name to search"); return; }
    setStatus("looking up prices…");
    try {
      const resp = await send("lookup", { identity });
      lastResults = resp.results || [];
      if (!resp.best) { renderMatch(null); renderPrices(null); setMatchImage(null); setStatus("no match found"); return; }
      renderMatch(resp.best, lastResults);
      renderPrices(resp.prices);
      setMatchImage((resp.prices && resp.prices.image) || resp.best.image);
      setStatus("done");
    } catch (e) {
      setStatus("lookup error: " + e.message);
    }
  }

  // ------------------------------------------------------------ render -------
  // Show the matched PriceCharting card image. Tries the URL directly; if the
  // page CSP blocks the image host, falls back to a background-fetched data URL.
  let matchImgToken = 0;
  function setMatchImage(url) {
    const img = ui.matchImg;
    if (!url) { img.style.display = "none"; img.removeAttribute("src"); return; }
    const token = ++matchImgToken;
    img.style.display = "block";
    img.onerror = async () => {
      if (token !== matchImgToken) return;
      img.onerror = null;
      try {
        const resp = await send("fetchImage", { url });
        if (token === matchImgToken) img.src = resp.dataUrl;
      } catch (e) {
        if (token === matchImgToken) { img.style.display = "none"; }
      }
    };
    img.src = url;
  }

  function renderMatch(best, results) {
    ui.match.textContent = "";
    if (!best) return;
    const label = el("span", { class: "ca-matchlabel", text: "Matched: " });
    ui.match.appendChild(label);
    if (results && results.length > 1) {
      const sel = el("select", { class: "ca-select" });
      results.slice(0, 12).forEach((r, i) => {
        sel.appendChild(el("option", { value: String(i), text: `${r.title} — ${r.set}` }));
      });
      sel.value = "0";
      sel.addEventListener("change", async () => {
        const r = results[parseInt(sel.value, 10)];
        setStatus("fetching prices…");
        setMatchImage(r.image); // instant row thumb while the product page loads
        try {
          const resp = await send("pricesForUrl", { url: r.url, row: r });
          renderPrices(resp.prices);
          setMatchImage((resp.prices && resp.prices.image) || r.image);
          setStatus("done");
        } catch (e) { setStatus("error: " + errMsg(e)); }
      });
      ui.match.appendChild(sel);
    } else {
      ui.match.appendChild(el("a", { class: "ca-link", href: best.url, target: "_blank", text: best.title }));
    }
    ui.match.appendChild(el("a", { class: "ca-link ca-ext", href: best.url, target: "_blank", text: "↗" }));
  }

  function renderPrices(prices) {
    ui.prices.textContent = "";
    if (!prices) return;

    // Headline: Near Mint raw price (TCGPlayer market) — the number that best
    // reflects a clean card, vs the blended "Ungraded" which played/damaged
    // copies drag down.
    if (prices.nearMint != null) {
      ui.prices.appendChild(el("div", { class: "ca-nm" }, [
        el("span", { class: "ca-nm-label", text: "Near Mint" }),
        el("span", { class: "ca-nm-val", text: fmtMoney(prices.nearMint) }),
      ]));
    }

    if (prices.byLabel) {
      const grades = ["Ungraded", "Grade 7", "Grade 8", "Grade 9", "Grade 9.5", "PSA 10"];
      const table = el("table", { class: "ca-table" });
      for (const g of grades) {
        const v = prices.byLabel[g];
        if (v == null && g !== "Ungraded" && g !== "PSA 10") continue; // hide empties except anchors
        const label = g === "Ungraded" ? "Ungraded (avg)" : g;
        const row = el("tr", { class: g === settings.highlightGrade ? "ca-hl" : "" }, [
          el("td", { class: "ca-g", text: label }),
          el("td", { class: "ca-v", text: fmtMoney(v) }),
        ]);
        table.appendChild(row);
      }
      ui.prices.appendChild(table);
    }
    if (prices.partial) ui.prices.appendChild(el("div", { class: "ca-note", text: "partial (search-row prices)" }));
  }

  function fmtMoney(n) {
    if (n == null) return "—";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // -------------------------------------------------------------- init -------
  async function init() {
    const resp = await send("getSettings");
    settings = resp.settings;

    // Warm PriceCharting cookies now so the first scan isn't slowed by it.
    send("warmSession").catch(() => {});

    buildPanel();

    detector = new CA.Detector({
      pollInterval: settings.pollInterval,
      diffThreshold: settings.diffThreshold,
    });
    detector.onNewCard = () => triggerCapture(false);
    detector.onTick = ({ diff, state }) => {
      if (settings.debug) {
        ui.foot.textContent = `diff ${diff} · ${state}` + (detector.tainted ? " · tainted(canvas)" : "");
      } else if (state === "TAINTED") {
        ui.foot.textContent = "auto-detect off (cross-origin video) — use Re-scan frame";
      }
    };

    watchForVideo();
    detector.start();

    if (settings.engine === "vision" && !settings.apiKey) {
      setStatus("Vision selected but no API key — open ⚙ settings");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
