"""CLI entry point: python3 -m html2elementor input.html -o layout.json"""
from __future__ import annotations
import argparse
import sys
import json
import os
from . import convert


def main():
    ap = argparse.ArgumentParser(
        prog="html2elementor",
        description="Convert HTML+CSS to Elementor JSON template (envelope or layout) with global kit.",
    )
    ap.add_argument("input", nargs="?", help="HTML file path (or - for stdin)")
    ap.add_argument("-o", "--output", help="Output JSON file (default: stdout)")
    ap.add_argument("--indent", type=int, default=2, help="JSON indent (default: 2)")
    ap.add_argument("--url", help="Fetch URL via Playwright instead of reading a file")
    ap.add_argument("--no-kit", action="store_true", help="Skip kit.json generation")
    ap.add_argument("--raw-layout", action="store_true", help="Output raw _elementor_data array instead of template envelope")
    ap.add_argument("--use-globals", action="store_true", help="Use __globals__ references to companion kit instead of inlined styles")
    ap.add_argument("--manifest", action="store_true", help="Generate images_manifest.json for external/referenced images")
    ap.add_argument("--no-validate", action="store_true", help="Skip post-generation schema validation")
    ap.add_argument("--upload", action="store_true", help="Upload external images to WP media library via Playsand")
    ap.add_argument("--css", action="append", metavar="FILE",
                    help="Extra CSS file(s) to include (may be repeated). Useful when the HTML links external stylesheets that can't be auto-resolved.")
    args = ap.parse_args()

    extra_css: list[str] | None = None
    if args.css:
        extra_css = []
        for css_file in args.css:
            with open(css_file) as f:
                extra_css.append(f.read())

    if args.url:
        try:
            from ._playwright import fetch_and_convert
            result = fetch_and_convert(args.url)
        except ImportError:
            print("Error: --url requires playwright. Install: pip install playwright && playwright install chromium", file=sys.stderr)
            sys.exit(1)
    elif args.input and args.input != "-":
        with open(args.input) as f:
            html = f.read()
        result = convert(html, html_path=args.input, extra_css=extra_css, use_globals=args.use_globals)
    elif not sys.stdin.isatty():
        html = sys.stdin.read()
        result = convert(html, extra_css=extra_css, use_globals=args.use_globals)
    else:
        ap.print_help()
        sys.exit(1)

    if args.upload:
        from .media import upload_all_images
        # Pass the input path so relative <img src="..."> paths get resolved
        # against the HTML's own directory and uploaded from local disk.
        html_path = args.input if args.input and args.input != "-" else None
        n = upload_all_images(result["layout"], html_path=html_path)
        if n:
            print(f"Uploaded {n} images to WP media library", file=sys.stderr)

    # Post-generation schema validation
    if not args.no_validate:
        from .validator import validate_elementor_template
        val_errors = validate_elementor_template(result["template"])
        if val_errors:
            print("Elementor Schema Validation Error(s):", file=sys.stderr)
            for err in val_errors:
                print(f"  ✗ {err}", file=sys.stderr)
            sys.exit(1)

    output_data = result["layout"] if args.raw_layout else result["template"]
    output_json = json.dumps(output_data, indent=args.indent, ensure_ascii=False)

    if args.output:
        with open(args.output, "w") as f:
            f.write(output_json)

        # Write manifest if requested
        if args.manifest:
            from .media import generate_image_manifest
            manifest = generate_image_manifest(result["layout"])
            manifest_path = os.path.splitext(args.output)[0] + ".manifest.json"
            with open(manifest_path, "w") as f:
                json.dump(manifest, f, indent=args.indent, ensure_ascii=False)
            print(f"Wrote {len(manifest)} image references to {manifest_path}", file=sys.stderr)

        # Write kit alongside layout
        if not args.no_kit:
            kit_path = os.path.splitext(args.output)[0] + ".kit.json"
            with open(kit_path, "w") as f:
                json.dump(result["kit"], f, indent=args.indent, ensure_ascii=False)

        n_sections = len(result["layout"])
        n_colors = len(result["kit"].get("system_colors", [])) + len(result["kit"].get("custom_colors", []))
        format_name = "raw _elementor_data" if args.raw_layout else "Elementor template envelope"
        print(f"Wrote {n_sections} sections ({format_name}) to {args.output}", file=sys.stderr)
        if not args.no_kit:
            print(f"Wrote {n_colors} global colors to {kit_path}", file=sys.stderr)

        # Print mapping summary
        cm = result.get("color_map", {})
        fm = result.get("font_map", {})
        if cm and args.use_globals:
            print(f"Color globals: {', '.join(f'{v}={k}' for k, v in list(cm.items())[:8])}", file=sys.stderr)
        if fm and args.use_globals:
            print(f"Font globals: {', '.join(f'{v}={k}' for k, v in fm.items())}", file=sys.stderr)
    else:
        print(output_json)


if __name__ == "__main__":
    main()

