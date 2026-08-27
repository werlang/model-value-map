# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

A **static, dependency-free dashboard** that plots AI models by:

- **X axis** — USD per 1M output tokens directly from [models.dev](https://models.dev) (`https://models.dev/api.json`).
- **Y axis** — [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/models).

The dashed line on the chart is the **Pareto frontier**: no visible model beats a frontier member on both price and intelligence simultaneously.

## Hard constraints

These are design decisions, not accidents. Do not violate them without explicit instruction:

1. **No dependencies, no build step, no bundler, no framework.** Plain HTML/CSS/JS only.
2. **No modules.** All scripts are classic scripts exposing globals:
   - `data.js` → `window.DASHBOARD_DATA` (embedded snapshot)
   - `live.js` → `window.LiveData` (fetch/merge layer)
   - `app.js` → IIFE that renders and wires the UI
3. **Never execute remote content.** Artificial Analysis flight payloads are parsed as *inert text* (regex + brace matching). Both endpoints are queried directly over CORS without proxies or external execution.
4. **Graceful degradation is mandatory.** Every live value must pass validation (`live.js`) before plotting; anything missing or offline falls back to cached entries or `data.js`. The page must always render, even fully offline.
5. **Cache honestly.** Parsed payloads are cached in `localStorage` (key prefix `mvm.`) with a 30-minute TTL. Any successful fetch also refreshes an unTTL'd `mvm.live.lastgood`; when origins are unreachable the page renders it (`state: 'stale'`) instead of the raw snapshot.

## File map

| File               | Responsibility |
| ------------------ | -------------- |
| `index.html`       | Semantic shell; loads scripts in order: live → app |
| `styles.css`       | Design tokens + components (IBM Plex Mono/Sans) |
| `live.js`          | Direct parallel fetch (models.dev + AA), parsers, per-value merge, cache |
| `app.js`           | Scales (log x, linear y), Pareto computation, SVG render, toggles, readout |
| `tests/`           | Headless behavioral suite (`npm test`) — sandbox + stubs, no dependencies |

When changing behavior, keep logic in the file that owns it (fetch/parse/merge → `live.js`; rendering/scales/UI → `app.js`).

## Conventions

- ES5-compatible vanilla JS style with `'use strict'`; small pure helpers over abstractions.
- Escape any dynamic string before injecting into HTML (`esc()` in `app.js`).
- AA slug mapping lives in `AA_SLUG` (`live.js`); a deterministic dots-to-dashes normalization handles new models automatically — add curated entries only when normalization can't match.
- Accessibility is a feature: keyboard-focusable dots, ARIA labels on the SVG, screen-reader table, `prefers-reduced-motion` respected. Don't regress these.
- Axis domains are computed from the plotted set so live data drift never clips points. Keep that property.
- Models missing an axis stay visible via `plot: false` + `excludeReason` ("Off the map" tray). Never silently drop them from the dataset.

## Updating the snapshot

`data.js` is a manually retrieved join of both sources (date recorded in `meta.retrieved`). When regenerating it, keep the existing shape exactly — `live.js` merges over it field-by-field.

## Validation

The test suite runs on Node's built-in runner (zero dependencies):

```
npm test                 # node --test "tests/*.test.js"
npm run test:coverage    # same, with V8 coverage
```

The suite loads `data.js` / `live.js` / `app.js` inside a `vm` sandbox with
stubbed browser globals (`fetch`, `localStorage`, DOM), so it exercises the real
scripts headlessly — including direct origin fetching, cache honesty/TTL/tamper
defense, inert-text flight parsing, Pareto ties, and the render/stamp behavior of
a booted page. `app.js` exposes pure helpers via `window.MVM_TEST` for direct unit
assertions; nothing else in production code exists for testing's sake.

## Commits

Follow `.github/COMMIT-v2.md`: semantic format `<type>(<scope>): <short summary>` — lowercase, imperative, ≤72 chars first line, no emojis, no body/footer unless asked. Inspect staged changes before writing the message.
