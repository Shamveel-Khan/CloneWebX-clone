// Builds a realistic Site Rebuilder package (ZIP) using the REAL extension
// builders (lib/elementor.js + lib/zip.js) — used for the WordPress E2E test.
// Run: node tests/make-fixture-package.mjs <output-zip-path>

import { buildZip, utf8Bytes } from '../extension/lib/zip.js';
import { modelToElementor, nodeToElementor } from '../extension/lib/elementor.js';
import { readFileSync } from 'node:fs';

const outPath = process.argv[2] || '/tmp/sr-test-package.zip';

// A hero model as the analyzer would emit it (absolute asset URLs).
const heroSection = {
  kind: 'container',
  tag: 'section',
  style: {
    display: 'block',
    paddingTop: '110px', paddingRight: '24px', paddingBottom: '110px', paddingLeft: '24px',
    backgroundColor: 'rgb(255, 255, 255)',
    backgroundImage: 'url("https://src.example/assets/hero.svg")',
    backgroundSize: 'cover', backgroundPosition: 'center center', backgroundRepeat: 'no-repeat',
    minHeight: '420px', marginTop: '0px', marginBottom: '0px', marginLeft: '0px', marginRight: '0px',
  },
  children: [
    {
      kind: 'container', tag: 'div', style: { display: 'block' },
      children: [
        { kind: 'heading', level: 1, text: 'We design websites that ship fast', style: { fontSize: '52px', fontWeight: '800', fontFamily: 'Inter', lineHeight: '57.2px', color: 'rgb(20, 23, 43)', textAlign: 'left' } },
        { kind: 'text', html: 'Acme Studio is a small team of designers and engineers.', style: { fontSize: '19px', color: 'rgb(60, 66, 88)' } },
        { kind: 'button', text: 'Start a project', href: 'https://src.example/about', style: { backgroundColor: 'rgb(79, 70, 229)', color: 'rgb(255, 255, 255)', paddingTop: '13px', paddingLeft: '26px', fontSize: '16px', fontWeight: '600' } },
      ],
    },
  ],
};

const featuresSection = {
  kind: 'container',
  tag: 'section',
  style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', rowGap: '24px', columnGap: '32px', backgroundColor: 'rgb(246, 247, 251)', paddingTop: '72px', paddingBottom: '72px' },
  children: ['Strategy first', 'Design systems', 'Performance built in'].map((t, i) => ({
    kind: 'container', tag: 'div', style: { display: 'block', backgroundColor: 'rgb(255, 255, 255)', paddingTop: '26px', paddingBottom: '26px', paddingLeft: '26px', paddingRight: '26px' },
    children: [
      { kind: 'heading', level: 3, text: t, style: { fontSize: '20px', fontWeight: '700', fontFamily: 'Inter' } },
      { kind: 'text', html: 'Card number ' + (i + 1) + ' describing what we do for teams.', style: { fontSize: '16px', color: 'rgb(91, 100, 120)' } },
    ],
  })),
};

const imageSection = {
  kind: 'container', tag: 'section', style: { display: 'flex', flexDirection: 'row', paddingTop: '80px', paddingBottom: '80px' },
  children: [
    { kind: 'image', src: 'https://src.example/assets/hero.svg', href: '', style: { display: 'block' } },
    { kind: 'container', tag: 'div', style: { display: 'block' }, children: [
      { kind: 'heading', level: 2, text: 'Selected work', style: { fontSize: '34px', fontWeight: '800', fontFamily: 'Inter' } },
      { kind: 'list', items: [{ text: 'Northwind storefront', href: 'https://src.example/about' }, { text: 'Kite marketing site', href: 'https://src.example/about' }], style: {} },
    ] },
  ],
};

const navModel = {
  kind: 'container', tag: 'header', style: { display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: '14px', paddingBottom: '14px', backgroundColor: 'rgb(255, 255, 255)' },
  children: [
    { kind: 'navlist', items: [{ text: 'Home', href: 'https://src.example/' }, { text: 'About', href: 'https://src.example/about' }, { text: 'Work', href: 'https://src.example/#work' }], style: {} },
  ],
};

const footerModel = {
  kind: 'container', tag: 'footer', style: { display: 'flex', flexDirection: 'row', paddingTop: '48px', paddingBottom: '48px', backgroundColor: 'rgb(16, 20, 42)', color: 'rgb(200, 205, 228)' },
  children: [
    { kind: 'navlist', items: [{ text: 'About us', href: 'https://src.example/about' }, { text: 'Contact', href: 'https://src.example/about#contact' }, { text: 'Twitter', href: 'https://example.com/twitter' }], style: {} },
  ],
};

const resolve = (url) => (url === 'https://src.example/assets/hero.svg' ? ASSET_PATH : url);
const ASSET_PATH = 'assets/7c1f4a2b-hero.svg';

const home = modelToElementor({ body: [heroSection, featuresSection, imageSection] }, resolve);
const about = modelToElementor({ body: [heroSection] }, resolve);

const pkg = {
  format: 'site-rebuilder/1',
  generatedAt: new Date().toISOString(),
  source: { url: 'https://src.example/', platform: 'generic' },
  siteStyles: {
    bodyBackground: 'rgb(255, 255, 255)',
    bodyColor: 'rgb(29, 35, 51)',
    bodyFontFamily: 'Inter',
    bodyFontSize: 16,
    headingColor: 'rgb(20, 23, 43)',
  },
  navigation: [
    { text: 'Home', href: 'https://src.example/' },
    { text: 'About', href: 'https://src.example/about' },
  ],
  assets: {
    [ASSET_PATH]: { url: 'https://src.example/assets/hero.svg', mime: 'image/svg+xml' },
  },
  header: [nodeToElementor(navModel, resolve)],
  footer: [nodeToElementor(footerModel, resolve)],
  pages: [
    { title: 'Home', slug: 'home', sourceUrl: 'https://src.example/', elements: home.elements },
    { title: 'About', slug: 'about', sourceUrl: 'https://src.example/about', elements: about.elements },
  ],
};

const svgBytes = new Uint8Array(
  readFileSync(new URL('../samples/test-site/assets/hero.svg', import.meta.url))
);

const blob = buildZip([
  { name: 'package.json', data: utf8Bytes(JSON.stringify(pkg, null, 2)) },
  { name: ASSET_PATH, data: svgBytes },
]);

const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, Buffer.from(await blob.arrayBuffer()));
console.log(`package written: ${outPath} (${pkg.pages.length} pages, 1 asset)`);
