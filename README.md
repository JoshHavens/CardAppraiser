# Whatnot Card Appraiser (Firefox extension)

Shows live **PriceCharting** market prices for Pokémon cards shown on **Whatnot**
auction streams, so you can decide whether a bid is a good deal.

- **Auto-detects a new card** on the stream using a free, local video frame-diff
  (no network, no API).
- **Identifies** the card via free local OCR (default) or, optionally, **Claude
  Vision** (your own Anthropic API key; ~$0.002–0.004 per detected card).
- **Prices** are scraped from PriceCharting from inside the browser (their site
  blocks plain server requests but serves a real browser normally).

> Personal-use tool. Scraping PriceCharting is against their ToS — request volume
> is kept low (only on a detected new card, plus a 15-minute session cache).

## Install (temporary, for development)

1. In Firefox go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder.
3. Open a Whatnot stream — the **Card Appraiser** panel appears top-right.
4. Click the ⚙ (or the toolbar icon) to open **Settings**.

Temporary add-ons unload when Firefox restarts; just load it again.

## Using it

- **Automatic:** when the seller holds up a new card and it settles, the panel
  captures a still, identifies it, and shows the price table.
- **Manual:** type a card name (and optionally #, set, edition) and click
  **Search**. This always works, needs no setup, and is 100% reliable.
- **Re-scan frame:** force an identify on the current frame.
- **Matched:** if the auto-picked PriceCharting result is wrong, use the dropdown
  to choose the correct variant (1st Edition / Shadowless / Unlimited / etc.).

## Identification engines

| Engine | Cost | Setup | Accuracy |
|---|---|---|---|
| **PriceCharting Photo Search** | free | **default, no setup** | high — PriceCharting's own card CV (~96% top-3) |
| Local OCR | free | already bundled | low; struggles with glare/blur/angle |
| Claude Vision | ~$0.002–0.004/card | paste an Anthropic API key in Settings | high; also reads edition/condition + works beyond Pokémon |

The default engine posts the captured frame to PriceCharting's own image-recognition
endpoint (`/search-by-photo`) and gets back ranked card matches **with prices** —
free, no API key, no OCR. OCR and Claude Vision remain as alternative engines in
Settings.

### Free OCR (default, already set up)

The Tesseract assets (~15 MB of wasm + trained data) live in `lib/tesseract/`
and are already loaded via `manifest.json` — OCR is the default engine, no extra
steps. If you ever need to re-download them:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-tesseract.ps1
```

### Enable Claude Vision

Settings → Engine = *Claude Vision*, paste your key (`sk-ant-…`), pick a model.
The key is stored only in this browser's local extension storage. Use a
dedicated, low-limit key.

## Project layout

```
manifest.json
background/
  pricecharting.js   PriceCharting search + product-page scrape (verified IDs)
  vision.js          Anthropic Vision call (opt-in)
  background.js      message router + session price cache + captureVisibleTab
content/
  util.js            messaging + frame-capture helpers
  detector.js        free frame-diff new-card detector (state machine)
  ocr.js             Tesseract wrapper (degrades gracefully if not installed)
  overlay.js         panel UI + orchestration
  overlay.css
options/             settings page
scripts/fetch-tesseract.ps1
```

## Known limitations

- Detection is heuristic: expect occasional false triggers (seller talking) and
  misses. Editable fields + **Re-scan** + manual search are the safety nets.
- Some streams use a cross-origin video the canvas can't read; the extension
  falls back to `captureVisibleTab` for stills, and the debug footer shows
  `tainted(canvas)` when that happens.
- PriceCharting HTML can change; the scraper selectors are in
  `background/pricecharting.js`.
