# Model Value Map

**Which AI models give you the most intelligence per dollar?** This dashboard plots the models developers actually ran on [OpenCode](https://opencode.ai) by what they cost against how smart they score — and draws a line showing where the good deals end.

## What you're looking at

- **Left is cheaper, right is pricier** — cost per 1M tokens (log scale), from OpenCode's public usage data.
- **Higher is smarter** — the Artificial Analysis Intelligence Index, an independent benchmark.
- **The dashed cobalt line is the frontier** — nothing above or to its left of another frontier model beats it on *both* price and intelligence. Buy inside the line, pay extra outside it.
- **Dot size** shows how many tokens people actually processed with that model this month.

Everything renders in one static page. No build step, no bundler, no API keys.

## Run it

```
python3 -m http.server 8000
# open http://localhost:8000
```

That's it. Opening `index.html` directly also works in most browsers.

## How the data stays fresh

On every load the page fetches both sources live, validates every value, and merges them over an embedded snapshot, so it always works — even offline:

| Stamp | Meaning |
| ----- | ------- |
| 🟢 `Live · OpenCode updated 21:39 UTC` | Everything fetched fresh |
| 🟢 `Live · fetched 12 min ago` | Served from the fresh cache |
| 🟠 `Live + snapshot · N values from snapshot` | Partial coverage — missing values fell back |
| 🟠 `Stale live data · fetched 5h 02m ago · sources unreachable` | Every transport failed; renders the newest clean fetch on record |
| 🔴 `Snapshot Aug 23, 2026 · live fetch failed` | Nothing better available; full snapshot shown |

A few things worth knowing:

- **Artificial Analysis** allows cross-origin requests, so it's fetched directly. Its payloads are parsed as inert text — never executed.
- **OpenCode** sends no CORS header, so requests go through public relays, rotating the starting relay per request to spread rate-limit pressure; a direct request is the absolute last resort. Per-model page URLs come from the canonical links embedded in the /data HTML. Parsing happens in a throwaway Web Worker; the remote script never touches the page.
- **AA matching is tiered**: curated slug (`AA_SLUG`) → deterministic dots-to-dashes normalization against the live index → per-model AA page. Renamed slugs and brand-new models keep working without manual edits whenever their OpenCode id matches an AA slug by normalization alone.
- **Every value is validated** (finite prices, sane scores) before it may override the snapshot; anything missing or malformed degrades per-value, never per-page.
- **Caching is honest**: the 30-minute fresh cache is written only after a fetch with zero transport failures (a 404 counts as a real answer, not a failure), and every successful OpenCode fetch also refreshes an unexpired last-known-good copy that keeps the map alive during total outages. Hit ⟳ to force a refresh.
- Axis ranges adapt to whatever the data contains, so new models can never clip off the edge.

## Features

- Log-scale cost × linear intelligence scatter, dot area ∝ tokens processed on OpenCode
- **Dashed Pareto frontier** with hatched "dominated" zone — recomputed live as you toggle models
- Per-model and per-lab toggles (persisted), plus All / None / Frontier-only quick filters
- Crosshair + readout panel on hover/focus; keyboard-accessible dots; screen-reader data table
- "Off the map" tray for tracked models missing an axis — nothing quietly disappears
- Responsive layout, `prefers-reduced-motion` respected

## Files

| File         | Purpose                                                 |
| ------------ | ------------------------------------------------------- |
| `index.html` | Semantic shell                                          |
| `styles.css` | Design tokens + components (IBM Plex Mono/Sans)         |
| `data.js`    | Embedded snapshot — the fallback layer (retrieved 2026-08-23) |
| `live.js`    | Live fetch, relay chain, parsers, merge, cache          |
| `app.js`     | Scales, Pareto computation, SVG rendering, toggles      |

Curious about extending this with an AI agent? See [AGENTS.md](AGENTS.md).

## Data notes

- OpenCode's Token Cost board publishes the **output** rate as its headline number (`total == output` on every row), so page-level prices use the same definition.
- Frontier members as of the snapshot: DeepSeek V4 Flash → GPT-5.6 Luna → DeepSeek V4 Pro → GLM-5.3 → Kimi K3.
- Not plottable: ox-alpha, Muse Spark 1.2 (contrib), Nemotron 3 Ultra (no published token cost); DS V4 Flash Vision Exp, Laguna-S 2.1 (no AA score yet). Nemotron 3.5 Lightning joined the chart once AA scored it (fixed 2026-08-24); the snapshot predates that score, so it only plots with live data.
- AA scores are per published variant (effort levels noted in the readout).
- Public relays are rate-limited and occasionally fail; the fetch chain retries across them and degrades to the snapshot per value, so the page always renders.

## License

[MIT](LICENSE)
