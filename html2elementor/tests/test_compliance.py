"""Unit tests for Elementor Template import compliance and schema validation."""
from __future__ import annotations
import unittest
from pathlib import Path

from html2elementor import convert
from html2elementor.validator import validate_elementor_template, ALLOWED_HEADER_SIZES, ALLOWED_WIDGET_TYPES


class TestElementorCompliance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tests_dir = Path(__file__).parent

    def test_schema_compliance_all_templates(self):
        """Every test HTML template must produce a 100% compliant Elementor template envelope."""
        html_files = sorted(self.tests_dir.glob("*.html"))
        self.assertGreater(len(html_files), 0, "No test HTML templates found")

        for html_file in html_files:
            with self.subTest(template=html_file.name):
                with open(html_file) as f:
                    html = f.read()

                result = convert(html, html_path=str(html_file))
                template = result["template"]

                # Run strict schema validator
                errors = validate_elementor_template(template)
                self.assertEqual(errors, [], f"Template {html_file.name} failed schema validation: {errors}")

                # Verify envelope keys
                self.assertEqual(template.get("version"), "0.4")
                self.assertEqual(template.get("type"), "page")
                self.assertIsInstance(template.get("title"), str)
                self.assertIsInstance(template.get("content"), list)
                self.assertIsInstance(template.get("page_settings"), (list, dict))

    def test_no_invalid_header_sizes(self):
        """Assert no heading widget ever outputs header_size == 'div' or outside h1-h6."""
        html_files = sorted(self.tests_dir.glob("*.html"))
        for html_file in html_files:
            with self.subTest(template=html_file.name):
                with open(html_file) as f:
                    html = f.read()

                result = convert(html, html_path=str(html_file))

                def _check_elements(elements):
                    for el in elements:
                        if el.get("elType") == "widget" and el.get("widgetType") == "heading":
                            h_size = el.get("settings", {}).get("header_size")
                            self.assertIn(
                                h_size, ALLOWED_HEADER_SIZES,
                                f"In {html_file.name}, heading {el.get('id')} has invalid header_size: '{h_size}'"
                            )
                            self.assertNotEqual(h_size, "div", f"In {html_file.name}, header_size cannot be 'div'")
                        _check_elements(el.get("elements", []))

                _check_elements(result["template"]["content"])

    def test_negative_validation_cases(self):
        """Validator must catch bare arrays, missing envelope keys, invalid header sizes, and duplicate IDs."""
        # Bare array (fatal import bug)
        errors = validate_elementor_template([{"id": "a", "elType": "container", "settings": {}, "elements": [], "isInner": False}])
        self.assertTrue(any("Bare arrays fail" in e for e in errors))

        # Missing envelope keys
        errors = validate_elementor_template({"content": []})
        self.assertTrue(any("Missing required envelope key" in e for e in errors))

        # Invalid header_size
        bad_heading = {
            "version": "0.4",
            "title": "Bad Template",
            "type": "page",
            "page_settings": [],
            "content": [
                {
                    "id": "c1",
                    "elType": "container",
                    "settings": {},
                    "isInner": False,
                    "elements": [
                        {
                            "id": "w1",
                            "elType": "widget",
                            "widgetType": "heading",
                            "isInner": False,
                            "settings": {"title": "Hello", "header_size": "div"},
                            "elements": [],
                        }
                    ]
                }
            ]
        }
        errors = validate_elementor_template(bad_heading)
        self.assertTrue(any("invalid header_size 'div'" in e for e in errors))

        # Duplicate ID
        dup_id = {
            "version": "0.4",
            "title": "Dup ID Template",
            "type": "page",
            "page_settings": [],
            "content": [
                {"id": "same_id", "elType": "container", "settings": {}, "isInner": False, "elements": []},
                {"id": "same_id", "elType": "container", "settings": {}, "isInner": False, "elements": []},
            ]
        }
        errors = validate_elementor_template(dup_id)
        self.assertTrue(any("duplicate element id detected" in e for e in errors))


class TestLayoutFidelity(unittest.TestCase):

    def test_gap_zero_preserved(self):
        """CSS gap:0 must not become gap:20 in output."""
        html = '<section style="display:flex;gap:0"><div>A</div><div>B</div></section>'
        result = convert(html)
        layout = result["layout"]
        gap = layout[0]["settings"].get("flex_gap", {})
        self.assertEqual(gap.get("size"), 0, "gap:0 must not default to 20")

    def test_content_width_full_no_maxwidth(self):
        """Sections without max-width must get content_width:full."""
        html = '<section style="padding:96px 72px;background:#f0f0f0"><h1>Hello</h1></section>'
        result = convert(html)
        self.assertEqual(result["layout"][0]["settings"]["content_width"], "full")

    def test_content_width_boxed_with_maxwidth(self):
        """Sections with max-width wrapper must get content_width:boxed."""
        html = '<section><div style="max-width:1200px;margin:0 auto"><h1>Hello</h1></div></section>'
        result = convert(html)
        self.assertEqual(result["layout"][0]["settings"]["content_width"], "boxed")
        self.assertEqual(result["layout"][0]["settings"].get("boxed_width", {}).get("size"), 1200)

    def test_flex_grow_propagated(self):
        """flex:1 on child divs in split/inline flex must set _flex_size or _flex_grow."""
        html = '''<section>
            <div style="display:flex">
                <div style="flex:1"><h2>Left</h2></div>
                <div style="flex:1"><h2>Right</h2></div>
            </div>
        </section>'''
        result = convert(html)
        layout = result["layout"]
        found_grow = False

        def _search(els):
            nonlocal found_grow
            for e in els:
                if e.get("settings", {}).get("_flex_size") == "grow" or e.get("settings", {}).get("_flex_grow"):
                    found_grow = True
                _search(e.get("elements", []))

        _search(layout)
        self.assertTrue(found_grow, "flex:1 must produce _flex_size:grow on children")

    def test_min_height_on_section(self):
        """CSS min-height on a section must appear in Elementor settings."""
        html = '<section style="min-height:600px;padding:40px"><h1>Hero</h1></section>'
        result = convert(html)
        mh = result["layout"][0]["settings"].get("min_height")
        self.assertIsNotNone(mh)
        self.assertEqual(mh["size"], 600)

    def test_overflow_hidden_on_card(self):
        """CSS overflow:hidden on card wrappers in a grid must appear in Elementor settings."""
        html = '''<section>
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:24px">
                <div style="border-radius:12px;overflow:hidden;background:#fff">
                    <img src="a.jpg"><h3>Card 1</h3>
                </div>
                <div style="border-radius:12px;overflow:hidden;background:#fff">
                    <img src="b.jpg"><h3>Card 2</h3>
                </div>
            </div>
        </section>'''
        result = convert(html)
        layout = result["layout"]
        found_overflow = False

        def _search(els):
            nonlocal found_overflow
            for e in els:
                if e.get("settings", {}).get("overflow") == "hidden":
                    found_overflow = True
                _search(e.get("elements", []))

        _search(layout)
        self.assertTrue(found_overflow, "overflow:hidden must appear on card container")

    def test_no_forced_horizontal_padding(self):
        """A section with padding:0 must not get forced 40px horizontal padding."""
        html = '<section style="padding:0;background:#000"><h1 style="color:#fff">Full bleed</h1></section>'
        result = convert(html)
        pad = result["layout"][0]["settings"].get("padding", {})
        left_px = int(pad.get("left", "0"))
        self.assertEqual(left_px, 0, "padding:0 section must not get forced 40px left padding")

    def test_line_height_preserved_without_font_size(self):
        """line-height:px must still emit when font-size isn't set explicitly."""
        html = '<section><p style="line-height:28px">Some text with line height</p></section>'
        result = convert(html)
        layout = result["layout"]
        found_lh = False

        def _search(els):
            nonlocal found_lh
            for e in els:
                lh = e.get("settings", {}).get("typography_line_height")
                if lh:
                    found_lh = True
                _search(e.get("elements", []))

        _search(layout)
        self.assertTrue(found_lh, "line-height:28px must produce typography_line_height setting")


if __name__ == "__main__":
    unittest.main()

