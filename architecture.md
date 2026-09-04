# Site Rebuilder — Architecture

This document summarizes the architecture of the Site Rebuilder project (Chrome extension + WordPress importer), describes key components and data contracts, and lists important design decisions and prioritized improvements.

## Overview

- Purpose: analyze a public website in a real browser, convert its DOM + computed styles into editable Elementor JSON, package the site and assets into a ZIP, and import that package into WordPress as editable pages, header/footer templates and media.
- Two runtimes:
  - Chrome extension (MV3): analysis, conversion, asset download, packaging, ZIP export.
  - WordPress plugin: package extraction, media import, page/template creation and batch import runner.

Top-level layout:

```
wordpress-copier/
├─ extension/                # Chrome MV3 extension
│  ├─ manifest.json
│  ├─ background.js          # service worker orchestrator
│  ├─ popup.html, popup.js   # UI
│  └─ content/analyzer.js    # injected page analyzer
│  └─ lib/elementor.js       # model -> Elementor mapper
│  └─ lib/zip.js             # tiny ZIP writer
├─ wp-plugin/
│  └─ site-rebuilder-importer/  # PHP plugin
│     ├─ site-rebuilder-importer.php
│     └─ includes/
│        ├─ class-sri-package.php
│        ├─ class-sri-media.php
│        └─ class-sri-importer.php
├─ samples/test-site/
└─ tests/
```

## Components & Responsibilities

- `extension/background.js`
  - Orchestrates analysis and rebuild flows, persists UI state to `chrome.storage.local`, handles asset downloads, calls model→Elementor conversion and builds the ZIP.
- `extension/popup.js` + `popup.html`
  - Thin UI that renders the state saved by the service worker and issues user commands (analyze, rebuild, download).
- `extension/content/analyzer.js`
  - Self-contained function injected into a target tab via `chrome.scripting.executeScript`. Walks the live DOM, snapshots computed styles, classifies nodes and emits a JSON-safe page model.
- `extension/lib/elementor.js`
  - Pure mapping functions converting the analyzer page model into Elementor element JSON (containers + widgets).
- `extension/lib/zip.js`
  - Minimal ZIP writer (STORE method) used to build the export package in the extension.
- `wp-plugin/site-rebuilder-importer/*`
  - `class-sri-package.php`: extracts uploaded ZIP into a unique directory and builds the import job object.
  - `class-sri-media.php`: imports package assets into the WP Media Library and caches path→URL mappings.
  - `class-sri-importer.php`: implements a step-by-step batch runner (AJAX `sri_step`) that creates templates/pages, maps assets, applies styles and builds navigation.

## Communication & Protocols

- Extension internal channels:
  - Popup ↔ Service worker: `chrome.runtime.sendMessage()` (commands) and `chrome.storage.local` (state). Popup subscribes to `chrome.storage.onChanged`.
  - Service worker ↔ Tab: `chrome.tabs.create()` / `chrome.scripting.executeScript()` to inject `analyzePage()` and receive the page model.
  - Service worker maintains an internal `queue` promise to serialize state updates.
- Serialization:
  - Page model → cross-context result: JSON-safe objects (structured-clone compatible). No DOM nodes or platform functions cross the boundary.
  - Package manifest: `package.json` (JSON) inside ZIP; this is the canonical interchange format between browser and PHP importer.
  - ZIP contents: `package.json` + `assets/<hash>.<ext>` files.
  - ZIP is encoded to base64 in the existing flow (`zipB64`) for storage/transfer to the popup; this is flagged as a memory/scale bottleneck in improvements.

## Data Contracts

The project’s architecture depends on three major data contracts.

### Page Model (canonical)

The analyzer in `extension/content/analyzer.js` returns a page model with these fields:

- `url`: canonical page URL without hash.
- `title`: document title.
- `description`: meta description if present.
- `slug`: derived from URL path.
- `platform`: one of `elementor`, `webflow`, `wordpress`, `generic`.
- `links`: up to 12 internal page links as `{ url, text }`.
- `assets`: absolute asset URLs collected from images, background images, videos, and og:image.
- `header`: tree model for detected header root, or null.
- `footer`: tree model for detected footer root, or null.
- `navLinks`: navigation candidates extracted from the primary nav host.
- `globalStyles`: a small style summary with body and heading colors/fonts.
- `body`: array of top-level content node models.

Each node in `header`, `footer`, or `body` is a recursive model with a `kind` and kind-specific payload:

- `container`: `{ kind, tag, style, children }`
- `heading`: `{ kind, level, text, style }`
- `text`: `{ kind, html, style }`
- `image`: `{ kind, src, href, style }`
- `button`: `{ kind, text, href, style }`
- `list` / `navlist`: `{ kind, items, style }`
- `divider`: `{ kind, style }`
- `spacer`: `{ kind, height, style }`
- `video`: provider-specific payload like `{ kind, provider, id, style }` or hosted video URLs

That is the contract between DOM analysis and conversion.

### Site Package Schema

The ZIP package assembled by `extension/background.js` has a very specific structure:

- `package.json` at the ZIP root is the manifest.
- `assets/` contains deduplicated binary assets downloaded from the source site.
- No other runtime metadata is required for import.

The manifest object written to `package.json` has these fields:

- `format`: always `site-rebuilder/1`.
- `generatedAt`: ISO timestamp.
- `source`: `{ url, platform }`.
- `siteStyles`: copied from the analyzer’s `globalStyles`.
- `navigation`: copied from the analyzer’s `navLinks`.
- `assets`: index mapping `assets/<hashed-file>` to `{ url, mime }`.
- `header`: array containing one Elementor root element, or null.
- `footer`: array containing one Elementor root element, or null.
- `pages`: array of page records, each with:
  - `title`
  - `slug`
  - `sourceUrl`
  - `elements`: Elementor element tree

### WordPress Job State

The plugin stores import progress in the WordPress options table under `SRI_OPTION_JOB` (`sri_job`). The shape created in `class-sri-package.php` is:

- `dir`: absolute extracted package directory inside uploads.
- `package`: decoded package manifest array.
- `map`: package asset path → Media Library URL.
- `templates`: which → template post ID.
- `results`: per-step results for the admin UI.
- `created`: Unix timestamp.

There is also `SRI_OPTION_TEMPLATES` (`sri_template_ids`) for header/footer IDs and `SRI_OPTION_INJECT` (`sri_inject_header_footer`).

The browser-to-PHP serialization bridge is JSON via `package.json`.

## State Management & Persistence

- Extension:
  - `chrome.storage.local` persists the UI-visible state object (phase, pages[], progress, zipB64, log, summary). Internal promises and ephemeral variables manage concurrent tasks.
  - Current implementation stores the ZIP as base64 in storage — this is a known scalability issue.
- WordPress:
  - `get_option()` / `update_option()` store the job state; uploads and extracted package files live under `wp-content/uploads/sri-import-*`.
  - Post types, attachments and meta store created pages and Elementor JSON (`_elementor_data`).

## Security Architecture

- Extension permissions: MV3 manifest requests `tabs`, `scripting`, `storage`, `downloads`, `unlimitedStorage` and `host_permissions` `<all_urls>`.
- The analyzer runs in the page context and returns JSON-safe data. Asset fetches from the extension use `credentials: 'omit'`.
- WordPress plugin defenses: capability checks, nonces, sanitization functions and defensive path checks for filesystem operations.

## Design Patterns & Trade-offs

- Patterns observed:
  - Step-by-step AJAX batch runner for shared hosting (resilience over long-running PHP execution).
  - Function serialization + injection for DOM analysis (simple, portable analyzer).
  - Factory-style widget builders in `lib/elementor.js`.
  - Small repository abstraction for media import (`class-sri-media.php`).

- Trade-offs:
  - ZIP entries are stored with STORE method (no compression) for simplicity; archive size may be larger.
  - ZIP and assets are built in-memory and encoded to base64, which is simple but memory-expensive.
  - Heuristic DOM classification provides editable output but not pixel-perfect fidelity.

## Failure Handling & Resilience

- Extension handles asset failures by keeping remote URLs in the package when downloads fail.
- Analyzer has node/depth limits; very large or dynamic sites may be truncated.
- The importer is append-only and not transactional; partial imports may leave orphaned pages/assets.

## Prioritized Improvements (summary)

High priority:
1. Add `waitForStableDOM()` and bounded scrolling to `extension/content/analyzer.js`.
2. Replace base64 ZIP storage with `Blob` + `objectURL` or direct `chrome.downloads.download()` in `extension/background.js`.
3. Stage assets in IndexedDB and stream them into ZIP builder.

Medium:
4. Modularize `analyzePage()`; add component classifiers (cards, carousels, accordions).
5. Enhanced deduplication (URL + content hash).
6. Checkpointed import state and partial rollback in the WP importer.

Lower:
7. Better Elementor grid/overlay mapping in `extension/lib/elementor.js`.
8. Manifest schema validation on both sides.

## Next steps

1. Implement `waitForStableDOM()` and test on sample sites.
2. Replace `zipB64` storage with object URL download flow.
3. Add IndexedDB asset staging.

---
For implementation guidance and code snippets, see the project files under `extension/` and `wp-plugin/site-rebuilder-importer/`.
