// Tests for lib/elementor.js — style mapping + model→Elementor conversion.
// Run: node tests/test-elementor.mjs

import {
  elId, container, widget,
  mapTypography, mapBackground, backgroundImageUrl, containerSettings,
  headingWidget, textWidget, buttonWidget, imageWidget, listWidget, videoWidget,
  modelToElementor, nodeToElementor,
} from '../extension/lib/elementor.js';

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log('  ok — ' + label);
  } else {
    failures++;
    console.error('  FAIL — ' + label);
  }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  assert(same, label + (same ? '' : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`));
}

// ---------------------------------------------------------------- ids & builders

console.log('ids & builders:');
const ids = new Set(Array.from({ length: 500 }, elId));
assert(ids.size === 500, 'ids are unique across 500 calls');
assert([...ids].every((id) => /^[0-9a-f]{7}$/.test(id)), 'ids are 7 hex chars');

const c = container({ flex_direction: 'column' }, [widget('heading', { title: 'X' })]);
assert(c.elType === 'container' && c.isInner === false && Array.isArray(c.elements), 'container shape');
const w = widget('text-editor');
assert(w.elType === 'widget' && w.widgetType === 'text-editor' && Array.isArray(w.elements), 'widget shape');

// ---------------------------------------------------------------- typography

console.log('typography mapping:');
const typo = mapTypography({
  fontFamily: '"Inter", system-ui, sans-serif',
  fontSize: '32px',
  fontWeight: '700',
  lineHeight: '38.4px',
  letterSpacing: 'normal',
  textTransform: 'uppercase',
});
eq(typo.typography_font_family, 'Inter', 'font family unquoted, first of stack');
eq(typo.typography_font_size, { unit: 'px', size: 32, sizes: [] }, 'font size');
eq(typo.typography_font_weight, '700', 'font weight');
eq(typo.typography_line_height, { unit: 'em', size: 1.2, sizes: [] }, 'line height as em ratio');
eq(typo.typography_text_transform, 'uppercase', 'text transform');
assert(!('typography_letter_spacing' in typo), 'normal letter-spacing omitted');

const minimal = mapTypography({ fontSize: '16px', fontWeight: '400', lineHeight: 'normal' });
assert(minimal.typography_font_size.size === 16, 'minimal typography keeps size');
assert(!('typography_line_height' in minimal), 'normal line height omitted');

// ---------------------------------------------------------------- background

console.log('background mapping:');
const bg = mapBackground({
  backgroundColor: 'rgb(79, 70, 229)',
  backgroundImage: 'url("https://example.com/hero.svg")',
  backgroundSize: 'cover',
  backgroundPosition: 'center center',
  backgroundRepeat: 'no-repeat',
});
eq(bg.background_color, 'rgb(79,70,229)', 'color normalized (spaces stripped)');
eq(bg.background_background, 'classic', 'classic background type');
eq(bg.background_image, { url: 'https://example.com/hero.svg', id: '' }, 'background image url');
eq(bg.background_size, 'cover', 'background size');

const bgResolved = mapBackground(
  { backgroundImage: 'url("https://cdn.example/hero.svg")' },
  (u) => 'assets/99.svg'
);
eq(bgResolved.background_image.url, 'assets/99.svg', 'background image url passed through resolver');

const bgPlain = mapBackground({ backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' });
assert(!('background_color' in bgPlain) && !('background_image' in bgPlain), 'transparent/none background produces no settings');

eq(backgroundImageUrl('none'), '', 'none yields no url');
eq(backgroundImageUrl('url(https://a.com/x.png)'), 'https://a.com/x.png', 'unquoted url parsed');

// ---------------------------------------------------------------- container

console.log('container settings:');
const grid = containerSettings({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr 1fr',
  rowGap: '24px', columnGap: '32px',
  paddingTop: '72px', paddingRight: '24px', paddingBottom: '72px', paddingLeft: '24px',
  marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px',
  minHeight: '420px',
  backgroundColor: 'rgb(246, 247, 251)',
  backgroundImage: 'none',
}, ['container', 'container', 'container']);
eq(grid.flex_direction, 'row', 'grid with multiple columns → row container');
eq(grid.flex_direction_tablet, 'column', '3 container children → stacks on tablet');
eq(grid.padding, { unit: 'px', top: 72, right: 24, bottom: 72, left: 24, isLinked: false }, 'padding box');
eq(grid.flex_gap, { unit: 'px', size: 24, row_gap: 24, column_gap: 32, sizes: [] }, 'gap keeps distinct row/column gaps');
eq(grid.min_height, { unit: 'px', size: 420, sizes: [] }, 'min height');
eq(grid.background_color, 'rgb(246,247,251)', 'container background color');

const flexRow = containerSettings({ display: 'flex', flexDirection: 'row', justifyContent: 'space-between' }, ['text', 'text']);
eq(flexRow.flex_direction, 'row', 'flex row detected');
assert(!('flex_direction_tablet' in flexRow), 'row of leaf widgets does NOT stack on tablet');

const plain = containerSettings({ display: 'block', minHeight: '0px' }, []);
eq(plain.flex_direction, 'column', 'default stacks vertically');
assert(!('padding' in plain) && !('margin' in plain) && !('min_height' in plain), 'empty spacing omitted');

// ---------------------------------------------------------------- widgets

console.log('widgets:');
const h = headingWidget({ level: 1, text: 'We design websites', style: { fontSize: '52px', fontWeight: '800', color: 'rgb(20, 23, 43)', textAlign: 'center', lineHeight: '57.2px', fontFamily: 'Inter' } });
assert(h.widgetType === 'heading', 'heading widget type');
eq(h.settings.header_size, 'h1', 'heading level → header_size');
eq(h.settings.title_color, 'rgb(20,23,43)', 'heading color');
eq(h.settings.align, 'center', 'heading align');
assert(h.settings.typography_font_size_mobile.size === 34, 'big headings scale down on mobile');

const p = textWidget({ html: 'Hello <strong>world</strong>', style: { fontSize: '16px', color: 'rgb(60, 66, 88)' } });
assert(p.widgetType === 'text-editor', 'text widget type');
eq(p.settings.editor, '<p>Hello <strong>world</strong></p>', 'inline html wrapped in <p>');
eq(p.settings.text_color, 'rgb(60,66,88)', 'text color');

const pBlock = textWidget({ html: '<ul><li>a</li></ul>', style: {} });
eq(pBlock.settings.editor, '<ul><li>a</li></ul>', 'block html not double-wrapped');

const btn = buttonWidget({ text: 'Start a project', href: 'https://example.com/start', style: { backgroundColor: 'rgb(79, 70, 229)', color: 'rgb(255, 255, 255)', paddingTop: '13px', paddingLeft: '26px', borderTopLeftRadius: '8px', borderTopRightRadius: '8px', borderBottomRightRadius: '8px', borderBottomLeftRadius: '8px', fontSize: '16px', fontWeight: '600' } });
assert(btn.widgetType === 'button', 'button widget type');
eq(btn.settings.text, 'Start a project', 'button label');
eq(btn.settings.link, { url: 'https://example.com/start', is_external: '', nofollow: '', custom_attributes: '' }, 'button link');
eq(btn.settings.background_color, 'rgb(79,70,229)', 'button background');
eq(btn.settings.border_radius.top, 8, 'button radius');

const img = imageWidget({ src: 'assets/abc.png' }, (u) => 'assets/resolved-' + u);
eq(img.settings.image, { url: 'assets/resolved-assets/abc.png', id: '' }, 'image url passed through resolver');

const list = listWidget({ items: [{ text: 'Home', href: 'https://x/' }, { text: 'About', href: 'https://x/about' }] });
assert(list.widgetType === 'icon-list', 'list → icon-list widget');
eq(list.settings.icon_list.length, 2, 'icon-list items count');
eq(list.settings.icon_list[0].link.url, 'https://x/', 'icon-list item link');

eq(videoWidget({ provider: 'youtube', id: 'dQw4w9WgXcQ' }).settings.video_type, 'youtube', 'youtube video');
eq(videoWidget({ provider: 'youtube', id: 'dQw4w9WgXcQ' }).settings.link, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube link');
eq(videoWidget({ provider: 'vimeo', id: '12345' }).settings.link, 'https://vimeo.com/12345', 'vimeo link');
const hosted = videoWidget({ provider: 'hosted', url: 'assets/movie.mp4' }, (u) => 'remote/' + u);
eq(hosted.settings.host_link.url, 'remote/assets/movie.mp4', 'hosted video resolved');

// ---------------------------------------------------------------- full model

console.log('model → elementor conversion:');
const model = {
  body: [
    {
      kind: 'container', tag: 'section',
      style: { display: 'block', paddingTop: '110px', paddingBottom: '110px', backgroundColor: 'rgb(255,255,255)', backgroundImage: 'url("https://src.example/hero.svg")', backgroundSize: 'cover', minHeight: '420px' },
      children: [
        { kind: 'container', tag: 'div', style: { display: 'block' }, children: [
          { kind: 'heading', level: 1, text: 'We design websites that ship fast', style: { fontSize: '52px', fontWeight: '800', fontFamily: 'Inter', lineHeight: '57.2px', color: 'rgb(20,23,43)', textAlign: 'left' } },
          { kind: 'text', html: 'Acme Studio is a small team.', style: { fontSize: '19px', color: 'rgb(60,66,88)' } },
          { kind: 'button', text: 'Start a project', href: 'about.html', style: { backgroundColor: 'rgb(79,70,229)', color: 'rgb(255,255,255)' } },
        ] },
      ],
    },
    {
      kind: 'container', tag: 'section',
      style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', rowGap: '32px' },
      children: [
        { kind: 'container', tag: 'div', style: { display: 'block' }, children: [ { kind: 'heading', level: 3, text: 'One', style: { fontSize: '20px', fontWeight: '700' } } ] },
        { kind: 'container', tag: 'div', style: { display: 'block' }, children: [ { kind: 'heading', level: 3, text: 'Two', style: { fontSize: '20px', fontWeight: '700' } } ] },
        { kind: 'container', tag: 'div', style: { display: 'block' }, children: [ { kind: 'heading', level: 3, text: 'Three', style: { fontSize: '20px', fontWeight: '700' } } ] },
      ],
    },
    { kind: 'navlist', items: [{ text: 'Home', href: 'index.html' }, { text: 'About', href: 'about.html' }], style: {} },
  ],
};

const { elements } = modelToElementor(model, (u) => 'PKG:' + u);
assert(Array.isArray(elements) && elements.length === 3, 'three top-level elements');
assert(elements.every((e) => /^[0-9a-f]{7}$/.test(e.id)), 'every top-level element has an id');
assert(elements.slice(0, 2).every((e) => e.elType === 'container'), 'sections become containers');
assert(elements[2].elType === 'widget', 'top-level navlist becomes a widget');

const hero = elements[0];
eq(hero.settings.background_image.url, 'PKG:https://src.example/hero.svg', 'hero background resolved via resolver');
eq(hero.settings.min_height.size, 420, 'hero min-height');
const heroInner = hero.elements[0];
assert(heroInner.elType === 'container', 'hero inner container');
eq(heroInner.elements.map((e) => e.widgetType), ['heading', 'text-editor', 'button'], 'hero children are heading, text, button widgets');

const features = elements[1];
eq(features.settings.flex_direction, 'row', '3-col grid becomes row');
eq(features.settings.flex_direction_tablet, 'column', '3-col grid stacks on tablet');

assert(elements[2].widgetType === 'icon-list', 'navlist becomes icon-list');

// header conversion
const headerEl = nodeToElementor(model.body[2], (u) => u);
assert(headerEl && headerEl.widgetType === 'icon-list', 'nodeToElementor converts a single node');

// every widget node has required fields
const all = [];
(function collect(n) { all.push(n); (n.elements || []).forEach(collect); })(container({}, elements));
assert(all.every((e) => e.id && e.elType && e.settings), 'every element has id, elType, settings');
assert(all.filter((e) => e.elType === 'widget').every((e) => typeof e.widgetType === 'string'), 'every widget has widgetType');

if (failures) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nall elementor tests passed');
