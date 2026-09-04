/*
 * Free, local new-card detection via frame differencing.
 *
 * Samples the stream video ~1 fps into a tiny grayscale thumbnail and computes
 * the mean absolute difference vs the previous sample. A simple state machine
 * turns that signal into "a new card is now being held steady" events:
 *
 *   IDLE --(diff spikes: card being moved)--> MOVING
 *   MOVING --(diff settles below threshold for settleMs)--> STEADY
 *   STEADY --(differs enough from last identified frame)--> emit newCard, cooldown
 *
 * No network, no API — this part is always free.
 */
(function () {
  "use strict";

  const THUMB = 48; // thumbnail edge in px used for diffing

  function grayThumb(video, cropRect) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const sx = cropRect ? cropRect.x : 0;
    const sy = cropRect ? cropRect.y : 0;
    const sw = cropRect ? cropRect.w : vw;
    const sh = cropRect ? cropRect.h : vh;
    const c = document.createElement("canvas");
    c.width = THUMB; c.height = THUMB;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    try {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, THUMB, THUMB);
      const data = ctx.getImageData(0, 0, THUMB, THUMB).data;
      const gray = new Uint8Array(THUMB * THUMB);
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      }
      return gray;
    } catch (e) {
      return { tainted: true };
    }
  }

  function meanAbsDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 255;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  class Detector {
    constructor(opts) {
      this.opts = Object.assign(
        { pollInterval: 1000, diffThreshold: 12, settleMs: 1200, cooldownMs: 4000, newSceneDelta: 18 },
        opts || {}
      );
      this.state = "IDLE";
      this.prev = null;            // previous sampled thumb
      this.lastIdentified = null;  // thumb at last emitted new-card
      this.steadySince = 0;
      this.lastEmit = 0;
      this.lastDiff = 0;
      this.timer = null;
      this.video = null;
      this.cropRect = null;
      this.onNewCard = null;       // callback()
      this.onTick = null;          // callback({diff, state})
      this.tainted = false;
    }

    setVideo(video) { this.video = video; }
    setCrop(rect) { this.cropRect = rect; }

    start() {
      this.stop();
      this.timer = setInterval(() => this.tick(), this.opts.pollInterval);
    }
    stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

    /** Force an emit regardless of state (manual "Re-scan now"). */
    forceEmit() {
      const cur = grayThumb(this.video, this.cropRect);
      if (cur && !cur.tainted) this.lastIdentified = cur;
      this.lastEmit = Date.now();
      if (this.onNewCard) this.onNewCard();
    }

    tick() {
      if (!this.video || this.video.readyState < 2 || this.video.paused) return;
      const cur = grayThumb(this.video, this.cropRect);
      if (!cur) return;
      if (cur.tainted) { this.tainted = true; if (this.onTick) this.onTick({ diff: 0, state: "TAINTED" }); return; }

      const diff = this.prev ? meanAbsDiff(cur, this.prev) : 0;
      this.lastDiff = diff;
      this.prev = cur;

      const now = Date.now();
      const { diffThreshold, settleMs, cooldownMs, newSceneDelta } = this.opts;

      if (diff > diffThreshold) {
        this.state = "MOVING";
        this.steadySince = 0;
      } else {
        // below threshold => steady-ish
        if (this.state === "MOVING" || this.state === "IDLE") {
          if (!this.steadySince) this.steadySince = now;
          if (now - this.steadySince >= settleMs) this.state = "STEADY";
        }
        if (this.state === "STEADY" && now - this.lastEmit >= cooldownMs) {
          const changed = !this.lastIdentified ||
            meanAbsDiff(cur, this.lastIdentified) >= newSceneDelta;
          if (changed) {
            this.lastIdentified = cur;
            this.lastEmit = now;
            this.state = "IDLE";
            this.steadySince = 0;
            if (this.onNewCard) this.onNewCard();
          }
        }
      }
      if (this.onTick) this.onTick({ diff: Math.round(diff * 10) / 10, state: this.state });
    }
  }

  window.CardAppraiser = window.CardAppraiser || {};
  window.CardAppraiser.Detector = Detector;
})();
