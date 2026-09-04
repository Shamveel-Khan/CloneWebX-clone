// Content analyzer. Injected into a fully rendered page via
// chrome.scripting.executeScript({func: analyzePage}) and runs in the page.
//
// IMPORTANT: this function must stay fully self-contained — no imports, no
// references to module scope — because Chrome serializes its source and runs
// it inside the analyzed tab. It returns a JSON-safe "page model" describing
// structure, content and computed styles, which background.js converts into
// Elementor JSON.

export function analyzePage() {
  const MAX_NODES = 600;
  let nodeCount = 0;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'TITLE', 'HEAD',
    'SVG', 'CANVAS', 'SOURCE', 'TRACK', 'PARAM', 'EMBED', 'OBJECT',
    'INPUT', 'SELECT', 'TEXTAREA', 'DATALIST', 'OPTION', 'DIALOG',
    'AUDIO', 'MAP', 'AREA', 'BUTTON',
  ]);

  const INLINE_RE = /^(A|B|STRONG|I|EM|SPAN|SMALL|BR|U|MARK|CODE|TIME|ABBR|SUB|SUP|LABEL)$/;
  const BUTTON_CLASS = /(^|[\s_-])(btn|button|cta)([\s_-]|$)/i;
  const SKIP_LINK_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|avif|zip|rar|7z|mp4|mp3|webm|css|js|xml|rss|ico|woff2?|ttf|eot|dmg|exe)($|\?)/i;

  function px(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  function isTransparent(color) {
    const c = String(color || '').replace(/\s+/g, '');
    return !c || c === 'transparent' || /^rgba\(\d+,\d+,\d+,0\)$/.test(c);
  }

  function abs(u) {
    try {
      return new URL(u, location.href).href;
    } catch (e) {
      return '';
    }
  }

  const SNAP_PROPS = [
    'display', 'flexDirection', 'flexWrap', 'alignItems', 'justifyContent',
    'rowGap', 'columnGap', 'gridTemplateColumns',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
    'color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
    'letterSpacing', 'textAlign', 'textTransform', 'textDecorationLine',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
    'borderTopWidth', 'borderTopColor', 'borderTopStyle',
    'minHeight', 'opacity',
  ];

  function snap(el) {
    const cs = getComputedStyle(el);
    const out = { _tag: el.tagName.toLowerCase() };
    for (const p of SNAP_PROPS) {
      out[p] = cs[p] === undefined ? cs.getPropertyValue(p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())) : cs[p];
    }
    return out;
  }

  function isHidden(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
    const r = el.getBoundingClientRect();
    return r.width < 2 && r.height < 2;
  }

  function bgImageUrl(value) {
    if (!value || value === 'none') return '';
    const m = /url\((['"]?)(.*?)\1\)/.exec(value);
    if (!m || !m[2] || /^data:/.test(m[2])) return '';
    return abs(m[2]);
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function cleanHtml(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg,iframe,button,input,select,textarea').forEach((n) => n.remove());
    return clone.innerHTML.replace(/\s+/g, ' ').trim().slice(0, 8000);
  }

  // ------------------------------------------------------------ assets

  const assetSet = new Set();
  function addAsset(u) {
    if (u && /^https?:/.test(u) && assetSet.size < 400) assetSet.add(u);
  }

  function bestSrc(el) {
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (!img) return '';
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    if (srcset) {
      let best = '';
      let bestW = -1;
      for (const part of srcset.split(',')) {
        const seg = part.trim().split(/\s+/);
        const url = seg[0];
        if (!url || /^data:/.test(url)) continue;
        let w = 1000;
        const wm = /(\d+)w/.exec(seg[1] || '');
        const xm = /([\d.]+)x/.exec(seg[1] || '');
        if (wm) w = parseInt(wm[1], 10);
        else if (xm) w = Math.round(parseFloat(xm[1]) * 1000);
        if (w >= bestW) {
          bestW = w;
          best = url;
        }
      }
      if (best) return abs(best);
    }
    let direct = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
    if (/^data:/.test(direct)) {
      direct =
        img.getAttribute('data-src') ||
        img.getAttribute('data-lazy-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-actual-src') ||
        '';
    }
    return abs(direct || '');
  }

  // ------------------------------------------------------------ platform

  function detectPlatform() {
    const gen = (document.querySelector('meta[name="generator"]') || {}).content || '';
    const bodyCls = document.body ? document.body.className : '';
    if (
      /\belementor-page\b/.test(bodyCls) ||
      document.querySelector('[data-elementor-type]') ||
      /Elementor/i.test(gen)
    ) {
      return 'elementor';
    }
    const html = document.documentElement;
    if (
      html.hasAttribute('data-wf-site') ||
      html.hasAttribute('data-wf-page') ||
      /Webflow/i.test(gen) ||
      document.querySelector('script[src*="assets.website-files.com"]')
    ) {
      return 'webflow';
    }
    if (
      /WordPress/i.test(gen) ||
      document.querySelector('link[href*="wp-content"]') ||
      document.querySelector('script[src*="wp-content"]')
    ) {
      return 'wordpress';
    }
    return 'generic';
  }

  // ------------------------------------------------------------ links & nav

  function normalizePageUrl(href) {
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:|sms:)/i.test(href)) return '';
    let u;
    try {
      u = new URL(href, location.href);
    } catch (e) {
      return '';
    }
    if (u.origin !== location.origin) return '';
    if (SKIP_LINK_EXT.test(u.pathname)) return '';
    u.hash = '';
    return u.href;
  }

  function discoverLinks() {
    const seen = new Set([location.href.split('#')[0]]);
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const url = normalizePageUrl(a.getAttribute('href'));
      if (!url) continue;
      const norm = url.replace(/\/+$/, '');
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({ url, text: (a.textContent || '').trim().slice(0, 80) });
      if (out.length >= 12) break;
    }
    return out;
  }

  function navLinksFrom(host) {
    const seen = new Set();
    const out = [];
    for (const a of host.querySelectorAll('a[href]')) {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const href = abs(a.getAttribute('href') || '');
      if (!text || !href || !/^https?:/.test(href) || seen.has(href)) continue;
      seen.add(href);
      out.push({ text, href });
      if (out.length >= 20) break;
    }
    return out;
  }

  // ------------------------------------------------------------ classification

  function isButtonish(el, cs) {
    if (el.tagName !== 'A') return false;
    const href = el.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return false;
    const cls = typeof el.className === 'string' ? el.className : el.className.baseVal || '';
    if (BUTTON_CLASS.test(cls) || el.getAttribute('role') === 'button') return true;
    const hasBg = !isTransparent(cs.backgroundColor);
    const hasPad = px(cs.paddingTop) >= 6 && px(cs.paddingLeft) >= 10;
    return hasBg && hasPad;
  }

  function listIsNav(ul) {
    const items = [...ul.children].filter((c) => c.tagName === 'LI');
    if (items.length < 3 || items.length > 15) return false;
    const withLinks = items.filter((li) => li.querySelector('a[href]')).length;
    return withLinks / items.length >= 0.7;
  }

  function classify(el, cs) {
    const tag = el.tagName;
    if (tag === 'PICTURE') {
      return el.querySelector('img') ? 'image' : 'skip';
    }
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'IMG') return 'image';
    if (tag === 'HR') return 'divider';
    if (tag === 'VIDEO') return 'video';
    if (tag === 'IFRAME') {
      const src = el.getAttribute('src') || '';
      if (/youtube|youtu\.be|youtube-nocookie|vimeo|dailymotion/i.test(src)) return 'video';
      return 'skip';
    }
    if (tag === 'NAV') return 'navlist';
    if (tag === 'UL' || tag === 'OL') {
      return listIsNav(el) ? 'navlist' : 'list';
    }
    if (tag === 'A') {
      const img = el.querySelector('img');
      const text = (el.textContent || '').trim();
      if (img && !text) return 'image';
      if (isButtonish(el, cs)) return 'button';
      return 'text';
    }
    if (tag === 'P') return 'text';
    // A wrapper holding exactly one image (lightbox links etc).
    if (!el.children.length && (el.textContent || '').trim()) return 'text';
    const onlyTextChild =
      el.children.length > 0 &&
      [...el.children].every((c) => INLINE_RE.test(c.tagName)) &&
      (el.textContent || '').trim();
    if (onlyTextChild) return 'text';
    // Decorative wrappers that only exist for spacing → spacer.
    if (!el.textContent.trim() && !bgImageUrl(cs.backgroundImage) && !el.querySelector('img,video,iframe')) {
      const r = el.getBoundingClientRect();
      const hasBox = !isTransparent(cs.backgroundColor) || px(cs.borderTopWidth) > 0;
      if (!hasBox && r.height >= 8 && el.children.length === 0) return 'spacer';
    }
    return 'container';
  }

  function videoModel(el) {
    if (el.tagName === 'IFRAME') {
      const src = el.getAttribute('src') || '';
      const yt = /(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,})/.exec(src);
      if (yt) return { kind: 'video', provider: 'youtube', id: yt[1], style: snap(el) };
      const vm = /vimeo\.com\/(?:video\/)?(\d+)/.exec(src);
      if (vm) return { kind: 'video', provider: 'vimeo', id: vm[1], style: snap(el) };
      return null;
    }
    const source = el.querySelector('source');
    const src = el.currentSrc || el.src || (source && source.src) || '';
    return { kind: 'video', provider: 'hosted', url: abs(src), poster: abs(el.getAttribute('poster') || ''), style: snap(el) };
  }

  // ------------------------------------------------------------ walker

  function walk(el, depth) {
    if (!el || nodeCount >= MAX_NODES || depth > 9) return null;
    if (SKIP_TAGS.has(el.tagName)) return null;
    const cs = getComputedStyle(el);
    if (isHidden(el, cs)) return null;

    const kind = classify(el, cs);
    if (kind === 'skip') {
      return null;
    }
    if (kind === 'spacer') {
      nodeCount++;
      return { kind: 'spacer', height: Math.round(el.getBoundingClientRect().height), style: snap(el) };
    }
    nodeCount++;
    const style = snap(el);

    switch (kind) {
      case 'heading': {
        return { kind, level: parseInt(el.tagName[1], 10), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500), style };
      }
      case 'text': {
        let html = cleanHtml(el);
        if (el.tagName === 'A' && el.href) {
          html = '<a href="' + escapeHtml(el.href) + '">' + html + '</a>';
        }
        return { kind, html, style };
      }
      case 'image': {
        const src = bestSrc(el);
        addAsset(src);
        return { kind, src, href: el.closest && el.closest('a[href]') ? el.closest('a[href]').href : '', style };
      }
      case 'button': {
        return { kind, text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200), href: el.href || abs(el.getAttribute('href') || '#'), style };
      }
      case 'video': {
        const m = videoModel(el);
        if (m && m.url) addAsset(m.url);
        return m;
      }
      case 'navlist': {
        return { kind, items: navLinksFrom(el), style };
      }
      case 'list': {
        const items = [...el.children]
          .filter((li) => li.tagName === 'LI')
          .map((li) => ({
            text: (li.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
            href: li.querySelector('a[href]') ? li.querySelector('a[href]').href : '',
          }))
          .filter((it) => it.text);
        if (!items.length) return { kind: 'text', html: cleanHtml(el), style };
        return { kind, items, style };
      }
    }

    // container
    const children = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const t = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 1) children.push({ kind: 'text', html: escapeHtml(t), style });
      } else if (child.nodeType === 1) {
        const m = walk(child, depth + 1);
        if (m) children.push(m);
      }
    }
    const bg = bgImageUrl(style.backgroundImage);
    if (bg) addAsset(bg);
    if (!children.length && !bg) return null;
    return { kind: 'container', tag: el.tagName.toLowerCase(), style, children };
  }

  // ------------------------------------------------------------ header / footer / body

  function pickRoot(selectors) {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isHidden(el, getComputedStyle(el))) return el;
      }
    }
    return null;
  }

  const headerEl = pickRoot(['header', '[role="banner"]', '.site-header', '#site-header', '#header', '.header']);
  const footerEl = pickRoot(['footer', '[role="contentinfo"]', '.site-footer', '#site-footer', '#footer', '.footer']);

  const headerModel = headerEl ? walk(headerEl, 1) : null;
  const footerModel = footerEl ? walk(footerEl, 1) : null;

  const navHost = headerEl ? headerEl.querySelector('nav') || headerEl : document.querySelector('nav');
  const navLinks = navHost ? navLinksFrom(navHost) : [];

  const bodyChildren = [];
  for (const child of document.body.children) {
    if (headerEl && (child === headerEl || headerEl.contains(child))) continue;
    if (footerEl && (child === footerEl || footerEl.contains(child))) continue;
    const m = walk(child, 1);
    if (m) bodyChildren.push(m);
  }

  const og = document.querySelector('meta[property="og:image"]');
  if (og && og.content) addAsset(abs(og.content));

  const bodyCs = getComputedStyle(document.body);
  const h1 = document.querySelector('h1');

  function slugFromUrl(u) {
    try {
      const segs = new URL(u).pathname.split('/').filter(Boolean);
      const last = segs.length ? segs[segs.length - 1] : 'home';
      const s = last
        .replace(/\.[a-z0-9]+$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return s || 'home';
    } catch (e) {
      return 'home';
    }
  }

  return {
    url: location.href.split('#')[0],
    title: document.title || '',
    description: (document.querySelector('meta[name="description"]') || {}).content || '',
    slug: slugFromUrl(location.href),
    platform: detectPlatform(),
    links: discoverLinks(),
    assets: Array.from(assetSet),
    header: headerModel,
    footer: footerModel,
    navLinks,
    globalStyles: {
      bodyBackground: isTransparent(bodyCs.backgroundColor) ? '' : bodyCs.backgroundColor,
      bodyColor: bodyCs.color,
      bodyFontFamily: String(bodyCs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
      bodyFontSize: px(bodyCs.fontSize),
      headingColor: h1 ? getComputedStyle(h1).color : '',
    },
    body: bodyChildren,
  };
}

// Progressive scroll + quiescence detection. Scroll in ~0.9-viewport steps to
// trigger lazy loaders, then wait until DOM mutations AND network activity
// stop (or a hard deadline passes), then scroll back to top for analysis.
// Self-contained like analyzePage — Chrome serializes it for injection.
export function scrollAndSettle(opts) {
  const STEP_MS = (opts && opts.stepMs) || 350;
  const QUIET_MS = (opts && opts.quietMs) || 600;
  const DEADLINE_MS = (opts && opts.deadlineMs) || 12000;
  const MAX_SCREENS = 12;
  const start = Date.now();
  return new Promise((resolve) => {
    let lastMutation = Date.now();
    let lastResources = performance.getEntriesByType('resource').length;
    const mo = new MutationObserver(() => {
      lastMutation = Date.now();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    let screens = 0;
    let lastY = -1;
    (function step() {
      const y = window.scrollY;
      const atBottom = window.innerHeight + y >= document.documentElement.scrollHeight - 2;
      const noProgress = y === lastY;
      if (
        Date.now() - start > DEADLINE_MS ||
        screens >= MAX_SCREENS ||
        (screens > 0 && (atBottom || noProgress))
      ) {
        return finish();
      }
      lastY = y;
      window.scrollTo(0, y + Math.round(window.innerHeight * 0.9));
      screens++;
      setTimeout(step, STEP_MS);
    })();
    function finish() {
      (async () => {
        try {
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
        } catch (e) {
          /* font API unavailable */
        }
        const hardStop = Date.now() + 3000;
        while (Date.now() - lastMutation < QUIET_MS && Date.now() < hardStop) {
          const n = performance.getEntriesByType('resource').length;
          if (n !== lastResources) {
            lastResources = n;
            lastMutation = Date.now();
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        mo.disconnect();
        window.scrollTo(0, 0); // restore top so sticky headers/fixed nav aren't duplicated
        setTimeout(() => resolve({ ms: Date.now() - start, screens }), 250);
      })();
    }
  });
}
