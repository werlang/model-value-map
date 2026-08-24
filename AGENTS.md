# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

A **static, dependency-free dashboard** that plots AI models by:

- **X axis** — USD per 1M output tokens from [opencode.ai/data](https://opencode.ai/data) ("Token Cost" board; models the board omits use their published OpenCode page rate).
- **Y axis** — [Artificial Analysis Intelligence Index v4.1.1](https://artificialanalysis.ai/models).

The dashed line on the chart is the **Pareto frontier**: no visible model beats a frontier member on both price and intelligence simultaneously.

## Hard constraints

These are design decisions, not accidents. Do not violate them without explicit instruction:

1. **No dependencies, no build step, no bundler, no framework.** Plain HTML/CSS/JS only.
2. **No modules.** All scripts are classic scripts exposing globals:
   - `data.js` → `window.DASHBOARD_DATA` (embedded snapshot)
   - `live.js` → `window.LiveData` (fetch/merge layer)
   - `app.js` → IIFE that renders and wires the UI
3. **Never execute remote content.** Artificial Analysis flight payloads are parsed as *inert text* (regex + brace matching). OpenCode hydration blobs are evaluated inside a throwaway **Blob Worker with stubbed globals**, never on the page or against the DOM. Any change to parsing must preserve this.
4. **Graceful degradation is mandatory.** Every live value must pass validation (`live.js`) before overriding the snapshot; anything missing falls back to `data.js` per value. The page must always render, even fully offline.
5. **Cache honestly.** Parsed payloads are cached in `localStorage` (key prefix `mvm.`) only after a fetch with zero transport failures; TTL is 30 minutes. HTTP 404/410 is an authoritative miss, not a transport failure. Any successful OpenCode backbone fetch also refreshes an unTTL'd `mvm.live.lastgood`; when every transport fails the page renders it (`state: 'stale'`) instead of the raw snapshot.

## File map

| File         | Responsibility |
| ------------ | -------------- |
| `index.html` | Semantic shell; loads scripts in order: data → live → app |
| `styles.css` | Design tokens + components (IBM Plex Mono/Sans) |
| `data.js`    | Snapshot joined from both sources; single source of fallback truth |
| `live.js`    | Relay chain (direct → allorigins → codetabs → corsproxy), parsers, per-value merge, cache |
| `app.js`     | Scales (log x, linear y), Pareto computation, SVG render, toggles, readout |
| `tests/`     | Headless behavioral suite (`npm test`) — sandbox + stubs, no dependencies |

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
stubbed browser globals (`fetch`, `localStorage`, `Worker`, DOM), so it
exercises the real scripts headlessly — including relay ordering, cache
honesty/TTL/tamper defense, inert-text parsing, merge fallback accounting,
Pareto ties, and the render/stamp behavior of a booted page. `app.js` exposes
pure helpers via `window.MVM_TEST` for direct unit assertions; nothing else in
production code exists for testing's sake. CI: none yet — run `npm test`
before pushing.

## Commits

Follow `.github/COMMIT-v2.md`: semantic format `<type>(<scope>): <short summary>` — lowercase, imperative, ≤72 chars first line, no emojis, no body/footer unless asked. Inspect staged changes before writing the message.
