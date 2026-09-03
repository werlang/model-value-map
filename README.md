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

On every load the page fetches both sources live in parallel, validates every value, and computes the value map and Pareto frontier:

| Stamp | Meaning |
| ----- | ------- |
| 🟢 `Live · updated 21:39 UTC` | Everything fetched fresh directly from models.dev and Artificial Analysis |
| 🟢 `Live · fetched 12 min ago` | Served from the fresh cache |
| 🟠 `Stale live data · fetched 5h 02m ago · sources unreachable` | Origins unreachable; renders the newest clean fetch on record |
| 🔴 `Snapshot Aug 23, 2026 · live fetch failed` | Nothing better available; full snapshot shown |

A few things worth knowing:

- **Direct API & No CORS Proxies**: Both `models.dev/api.json` and `artificialanalysis.ai/models` serve public CORS headers (`Access-Control-Allow-Origin: *`), so the client queries both endpoints directly in parallel with zero relay latency.
- **Inert Text Parsing**: Artificial Analysis Next.js flight payloads are parsed purely as *inert text* (regex marker + brace matching) and never executed.
- **Model Matching & Normalization**: Curated slug mapping (`AA_SLUG`) with automatic dots-to-dashes normalization matches models seamlessly across catalogs.
- **Every value is validated**: Finite prices and sane intelligence scores are strictly checked before plotting.
- **Caching is honest**: The 30-minute fresh cache is written to `localStorage` (`mvm.live.v1`), along with an unexpired `mvm.live.lastgood` copy to ensure instant page loads and offline resilience. Hit ⟳ to force a refresh.
- Axis ranges dynamically adapt to whatever the active models contain so no model is clipped.

## Features

- Log-scale cost × linear intelligence scatter
- **Dashed Pareto frontier** with hatched "dominated" zone — recomputed live as you toggle models
- Per-model and per-lab toggles (persisted), plus All / None / Frontier-only quick filters
- Crosshair + readout panel on hover/focus; keyboard-accessible dots; screen-reader data table
- "Off the map" tray for tracked models missing an axis — nothing quietly disappears
- Responsive layout, `prefers-reduced-motion` respected

## Files

| File               | Purpose                                                 |
| ------------------ | ------------------------------------------------------- |
| `index.html`       | Semantic shell                                          |
| `styles.css`       | Design tokens + components (IBM Plex Mono/Sans)         |
| `live.js`          | Direct parallel fetch (models.dev + AA), parsers, merge, cache |
| `app.js`           | Scales, Pareto computation, SVG rendering, toggles      |
| `tests/`           | Headless behavioral suite — runs on Node's built-in test runner |

## Tests

No dependencies, no build step — Node ≥ 18 runs them natively:

```
npm test
```

77 behavioral tests boot the real page headlessly and cover the risky edges:
parallel origin fetching, cache honesty (TTL, tampered payloads, outage fallbacks),
inert-text flight parsing under hostile input, Pareto ties, XSS escaping through the DOM,
and every status-stamp state.

Curious about extending this with an AI agent? See [AGENTS.md](AGENTS.md).

## Data notes

- Model pricing uses the standard **output** token rate (USD per 1M tokens) from `models.dev`.
- AA scores are per published model variant on the Artificial Analysis Intelligence Index.
- Missing either axis keeps a model visible in the "Off the map" tray with an explicit exclusion reason.

## Free on OpenRouter

[`/openrouter/`](openrouter/) reuses the same page with a different roster and a
different chart: the worker `GET /openrouter` returns the same
`{ t, meta, models }` shape, but lists only OpenRouter models priced at $0
prompt + $0 completion (`openrouter.ai/api/v1/models`), scored by the same AA
pipeline. With no price differences to plot, the page renders a descending
intelligence bar chart (`window.MVM_BAR_CHART`) instead of the cost scatter —
scored models chart smartest-first, unscored ones stay listed in the tray.

## License

[MIT](LICENSE)
