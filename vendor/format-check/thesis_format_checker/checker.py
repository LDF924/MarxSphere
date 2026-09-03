"""Main orchestration: load preset, run inspectors, evaluate rules."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .docx_inspector import inspect as docx_inspect, InspectResult
from .content_inspector import inspect as content_inspect, ContentResult
from .standard.rules import evaluate_all, Finding

STANDARD_DIR = Path(__file__).resolve().parent / "standard"


def load_preset(name_or_path: str | None = None) -> dict[str, Any]:
    """Load a standard preset by name or explicit YAML path."""
    if name_or_path is None:
        name_or_path = "ncwu"

    path = Path(name_or_path)
    if path.exists() and path.suffix in (".yaml", ".yml"):
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f)

    preset_file = STANDARD_DIR / f"{name_or_path}.yaml"
    if preset_file.exists():
        with open(preset_file, encoding="utf-8") as f:
            return yaml.safe_load(f)

    raise FileNotFoundError(
        f"Preset {name_or_path!r} not found. "
        f"Looked in: {path}, {preset_file}"
    )


def check(docx_path: str | Path, preset: dict) -> tuple[InspectResult, ContentResult, list[Finding]]:
    """Run full check pipeline: inspect + evaluate rules."""
    docx_path = Path(docx_path)
    if not docx_path.exists():
        raise FileNotFoundError(f"DOCX not found: {docx_path}")

    docx_result = docx_inspect(docx_path)
    content_result = content_inspect(docx_path)
    findings = evaluate_all(docx_result, content_result, preset)

    return docx_result, content_result, findings
