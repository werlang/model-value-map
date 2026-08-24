# Model Value Map

A static, dependency-free dashboard that crosses two public data sources:

- **X axis** — cost per 1M tokens, from [opencode.ai/data](https://opencode.ai/data)
  ("Token Cost" board; models the board omits use the output rate published on
  their own OpenCode model pages).
- **Y axis** — [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/models),
  from the models page and per-model pages (RSC flight payloads).

## Live data

On every load the page fetches both sources fresh, then merges them over the
embedded snapshot in `data.js`:

1. **Artificial Analysis** — fetched directly (the site sends
   `Access-Control-Allow-Origin: *`). The Next.js flight payload is parsed as
   inert text (regex + brace matching); nothing from it is ever executed.
2. **OpenCode** — sends no CORS header, so requests go through public relays
   (allorigins → codetabs → corsproxy), each response validated before parsing.
   Its SolidJS hydration graph needs real evaluation, which runs inside a
   throwaway **Blob Worker** with stubbed globals — the remote script never
   touches the page or the DOM.
3. **Merge** — live values win; any field the live fetch missed falls back to
   the snapshot, and the header stamp reports exactly what happened:
   - 🟢 `Live · OpenCode updated 21:39 UTC` — everything fetched
   - 🟠 `Live + snapshot · N values from snapshot` — partial coverage
   - 🔴 `Snapshot Aug 23, 2026 · live fetch failed` — offline / relays down
4. **Cache** — parsed payloads are kept in `localStorage` for 30 minutes, so
   repeat loads are instant. The ⟳ button forces a fresh fetch.

Axis domains adapt to whatever the live data contains, so new models can't clip.

## Features

- Log-scale cost × linear intelligence scatter, dot area ∝ tokens processed on OpenCode
- **Dashed Pareto frontier** with hatched "dominated" zone — recomputed live as you toggle models
- Per-model and per-lab toggles (persisted in `localStorage`), plus All / None / Frontier-only quick filters
- Crosshair + readout panel on hover/focus; keyboard accessible dots; screen-reader data table
- "Off the map" tray for models missing an axis (no published price, or not yet scored by AA)
- Responsive (labels yield to tap-and-readout on narrow screens), `prefers-reduced-motion` respected

## Run

No build step, no bundler, no API keys:

```
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly also works in most browsers (all scripts are plain
globals); the one-line server is the dependable path.

## Files

| File        | Purpose                                            |
| ----------- | -------------------------------------------------- |
| `index.html`| Semantic shell                                     |
| `styles.css`| Design tokens + components (IBM Plex Mono/Sans)    |
| `data.js`   | Embedded snapshot (fallback layer), retrieved 2026-08-23 |
| `live.js`   | Fetch + relay chain + parsers + merge + cache      |
| `app.js`    | Scales, Pareto computation, SVG render, toggles    |

## Data notes

- OpenCode's Token Cost board publishes the **output** rate as its headline number
  (`total == output` on every row), so page-level prices use the same definition.
- Frontier members as of the snapshot: DeepSeek V4 Flash → GPT-5.6 Luna →
  DeepSeek V4 Pro → GLM-5.3 → Kimi K3.
- Not plottable: ox-alpha, Muse Spark 1.2 (contrib), Nemotron 3 Ultra (no published
  token cost); DS V4 Flash Vision Exp, Laguna-S 2.1 (no AA score yet). Nemotron 3.5
  Lightning was in that group until AA scored it under the unprefixed slug
  `nemotron-3-5-lightning` (fixed 2026-08-24); the snapshot predates the score, so it
  only plots when live data is available.
- AA scores are per published variant (effort levels noted in the readout).
- Public relays are rate-limited and occasionally fail; the chain retries across
  them and degrades to the snapshot per value, so the page always renders.
