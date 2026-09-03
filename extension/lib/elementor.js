// Elementor JSON builders + computed-style → Elementor-settings mapping.
// Pure functions, no DOM access — importable from the service worker and Node tests.
//
// Output targets modern Elementor (>= 3.16) with Flexbox Containers:
//   { id, elType: 'container'|'widget', widgetType?, settings, elements, isInner }

const HEX = '0123456789abcdef';

export function elId() {
  let s = '';
  for (let i = 0; i < 7; i++) s += HEX[Math.floor(Math.random() * 16)];
  return s;
}

export function container(settings = {}, children = []) {
  return { id: elId(), elType: 'container', settings, elements: children, isInner: false };
}

export function widget(widgetType, settings = {}) {
  return { id: elId(), elType: 'widget', widgetType, settings, elements: [], isInner: false };
}

// ---------------------------------------------------------------- number utils

export function px(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function size(v) {
  const n = px(v);
  return n ? { unit: 'px', size: n, sizes: [] } : null;
}

function anyPx(...vals) {
  return vals.some((v) => px(v) > 0);
}

function dimValue(cssColor) {
  if (!cssColor) return '';
  return String(cssColor).replace(/\s+/g, '').toLowerCase();
}

export function isTransparent(color) {
  const c = dimValue(color);
  return !c || c === 'transparent' || /^rgba\(\d+,\d+,\d+,0\)$/.test(c);
}

// ---------------------------------------------------------------- CSS mapping

/** Typography block shared by heading / text / button widgets. */
export function mapTypography(st) {
  const s = { typography_typography: 'custom' };
  const family = String(st.fontFamily || '')
    .split(',')[0]
    .replace(/["']/g, '')
    .trim();
  if (family) s.typography_font_family = family;
  const fs = size(st.fontSize);
  if (fs) s.typography_font_size = fs;
  const weight = parseInt(st.fontWeight, 10);
  if (weight && weight >= 100) s.typography_font_weight = String(weight);
  const fsPx = px(st.fontSize);
  const lhPx = px(st.lineHeight);
  if (fsPx > 0 && lhPx > 0) {
    s.typography_line_height = { unit: 'em', size: Math.round((lhPx / fsPx) * 100) / 100, sizes: [] };
  }
  const ls = size(st.letterSpacing);
  if (ls && ls.size !== 0) s.typography_letter_spacing = ls;
  if (st.textTransform && st.textTransform !== 'none') s.typography_text_transform = st.textTransform;
  return s;
}

/** Background (color + optional image) for containers. `resolve` maps asset URLs. */
export function mapBackground(st, resolve) {
  const s = {};
  const bg = st.backgroundColor;
  const img = backgroundImageUrl(st.backgroundImage);
  if (!isTransparent(bg)) {
    s.background_background = 'classic';
    s.background_color = dimValue(bg);
  }
  if (img) {
    s.background_background = 'classic';
    s.background_image = { url: resolve ? resolve(img) : img, id: '' };
    const bs = st.backgroundSize;
    s.background_size = bs === 'cover' || bs === 'contain' ? bs : 'auto';
    s.background_position = st.backgroundPosition || 'center center';
    s.background_repeat = st.backgroundRepeat === 'repeat' ? 'repeat' : 'no-repeat';
  }
  return s;
}

/** Extract an absolute image URL from a computed `backgroundImage` value. */
export function backgroundImageUrl(value) {
  if (!value || value === 'none') return '';
  const m = /url\((['"]?)(.*?)\1\)/.exec(value);
  return m && m[2] ? m[2] : '';
}

function box4(top, right, bottom, left) {
  const t = px(top);
  const r = px(right);
  const b = px(bottom);
  const l = px(left);
  if (!t && !r && !b && !l) return null;
  const isLinked = t === r && r === b && b === l;
  return { unit: 'px', top: t, right: r, bottom: b, left: l, isLinked };
}

/** Align setting; Elementor uses '' for the default left. */
export function mapAlign(textAlign) {
  if (textAlign === 'center' || textAlign === 'right' || textAlign === 'justify') return textAlign;
  return '';
}

/** Elementor settings for a container, derived from a style snapshot. */
export function containerSettings(st, childKinds = [], resolve) {
  const s = { ...mapBackground(st, resolve) };

  const pad = box4(st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft);
  if (pad) s.padding = pad;
  const mar = box4(st.marginTop, st.marginRight, st.marginBottom, st.marginLeft);
  if (mar) s.margin = mar;

  const radius = box4(
    st.borderTopLeftRadius,
    st.borderTopRightRadius,
    st.borderBottomRightRadius,
    st.borderBottomLeftRadius
  );
  if (radius) s.border_radius = radius;

  // Direction: source flex rows / CSS grids become row containers, everything
  // else stacks vertically (the common case for sections).
  const isGrid = st.display === 'grid';
  const gridCols = isGrid ? String(st.gridTemplateColumns || '').trim().split(/\s+/).filter(Boolean).length : 0;
  const srcRow = (st.flexDirection || '').startsWith('row') || gridCols > 1;
  s.flex_direction = srcRow ? 'row' : 'column';

  // Heuristic responsiveness: a row holding >= 2 nested containers is almost
  // certainly a multi-column layout → stack it on tablet.
  const containerChildren = childKinds.filter((k) => k === 'container').length;
  if (s.flex_direction === 'row' && containerChildren >= 2) {
    s.flex_direction_tablet = 'column';
  }

  const rowGap = px(st.rowGap);
  const colGap = px(st.columnGap);
  const gap = rowGap || colGap;
  if (gap) s.flex_gap = { unit: 'px', size: gap, row_gap: rowGap || gap, column_gap: colGap || gap, sizes: [] };

  if (st.alignItems && st.alignItems !== 'normal' && st.alignItems !== 'stretch') {
    s.align_items = st.alignItems;
  }
  if (st.justifyContent && st.justifyContent !== 'normal') s.justify_content = st.justifyContent;
  if (s.flex_direction === 'row' && st.flexWrap === 'wrap') s.flex_wrap = 'wrap';

  const mh = px(st.minHeight);
  if (mh > 40) s.min_height = { unit: 'px', size: mh, sizes: [] };

  return s;
}

// ---------------------------------------------------------------- widget builders

export function headingWidget(node) {
  const st = node.style || {};
  const settings = {
    title: node.text || '',
    header_size: 'h' + (node.level || 2),
    align: mapAlign(st.textAlign),
    ...mapTypography(st),
  };
  if (!isTransparent(st.color)) settings.title_color = dimValue(st.color);
  // Scale oversized headings down on mobile.
  const fsPx = px(st.fontSize);
  if (fsPx >= 32) settings.typography_font_size_mobile = { unit: 'px', size: Math.max(24, Math.round(fsPx * 0.65)), sizes: [] };
  return widget('heading', settings);
}

export function textWidget(node) {
  const st = node.style || {};
  let html = node.html || '';
  if (!/^<(p|div|ul|ol|h[1-6]|blockquote)\b/i.test(html)) html = '<p>' + html + '</p>';
  const settings = {
    editor: html,
    align: mapAlign(st.textAlign),
    ...mapTypography(st),
  };
  if (!isTransparent(st.color)) settings.text_color = dimValue(st.color);
  return widget('text-editor', settings);
}

export function imageWidget(node, resolve) {
  const url = resolve ? resolve(node.src) : node.src;
  return widget('image', {
    image: { url: url || '', id: '' },
    image_size: 'full',
  });
}

export function buttonWidget(node) {
  const st = node.style || {};
  const settings = {
    text: node.text || 'Button',
    link: { url: node.href || '#', is_external: '', nofollow: '', custom_attributes: '' },
    align: mapAlign(st.textAlign),
    hover_animation: 'grow',
    ...mapTypography(st),
  };
  if (!isTransparent(st.backgroundColor)) settings.background_color = dimValue(st.backgroundColor);
  if (!isTransparent(st.color)) settings.button_text_color = dimValue(st.color);
  const radius = box4(
    st.borderTopLeftRadius,
    st.borderTopRightRadius,
    st.borderBottomRightRadius,
    st.borderBottomLeftRadius
  );
  if (radius) settings.border_radius = radius;
  const pad = box4(st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft);
  if (pad && anyPx(st.paddingTop, st.paddingBottom)) {
    settings.padding = {
      unit: 'px',
      top: Math.max(0, px(st.paddingTop) - 0),
      right: Math.max(0, px(st.paddingRight)),
      bottom: Math.max(0, px(st.paddingBottom)),
      left: Math.max(0, px(st.paddingLeft)),
      isLinked: false,
    };
  }
  return widget('button', settings);
}

export function listWidget(node) {
  const items = (node.items || []).slice(0, 30).map((it) => ({
    _id: elId(),
    text: it.text || '',
    selected_icon: { value: 'fas fa-angle-right', library: 'fa-solid' },
    link: { url: it.href || '', is_external: '', nofollow: '', custom_attributes: '' },
  }));
  return widget('icon-list', {
    icon_list: items,
    space_between: { unit: 'px', size: 10, sizes: [] },
  });
}

export function dividerWidget(node) {
  const st = node.style || {};
  const settings = {};
  if (!isTransparent(st.borderTopColor)) settings.color = dimValue(st.borderTopColor);
  const w = px(st.borderTopWidth);
  if (w) settings.weight = { unit: 'px', size: w, sizes: [] };
  settings.width = { unit: '%', size: 100, sizes: [] };
  return widget('divider', settings);
}

export function spacerWidget(node) {
  return widget('spacer', { space: { unit: 'px', size: Math.min(Math.max(node.height || 20, 5), 400), sizes: [] } });
}

export function videoWidget(node, resolve) {
  if (node.provider === 'youtube') {
    return widget('video', { video_type: 'youtube', link: 'https://www.youtube.com/watch?v=' + node.id });
  }
  if (node.provider === 'vimeo') {
    return widget('video', { video_type: 'vimeo', link: 'https://vimeo.com/' + node.id });
  }
  return widget('video', {
    video_type: 'hosted',
    host_link: { url: resolve ? resolve(node.url) : node.url || '', id: '' },
  });
}

// ---------------------------------------------------------------- model → Elementor

function convertNode(node, resolve, depth) {
  if (!node || depth > 10) return null;
  switch (node.kind) {
    case 'heading':
      return headingWidget(node);
    case 'text':
      return textWidget(node);
    case 'image':
      return imageWidget(node, resolve);
    case 'button':
      return buttonWidget(node);
    case 'navlist':
    case 'list':
      return listWidget(node);
    case 'divider':
      return dividerWidget(node);
    case 'spacer':
      return spacerWidget(node);
    case 'video':
      return videoWidget(node, resolve);
    case 'container': {
      const children = (node.children || [])
        .map((c) => convertNode(c, resolve, depth + 1))
        .filter(Boolean);
      return container(containerSettings(node.style || {}, children.map((c) => c.elType), resolve), children);
    }
    default:
      return null;
  }
}

/**
 * Convert a page model (analyzer output) into an Elementor elements array.
 * @param {{body: Array}} model
 * @param {(url: string) => string} resolve asset url → package path / remote url
 * @returns {{elements: Array}}
 */
export function modelToElementor(model, resolve) {
  const elements = (model.body || [])
    .map((n) => convertNode(n, resolve, 0))
    .filter(Boolean);
  return { elements };
}

/** Convert a single node (header/footer model) to a root element or null. */
export function nodeToElementor(node, resolve) {
  return node ? convertNode(node, resolve, 0) : null;
}
