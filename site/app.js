// Claude Skin Switcher: project site script.
// Every string from the gallery API or GitHub is written with textContent or
// as a validated attribute, never as HTML. Skin previews are only ever <img src>
// (an SVG loaded as an image cannot run script).
'use strict';

(() => {
  const API = 'https://claude-skins.sdigasyugfyasfgdyf.workers.dev';
  const REPO = 'Bowen1314/claude-skin-switcher';
  const RELEASES = `https://github.com/${REPO}/releases/latest`;
  const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

  // Same patterns the gallery server uses (server/src/handler.js).
  const AUTHOR_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
  const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
  const TAG_RE = /^[a-z0-9-]{1,20}$/;
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  const PAGE_SIZE = 24;
  const QUERY_MAX = 64;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

  // ------------------------------------------------------------ downloads

  const PLATFORMS = {
    'mac-arm64': { label: 'macOS', sub: 'Apple silicon', alt: 'macOS (Apple silicon)', suffix: '-mac-arm64.dmg' },
    'mac-x64': { label: 'macOS', sub: 'Intel', alt: 'macOS (Intel)', suffix: '-mac-x64.dmg' },
    'win-x64': { label: 'Windows', sub: '', alt: 'Windows', suffix: '-win-x64.exe' },
  };
  const links = { 'mac-arm64': RELEASES, 'mac-x64': RELEASES, 'win-x64': RELEASES };
  let primaryKey = null;

  function detectOS() {
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/Windows/i.test(platform) || /Windows NT/i.test(ua)) return 'win';
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return 'other';
    if (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) {
      // iPadOS reports itself as a Mac; a touch screen gives it away.
      return navigator.maxTouchPoints > 1 ? 'other' : 'mac';
    }
    return 'other';
  }

  function renderDownloads() {
    const primary = $('dl-primary');
    const final = $('dl-final');
    const alt = $('dl-alt');
    if (!primary || !alt) return;
    const p = primaryKey ? PLATFORMS[primaryKey] : null;
    primary.href = p ? links[primaryKey] : RELEASES;
    $('dl-primary-label').textContent = p ? `Download for ${p.label}` : 'Download';
    $('dl-primary-sub').textContent = p && p.sub ? p.sub : '';
    if (final) {
      final.href = primary.href;
      $('dl-final-label').textContent = p ? `Download for ${p.label}` : 'Download';
    }
    alt.replaceChildren();
    const others = Object.keys(PLATFORMS).filter((k) => k !== primaryKey);
    if (primaryKey) alt.append(document.createTextNode('Also for '));
    others.forEach((k, i) => {
      if (i > 0) {
        const sep = el('span', 'sep', '·');
        sep.setAttribute('aria-hidden', 'true');
        alt.append(sep);
      }
      const a = el('a', null, PLATFORMS[k].alt);
      a.href = links[k];
      alt.append(a);
    });
  }

  async function initDownloads() {
    const os = detectOS();
    if (os === 'win') primaryKey = 'win-x64';
    else if (os === 'mac') {
      primaryKey = 'mac-arm64';
      // Chromium can tell Apple silicon from Intel; Safari and Firefox can't,
      // so they get Apple silicon first with Intel one click away.
      try {
        const uad = navigator.userAgentData;
        if (uad && uad.getHighEntropyValues) {
          const { architecture } = await uad.getHighEntropyValues(['architecture']);
          if (architecture === 'x86') primaryKey = 'mac-x64';
        }
      } catch {
        /* keep the default */
      }
    }
    renderDownloads();

    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) return;
      const rel = await res.json();
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      for (const key of Object.keys(PLATFORMS)) {
        const asset = assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith(PLATFORMS[key].suffix));
        const url = asset && typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
        if (url.startsWith(DOWNLOAD_PREFIX)) links[key] = url;
      }
      renderDownloads();
      const tag = str(rel.tag_name, 40);
      if (/^v?[0-9A-Za-z.\-]{1,32}$/.test(tag)) {
        const meta = $('dl-meta');
        meta.replaceChildren();
        meta.append(document.createTextNode(`${tag} · Free · MIT license · `));
        const notes = el('a', null, 'Release notes');
        notes.href = RELEASES;
        meta.append(notes);
      }
    } catch {
      /* the links already point at the releases page */
    }
  }

  // ------------------------------------------------------------ gallery

  const state = {
    sort: 'new',
    q: '',
    tag: '',
    cursor: null,
    count: 0,
    seq: 0,
    controller: null,
    knownTags: new Set(),
  };
  const darkMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function pickPreview(preview) {
    if (!preview || typeof preview !== 'object') return null;
    const want = darkMQ && darkMQ.matches ? ['dark', 'light'] : ['light', 'dark'];
    for (const mode of want) {
      const p = preview[mode];
      if (p && typeof p === 'object') {
        const out = {};
        for (const k of ['surface0', 'surface1', 'text', 'muted', 'accent']) {
          if (typeof p[k] === 'string' && HEX_RE.test(p[k])) out[k] = p[k];
        }
        if (out.surface0 && out.text) {
          out.surface1 = out.surface1 || out.surface0;
          out.muted = out.muted || out.text;
          out.accent = out.accent || out.text;
          return out;
        }
      }
    }
    return null;
  }

  function renderCard(item) {
    const author = str(item.author, 40);
    const slug = str(item.slug, 60);
    const name = str(item.name, 80) || slug || 'Untitled skin';
    const card = el('article', 'card');

    // Preview: the palette as a tiny chat, over the scene if the skin has one.
    const pv = pickPreview(item.preview);
    const top = el('div', 'card-preview');
    if (pv) {
      top.style.setProperty('--sw-bg', pv.surface0);
      top.style.setProperty('--sw-s1', pv.surface1);
      top.style.setProperty('--sw-text', pv.text);
      top.style.setProperty('--sw-muted', pv.muted);
      top.style.setProperty('--sw-accent', pv.accent);
    }
    if (item.hasScene === true && AUTHOR_RE.test(author) && SLUG_RE.test(slug)) {
      const img = document.createElement('img');
      const v = Number.isSafeInteger(item.version) ? `?v=${item.version}` : '';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = `${API}/api/skins/${author}/${slug}/scene.svg${v}`;
      top.append(img);
    }
    if (pv) {
      const mock = el('div', 'mock');
      mock.setAttribute('aria-hidden', 'true');
      mock.append(el('div', 'mock-bubble'), el('div', 'mock-line'), el('div', 'mock-line short'), el('div', 'mock-input'));
      top.append(mock);
    }
    card.append(top);

    const body = el('div', 'card-body');
    const title = el('div', 'card-title');
    title.append(el('h3', null, name));
    if (pv) {
      const sw = el('div', 'swatches');
      sw.setAttribute('role', 'img');
      sw.setAttribute('aria-label', 'Palette');
      for (const c of [pv.surface0, pv.surface1, pv.text, pv.accent]) {
        const dot = el('span', 'swatch');
        dot.style.setProperty('background', c);
        dot.title = c;
        sw.append(dot);
      }
      title.append(sw);
    }
    body.append(title);
    if (author) body.append(el('p', 'card-author', author === 'official' ? 'by official (built in)' : `by ${author}`));
    const desc = str(item.description, 200);
    if (desc) body.append(el('p', 'card-desc', desc));

    const foot = el('div', 'card-foot');
    const tags = el('div', 'card-tags');
    if (Array.isArray(item.tags)) {
      for (const t of item.tags.slice(0, 5)) {
        if (typeof t === 'string' && TAG_RE.test(t)) tags.append(el('span', 'tag', t));
      }
    }
    foot.append(tags);
    if (typeof item.downloads === 'number' && Number.isFinite(item.downloads) && item.downloads >= 0) {
      const n = Math.floor(item.downloads);
      foot.append(el('span', 'card-meta', `${n.toLocaleString('en-US')} download${n === 1 ? '' : 's'}`));
    }
    body.append(foot);
    card.append(body);
    return card;
  }

  function renderTags() {
    const bar = $('gallery-tags');
    if (!bar) return;
    bar.replaceChildren();
    const tags = [...state.knownTags].sort();
    if (state.tag && !state.knownTags.has(state.tag)) tags.unshift(state.tag);
    if (!tags.length) return;
    const mk = (label, value) => {
      const b = el('button', 'chip', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.tag === value));
      b.addEventListener('click', () => {
        state.tag = state.tag === value ? '' : value;
        load(true);
      });
      return b;
    };
    bar.append(mk('All', ''));
    for (const t of tags) bar.append(mk(t, t));
  }

  function skeletons(n) {
    const grid = $('gallery-grid');
    grid.replaceChildren();
    for (let i = 0; i < n; i++) {
      const s = el('div', 'skeleton');
      s.setAttribute('aria-hidden', 'true');
      s.append(el('div', 'sk-top'), el('div', 'sk-line'), el('div', 'sk-line short'));
      grid.append(s);
    }
  }

  function setStatus(title, detail, retry) {
    const box = $('gallery-status');
    box.replaceChildren();
    if (!title) return;
    const wrap = el('div', 'gallery-status');
    wrap.append(el('strong', null, title));
    if (detail) wrap.append(el('span', null, detail));
    if (retry) {
      const b = el('button', 'btn btn-secondary', 'Try again');
      b.type = 'button';
      b.addEventListener('click', () => load(true));
      wrap.append(document.createElement('br'), b);
    }
    box.append(wrap);
  }

  async function load(reset) {
    const grid = $('gallery-grid');
    const more = $('gallery-more');
    const moreBtn = $('gallery-more-btn');
    if (!grid) return;
    if (state.controller) state.controller.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    state.controller = controller;
    const seq = ++state.seq;

    if (reset) {
      state.cursor = null;
      state.count = 0;
      setStatus('');
      skeletons(3);
      more.hidden = true;
    } else {
      moreBtn.disabled = true;
      moreBtn.textContent = 'Loading…';
    }
    renderTags();

    const params = new URLSearchParams({ sort: state.sort, limit: String(PAGE_SIZE) });
    if (state.q) params.set('q', state.q);
    if (state.tag) params.set('tag', state.tag);
    if (!reset && state.cursor) params.set('cursor', state.cursor);

    try {
      const res = await fetch(`${API}/api/skins?${params}`, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller ? controller.signal : undefined,
      });
      if (seq !== state.seq) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== state.seq) return;
      const items = Array.isArray(data && data.items) ? data.items.filter((i) => i && typeof i === 'object') : [];
      state.cursor = typeof data.nextCursor === 'string' && data.nextCursor.length < 512 ? data.nextCursor : null;

      if (reset) grid.replaceChildren();
      for (const item of items) {
        grid.append(renderCard(item));
        if (Array.isArray(item.tags)) for (const t of item.tags) if (typeof t === 'string' && TAG_RE.test(t)) state.knownTags.add(t);
      }
      state.count += items.length;
      renderTags();

      if (state.count === 0) {
        if (state.q || state.tag) setStatus('No skins match.', 'Try a different search or tag.');
        else setStatus('No skins yet.', 'Be the first to share one from the app.');
      } else {
        setStatus('');
      }
      more.hidden = !state.cursor;
    } catch (err) {
      if (seq !== state.seq || (err && err.name === 'AbortError')) return;
      if (reset) {
        grid.replaceChildren();
        setStatus("Couldn't reach the gallery.", 'Check your connection, or browse it from inside the app.', true);
      }
      more.hidden = !state.cursor;
    } finally {
      if (seq === state.seq) {
        moreBtn.disabled = false;
        moreBtn.textContent = 'Load more';
      }
    }
  }

  function initGallery() {
    const search = $('gallery-search');
    if (!search) return;
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const q = search.value.trim().toLowerCase().slice(0, QUERY_MAX);
        if (q === state.q) return;
        state.q = q;
        load(true);
      }, 250);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });
    document.querySelectorAll('.seg button[data-sort]').forEach((b) => {
      b.addEventListener('click', () => {
        const sort = b.getAttribute('data-sort');
        if (sort === state.sort) return;
        state.sort = sort;
        document.querySelectorAll('.seg button[data-sort]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        load(true);
      });
    });
    $('gallery-more-btn').addEventListener('click', () => load(false));
    // Re-draw the palettes when the system switches between light and dark.
    if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener('change', () => load(true));
    load(true);
  }

  function init() {
    initDownloads();
    initGallery();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
