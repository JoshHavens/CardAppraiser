/*
 * PriceCharting scraping.
 *
 * PriceCharting returns 403 to plain server-side requests but serves normally
 * to a real browser context. A Firefox extension background page fetches with
 * the browser's own identity, so these requests succeed where curl/WebFetch
 * fail. Keep request volume low (only on a new card + caching) — scraping is
 * against PriceCharting's ToS and this is a personal-use tool.
 *
 * Verified live (2026-08): product pages expose these element IDs, which are
 * legacy video-game field names reused for card grade columns:
 *   #used_price     -> Ungraded
 *   #complete_price -> Grade 7
 *   #new_price      -> Grade 8
 *   #graded_price   -> Grade 9
 *   #box_only_price -> Grade 9.5
 *   #manual_only_price -> PSA 10
 * Graded cells carry a trailing delta ("$3,100.00 +$190.62") — take the first
 * dollar amount only.
 *
 * Search: /search-products?q=<query>&type=prices -> rows in #games_table tbody tr.
 * Each row: an a[href] product link, then cells [img, title, set, Ungraded$,
 * gradedA$, gradedB$, ...]. Prices are already in the row, so a quick lookup
 * can skip the product-page fetch.
 */

(function () {
  "use strict";

  const BASE = "https://www.pricecharting.com";
  const UA_HINT = { credentials: "include", headers: { "Accept": "text/html" } };

  // Map of product-page price element id -> human grade label, in display order.
  const GRADE_FIELDS = [
    { id: "used_price", label: "Ungraded" },
    { id: "complete_price", label: "Grade 7" },
    { id: "new_price", label: "Grade 8" },
    { id: "graded_price", label: "Grade 9" },
    { id: "box_only_price", label: "Grade 9.5" },
    { id: "manual_only_price", label: "PSA 10" },
  ];

  /** Parse the first "$1,234.56" money value out of a string; null if none. */
  function parseMoney(text) {
    if (!text) return null;
    const m = String(text).match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function fmtMoney(n) {
    if (n == null) return "—";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Pull a card number out of a title/href, e.g. "#4", "4/102", "-charizard-4". */
  function extractNumber(text) {
    if (!text) return null;
    let m = String(text).match(/#\s*(\d+)\b/);
    if (m) return m[1];
    m = String(text).match(/\b(\d+)\s*\/\s*\d+\b/);
    if (m) return m[1];
    m = String(text).match(/-(\d+)(?:$|\?|#)/); // trailing number in a slug
    if (m) return m[1];
    return null;
  }

  const EDITIONS = ["1st edition", "shadowless", "unlimited", "reverse holo", "holo"];
  function extractEdition(text) {
    const t = (text || "").toLowerCase();
    for (const e of EDITIONS) if (t.includes(e)) return e;
    return null;
  }

  async function fetchHtml(url) {
    const res = await fetch(url, UA_HINT);
    if (!res.ok) throw new Error("PriceCharting HTTP " + res.status);
    return res.text();
  }

  function parse(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  // Price cell CSS-class tokens shared between the search table and product page.
  const PRICE_TOKENS = ["used_price", "cib_price", "new_price", "graded_price", "box_only_price", "manual_only_price"];

  /**
   * Read the search results table header to learn what grade each price column
   * means (PriceCharting lets users configure which grades show, so labels are
   * NOT positional and must be read live). Returns { token -> label }.
   * `used_price` is always "Ungraded" regardless of header wording.
   */
  function headerLabels(doc) {
    const map = { used_price: "Ungraded" };
    doc.querySelectorAll("#games_table thead th").forEach((th) => {
      const label = th.textContent.trim().replace(/\s+/g, " ");
      if (!label) return;
      for (const tok of ["cib_price", "new_price", "graded_price", "box_only_price", "manual_only_price"]) {
        if (th.classList.contains(tok)) map[tok] = label;
      }
      if (th.classList.contains("js-loose") || /ungraded/i.test(label)) map.used_price = "Ungraded";
    });
    return map;
  }

  /** Extract the card image URL from a product-page document (larger, 240px). */
  function productImage(doc) {
    const el =
      doc.querySelector(".cover img") ||
      doc.querySelector("#product_details img") ||
      Array.from(doc.querySelectorAll("img")).find((i) => /images\.pricecharting\.com/.test(i.getAttribute("src") || ""));
    return el ? el.getAttribute("src") || "" : "";
  }

  /** Row image (upgrade the 60px search thumb to the 240px version). */
  function rowImage(tr) {
    const img = tr.querySelector("td.image img");
    const src = img ? img.getAttribute("src") || img.getAttribute("data-src") || "" : "";
    return src.replace(/\/60\.jpg$/, "/240.jpg");
  }

  /** Parse a row's price cells into { gradeLabel -> number } using class tokens. */
  function rowPrices(tr, headerMap) {
    const inline = {};
    tr.querySelectorAll("td.price").forEach((td) => {
      for (const tok of PRICE_TOKENS) {
        if (td.classList.contains(tok)) {
          const v = parseMoney(td.textContent);
          const label = tok === "used_price" ? "Ungraded" : headerMap[tok] || tok;
          if (v != null) inline[label] = v;
          break;
        }
      }
    });
    return inline;
  }

  /**
   * Search PriceCharting. Returns an array of result objects:
   *   { title, set, url, number, edition, inline: {gradeLabel: price, ...} }
   * `inline` holds whatever grade columns the results table exposed, labeled by
   * the live table header (used only as a fallback if the product page fails).
   */
  async function search(query) {
    const url = `${BASE}/search-products?q=${encodeURIComponent(query)}&type=prices`;
    const html = await fetchHtml(url);
    const doc = parse(html);

    // A single exact match redirects to the product page instead of a table.
    const productName = doc.querySelector("#product_name");
    if (productName && !doc.querySelector("#games_table tbody tr")) {
      const prices = extractProductPrices(doc);
      return [{
        title: productName.textContent.trim().replace(/\s+/g, " "),
        set: (doc.querySelector("#product_details .attribute a") || {}).textContent || "",
        url: (doc.querySelector('link[rel="canonical"]') || {}).href || url,
        number: extractNumber(productName.textContent),
        edition: extractEdition(productName.textContent),
        inline: prices.byLabel,
        image: prices.image,
        full: prices,
      }];
    }

    const headerMap = headerLabels(doc);
    const rows = Array.from(doc.querySelectorAll("#games_table tbody tr"));
    const results = [];
    for (const tr of rows) {
      const link = tr.querySelector("td.title a, a[href*='/game/']");
      if (!link) continue;
      const href = link.getAttribute("href") || "";
      const abs = href.startsWith("http") ? href : BASE + href;
      const titleCell = tr.querySelector("td.title");
      const setCell = tr.querySelector("td.console");
      const title = (titleCell || link).textContent.trim().replace(/\s+/g, " ");
      const set = setCell ? setCell.textContent.trim().replace(/\s+/g, " ") : "";
      results.push({
        title,
        set,
        url: abs,
        number: extractNumber(href) || extractNumber(title),
        edition: extractEdition(title),
        inline: rowPrices(tr, headerMap),
        image: rowImage(tr),
      });
    }
    return results;
  }

  /**
   * The TCGPlayer "Loose Price" is the market price for a Near Mint raw card.
   * PriceCharting's headline "Ungraded" price blends all raw sales (incl.
   * played/damaged) and runs lower, so this is the better near-mint number.
   * It's in the server-rendered condition-comparison table.
   */
  function nearMintPrice(doc) {
    const el = doc.querySelector('tr[data-source-name="TCGPlayer"] td.price .js-price');
    return el ? parseMoney(el.textContent) : null;
  }

  /** Extract the full grade table from a product-page document. */
  function extractProductPrices(doc) {
    const byLabel = {};
    for (const f of GRADE_FIELDS) {
      const el = doc.getElementById(f.id);
      byLabel[f.label] = el ? parseMoney(el.textContent) : null;
    }
    const titleEl = doc.getElementById("product_name") || doc.querySelector("h1");
    return {
      title: titleEl ? titleEl.textContent.trim().replace(/\s+/g, " ") : null,
      byLabel,
      nearMint: nearMintPrice(doc),
      image: productImage(doc),
    };
  }

  /**
   * PriceCharting's own "Search by Photo" CV (beta; ~96% correct in top 3).
   * POST multipart {img, category, language} to /search-by-photo and map the
   * ranked matches to our result shape. Free, no API key — it's the same site
   * we price from. `distance` is lower = better (>= 0.7 flagged as poor).
   */
  // The /search-by-photo endpoint returns 500 "unauthorized request" without
  // PriceCharting's session cookies (vgpc_visitor / vgpc_daily). The daily one
  // expires, so we fetch a page to (re)obtain them, then send credentialed.
  let sessionReady = false;
  let sessionPromise = null;
  function ensureSession() {
    if (sessionReady) return Promise.resolve();
    if (!sessionPromise) {
      // Dedupe concurrent callers so a parallel batch triggers just one GET.
      sessionPromise = fetch(BASE + "/", { credentials: "include", cache: "no-store" })
        .then(() => { sessionReady = true; })
        .catch(() => {})
        .finally(() => { sessionPromise = null; });
    }
    return sessionPromise;
  }

  async function photoSearch(dataUrl, category, language) {
    const blob = await (await fetch(dataUrl)).blob();
    const buildBody = () => {
      const fd = new FormData();
      fd.append("img", blob, "card.jpg");
      fd.append("category", category || "pokemon-cards");
      fd.append("language", language || "english");
      return fd;
    };
    const post = () => fetch(BASE + "/search-by-photo", { method: "POST", body: buildBody(), credentials: "include" });

    if (!sessionReady) await ensureSession();
    let res = await post();
    if (res.status === 500) {
      // Likely missing/expired session cookies — refresh and retry once.
      sessionReady = false;
      await ensureSession();
      res = await post();
    }
    if (!res.ok) throw new Error("Photo search HTTP " + res.status);
    const json = await res.json();
    if (json.error) throw new Error(String(json.error));
    const records = json.answer_records || [];
    const dists = json.answer_distances || [];
    const results = records.map((r, i) => {
      const pid = String(r.product_id || "").replace(/^G/, "");
      const img = (r._url || r.image_url || "").replace(/\/\d+\.jpg(\?.*)?$/, "/240.jpg");
      return {
        title: r.name || "",
        set: r.set || "",
        url: BASE + "/game/" + pid,
        number: extractNumber(r.name),
        edition: extractEdition(r.name),
        image: img,
        product_id: r.product_id,
        distance: dists[i] != null ? dists[i] : null,
        inline: {},
      };
    });
    return { results, count: json.answer_count || results.length, bestDistance: dists[0] != null ? dists[0] : null };
  }

  /** Fetch a product page and return its full grade breakdown. */
  async function getProductPrices(productUrl) {
    const html = await fetchHtml(productUrl);
    const doc = parse(html);
    return extractProductPrices(doc);
  }

  /**
   * Rank search results against an identity {name, number, set, edition}.
   * Higher score = better match. Returns results sorted best-first with a
   * `.score` field attached.
   */
  function rankResults(results, identity) {
    const wantNum = identity.number ? String(identity.number).replace(/^0+/, "") : null;
    const wantSet = (identity.set || "").toLowerCase();
    const wantEd = (identity.edition || "").toLowerCase();
    const wantName = (identity.name || "").toLowerCase();

    for (const r of results) {
      let score = 0;
      // Domain guard: this is a Pokémon tool — push non-Pokémon results (e.g.
      // Skylanders figures that matched a garbled OCR word) to the bottom.
      if (!/pok[eé]mon/i.test((r.set || "") + " " + (r.title || ""))) score -= 1000;
      const rNum = r.number ? String(r.number).replace(/^0+/, "") : null;
      if (wantNum && rNum && wantNum === rNum) score += 40;
      else if (wantNum && rNum && wantNum !== rNum) score -= 15;

      const rSet = (r.set || "").toLowerCase();
      if (wantSet && rSet) {
        if (rSet.includes(wantSet) || wantSet.includes(rSet)) score += 25;
      }
      const rTitle = (r.title || "").toLowerCase();
      if (wantName) {
        const nameTokens = wantName.split(/\s+/).filter((t) => t.length > 2);
        const hits = nameTokens.filter((t) => rTitle.includes(t)).length;
        score += hits * 8;
      }
      // Edition: reward a match, and penalize a mismatch (1st Ed vs Unlimited
      // are very different prices).
      const rEd = extractEdition(r.title) || "unlimited";
      if (wantEd) {
        if (rEd === wantEd) score += 20;
        else score -= 10;
      } else {
        // No stated edition -> prefer the plain/unlimited variant.
        if (rEd === "unlimited") score += 6;
      }
      r.score = score;
    }
    return results.slice().sort((a, b) => b.score - a.score);
  }

  self.PriceCharting = {
    search,
    photoSearch,
    ensureSession,
    getProductPrices,
    rankResults,
    parseMoney,
    fmtMoney,
    extractNumber,
    extractEdition,
    GRADE_FIELDS,
    BASE,
  };
})();
