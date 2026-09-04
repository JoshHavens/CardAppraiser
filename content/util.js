/* Shared helpers for content scripts (isolated-world globals). */
(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      api.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
        const err = api.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!resp) return reject(new Error("No response from background."));
        if (!resp.ok) return reject(new Error(resp.error || "Background error."));
        resolve(resp);
      });
    });
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k.startsWith("on") && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  /** Draw a video frame (optionally a crop rect) to a jpeg data URL. */
  function frameToDataUrl(video, maxDim, cropRect) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const sx = cropRect ? cropRect.x : 0;
    const sy = cropRect ? cropRect.y : 0;
    const sw = cropRect ? cropRect.w : vw;
    const sh = cropRect ? cropRect.h : vh;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
    const canvas = document.createElement("canvas");
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext("2d");
    try {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
      return canvas.toDataURL("image/jpeg", 0.82);
    } catch (e) {
      // Tainted canvas (cross-origin video) — caller should use captureVisibleTab.
      return { tainted: true, error: String(e) };
    }
  }

  window.CardAppraiser = window.CardAppraiser || {};
  Object.assign(window.CardAppraiser, { send, el, frameToDataUrl, api });
})();
