"""Parse HTML+CSS into an internal tree for widget mapping.

Node format matches the Playwright dom_capture output so downstream
code (widgets, containers, sections) works without changes.
"""
from __future__ import annotations
import gzip
import hashlib
import logging
import os
import re
import urllib.request
from typing import Any
from bs4 import BeautifulSoup, Tag, NavigableString
from .resolver import resolve_all

logger = logging.getLogger("html2elementor")
SKIP_TAGS = {"script", "style", "noscript", "meta", "link", "template", "head"}


def _fetch_remote_css(url: str, referer: str | None = None, cache_dir: str | None = None) -> str | None:
    """Fetch external CSS with browser headers, host fallback, and disk caching."""
    # Check cache first
    cache_file = None
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        url_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
        cache_file = os.path.join(cache_dir, f"css_{url_hash}.css")
        if os.path.isfile(cache_file):
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    return f.read()
            except Exception as e:
                logger.debug(f"Cache read error for {url}: {e}")

    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/css,*/*;q=0.1",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
    }
    if referer:
        headers["Referer"] = referer

    candidate_urls = [url]
    if "assets-global.website-files.com" in url:
        candidate_urls.append(url.replace("assets-global.website-files.com", "cdn.prod.website-files.com"))
    elif "cdn.prod.website-files.com" in url:
        candidate_urls.append(url.replace("cdn.prod.website-files.com", "assets-global.website-files.com"))

    for target_url in candidate_urls:
        try:
            req = urllib.request.Request(target_url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw_bytes = resp.read()
                # Check for gzip
                if resp.info().get("Content-Encoding") == "gzip" or (len(raw_bytes) > 2 and raw_bytes[:2] == b"\x1f\x8b"):
                    css_text = gzip.decompress(raw_bytes).decode("utf-8", errors="replace")
                else:
                    css_text = raw_bytes.decode("utf-8", errors="replace")

                # Cache result
                if cache_file and css_text:
                    try:
                        with open(cache_file, "w", encoding="utf-8") as f:
                            f.write(css_text)
                    except Exception as e:
                        logger.debug(f"Failed to write CSS cache: {e}")
                return css_text
        except Exception as e:
            logger.warning(f"Failed to fetch CSS from {target_url}: {e}")

    return None


def _sanitize_html_soup(soup: BeautifulSoup) -> None:
    """Strip template blocks, data-w-id, Webflow IX2 transforms, and commerce elements."""
    # 1. Strip <script type="text/x-wf-template"> blocks
    for t in list(soup.find_all("script", type=lambda v: v and "wf-template" in v)):
        t.decompose()

    # 2. Strip commerce elements (.w-commerce-* or data-node-type="commerce-*")
    for el in list(soup.find_all(True)):
        if not el.parent:  # already decomposed
            continue
        classes = el.get("class", [])
        classes_str = " ".join(classes) if isinstance(classes, list) else str(classes)
        node_type = str(el.get("data-node-type", ""))
        if "w-commerce-" in classes_str or node_type.startswith("commerce-"):
            el.decompose()
            continue

        # 3. Strip data-w-id
        if el.has_attr("data-w-id"):
            del el["data-w-id"]

        # 4. Strip Webflow IX2 inline transform styles
        if el.has_attr("style"):
            s = el["style"]
            if "transform:" in s:
                s_clean = re.sub(r"(-webkit-|-moz-|-ms-)?transform:[^;]+;?", "", s).strip()
                if s_clean:
                    el["style"] = s_clean
                else:
                    del el["style"]


def parse_html(html: str, html_path: str | None = None,
               extra_css: list[str] | None = None,
               no_css: bool = False) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")

    # Referer derived from <html data-wf-domain="...">
    html_tag = soup.find("html")
    wf_domain = html_tag.get("data-wf-domain") if html_tag else None
    referer = f"https://{wf_domain}/" if wf_domain else None

    # Sanitize Webflow artifacts & commerce widgets before tree traversal
    _sanitize_html_soup(soup)

    css_sources: list[str] = []

    if not no_css:
        # Inline <style> blocks
        css_sources.extend(tag.string for tag in soup.find_all("style") if tag.string)

        # Cache dir next to input HTML
        base_dir = os.path.dirname(os.path.abspath(html_path)) if html_path else None
        cache_dir = os.path.join(base_dir, ".css_cache") if base_dir else None

        # External stylesheets via <link rel="stylesheet" href="...">
        for link in soup.find_all("link", rel=lambda r: r and "stylesheet" in (r if isinstance(r, list) else [r])):
            href = link.get("href", "").strip()
            if not href:
                continue

            if href.startswith("http://") or href.startswith("https://") or href.startswith("//"):
                full_url = "https:" + href if href.startswith("//") else href
                remote_css = _fetch_remote_css(full_url, referer=referer, cache_dir=cache_dir)
                if remote_css:
                    css_sources.append(remote_css)
            elif base_dir:
                css_file = os.path.join(base_dir, href)
                if os.path.isfile(css_file):
                    try:
                        with open(css_file, "r", encoding="utf-8") as f:
                            css_sources.append(f.read())
                    except OSError as e:
                        logger.warning(f"Could not read local stylesheet {css_file}: {e}")

        # Caller-supplied extra CSS (e.g. passed via --css CLI flag)
        if extra_css:
            css_sources.extend(extra_css)

    styles_map, hover_map, tablet_map, mobile_map = resolve_all(soup, css_sources)

    body = soup.find("body") or soup
    title_tag = soup.find("title")
    title = title_tag.string.strip() if title_tag and title_tag.string else ""

    sections: list[dict] = []
    _SEMANTIC_SECTION_TAGS = {"section", "header", "footer", "nav", "main",
                               "article", "aside"}
    for child in body.children:
        if not (isinstance(child, Tag) and child.name not in SKIP_TAGS):
            continue
        node = _walk(child, styles_map, hover_map=hover_map,
                     tablet_map=tablet_map, mobile_map=mobile_map)
        if not node:
            continue
        # Semantic tags always count. Top-level <div>s only count as sections
        # when they contain substantial content (headings, paragraphs, images,
        # or card-like nested divs). Otherwise they're decorative wrappers
        # (marquees, sticky banners, skip-links) that the converter won't emit
        # as sections — and keeping them here would misalign verify's positional
        # matching between parser and layout.
        if child.name in _SEMANTIC_SECTION_TAGS:
            sections.append(node)
        elif child.name == "div":
            has_content = any(
                t.name in ("h1", "h2", "h3", "h4", "h5", "h6", "p", "img",
                           "ul", "ol", "table", "form", "figure")
                for t in child.find_all(True, recursive=True)
            )
            # Or nested divs with their own real content (card grids etc.)
            if not has_content:
                has_content = any(
                    d.name == "div" and any(
                        t.name in ("h1", "h2", "h3", "h4", "h5", "h6", "p", "img")
                        for t in d.find_all(True, recursive=True)
                    )
                    for d in child.children
                    if isinstance(d, Tag)
                )
            if has_content:
                sections.append(node)
        else:
            sections.append(node)

    body_styles = styles_map.get(id(body), {})
    page_bg = body_styles.get("background-color") or body_styles.get("background") or "#ffffff"

    return {
        "title": title,
        "url": "",
        "viewport": {"w": 1440, "h": 900},
        "pageBg": page_bg,
        "sections": sections,
        "_raw_css_sources": css_sources,
    }


def _walk(el: Tag, styles_map: dict, depth: int = 0, hover_map: dict | None = None,
          tablet_map: dict | None = None, mobile_map: dict | None = None) -> dict | None:
    if not isinstance(el, Tag):
        return None
    if el.name in SKIP_TAGS:
        return None
    if depth > 15:
        return None

    styles = styles_map.get(id(el), {})
    hover_styles = (hover_map or {}).get(id(el), {})
    tablet_styles = (tablet_map or {}).get(id(el), {})
    mobile_styles = (mobile_map or {}).get(id(el), {})

    node: dict[str, Any] = {
        "tag": el.name,
        "classes": (el.get("class") or [])[:],
        "text": _direct_text(el),
        "styles": styles,
        "hover_styles": hover_styles,
        "tablet_styles": tablet_styles,
        "mobile_styles": mobile_styles,
        "children": [],
        "_order": _child_order(el),
    }

    # Tables: preserve raw outer HTML so widgets.py can emit a complete
    # <table> via the `html` widget (Elementor Free). Rebuilding from the
    # children tree loses the tr/th/td structure.
    if el.name == "table":
        node["html"] = str(el)
    # Extract source CSS rules referencing the element's classes (and inner
    # descendants' classes) so a raw html widget can inline the exact
    # visual styling. Stored only for tables + terminal blocks.
    # Terminal/console/code blocks: complex divs with .terminal /
    # .terminal-body / monospace content that the widget mapper would
    # otherwise flatten into plain text widgets. Stash raw outer HTML so
    # downstream can emit an html widget preserving traffic lights,
    # code formatting, per-line syntax colors, etc.
    if el.name == "div":
        cls = " ".join(el.get("class") or []).lower()
        if any(k in cls for k in ("terminal", "console", "code-block", "mcpbox")):
            # Only flag the OUTER wrapper (avoid stashing on inner
            # .terminal-head / .terminal-body that would duplicate content)
            if not any(p and p.name == "div" and any(
                    k in " ".join(p.get("class") or []).lower()
                    for k in ("terminal", "console", "code-block", "mcpbox"))
                    for p in el.parents):
                node["html"] = str(el)
                node["_raw_html_block"] = True
                node["_raw_css"] = _scoped_css_for(el, styles_map)
    if el.name == "img":
        node["src"] = el.get("src", "")
        node["alt"] = el.get("alt", "")
    if el.name == "a":
        node["href"] = el.get("href", "")
    if el.name == "button":
        node["text"] = el.get_text(strip=True)
    if el.name == "input":
        node["type"] = el.get("type", "text")
        node["placeholder"] = el.get("placeholder", "")
        node["name"] = el.get("name", "")

    for child in el.children:
        if isinstance(child, Tag):
            child_node = _walk(child, styles_map, depth + 1, hover_map=hover_map,
                               tablet_map=tablet_map, mobile_map=mobile_map)
            if child_node:
                node["children"].append(child_node)

    return node


_VISUAL_PROPS = {
    "background", "background-color", "background-image",
    "color", "font-family", "font-size", "font-weight", "font-style",
    "line-height", "letter-spacing", "text-align", "text-transform",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "border", "border-radius", "border-width", "border-style", "border-color",
    "border-top", "border-top-width", "border-top-color", "border-top-style",
    "border-bottom", "border-bottom-width", "border-bottom-color", "border-bottom-style",
    "border-left", "border-left-width", "border-left-color",
    "border-right", "border-right-width", "border-right-color",
    "display", "flex-direction", "flex-wrap", "align-items", "justify-content",
    "gap", "row-gap", "column-gap", "flex", "flex-grow", "flex-shrink",
    "width", "height", "min-width", "min-height", "max-width", "max-height",
    "position", "top", "right", "bottom", "left", "z-index",
    "overflow", "white-space", "box-shadow", "opacity",
    "grid-template-columns", "grid-template-rows", "place-items",
}


def _scoped_css_for(root: Tag, styles_map: dict[int, dict]) -> str:
    """Walk root + descendants, emit CSS rules that replay the resolved
    visual styles per-element, selected by class path. Meant for raw HTML
    blocks (terminal, code viewers) so html widgets reproduce the source
    look without bundling the full stylesheet."""
    rules: list[str] = []
    seen: set[str] = set()
    stack = [root]
    while stack:
        el = stack.pop()
        if not isinstance(el, Tag):
            continue
        classes = el.get("class") or []
        if classes:
            selector = "." + ".".join(classes)
        else:
            selector = el.name
        if selector not in seen:
            styles = styles_map.get(id(el), {})
            decls = []
            for k in _VISUAL_PROPS:
                v = styles.get(k)
                if v and not str(v).startswith("var("):
                    decls.append(f"  {k}: {v};")
            if decls:
                rules.append(f"{{SCOPE}} {selector} {{\n" + "\n".join(decls) + "\n}")
            seen.add(selector)
        for child in el.children:
            if isinstance(child, Tag):
                stack.append(child)
    return "\n".join(rules)


def _direct_text(el: Tag) -> str:
    parts = []
    for child in el.children:
        if isinstance(child, NavigableString) and not isinstance(child, Tag):
            parts.append(str(child).strip())
    return " ".join(p for p in parts if p)


def _child_order(el: Tag) -> list:
    """Return interleaved list of text strings and child indices, preserving DOM order."""
    order = []
    child_idx = 0
    for item in el.children:
        if isinstance(item, NavigableString) and not isinstance(item, Tag):
            text = str(item).strip()
            if text:
                order.append(("text", text))
        elif isinstance(item, Tag):
            order.append(("child", child_idx))
            child_idx += 1
    return order
