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
| `subsidy.html`     | Subsidy shell — three X modes, plan arithmetic, trays   |
| `subsidy.js`       | Subsidy merge, plan expansion, scatter, mode switching  |
| `data/subsidy-plans.json` | Published per-model plan prices and multiples     |
| `data/aa-subsidy-snapshot.json` | AA score/cost-per-task snapshot + models.dev fallback |
| `tests/`           | Headless behavioral suite — runs on Node's built-in test runner |

## Tests

No dependencies, no build step — Node ≥ 18 runs them natively:

```
npm test
```

141 behavioral tests boot the real page headlessly and cover the risky edges:
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
Scores are `exact` when Artificial Analysis benchmarks that precise model;
otherwise the bar carries the closest AA match, marked `≈` with an explicit
note (and the worker still tries the model's own AA page to upgrade it).

## Subsidy frontier

[`/subsidy`](subsidy.html) compares the same models against the Artificial
Analysis Intelligence Index through three X axes, switchable without a reload:

- **Subsidized** (default) — `cost_per_task / subsidy_multiple`: the effective
  USD per AA task once a published subscription plan is applied. One point per
  model × plan (a model with three plans produces three points), with plan
  name, monthly price, multiple, base cost per task and effective cost in the
  tooltip/readout.
- **Cost per task** — Artificial Analysis `intelligenceIndexCostPerTask.cost.total`.
  Missing values are absent (excluded with a reason), never treated as $0.
- **API cost** — models.dev base-tier `cost.output` (USD per 1M output tokens),
  with base input/output shown in the readout. `cost.tiers` and
  `cost.context_over_200k` are ignored so tiers are never mixed.

The roster is strictly `anthropic`, `openai`, `google`, `xai` and
`opencode-go`; Z.ai models enter only through `opencode-go`. Models without an
AA score stay visible in the **Sem score AA** tray, and models without a
published subsidy table are listed in **Sem tabela de subsídio**. Live AA
scores still come from the worker; `data/subsidy-plans.json` holds the six
published plan tables (collected 2026-11-23), and
`data/aa-subsidy-snapshot.json` holds the inert-parsed AA index snapshot plus
a `models.dev` fallback slice. The merged dataset is cached in LocalStorage
(`mvm.subsidy.v1`, 30-minute TTL, plus `mvm.subsidy.lastgood`), so an
unreachable worker degrades to the snapshot and then to the last clean merge.

## License

[MIT](LICENSE)
