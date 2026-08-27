/* Model Value Map — vanilla JS, no dependencies.
   Renders a responsive SVG scatter (log cost × linear intelligence),
   computes the Pareto frontier over currently visible models,
   and wires toggles + crosshair readout. */
(function () {
  'use strict';

  const SNAPSHOT = window.DASHBOARD_DATA || null;
  let MODELS = (SNAPSHOT && SNAPSHOT.models) || [];
  const STORE_KEY = 'mvm.hidden.v1';

  let plotted = [];
  let excluded = [];
  let tMax = 1;
  function recompute() {
    plotted = MODELS.filter((m) => m.plot);
    excluded = MODELS.filter((m) => !m.plot);
    const tokenCounts = plotted.map((m) => m.weeklyTokensT).filter((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
    tMax = tokenCounts.length ? Math.max(1, ...tokenCounts) : 1;
  }

  // ---------- state ----------
  const hidden = new Set(loadHidden());
  let activeId = null;

  function loadHidden() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((id) => MODELS.some((m) => m.id === id)) : [];
    } catch { return []; }
  }
  function saveHidden() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...hidden])); } catch { /* private mode */ }
  }

  // ---------- scales ----------
  const M = { top: 26, right: 24, bottom: 44, left: 52 };
  const X_TICK_CANDIDATES = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];

  const lx = (v) => Math.log10(v);
  function makeScales(w, h, xDomain, yDomain) {
    const iw = w - M.left - M.right;
    const ih = h - M.top - M.bottom;
    const x = (v) => M.left + ((lx(v) - lx(xDomain[0])) / (lx(xDomain[1]) - lx(xDomain[0]))) * iw;
    const y = (v) => M.top + ih - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * ih;
    return { x, y, iw, ih };
  }

  // Domains derive from the plotted set so live data drift can't clip points,
  // while staying stable across visibility toggles.
  function computeDomains() {
    if (!plotted.length) return { xd: [0.17, 18], yd: [35, 62], xt: [0.2, 0.5, 1, 2, 5, 10], yt: [35, 40, 45, 50, 55, 60] };
    const xs = plotted.map((m) => m.ocCostPerM);
    const ys = plotted.map((m) => m.aa.intelligenceIndex);
    const xd = [Math.min(...xs) / 1.4, Math.max(...xs) * 1.4];
    const yd = [Math.floor((Math.min(...ys) - 2) / 5) * 5, Math.ceil((Math.max(...ys) + 2) / 5) * 5];
    const xt = X_TICK_CANDIDATES.filter((t) => t >= xd[0] && t <= xd[1]);
    const yt = [];
    for (let v = yd[0]; v <= yd[1]; v += 5) yt.push(v);
    return { xd, yd, xt, yt };
  }

  const R_MIN = 5, R_MAX = 15;
  const R_DEFAULT = 7;
  const radius = (t) => (typeof t === 'number' && Number.isFinite(t) && t > 0 ? R_MIN + Math.sqrt(t / tMax) * (R_MAX - R_MIN) : R_DEFAULT);

  // Per-model label placement hints [dx, dy, textAnchor]
  const LABEL_HINTS = {
    'deepseek-v4-flash': [20, -7, 'start'],
    'mimo-v2.5': [17, 17, 'start'],
    'hy3': [11, 15, 'start'],
    'mimo-v2.5-pro': [11, 15, 'start'],
    'gpt-5.6-luna': [-12, -9, 'end'],
    'minimax-m3': [12, 14, 'start'],
    'qwen3.7-plus': [12, 14, 'start'],
    'kimi-k2.7-code': [12, 14, 'start'],
    'glm-5.3': [-4, -16, 'middle'],
    'glm-5.2': [13, 4, 'start'],
    'deepseek-v4-pro': [-12, -11, 'end'],
    'kimi-k3': [-13, 20, 'end'],
  };

  // ---------- pareto ----------
  function frontierOf(models) {
    const pts = [...models].sort((a, b) => (a.ocCostPerM - b.ocCostPerM) || (b.aa.intelligenceIndex - a.aa.intelligenceIndex));
    const out = [];
    for (const p of pts) {
      if (!out.length || p.aa.intelligenceIndex > out[out.length - 1].aa.intelligenceIndex) out.push(p);
    }
    return out;
  }

  const fmt$ = (v) => '$' + (v >= 1 ? String(+v.toFixed(2)) : v.toFixed(2).replace(/0$/, ''));
  const fmtCtx = (t) => (t == null ? '—' : t >= 1e6 ? Math.round(t / 1e5) / 10 + 'M' : Math.round(t / 1e3) + 'k');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- DOM handles ----------
  const holder = document.getElementById('chart-holder');
  const chartLoadingEl = document.getElementById('chart-loading');
  const readoutEl = document.getElementById('readout');
  const togglesEl = document.getElementById('toggles');
  const countEl = document.getElementById('visible-count');
  const excludedEl = document.getElementById('excluded-list');
  const sourceLinksEl = document.getElementById('source-links');

  const DEFAULT_SOURCES = (SNAPSHOT && SNAPSHOT.meta && SNAPSHOT.meta.sources) || [
    { name: 'opencode.ai/data', url: 'https://opencode.ai/data' },
    { name: 'artificialanalysis.ai/models', url: 'https://artificialanalysis.ai/models' },
  ];
  sourceLinksEl.innerHTML = DEFAULT_SOURCES
    .map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${esc(s.name)}</a>`)
    .join(' · ');

  // ---------- chart ----------
  let svg = null;
  let cur = null; // live scales + crosshair layer for setActive

  function render() {
    const w = Math.max(320, holder.clientWidth);
    const h = Math.round(Math.min(680, Math.max(380, w * 0.56)));
    const { xd, yd, xt, yt } = computeDomains();
    const { x, y, iw, ih } = makeScales(w, h, xd, yd);

    const visible = plotted.filter((m) => !hidden.has(m.id));
    const frontier = frontierOf(visible);
    const frontierIds = new Set(frontier.map((f) => f.id));

    const NS = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('class', 'chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label',
      `Scatter plot of ${visible.length} models. Horizontal axis: dollars per million tokens, log scale. Vertical axis: Artificial Analysis Intelligence Index.`);

    // defs: hatch for dominated zone
    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML =
      `<pattern id="hatch" patternUnits="userSpaceOnUse" width="7" height="7">
         <path d="M0 7 L7 0" stroke="#1f49e0" stroke-opacity="0.10" stroke-width="1"/>
       </pattern>`;
    svg.appendChild(defs);

    const gGrid = el('g'); const gZone = el('g');
    const gCross = el('g'); const gAxes = el('g');
    const gDots = el('g', 'layer-dots');
    const gTop = el('g', 'layer-top');
    gTop.setAttribute('pointer-events', 'none');
    svg.append(gGrid, gZone, gCross, gAxes, gDots, gTop);
    cur = { x, y, gCross, gTop, bottom: M.top + ih, left: M.left, w, frontier, frontierIds };

    function el(name, cls) {
      const n = document.createElementNS(NS, name);
      if (cls) n.setAttribute('class', cls);
      return n;
    }
    function line(parent, x1, y1, x2, y2, cls) {
      const l = el('line', cls);
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      parent.appendChild(l); return l;
    }
    function txt(parent, x, y, str, cls, anchor) {
      const t = el('text', cls);
      t.setAttribute('x', x); t.setAttribute('y', y);
      if (anchor) t.setAttribute('text-anchor', anchor);
      t.textContent = str;
      parent.appendChild(t); return t;
    }

    // grid
    for (const tv of xt) {
      line(gGrid, x(tv), M.top, x(tv), M.top + ih, 'grid-minor');
      line(gGrid, x(tv), M.top + ih, x(tv), M.top + ih + 5, 'grid-major');
      txt(gAxes, x(tv), M.top + ih + 18, '$' + tv, 'tick-label', 'middle');
    }
    for (const tv of yt) {
      line(gGrid, M.left, y(tv), M.left + iw, y(tv), tv % 10 === 0 ? 'grid-major' : 'grid-minor');
      txt(gAxes, M.left - 8, y(tv) + 3.5, String(tv), 'tick-label', 'end');
    }
    // frame
    line(gAxes, M.left, M.top + ih, M.left + iw, M.top + ih, 'grid-major');
    line(gAxes, M.left, M.top, M.left, M.top + ih, 'grid-major');
    // axis titles
    txt(gAxes, M.left + iw / 2, h - 6, 'COST PER 1M TOKENS (USD, OPENCODE)', 'axis-title-x', 'middle');
    const yTitle = txt(gAxes, 14, M.top + ih / 2, 'INTELLIGENCE INDEX (ARTIFICIAL ANALYSIS)', 'axis-title-y', 'middle');
    yTitle.setAttribute('transform', `rotate(-90 14 ${M.top + ih / 2})`);

    // dominated zone (under-left hull of the frontier)
    if (frontier.length > 1) {
      const poly = el('polygon', 'dominated-zone fade');
      const pts = [
        `${x(frontier[0].ocCostPerM)},${y(frontier[0].aa.intelligenceIndex)}`,
        ...frontier.slice(1).map((p) => `${x(p.ocCostPerM)},${y(p.aa.intelligenceIndex)}`),
        `${x(frontier[frontier.length - 1].ocCostPerM)},${M.top + ih}`,
        `${x(frontier[0].ocCostPerM)},${M.top + ih}`,
      ].join(' ');
      poly.setAttribute('points', pts);
      gZone.appendChild(poly);
      const zl = txt(gZone, 0, 0, 'DOMINATED', 'zone-label', 'middle');
      const mx = (x(frontier[0].ocCostPerM) + x(frontier[frontier.length - 1].ocCostPerM)) / 2;
      zl.setAttribute('x', mx + 30);
      zl.setAttribute('y', M.top + ih - 14);
      zl.setAttribute('transform', `rotate(-52 ${mx + 30} ${M.top + ih - 14})`);
    }

    // frontier dashed path + halo
    if (frontier.length > 1) {
      const d = frontier.map((p, i) => `${i ? 'L' : 'M'}${x(p.ocCostPerM)},${y(p.aa.intelligenceIndex)}`).join('');
      const halo = el('path', 'frontier-halo'); halo.setAttribute('d', d);
      const path = el('path', 'frontier-path draw');
      path.setAttribute('d', d);
      path.setAttribute('stroke-dasharray', '7 5');
      gZone.append(halo, path);
      // tag riding just below the first (cheap) segment, inside the dominated zone
      const p0 = frontier[0], p1 = frontier[1];
      const x0 = x(p0.ocCostPerM), y0 = y(p0.aa.intelligenceIndex);
      const x1 = x(p1.ocCostPerM), y1 = y(p1.aa.intelligenceIndex);
      const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
      const tx = x0 + (x1 - x0) * 0.6, ty = (y0 + y1) / 2;
      const tag = txt(gZone, tx, ty + 20, 'PARETO FRONTIER', 'frontier-tag', 'middle');
      tag.setAttribute('transform', `rotate(${ang.toFixed(1)} ${tx} ${ty})`);
    }

    // dots
    let dotIdx = 0;
    for (const m of plotted) {
      if (hidden.has(m.id)) continue;
      const cx = x(m.ocCostPerM), cy = y(m.aa.intelligenceIndex), r = radius(m.weeklyTokensT);
      const onF = frontierIds.has(m.id);
      const rankNum = typeof m.rank === 'number' && Number.isFinite(m.rank) ? m.rank : (dotIdx + 1);
      dotIdx++;
      const g = el('g', 'dot-point' + (onF ? ' frontier-member' : ''));
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'img');
      g.setAttribute('aria-label',
        `${m.label}${m.rank ? `, rank ${m.rank}` : ''}. ${fmt$(m.ocCostPerM)} per million tokens, intelligence ${m.aa.intelligenceIndex}${onF ? ', on the Pareto frontier' : ''}.`);
      g.dataset.id = m.id;
      g.setAttribute('transform', `translate(${cx},${cy})`);

      const mark = el('circle', 'dot-mark');
      mark.setAttribute('r', r.toFixed(1));
      mark.setAttribute('fill', m.hue || '#3B5BDB');
      mark.classList.add('dot-enter');
      mark.style.animationDelay = `${80 + rankNum * 28}ms`;
      mark.addEventListener('animationend', () => mark.classList.remove('dot-enter'), { once: true });

      const ring = el('circle', 'dot-ring');
      ring.setAttribute('r', (r + 4.5).toFixed(1));

      const [dx, dy, anch] = LABEL_HINTS[m.id] || [12, -8, 'start'];
      g.append(mark, ring);
      // narrow charts: labels crowd and collide — dots stay tappable,
      // the readout + screen-reader table carry identification
      if (w >= 640) txt(g, dx, dy, `${m.label}`, 'dot-label', anch);
      gDots.appendChild(g);

      g.addEventListener('pointerenter', () => { setActive(m.id, g, true); });
      g.addEventListener('pointerleave', () => { setActive(null, g, false); });
      g.addEventListener('focus', () => { setActive(m.id, g, true); });
      g.addEventListener('blur', () => { setActive(null, g, false); });
    }

    holder.replaceChildren(svg);
    if (chartLoadingEl) holder.appendChild(chartLoadingEl);
    renderReadout(activeId ? MODELS.find((mm) => mm.id === activeId) : null, frontier);
    renderCount(visible.length, frontier.length);
    syncChips();
  }

  function setActive(id, g, on) {
    const { x, y, gCross, gTop, bottom, left, w, frontierIds } = cur;
    gCross.replaceChildren();
    if (gTop) gTop.replaceChildren();

    if (on && id) {
      if (g) {
        if (g.parentElement && g.parentElement.lastElementChild !== g) {
          g.parentElement.appendChild(g);
        }
        g.classList.add('is-active');
        const ring = g.querySelector('.dot-ring');
        if (ring) ring.style.opacity = 1;
      }
      const m = MODELS.find((mm) => mm.id === id);
      if (m && m.ocCostPerM != null && m.aa && typeof m.aa.intelligenceIndex === 'number') {
        const cx = x(m.ocCostPerM), cy = y(m.aa.intelligenceIndex);
        const NS = 'http://www.w3.org/2000/svg';
        const vx = document.createElementNS(NS, 'line');
        vx.setAttribute('class', 'dot-cross-x');
        vx.setAttribute('x1', cx); vx.setAttribute('y1', cy);
        vx.setAttribute('x2', cx); vx.setAttribute('y2', bottom);
        const hy = document.createElementNS(NS, 'line');
        hy.setAttribute('class', 'dot-cross-y');
        hy.setAttribute('x1', cx); hy.setAttribute('y1', cy);
        hy.setAttribute('x2', left); hy.setAttribute('y2', cy);
        gCross.append(vx, hy);

        if (gTop) {
          const r = radius(m.weeklyTokensT);
          const topG = document.createElementNS(NS, 'g');
          topG.setAttribute('class', 'dot-point is-active' + (frontierIds.has(m.id) ? ' frontier-member' : ''));
          topG.setAttribute('transform', `translate(${cx},${cy})`);

          const mark = document.createElementNS(NS, 'circle');
          mark.setAttribute('class', 'dot-mark');
          mark.setAttribute('r', r.toFixed(1));
          mark.setAttribute('fill', m.hue || '#3B5BDB');
          mark.style.stroke = 'var(--ink)';
          mark.style.strokeWidth = '2.5px';

          const topRing = document.createElementNS(NS, 'circle');
          topRing.setAttribute('class', 'dot-ring');
          topRing.setAttribute('r', (r + 4.5).toFixed(1));
          topRing.style.opacity = 1;

          topG.append(mark, topRing);

          if (w >= 640) {
            const [dx, dy, anch] = LABEL_HINTS[m.id] || [12, -8, 'start'];
            const txt = document.createElementNS(NS, 'text');
            txt.setAttribute('class', 'dot-label');
            txt.setAttribute('x', dx);
            txt.setAttribute('y', dy);
            if (anch) txt.setAttribute('text-anchor', anch);
            txt.style.fontWeight = '700';
            txt.style.fill = 'var(--ink)';
            txt.textContent = m.label;
            topG.appendChild(txt);
          }
          gTop.appendChild(topG);
        }
      }
      activeId = id;
      const visible = plotted.filter((mm) => !hidden.has(mm.id));
      renderReadout(m, frontierOf(visible));
    } else if (!on) {
      if (g) {
        g.classList.remove('is-active');
        const ring = g.querySelector('.dot-ring');
        if (ring) ring.style.opacity = 0;
      }
    }
  }

  // ---------- readout ----------
  function renderReadout(model, frontier) {
    if (model) {
      const c = model.ocCost || {};
      const onF = frontier.some((f) => f.id === model.id);
      const badges = [];
      if (model.rank) badges.push(`<span class="badge">rank #${model.rank}</span>`);
      if (onF) badges.push('<span class="badge on-frontier">on frontier</span>');
      if (model.openWeights != null) badges.push(`<span class="badge">${model.openWeights ? 'open weights' : 'proprietary'}</span>`);
      if (model.reasoning != null) badges.push(`<span class="badge">${model.reasoning ? 'reasoning' : 'non-reasoning'}</span>`);

      readoutEl.innerHTML = `
        <h2 class="readout-model-title"><span class="chip-dot" style="--chip-c:${model.hue};width:11px;height:11px"></span>${esc(model.label)}</h2>
        <p class="readout-author">${esc(model.author)}${model.rank ? ` · leaderboard #${model.rank}` : ''}</p>
        <div class="readout-badges">${badges.join('')}</div>
        <dl class="readout-grid">
          <div><dt>Cost / 1M</dt><dd>${fmt$(model.ocCostPerM)} <small>(out)</small></dd></div>
          <div><dt>Intelligence</dt><dd>${model.aa.intelligenceIndex} / 100</dd></div>
          <div><dt>Input rate</dt><dd>${c.input != null ? fmt$(c.input) : '—'} <small>/1M</small></dd></div>
          <div><dt>Cached</dt><dd>${c.cached != null ? fmt$(c.cached) : '—'} <small>/1M</small></dd></div>
          <div><dt>Context</dt><dd>${fmtCtx(model.contextWindowTokens)}</dd></div>
          ${model.weeklyTokensT ? `<div><dt>Tokens this month</dt><dd>${model.weeklyTokensT >= 1 ? model.weeklyTokensT.toFixed(1) + 'T' : Math.round(model.weeklyTokensT * 1000) + 'B'}</dd></div>` : ''}
        </dl>
        ${model.aa.effort ? `<p class="hint">AA variant: ${esc(model.aa.name)} (${esc(model.aa.effort)} effort)</p>` : ''}
        <p class="readout-links">
          <a href="${(model.aa && model.aa.url) || ('https://artificialanalysis.ai/models/' + encodeURIComponent(model.id))}" target="_blank" rel="noopener">Artificial Analysis ↗</a>
          <a href="https://models.dev" target="_blank" rel="noopener">models.dev ↗</a>
        </p>`;
      return;
    }

    if (!frontier.length) {
      readoutEl.innerHTML = `
        <h2 class="readout-empty-title">No models selected</h2>
        <p class="readout-lede">Toggle models back on below and the frontier redraws itself.</p>`;
      return;
    }

    readoutEl.innerHTML = `
      <h2 class="readout-empty-title">Reading the map</h2>
      <p class="readout-lede">Hover any dot for detail. The dashed line connects models nothing
      beats on both axes — buy under the line, you lose intelligence; buy above it, you pay more for the same.</p>
      <ul class="readout-members">
        ${frontier.map((f) => `<li>
          <span class="chip-dot" style="--chip-c:${f.hue}"></span>
          <span class="m-name">${esc(f.label)}</span>
          <span class="m-vals">${fmt$(f.ocCostPerM)} · ${f.aa.intelligenceIndex}</span>
        </li>`).join('')}
      </ul>
      <p class="hint">Frontier recomputed over the ${plotted.length - hidden.size} models currently toggled on.</p>`;
  }

  // ---------- excluded tray ----------
  function renderExcluded() {
    excludedEl.innerHTML = excluded.map((m) => {
      const known = m.ocCostPerM != null
        ? `$${m.ocCostPerM}/1M`
        : (m.aa ? `II ${m.aa.intelligenceIndex}` : 'no data');
      const missingAxis = m.ocCostPerM == null ? 'missing cost' : 'missing score';
      return `<li>
        <div class="excluded-row">
          <span class="chip-dot" style="--chip-c:${m.hue}"></span>
          <span class="excluded-name">${esc(m.label)}</span>
          <span class="excluded-axis">${known} · ${missingAxis}</span>
        </div>
        <p class="excluded-reason">${esc(m.excludeReason)}</p>
      </li>`;
    }).join('');
  }

  // ---------- toggles with sort switcher ----------
  let currentSort = 'score'; // 'score' | 'cost' | 'provider'
  let labOrder = [];
  let byLab = new Map();

  function regroup() {
    labOrder = [];
    byLab = new Map();
    for (const m of MODELS) {
      if (!byLab.has(m.author)) { byLab.set(m.author, []); labOrder.push(m.author); }
      byLab.get(m.author).push(m);
    }

    // Sort models within each lab
    for (const [, list] of byLab) {
      list.sort((a, b) => {
        if (currentSort === 'score') {
          const sA = (a.aa && typeof a.aa.intelligenceIndex === 'number') ? a.aa.intelligenceIndex : -1;
          const sB = (b.aa && typeof b.aa.intelligenceIndex === 'number') ? b.aa.intelligenceIndex : -1;
          if (sB !== sA) return sB - sA;
          return (a.ocCostPerM ?? Infinity) - (b.ocCostPerM ?? Infinity);
        }
        if (currentSort === 'cost') {
          const cA = (typeof a.ocCostPerM === 'number' && a.ocCostPerM > 0) ? a.ocCostPerM : Infinity;
          const cB = (typeof b.ocCostPerM === 'number' && b.ocCostPerM > 0) ? b.ocCostPerM : Infinity;
          if (cA !== cB) return cA - cB;
          const sA = (a.aa && typeof a.aa.intelligenceIndex === 'number') ? a.aa.intelligenceIndex : -1;
          const sB = (b.aa && typeof b.aa.intelligenceIndex === 'number') ? b.aa.intelligenceIndex : -1;
          return sB - sA;
        }
        return (a.label || '').localeCompare(b.label || '');
      });
    }

    // Sort lab groups
    labOrder.sort((a, b) => {
      if (currentSort === 'provider') {
        return a.localeCompare(b);
      }
      if (currentSort === 'score') {
        const topA = Math.max(...byLab.get(a).map((m) => (m.aa && typeof m.aa.intelligenceIndex === 'number') ? m.aa.intelligenceIndex : -1));
        const topB = Math.max(...byLab.get(b).map((m) => (m.aa && typeof m.aa.intelligenceIndex === 'number') ? m.aa.intelligenceIndex : -1));
        if (topB !== topA) return topB - topA;
        return a.localeCompare(b);
      }
      if (currentSort === 'cost') {
        const minA = Math.min(...byLab.get(a).map((m) => (typeof m.ocCostPerM === 'number' && m.ocCostPerM > 0) ? m.ocCostPerM : Infinity));
        const minB = Math.min(...byLab.get(b).map((m) => (typeof m.ocCostPerM === 'number' && m.ocCostPerM > 0) ? m.ocCostPerM : Infinity));
        if (minA !== minB) return minA - minB;
        return a.localeCompare(b);
      }
      return 0;
    });
  }

  function chipBadge(m) {
    if (currentSort === 'cost' && typeof m.ocCostPerM === 'number') {
      return `$${m.ocCostPerM}`;
    }
    if (currentSort === 'score' && m.aa && typeof m.aa.intelligenceIndex === 'number') {
      return `${m.aa.intelligenceIndex}`;
    }
    if (m.rank) {
      return `#${m.rank}`;
    }
    if (m.aa && typeof m.aa.intelligenceIndex === 'number') {
      return `${m.aa.intelligenceIndex}`;
    }
    return '';
  }

  function renderToggles() {
    regroup();
    togglesEl.innerHTML = labOrder.map((lab) => {
      const list = byLab.get(lab);
      const hue = list[0].hue;
      return `<section class="lab-group" data-lab="${esc(lab)}">
        <button type="button" class="lab-row" data-lab-toggle="${esc(lab)}"
                aria-pressed="false">
          <span class="lab-swatch" style="--lab-c:${hue}"></span>
          <span class="lab-name">${esc(lab)}</span>
          <span class="lab-count">${list.length} model${list.length > 1 ? 's' : ''}</span>
          <span class="lab-state" aria-hidden="true"></span>
        </button>
        <div class="chips" role="group" aria-label="${esc(lab)} models">
          ${list.map((m) => `<button type="button" class="chip" data-chip="${esc(m.id)}" aria-pressed="true">
            <span class="chip-dot" style="--chip-c:${m.hue}"></span>
            <span class="chip-name">${esc(m.label)}</span>
            <span class="chip-rank">${chipBadge(m)}</span>
          </button>`).join('')}
        </div>
      </section>`;
    }).join('');
    syncChips();
  }

  function syncChips() {
    togglesEl.querySelectorAll('[data-chip]').forEach((btn) => {
      btn.setAttribute('aria-pressed', hidden.has(btn.dataset.chip) ? 'false' : 'true');
    });
    togglesEl.querySelectorAll('[data-lab-toggle]').forEach((btn) => {
      const ids = byLab.get(btn.dataset.labToggle).map((m) => m.id);
      const onN = ids.filter((id) => !hidden.has(id)).length;
      const state = btn.querySelector('.lab-state');
      btn.setAttribute('aria-pressed', onN ? 'true' : 'false');
      if (state) state.textContent = onN === 0 ? 'off' : onN === ids.length ? 'all on' : `${onN}/${ids.length}`;
    });
  }

  function wireToggleHandlers() {
    const sortBtns = document.querySelectorAll('.sort-btn');
    sortBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const sortKey = btn.dataset.sort;
        if (!sortKey || sortKey === currentSort) return;
        currentSort = sortKey;
        sortBtns.forEach((b) => {
          const isActive = b.dataset.sort === currentSort;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
        renderToggles();
      });
    });

    togglesEl.addEventListener('click', (e) => {
      const chipBtn = e.target.closest('[data-chip]');
      if (chipBtn) {
        const id = chipBtn.dataset.chip;
        hidden.has(id) ? hidden.delete(id) : hidden.add(id);
        saveHidden(); render(); return;
      }
      const labBtn = e.target.closest('[data-lab-toggle]');
      if (labBtn) {
        const lab = labBtn.dataset.labToggle;
        const ids = byLab.get(lab).map((m) => m.id);
        const anyOn = ids.some((id) => !hidden.has(id));
        ids.forEach((id) => (anyOn ? hidden.add(id) : hidden.delete(id)));
        saveHidden(); render();
      }
    });

    togglesEl.addEventListener('pointerenter', (e) => {
      const chipBtn = e.target.closest('[data-chip]');
      if (chipBtn) {
        const id = chipBtn.dataset.chip;
        const dot = svg ? svg.querySelector(`[data-id="${id}"]`) : null;
        if (dot) setActive(id, dot, true);
      }
    }, true);

    togglesEl.addEventListener('pointerleave', (e) => {
      const chipBtn = e.target.closest('[data-chip]');
      if (chipBtn) {
        const id = chipBtn.dataset.chip;
        const dot = svg ? svg.querySelector(`[data-id="${id}"]`) : null;
        if (dot) setActive(null, dot, false);
      }
    }, true);

    document.querySelector('.quick-actions').addEventListener('click', (e) => {
      const btn = e.target.closest('.action');
      if (!btn) return;
      const act = btn.dataset.action;
      if (act === 'all') hidden.clear();
      else if (act === 'none') plotted.forEach((m) => hidden.add(m.id));
      else if (act === 'frontier') {
        const f = frontierOf(plotted.filter((m) => !hidden.has(m.id)));
        hidden.clear();
        plotted.forEach((m) => { if (!f.includes(m)) hidden.add(m.id); });
      }
      saveHidden(); render();
    });
  }

  function renderCount(shown, frontierLen) {
    countEl.textContent = `${shown} of ${plotted.length} plotted · frontier has ${frontierLen} model${frontierLen === 1 ? '' : 's'} · toggling redraws it`;
  }

  // hidden-data table for assistive tech (built once, refreshed with the data)
  function buildTable() {
    const table = document.createElement('table');
    table.className = 'visually-hidden';
    table.id = 'sr-data-table';
    table.innerHTML = `
      <caption>Model cost and intelligence data</caption>
      <thead><tr><th>Model</th><th>Author</th><th>OpenCode usage rank</th>
      <th>Cost per 1M tokens (USD)</th><th>Intelligence Index</th></tr></thead>
      <tbody></tbody>`;
    document.querySelector('.toggles-panel').appendChild(table);
    updateTable();
  }

  function updateTable() {
    const tbody = document.querySelector('#sr-data-table tbody');
    if (!tbody) return;
    tbody.innerHTML = `
      ${plotted.map((m) => `<tr><td>${esc(m.label)}</td><td>${esc(m.author)}</td><td>${m.rank ?? '—'}</td><td>${m.ocCostPerM}</td><td>${m.aa ? m.aa.intelligenceIndex : 'n/a'}</td></tr>`).join('')}
      ${excluded.map((m) => `<tr><td>${esc(m.label)} (not plottable)</td><td>${esc(m.author)}</td><td>${m.rank ?? '—'}</td><td>${m.ocCostPerM ?? 'n/a'}</td><td>${m.aa ? m.aa.intelligenceIndex : 'n/a'}</td></tr>`).join('')}`;
  }

  // ---------- live data status stamp ----------
  const stampEl = document.getElementById('stamp');
  const stampText = document.getElementById('stamp-text');
  const refreshBtn = document.getElementById('stamp-refresh');

  function setStamp(cls, text) {
    stampEl.classList.remove('live', 'partial', 'snapshot', 'error');
    if (cls) stampEl.classList.add(cls);
    stampText.textContent = text;
  }

  function setChartLoading(loading) {
    if (chartLoadingEl) {
      chartLoadingEl.classList.toggle('is-visible', Boolean(loading));
    }
  }

  function fmtClock(iso) {
    try { return new Date(iso).toISOString().slice(11, 16) + ' UTC'; } catch (_) { return ''; }
  }

  function fmtAge(ts) {
    const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
    if (mins < 60) return mins + ' min';
    return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  }

  function updateStamp(res) {
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
    if (!res) {
      setChartLoading(false);
      setStamp('error', 'Snapshot Aug 23, 2026 · live fetch failed');
      return;
    }
    if (res.state === 'loading') {
      setChartLoading(true);
      refreshBtn.classList.add('spinning');
      refreshBtn.disabled = true;
      setStamp(null, 'Fetching live data…');
      return;
    }
    if (res.state === 'stale' && res.refreshing) {
      setChartLoading(true);
    } else {
      setChartLoading(false);
    }
    if (res.state === 'live') setStamp('live', 'Live · updated ' + fmtClock(res.ocUpdatedAt || res.fetchedAt));
    else if (res.state === 'cached') setStamp('live', 'Live · fetched ' + Math.max(1, Math.round((Date.now() - res.fetchedAt) / 60000)) + ' min ago');
    else if (res.state === 'partial') setStamp('partial', 'Live + snapshot · ' + (res.snapFallbacks || 0) + ' values from snapshot');
    else if (res.state === 'stale') setStamp('partial', 'Stale live data · fetched '
      + fmtAge(res.fetchedAt) + ' ago'
      + (res.refreshing ? ' · refreshing…' : ' · sources unreachable'));
    else setStamp('snapshot', 'Snapshot · Aug 23, 2026');
  }

  function applyLiveResult(res) {
    if (res && res.models) {
      MODELS = res.models;
      for (const id of [...hidden]) if (!MODELS.some((m) => m.id === id)) hidden.delete(id);
      activeId = null;
      recompute();
      renderExcluded();
      renderToggles();
      updateTable();
      render();
    }
    updateStamp(res);
  }

  function refreshLive(force) {
    if (!window.LiveData) { updateStamp(null); return; }
    updateStamp({ state: 'loading' });
    // load() may answer twice: a past-TTL visit gets stale data immediately
    // and the finished network refresh arrives via onUpdate.
    LiveData.load(MODELS, { force, onUpdate: applyLiveResult })
      .then(applyLiveResult).catch(() => updateStamp(null));
  }

  // ---------- boot ----------
  recompute();
  renderExcluded();
  renderToggles();
  wireToggleHandlers();
  buildTable();

  let raf = 0;
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(holder.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  });
  ro.observe(holder);
  render();

  // Wire refresh button and trigger live data fetch
  refreshBtn.addEventListener('click', () => refreshLive(true));
  if (window.LiveData) {
    refreshLive(false);
  } else {
    updateStamp({ state: 'snapshot' });
  }

  // Headless test seam: pure helpers only — nothing here captures DOM nodes
  // or mutable state, so exposing them has no effect on page behavior.
  window.MVM_TEST = { frontierOf, makeScales, esc, fmt$: fmt$, fmtCtx };
})();
