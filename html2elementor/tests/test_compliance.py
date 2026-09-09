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


if __name__ == "__main__":
    unittest.main()
