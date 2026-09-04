/*
 * Image crop helper (background page).
 *
 * The fast photo-identify path builds several centered crops of the captured
 * frame and races them against PriceCharting's photo CV. This crops a
 * fraction-rect out of a data URL, scaled so the longest edge is maxDim.
 */
(function () {
  "use strict";

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = dataUrl;
    });
  }

  async function cropFrac(dataUrl, frac, maxDim) {
    const img = await loadImage(dataUrl);
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const sx = frac.x * iw, sy = frac.y * ih, sw = frac.w * iw, sh = frac.h * ih;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  }

  self.CardCV = { cropFrac };
})();
