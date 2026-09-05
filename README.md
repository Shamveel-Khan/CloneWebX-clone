# Site Rebuilder

Analyze any public website and rebuild it as an **editable Elementor WordPress site**.

Two parts, no build step, no dependencies:

| Part | What it does |
|---|---|
| **Chrome extension** (`extension/`) | Paste a URL → it opens the site in hidden tabs, measures real layout/typography/colors, downloads the images, converts everything to Elementor JSON and exports a ZIP package. |
| **WordPress plugin** (`wp-plugin/site-rebuilder-importer/`) | Upload that ZIP in wp-admin → it creates real WordPress pages, imports images into the Media Library, registers header/footer templates and global styles — all editable in Elementor. |

---

## Quick start

### 1. Install the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder

### 2. Rebuild a site

1. Click the **Site Rebuilder** icon
2. Paste a website URL (e.g. `https://example.com`)
3. Choose how many internal pages to rebuild (1–10, default 5)
4. Click **Analyze site** — you'll see the detected platform (Webflow / Elementor / WordPress / generic), pages found and assets found
5. Click **Rebuild as Elementor** — progress shows each page being analyzed and each asset downloaded
6. Click **Download ZIP** when done

### 3. Import into WordPress

1. Install the free **Elementor** plugin (Elementor ≥ 3.16 recommended)
2. Zip `wp-plugin/site-rebuilder-importer/` (or use the ready-made `site-rebuilder-importer.zip` in the repo root)
3. In wp-admin: **Plugins → Add New → Upload Plugin** → activate
4. Go to **Tools → Site Rebuilder** → upload the package ZIP → wait for the progress bar to finish (runs one page per request, so it's safe on shared hosting)
5. Open **Pages** → any imported page → **Edit with Elementor** — every heading, text block, button, image and container is a separate editable element

To try it end-to-end locally: serve the sample site with `python3 -m http.server 8000 --directory samples/test-site`, rebuild `http://localhost:8000/`, and import the ZIP into any WordPress (e.g. via [Local](https://localwp.com) or Docker).

---

## How the conversion works

1. **Analysis** (`extension/content/analyzer.js`) runs inside a fully rendered hidden tab, so it measures the same computed styles you see: fonts, colors, padding, margins, backgrounds, flex/grid layout, radii, min-heights.
2. A recursive DOM walk classifies each visible node — headings, paragraphs, images, buttons, lists, videos, dividers, spacers, containers — and records its style snapshot.
3. **Conversion** (`extension/lib/elementor.js`) maps those nodes to modern **Flexbox Container** Elementor JSON:
   - `<h1>`–`<h6>` → `heading` widget (level, color, font family/size/weight, mobile font scaling)
   - paragraphs / text blocks → `text-editor` widget (inline links & bold preserved)
   - `<img>` → `image` widget (URL rewritten to the packaged asset)
   - button-like `<a>` (background + padding or `.btn` classes) → `button` widget
   - `<section>` / layout `<div>` → `container` with background image/color, padding, gap, min-height
   - CSS grid / flex rows with 2+ container children → row container that **stacks on tablet** (responsive heuristic)
   - `<nav>` / link lists → `icon-list` widget (Elementor's `nav-menu` is Pro-only, so it's avoided)
   - YouTube/Vimeo iframes & `<video>` → `video` widget
   - `<hr>` / empty spacer divs → `divider` / `spacer`
4. **Packaging** (`extension/background.js` + `extension/lib/zip.js`): images are fetched, deduplicated and stored in the ZIP; a `package.json` holds the Elementor trees for each page plus header/footer/global styles.
5. **Import** (PHP): one AJAX step per page → `wp_insert_post` + Elementor meta (`_elementor_data`, `_elementor_edit_mode`, template `elementor_header_footer`) + Media Library sideloading with URL rewriting.

### Platform detection

| Platform | Signals |
|---|---|
| Elementor | `body.elementor-page`, `[data-elementor-type]`, generator meta |
| Webflow | `data-wf-site` / `data-wf-page` on `<html>`, `assets.website-files.com`, generator meta |
| WordPress | generator meta, `wp-content` asset URLs |
| generic | everything else |

Detection adjusts reporting and small parsing hints; one universal DOM→Elementor converter handles all sources.

### Package format

```
package.json          # format, source, platform, pages[], header, footer, siteStyles, assets index
assets/<hash>.<ext>   # deduplicated downloaded images
```

### Header & footer without Elementor Pro

Imported header/footer become editable Elementor Library templates. The plugin prints them on imported pages via `wp_body_open` / `wp_footer` and Elementor's header-footer template hooks (deduplicated guards), so you don't need Elementor Pro's Theme Builder.

---

## Testing

```
npm test            # runs: node tests/test-zip.mjs && node tests/test-elementor.mjs
```

- `test-zip.mjs` builds a real archive and verifies it with the system `unzip` (integrity, names, byte-exact round-trip).
- `test-elementor.mjs` covers style mapping and model→Elementor conversion (~60 assertions).
- `make-fixture-package.mjs` builds a sample package with the real builders — used for WordPress import testing.

PHP syntax can be linted with Docker:

```
docker run --rm -v "$PWD/wp-plugin:/src" php:8.2-cli sh -c \
  "php -l /src/site-rebuilder-importer/site-rebuilder-importer.php \
   && php -l /src/site-rebuilder-importer/includes/*.php"
```

## Shared hosting (InfinityFree) notes

- The importer batches work: **one page per AJAX request**, so PHP `max_execution_time` limits don't kill the import.
- Uses only WordPress core functions — no Composer, no shell access, no cron.
- If `unzip_file` reports FTP-credential issues, ensure `uploads/` is writable (standard on InfinityFree).
- Some very strict hosts block outbound requests; images are already inside the ZIP, so that doesn't matter.

## Known MVP limits

- Forms, e-commerce and JS interactivity are not rebuilt; menus are simple link lists.
- Animations are limited to button hover effects; source webfonts are referenced by name with system fallbacks (add the font in Elementor's settings if you have a license).
- Responsive behavior is heuristic (rows stack on tablet, large headings scale down).
- Lazy-loaded content and infinite scroll are captured via a progressive scroll + settle pass (up to 12 screens / ~15 s per page), but content that only exists via JavaScript after long delays (or virtualized lists that remove off-screen DOM) may appear as empty containers.
- Single assets over 25 MB and packages over 150 MB of assets stay as remote URLs to the original site (per-asset status is recorded in `package.json` → `assets` and `assetFallbacks`).
- Internal links between rebuilt pages keep pointing at the source site — run a find-replace (e.g. *Better Search Replace*) on `postmeta._elementor_data` if you want them remapped.
- Exported packages are stored in the extension's IndexedDB; if a download link says the package expired, just click Rebuild again.

## Project layout

```
wordpress-copier/
├── extension/                  # Chrome MV3 extension — load unpacked, no build
│   ├── manifest.json
│   ├── popup.html|css|js       # URL input, analyze, progress, download
│   ├── background.js           # orchestrator (hidden tabs, assets, ZIP)
│   ├── offscreen.html|js       # blob-URL helper for ZIP downloads (SW-safe)
│   ├── content/analyzer.js     # in-page DOM/style analysis
│   └── lib/zip.js, elementor.js
├── wp-plugin/
│   └── site-rebuilder-importer/  # dependency-free PHP 7.4+ plugin
├── samples/test-site/          # 2-page demo site for end-to-end testing
└── tests/                      # Node test suites (npm test)
```

## License

MIT
