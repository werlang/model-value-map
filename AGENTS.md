# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

A **static, dependency-free dashboard** that plots AI models by:

- **X axis** — USD per 1M output tokens from the OpenCode catalog (models.dev).
- **Y axis** — [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/models).

Data flows through a single sanitized Cloudflare Worker endpoint (no client
secrets, CORS `*`), and the page filters the roster to the **Go table** — every
model listed on `opencode.ai/docs/go` always shows, automatically (worker
`/curated` is the CORS-safe fallback when the browser can't read the docs
directly). AA scores are sourced in three tiers — the keyed free-tier API,
then keyless public AA pages (index flight records + JSON-LD, then per-model
pages for Go-table models still missing a score), all parsed as inert text.
The dashed line on the chart is the **Pareto frontier**: no visible model beats
a frontier member on both price and intelligence simultaneously.

## Hard constraints

These are design decisions, not accidents. Do not violate them without explicit instruction:

1. **No dependencies, no build step, no bundler, no framework.** Plain HTML/CSS/JS only.
2. **No modules.** All scripts are classic scripts exposing globals:
   - `live.js` → `window.LiveData` (worker fetch + cache layer)
   - `app.js` → IIFE that renders and wires the UI (incl. the Go-table roster filter)
3. **Never execute remote content.** The worker parses Artificial Analysis flight/API payloads as inert data; the app parses docs HTML with `DOMParser`/regex as inert text. Nothing remote is ever `eval`'d or injected as a script.
4. **Graceful degradation is mandatory.** Every live value passes validation before plotting; anything missing or offline falls back to cached entries. If the Go-table roster can't be fetched (docs CORS-blocked and worker `/curated` down), the full payload renders unfiltered. The page must always render, even fully offline.
5. **Cache honestly.** Parsed payloads are cached in `localStorage` (key prefix `mvm.`) with a 30-minute TTL. Any successful fetch also refreshes an unTTL'd `mvm.live.lastgood`; when origins are unreachable the page renders it (`state: 'stale'`).

## File map

| File               | Responsibility |
| ------------------ | -------------- |
| `index.html`       | Semantic shell; loads scripts in order: live → app |
| `openrouter/index.html` | Free-roster shell; same scripts with `MVM_WORKER_URL` → `/openrouter` and `MVM_NO_CURATED` (no Go-table filter) |
| `styles.css`       | Design tokens + components (IBM Plex Mono/Sans) |
| `live.js`          | Worker-only fetch (`GET /`, override via `window.MVM_WORKER_URL`), validation, localStorage cache/TTL/lastgood |
| `app.js`           | Go-table roster filter, scales (log x, linear y), Pareto computation, SVG render, toggles, readout |
| `worker/index.js`  | Sanitized endpoint: joins models.dev + AA (keyed API, backed up by keyless public-page scores), emits Go-table models missing an axis as off-map, `GET /curated` returns the Go-table roster, `GET /openrouter` returns the same shape for free OpenRouter models |
| `wrangler.toml`    | Worker config (`AA_API_KEY` via `wrangler secret put`) |
| `tests/`           | Headless behavioral suite (`npm test`) — sandbox + stubs, no dependencies |

When changing behavior, keep logic in the file that owns it (fetch/parse/merge → `live.js`; rendering/scales/UI → `app.js`; origin joining/secrets → `worker/index.js`).

## Conventions

- ES5-compatible vanilla JS style with `'use strict'`; small pure helpers over abstractions.
- Escape any dynamic string before injecting into HTML (`esc()` in `app.js`).
- The roster is derived, never hard-coded: parse the Go docs tables (a `Model ID` column preferred, else `Model`) plus the listed models, normalize with dots-to-dashes. Every Go-table model must appear on the page (plotted or, honestly, in the off-map tray). `AA_SLUG` (`worker/index.js`) holds curated slug overrides — add entries only when normalization can't match.
- Accessibility is a feature: keyboard-focusable dots, ARIA labels on the SVG, screen-reader table, `prefers-reduced-motion` respected. Don't regress these.
- Axis domains are computed from the plotted set so live data drift never clips points. Keep that property.
- Models missing an axis stay visible via `plot: false` + `excludeReason` ("Off the map" tray). Never silently drop them from the dataset.

## Validation

The test suite runs on Node's built-in runner (zero dependencies):

```
npm test                 # node --test "tests/*.test.js"
npm run test:coverage    # same, with V8 coverage
```

The suite loads `live.js` / `app.js` inside a `vm` sandbox with stubbed browser
globals (`fetch`, `localStorage`, DOM), so it exercises the real scripts
headlessly — including worker fetching, cache honesty/TTL/tamper defense, the
Go-table roster filter (docs scraped, worker fallback, off-table exclusion),
Pareto ties, and the render/stamp behavior of a booted page. `app.js` exposes
pure helpers via `window.MVM_TEST` for direct unit assertions; nothing else in
production code exists for testing's sake.

## Commits

Follow `.github/COMMIT-v2.md`: semantic format `<type>(<scope>): <short summary>` — lowercase, imperative, ≤72 chars first line, no emojis, no body/footer unless asked. Inspect staged changes before writing the message.
