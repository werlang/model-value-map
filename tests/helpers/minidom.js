/**
 * Minimal DOM sufficient to boot app.js outside a browser: element tree,
 * classList/dataset/style, events with closest(), a small HTML parser for the
 * innerHTML templates the app writes, and descendant-combinator selectors
 * (#id tag.class, [attr], [attr=value]).
 */

const VOID_TAGS = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source']);

export function parseSimpleSelector(sel) {
  const m = /^([a-zA-Z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)(.*)$/.exec(sel.trim());
  const classes = m && m[3] ? m[3].slice(1).split('.') : [];
  const attrPart = m && m[4] ? m[4] : '';
  const attrs = [];
  const attrRe = /\[([\w-]+)(?:="([^"]*)")?\]/g;
  let am;
  while ((am = attrRe.exec(attrPart))) attrs.push({ name: am[1], value: am[2] });
  return { tag: m && m[1] ? m[1].toLowerCase() : null, id: m && m[2], classes, attrs };
}

export function matchesSimple(el, sel) {
  const { tag, id, classes, attrs } = parseSimpleSelector(sel);
  if (tag && el.tagName !== tag) return false;
  if (id && el.attrs.id !== id) return false;
  for (const c of classes) if (!el.classList.contains(c)) return false;
  for (const a of attrs) {
    const v = el.attrs[a.name];
    if (v === undefined || (a.value !== undefined && v !== a.value)) return false;
  }
  return true;
}

function camelizeData(name) {
  return name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

let elSeq = 0;
export class El {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toLowerCase();
    this.nodeType = 1;
    this.uid = ++elSeq;
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this._source = '';          // last innerHTML assigned (verbatim)
    this.clientWidth = 0;
    this.clientHeight = 0;
    const cls = this;
    this.classList = {
      set: new Set(),
      add(...names) { names.forEach((n) => n && cls.classList.set.add(n)); this._sync(); },
      remove(...names) { names.forEach((n) => cls.classList.set.delete(n)); this._sync(); },
      contains(n) { return cls.classList.set.has(n); },
      toggle(n) { this.set.has(n) ? this.set.delete(n) : this.set.add(n); this._sync(); },
      _sync() { cls.attrs.class = [...cls.classList.set].join(' '); },
      seed(str) { String(str).split(/\s+/).filter(Boolean).forEach((c) => this.set.add(c)); },
    };
  }

  get className() { return this.attrs.class || ''; }
  set className(v) { this.classList.set.clear(); this.classList.seed(v); this.classList._sync(); }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name.startsWith('data-')) this.dataset[camelizeData(name)] = String(value);
    if (name === 'class') { this.classList.set.clear(); this.classList.seed(value); }
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  get id() { return this.attrs.id ?? ''; }
  set id(v) { this.setAttribute('id', v); }

  appendChild(node) {
    if (node && node.kind === 'text') { this.children.push(node); node.parent = this; return node; }
    node.parent = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  replaceChildren(...nodes) { this.children = []; nodes.forEach((n) => this.appendChild(n)); }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  /** Dispatches on this element, then bubbles up through ancestors. */
  dispatch(type, ev = {}) {
    const event = { target: ev.target || this, type, ...ev };
    let cur = this;
    while (cur) {
      (cur.listeners[type] || []).forEach((fn) => fn(event));
      cur = cur === this ? this.parent : cur.parent;
    }
    return event;
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.nodeType === 1 && matchesSimple(cur, sel)) return cur;
      cur = cur.parent;
    }
    return null;
  }

  *descendants() {
    for (const child of this.children) {
      if (child.kind === 'text') continue;
      yield child;
      yield* child.descendants();
    }
  }

  /** right-to-left descendant-combinator match ("#id tbody", "[data-chip]") */
  matchesPath(parts) {
    // the final part must match THIS element; earlier parts match ancestors
    if (!matchesSimple(this, parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    let cur = this.parent;
    while (cur && i >= 0) {
      if (matchesSimple(cur, parts[i])) i--;
      cur = cur.parent;
    }
    return i < 0;
  }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    return [...this.descendants()].filter((d) => d.matchesPath(parts));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  get textContent() {
    if (!this.children.length) return this._ownText ?? '';
    return this.children.map((c) => (c.kind === 'text' ? c.value : c.textContent)).join('');
  }
  set textContent(v) {
    this.children = [];
    this._ownText = undefined;
    this.children.push({ kind: 'text', value: String(v), parent: this });
  }
  set innerHTML(html) {
    this.children = [];
    this._source = String(html);
    parseHtmlInto(this, this._source);
  }
  get innerHTML() { return this._source; }
}

// ---------- tiny HTML parser ----------
const TAG_RE = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|[^>"])*)>/g;
const ATTR_RE = /([\w:-]+)(?:="([^"]*)")?/g;

export function parseHtmlInto(parentEl, html) {
  const stack = [parentEl];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m;
  const addText = (raw) => {
    if (!raw) return;
    const top = stack[stack.length - 1];
    top.children.push({ kind: 'text', value: raw, parent: top });
  };
  while ((m = TAG_RE.exec(html))) {
    addText(html.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const [, rawTag, attrSrc] = m;
    const isClose = m[0][1] === '/';
    const tag = rawTag.toLowerCase();
    if (isClose) {
      // close: pop until the matching open tag (tolerate strays)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const el = new El(tag);
    let am;
    ATTR_RE.lastIndex = 0;
    while ((am = ATTR_RE.exec(attrSrc || ''))) {
      if (!am[1] || am[1] === '/') continue;
      el.setAttribute(am[1], am[2] ?? '');
    }
    stack[stack.length - 1].appendChild(el);
    const selfClosing = VOID_TAGS.has(tag) || /\/>$/.test(m[0]);
    if (!selfClosing) stack.push(el);
  }
  addText(html.slice(last));
  return parentEl;
}

// ---------- document ----------
export const PAGE_SKELETON = `
  <p id="stamp" class="updated-stamp">
    <span class="stamp-dot"></span>
    <span id="stamp-text">Snapshot</span>
    <button type="button" id="stamp-refresh" class="stamp-refresh" title="r"></button>
  </p>
  <div class="quick-actions">
    <button type="button" class="action" data-action="all">All</button>
    <button type="button" class="action" data-action="none">None</button>
    <button type="button" class="action" data-action="frontier">Frontier only</button>
  </div>
  <div class="chart-holder" id="chart-holder"></div>
  <div id="readout"></div>
  <ul class="excluded-list" id="excluded-list"></ul>
  <section class="toggles-panel">
    <p class="panel-sub" id="visible-count"></p>
    <div id="toggles"></div>
  </section>
  <p class="source-links" id="source-links"></p>
`;

export function makeDocument(skeletonHtml = PAGE_SKELETON) {
  const root = new El('#document');
  parseHtmlInto(root, skeletonHtml);
  const doc = {
    nodeType: 9,
    root,
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    createTextNode: (text) => ({ kind: 'text', value: text }),
    getElementById(id) { return root.querySelector('#' + id); },
    querySelector(sel) { return root.matchesPath(sel.trim().split(/\s+/)) ? root : root.querySelector(sel); },
    querySelectorAll(sel) { return root.querySelectorAll(sel); },
  };
  // document-level selectors should also see the root itself when it matches
  const origQs = doc.querySelector.bind(doc);
  doc.querySelector = (sel) => origQs(sel) ?? (matchesSimpleSafe(root, sel) ? root : null);
  return doc;
}

function matchesSimpleSafe(el, sel) {
  try { return matchesSimple(el, sel); } catch { return false; }
}
