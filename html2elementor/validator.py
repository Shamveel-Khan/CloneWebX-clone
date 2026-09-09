"""Strict schema and compliance validator for Elementor template JSON exports."""
from __future__ import annotations
from typing import Any

ALLOWED_WIDGET_TYPES = {
    "heading", "text-editor", "button", "image", "icon-list",
    "icon-box", "image-box", "accordion", "html", "form",
    "divider", "spacer", "counter", "progress", "testimonial",
}

ALLOWED_HEADER_SIZES = {"h1", "h2", "h3", "h4", "h5", "h6"}


def validate_elementor_template(data: Any) -> list[str]:
    """Validate Elementor template JSON against import requirements.
    
    Returns a list of error strings. If empty, the template is 100% compliant.
    """
    errors: list[str] = []

    if not isinstance(data, dict):
        return [f"Root must be a JSON object (envelope), got {type(data).__name__}. Bare arrays fail Elementor import with 'Invalid Data'."]

    # 1. Envelope structure check
    required_envelope_keys = ("version", "title", "type", "content", "page_settings")
    for key in required_envelope_keys:
        if key not in data:
            errors.append(f"Missing required envelope key: '{key}'")

    if data.get("version") != "0.4":
        errors.append(f"Envelope 'version' must be '0.4', got '{data.get('version')}'")

    if not isinstance(data.get("title"), str):
        errors.append("Envelope 'title' must be a string")

    if data.get("type") not in ("page", "section", "container", "header", "footer", "single", "archive"):
        errors.append(f"Envelope 'type' is invalid: '{data.get('type')}'. Expected 'page', 'section', etc.")

    content = data.get("content")
    if not isinstance(content, list):
        errors.append(f"Envelope 'content' must be a list of elements, got {type(content).__name__}")
        return errors

    # 2. Element tree traversal & validation
    seen_ids: set[str] = set()

    def _check_element(el: Any, is_root: bool = False, path: str = "content") -> None:
        if not isinstance(el, dict):
            errors.append(f"{path}: element must be a dict, got {type(el).__name__}")
            return

        for req_key in ("id", "elType", "settings", "elements", "isInner"):
            if req_key not in el:
                errors.append(f"{path}: element missing required key '{req_key}'")

        el_id = el.get("id")
        if not el_id or not isinstance(el_id, str):
            errors.append(f"{path}: element 'id' must be a non-empty string")
        elif el_id in seen_ids:
            errors.append(f"{path}: duplicate element id detected: '{el_id}'")
        else:
            seen_ids.add(el_id)

        el_type = el.get("elType")
        if el_type not in ("container", "section", "column", "widget"):
            errors.append(f"{path} ({el_id}): invalid elType '{el_type}'")

        is_inner = el.get("isInner")
        if is_root and is_inner is True:
            errors.append(f"{path} ({el_id}): root element cannot have isInner=True")
        elif not is_root and el_type == "container" and is_inner is False:
            errors.append(f"{path} ({el_id}): nested container must have isInner=True")

        settings = el.get("settings", {})
        if not isinstance(settings, dict):
            errors.append(f"{path} ({el_id}): 'settings' must be a dict")

        if el_type == "widget":
            widget_type = el.get("widgetType")
            if not widget_type:
                errors.append(f"{path} ({el_id}): widget missing 'widgetType'")
            elif widget_type not in ALLOWED_WIDGET_TYPES:
                errors.append(f"{path} ({el_id}): unknown or unsupported widgetType '{widget_type}'")

            # Heading widget checks
            if widget_type == "heading":
                header_size = settings.get("header_size")
                if header_size not in ALLOWED_HEADER_SIZES:
                    errors.append(
                        f"{path} ({el_id}): heading widget has invalid header_size '{header_size}'. "
                        f"Must be one of {sorted(ALLOWED_HEADER_SIZES)}. Values like 'div' fall back to 'h2' in Elementor."
                    )

            # Button widget checks
            if widget_type == "button":
                link = settings.get("link")
                if link is not None and not isinstance(link, dict):
                    errors.append(f"{path} ({el_id}): button widget 'link' must be an object with 'url'")

        child_elements = el.get("elements", [])
        if not isinstance(child_elements, list):
            errors.append(f"{path} ({el_id}): 'elements' must be a list")
        else:
            for idx, child in enumerate(child_elements):
                _check_element(child, is_root=False, path=f"{path}[{idx}]")

    for idx, root_el in enumerate(content):
        _check_element(root_el, is_root=True, path=f"content[{idx}]")

    return errors
