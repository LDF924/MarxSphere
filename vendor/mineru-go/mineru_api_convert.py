#!/usr/bin/env python3
"""MinerU Precision API document conversion helper.

Default output policy:
- Markdown is the primary artifact.
- JSON files and extracted assets are preserved as sidecars.
- A manifest records normalized paths for downstream tools.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path
from typing import Any, Callable, NamedTuple
from urllib.parse import urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


API_BASE = "https://mineru.net/api/v4"
AGENT_API_BASE = "https://mineru.net/api/v1/agent"
API_DOCS_URL = "https://mineru.net/apiManage/docs"
API_TOKEN_APPLY_URL = "https://mineru.net/apiManage/docs?openApplyModal=true"
TOKEN_ENV_NAME = "MINERU_API_TOKEN"
# MarxSphere 适配: 兼容 SAG .env 中的 MINERU_TOKEN
TOKEN_ENV_NAMES = ("MINERU_API_TOKEN", "MINERU_API_KEY", "MINERU_TOKEN")
AGENT_MAX_FILE_BYTES = 10 * 1024 * 1024
AGENT_MAX_PAGES = 20
POLL_INTERVAL = 3
POLL_TIMEOUT = 600


class MinerUApiError(RuntimeError):
    pass


IMAGE_EXTENSIONS = {".apng", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
AGENT_LOCAL_EXTENSIONS = {
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".jp2",
    ".webp",
    ".gif",
    ".bmp",
    ".docx",
    ".pptx",
    ".xlsx",
}
AGENT_FALLBACK_ERROR_CODES = {-30001, -30002, -30003}
ASSET_PATH_RE = re.compile(r"(?P<prefix>!\[[^\]]*\]\()(?P<path>[^)]+)(?P<suffix>\))")


class ApiModeDecision(NamedTuple):
    mode: str
    reason: str


def token_setup_hint() -> str:
    return (
        "MinerU API token is not configured.\n"
        f"1. Open {API_TOKEN_APPLY_URL}, sign in, and create/copy a token from the API management page.\n"
        "2. Save it once with the interactive helper; the helper never prints the token:\n"
        "   python <path-to-mineru-go>\\scripts\\mineru_api_convert.py --save-token\n"
        "3. Verify without revealing the token:\n"
        "   python <path-to-mineru-go>\\scripts\\mineru_api_convert.py --check-token\n"
        "Manual user-level PowerShell alternative:\n"
        '[Environment]::SetEnvironmentVariable("MINERU_API_TOKEN", "YOUR_TOKEN", "User")\n'
        "Then restart Codex/PowerShell if a different process cannot see it.\n"
        "Project-local alternative:\n"
        'Set-Content -NoNewline -Path .\\.mineru_token -Value "YOUR_TOKEN"'
    )


def read_windows_user_env(name: str) -> str | None:
    if os.name != "nt":
        return None
    try:
        import winreg
    except ImportError:
        return None

    locations = (
        (winreg.HKEY_CURRENT_USER, "Environment"),
        (
            winreg.HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    )
    for root, key_path in locations:
        try:
            with winreg.OpenKey(root, key_path) as key:
                value, _ = winreg.QueryValueEx(key, name)
        except OSError:
            continue
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def set_windows_user_env(name: str, value: str) -> None:
    if os.name != "nt":
        raise MinerUApiError(
            "User-level token saving is only implemented on Windows. "
            "Use a private project-local .mineru_token file instead."
        )
    try:
        import winreg
    except ImportError as exc:
        raise MinerUApiError("Windows registry support is unavailable in this Python runtime.") from exc

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
    except OSError as exc:
        raise MinerUApiError(f"Could not write user environment variable {name}: {exc}") from exc

    try:
        import ctypes

        hwnd_broadcast = 0xFFFF
        wm_settingchange = 0x001A
        smto_abortifhung = 0x0002
        ctypes.windll.user32.SendMessageTimeoutW(
            hwnd_broadcast,
            wm_settingchange,
            0,
            "Environment",
            smto_abortifhung,
            5000,
            None,
        )
    except Exception:
        pass


def save_user_token(token: str, setter: Callable[[str, str], None] | None = None) -> None:
    token = token.strip()
    if not token:
        raise MinerUApiError("Token is empty; create/copy a token from the MinerU API management page first.")
    if setter is None:
        setter = set_windows_user_env
    setter(TOKEN_ENV_NAME, token)
    os.environ[TOKEN_ENV_NAME] = token


def read_token_for_save(use_stdin: bool = False) -> str:
    if use_stdin:
        return sys.stdin.read().strip()
    import getpass

    return getpass.getpass("Paste MinerU API token (input hidden): ").strip()


def get_token(search_dirs: list[Path], explicit: str | None = None) -> str:
    for name in TOKEN_ENV_NAMES:
        token = explicit or os.environ.get(name)
        if token and token.strip():
            return token.strip()

    for name in TOKEN_ENV_NAMES:
        token = read_windows_user_env(name)
        if token:
            return token

    for directory in search_dirs:
        token_file = directory / ".mineru_token"
        if token_file.exists():
            token = token_file.read_text(encoding="utf-8").strip()
            if token:
                return token

    raise MinerUApiError(token_setup_hint())


def json_request(
    url: str,
    method: str = "GET",
    data: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 60,
) -> dict[str, Any]:
    request_headers = {"Accept": "*/*"}
    body = None
    if data is not None:
        request_headers["Content-Type"] = "application/json"
        body = json.dumps(data).encode("utf-8")
    if headers:
        request_headers.update(headers)

    req = Request(url, data=body, headers=request_headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        raise MinerUApiError(f"HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise MinerUApiError(f"Network error: {exc.reason}") from exc


def put_file(path: Path, upload_url: str) -> None:
    data = path.read_bytes()
    parsed = urlsplit(upload_url)
    if parsed.scheme not in {"http", "https"}:
        raise MinerUApiError(f"Unsupported upload URL scheme: {parsed.scheme}")

    connection_cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    conn = connection_cls(parsed.netloc, timeout=180)
    try:
        conn.request("PUT", target, body=data, headers={"Content-Length": str(len(data))})
        resp = conn.getresponse()
        detail = resp.read().decode("utf-8", errors="replace")
        if resp.status not in {200, 201, 204}:
            raise MinerUApiError(f"Upload failed with HTTP {resp.status}: {detail}")
    except OSError as exc:
        raise MinerUApiError(f"Upload network error: {exc}") from exc
    finally:
        conn.close()


def download(url: str, dest: Path) -> None:
    req = Request(url)
    try:
        with urlopen(req, timeout=180) as resp:
            dest.write_bytes(resp.read())
    except (HTTPError, URLError) as exc:
        raise MinerUApiError(f"Download failed: {exc}") from exc


def safe_extract(zip_path: Path, dest: Path) -> None:
    dest_resolved = dest.resolve()
    with zipfile.ZipFile(zip_path, "r") as archive:
        for member in archive.infolist():
            target = (dest / member.filename).resolve()
            if dest_resolved not in target.parents and target != dest_resolved:
                raise MinerUApiError(f"Unsafe zip member path: {member.filename}")
        archive.extractall(dest)


def choose_markdown(raw_dir: Path, stem: str) -> Path | None:
    md_files = list(raw_dir.rglob("*.md"))
    preferred_names = (f"{stem}.md", "full.md")
    for name in preferred_names:
        for md_file in md_files:
            if md_file.name.lower() == name.lower():
                return md_file
    return md_files[0] if md_files else None


def copy_tree_contents(src: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dest / item.name
        if item.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)


def count_files(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return 1
    return sum(1 for item in path.rglob("*") if item.is_file())


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def text_from_mineru_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(text_from_mineru_value(item.get("content") or item.get("text") or ""))
        return " ".join(part for part in parts if part)
    if isinstance(value, dict):
        return text_from_mineru_value(value.get("content") or value.get("text") or "")
    return ""


def clean_whitespace(value: str) -> str:
    return " ".join(value.split()).strip()


def slugify(value: str, default: str = "asset", max_length: int = 58) -> str:
    value = clean_whitespace(value).lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = value.strip("-")
    if not value:
        value = default
    return value[:max_length].strip("-") or default


def slug_hint_from_content(content: str) -> str:
    mermaid_declarations = {
        "graph",
        "flowchart",
        "sequencediagram",
        "classdiagram",
        "statediagram",
        "erdiagram",
        "gantt",
        "pie",
        "journey",
        "mindmap",
        "timeline",
    }
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("```") or line.startswith("<") or re.fullmatch(r"[\s|:\-]+", line):
            continue
        first_word = re.split(r"\s+", line, maxsplit=1)[0].lower()
        if first_word in mermaid_declarations:
            continue
        if "|" in line:
            cells = [cell.strip() for cell in line.strip("|").split("|") if cell.strip()]
            if cells and not all(re.fullmatch(r":?-{2,}:?", cell) for cell in cells):
                return slugify(" ".join(cells), default="")
        quoted = re.findall(r'"([^"]+)"', line)
        if quoted:
            return slugify(" ".join(quoted[:3]), default="")
        hint = slugify(line, default="")
        if hint:
            return hint
    return ""


def normalize_asset_ref(value: str) -> str:
    return value.replace("\\", "/").lstrip("./")


def asset_key(value: str) -> str:
    return Path(normalize_asset_ref(value)).name.lower()


def iter_nodes(value: Any) -> Any:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_nodes(child)


def collect_asset_metadata(raw_dir: Path) -> dict[str, dict[str, Any]]:
    metadata: dict[str, dict[str, Any]] = {}
    for json_file in raw_dir.rglob("*.json"):
        try:
            data = load_json(json_file)
        except Exception:
            continue
        for node in iter_nodes(data):
            content = node.get("content") if isinstance(node.get("content"), dict) else {}
            image_source = content.get("image_source") if isinstance(content, dict) else None
            raw_path = (
                node.get("img_path")
                or node.get("image_path")
                or (image_source or {}).get("path")
            )
            if not isinstance(raw_path, str):
                continue
            original_ref = normalize_asset_ref(raw_path)
            key = asset_key(original_ref)
            caption = (
                text_from_mineru_value(node.get("chart_caption"))
                or text_from_mineru_value(node.get("image_caption"))
                or text_from_mineru_value(content.get("chart_caption"))
                or text_from_mineru_value(content.get("image_caption"))
            )
            footnote = (
                text_from_mineru_value(node.get("chart_footnote"))
                or text_from_mineru_value(node.get("image_footnote"))
                or text_from_mineru_value(content.get("chart_footnote"))
                or text_from_mineru_value(content.get("image_footnote"))
            )
            extracted_content = text_from_mineru_value(node.get("content"))
            if isinstance(content, dict):
                extracted_content = text_from_mineru_value(content.get("content")) or extracted_content
            page_idx = node.get("page_idx")
            if page_idx is None:
                page_idx = node.get("page_index")
            bbox = node.get("bbox")
            existing = metadata.setdefault(key, {"original_path": original_ref})
            if "/" in original_ref and "/" not in existing.get("original_path", ""):
                existing["original_path"] = original_ref
            existing.update(
                {
                    "type": node.get("type") or existing.get("type") or "image",
                    "sub_type": node.get("sub_type") or existing.get("sub_type"),
                    "page_index": page_idx if page_idx is not None else existing.get("page_index"),
                    "bbox": bbox if bbox is not None else existing.get("bbox"),
                    "caption": clean_whitespace(caption) or existing.get("caption") or "",
                    "footnote": clean_whitespace(footnote) or existing.get("footnote") or "",
                    "extracted_content": extracted_content or existing.get("extracted_content") or "",
                    "metadata_source": str(json_file),
                }
            )
    return metadata


def collect_markdown_asset_refs(markdown_path: Path) -> list[str]:
    text = markdown_path.read_text(encoding="utf-8")
    refs = []
    for match in ASSET_PATH_RE.finditer(text):
        ref = normalize_asset_ref(match.group("path"))
        if Path(ref).suffix.lower() in IMAGE_EXTENSIONS and ref not in refs:
            refs.append(ref)
    return refs


def resolve_asset_path(raw_dir: Path, original_ref: str) -> Path | None:
    direct = raw_dir / original_ref
    if direct.exists():
        return direct
    name = Path(original_ref).name
    matches = [path for path in raw_dir.rglob(name) if path.is_file()]
    return matches[0] if matches else None


def build_asset_records(raw_dir: Path, markdown_path: Path, normalized: Path) -> list[dict[str, Any]]:
    metadata = collect_asset_metadata(raw_dir)
    refs: list[tuple[str, str]] = []
    seen_keys = set()
    for ref in collect_markdown_asset_refs(markdown_path):
        key = asset_key(ref)
        if key not in seen_keys:
            refs.append((key, ref))
            seen_keys.add(key)
    for key, meta in metadata.items():
        original_ref = meta.get("original_path") or key
        if key not in seen_keys and Path(original_ref).suffix.lower() in IMAGE_EXTENSIONS:
            refs.append((key, original_ref))
            seen_keys.add(key)

    figures_dir = normalized / "assets" / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)
    records = []
    for index, (key, original_ref) in enumerate(refs, start=1):
        src = resolve_asset_path(raw_dir, original_ref)
        if not src:
            continue
        meta = metadata.get(key, {})
        page_index = meta.get("page_index")
        page_number = int(page_index) + 1 if isinstance(page_index, int) else None
        caption = meta.get("caption") or ""
        content_hint = slug_hint_from_content(meta.get("extracted_content") or "")
        caption_slug = slugify(caption, default="")
        if len(caption_slug) < 4:
            caption_slug = ""
        slug = caption_slug or content_hint or slugify(Path(original_ref).stem)
        page_part = f"p{page_number:02d}" if page_number is not None else "pXX"
        dest_name = f"fig-{index:03d}-{page_part}-{slug}{src.suffix.lower()}"
        dest = figures_dir / dest_name
        counter = 2
        while dest.exists():
            dest = figures_dir / f"fig-{index:03d}-{page_part}-{slug}-{counter}{src.suffix.lower()}"
            counter += 1
        shutil.copy2(src, dest)
        relative_dest = dest.relative_to(normalized).as_posix()
        record = {
            "id": f"fig-{index:03d}",
            "label": f"Figure {index}",
            "type": meta.get("type") or "image",
            "sub_type": meta.get("sub_type"),
            "page_index": page_index,
            "page_number": page_number,
            "caption": caption,
            "footnote": meta.get("footnote") or "",
            "bbox": meta.get("bbox"),
            "original_path": original_ref,
            "metadata_original_path": meta.get("original_path") or original_ref,
            "normalized_path": relative_dest,
            "filename": dest.name,
            "source_path": str(src),
            "extracted_content": meta.get("extracted_content") or "",
        }
        records.append(record)
    return records


def rewrite_markdown_asset_refs(markdown_path: Path, records: list[dict[str, Any]]) -> None:
    mapping = {record["original_path"]: record["normalized_path"] for record in records}
    if not mapping:
        return
    text = markdown_path.read_text(encoding="utf-8")

    def replace(match: re.Match[str]) -> str:
        raw_ref = normalize_asset_ref(match.group("path"))
        new_ref = mapping.get(raw_ref)
        if not new_ref:
            return match.group(0)
        return f"{match.group('prefix')}{new_ref}{match.group('suffix')}"

    markdown_path.write_text(ASSET_PATH_RE.sub(replace, text), encoding="utf-8")


def write_asset_indexes(normalized: Path, records: list[dict[str, Any]]) -> dict[str, Any]:
    assets_dir = normalized / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    index_json = assets_dir / "index.json"
    index_md = assets_dir / "index.md"
    payload = {
        "schema": "mineru-go.asset-index.v1",
        "asset_count": len(records),
        "assets": records,
    }
    index_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# Asset Index", ""]
    if not records:
        lines.append("No extracted image assets were found.")
    for record in records:
        title = record["label"]
        if record.get("caption"):
            title += f" - {record['caption']}"
        lines.extend(
            [
                f"## {title}",
                "",
                f"- File: `{record['normalized_path']}`",
                f"- Original: `{record['original_path']}`",
                f"- Page: {record.get('page_number') or 'unknown'}",
                f"- Type: {record.get('type') or 'image'}"
                + (f" / {record['sub_type']}" if record.get("sub_type") else ""),
                "",
            ]
        )
        if record.get("footnote"):
            lines.extend([f"- Footnote: {record['footnote']}", ""])
    index_md.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return {
        "asset_index_json": str(index_json),
        "asset_index_markdown": str(index_md),
        "asset_count": len(records),
        "asset_dirs": [str(normalized / "assets" / "figures")] if records else [],
    }


def normalize_outputs(raw_dir: Path, output_dir: Path, stem: str, source: Path) -> dict[str, Any]:
    normalized = output_dir / stem
    if normalized.exists():
        shutil.rmtree(normalized)
    normalized.mkdir(parents=True, exist_ok=True)

    markdown_src = choose_markdown(raw_dir, stem)
    if not markdown_src:
        raise MinerUApiError("MinerU result archive did not contain a Markdown file.")
    markdown_dest = normalized / f"{stem}.md"
    shutil.copy2(markdown_src, markdown_dest)

    json_dir = normalized / "json"
    json_paths = []
    for json_src in raw_dir.rglob("*.json"):
        json_dir.mkdir(exist_ok=True)
        dest = json_dir / json_src.name
        counter = 2
        while dest.exists():
            dest = json_dir / f"{json_src.stem}_{counter}{json_src.suffix}"
            counter += 1
        shutil.copy2(json_src, dest)
        json_paths.append(dest)

    asset_records = build_asset_records(raw_dir, markdown_dest, normalized)
    rewrite_markdown_asset_refs(markdown_dest, asset_records)
    asset_index = write_asset_indexes(normalized, asset_records)

    manifest = {
        "manifest_version": 1,
        "source": str(source),
        "primary": "markdown",
        "primary_path": str(markdown_dest),
        "markdown_path": str(markdown_dest),
        "json_dir": str(json_dir) if json_paths else None,
        "json_paths": [str(path) for path in json_paths],
        "asset_dirs": asset_index["asset_dirs"],
        "asset_count": asset_index["asset_count"],
        "asset_index_json": asset_index["asset_index_json"],
        "asset_index_markdown": asset_index["asset_index_markdown"],
        "raw_result_dir": str(raw_dir),
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    manifest_path = normalized / "mineru_manifest.json"
    manifest["manifest_path"] = str(manifest_path)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def normalize_agent_markdown(
    markdown: str,
    output_dir: Path,
    stem: str,
    source: Path,
    markdown_url: str | None = None,
) -> dict[str, Any]:
    normalized = output_dir / stem
    if normalized.exists():
        shutil.rmtree(normalized)
    normalized.mkdir(parents=True, exist_ok=True)

    markdown_dest = normalized / f"{stem}.md"
    markdown_dest.write_text(markdown, encoding="utf-8")
    asset_index = write_asset_indexes(normalized, [])

    manifest = {
        "manifest_version": 1,
        "api_mode": "agent",
        "source": str(source),
        "primary": "markdown",
        "primary_path": str(markdown_dest),
        "markdown_path": str(markdown_dest),
        "json_dir": None,
        "json_paths": [],
        "asset_dirs": asset_index["asset_dirs"],
        "asset_count": asset_index["asset_count"],
        "asset_index_json": asset_index["asset_index_json"],
        "asset_index_markdown": asset_index["asset_index_markdown"],
        "raw_result_dir": None,
        "agent_markdown_url": markdown_url,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    manifest_path = normalized / "mineru_manifest.json"
    manifest["manifest_path"] = str(manifest_path)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def parse_extra_formats(raw: str | None) -> list[str]:
    if not raw:
        return []
    allowed = {"docx", "html", "latex"}
    formats = []
    for item in raw.split(","):
        value = item.strip().lower()
        if not value:
            continue
        if value not in allowed:
            raise MinerUApiError(f"Unsupported extra format: {value}. Use docx, html, or latex.")
        if value not in formats:
            formats.append(value)
    return formats


def simple_agent_page_count(raw: str | None) -> int | None:
    if not raw:
        return None
    value = raw.strip()
    if not value or "," in value:
        return None
    single = re.fullmatch(r"\d+", value)
    if single:
        return 1
    match = re.fullmatch(r"(\d+)-(\d+)", value)
    if not match:
        return None
    start = int(match.group(1))
    end = int(match.group(2))
    if start <= 0 or end < start:
        return None
    return end - start + 1


def is_simple_agent_page_range(raw: str | None) -> bool:
    if not raw:
        return True
    return simple_agent_page_count(raw) is not None


def estimate_pdf_page_count(path: Path) -> int | None:
    if path.suffix.lower() != ".pdf":
        return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    count = len(re.findall(rb"/Type\s*/Page\b", data))
    return count or None


def choose_api_mode(source: Path, args: argparse.Namespace) -> ApiModeDecision:
    requested = getattr(args, "api_mode", "auto")
    if requested == "precision":
        return ApiModeDecision("precision", "precision mode forced")
    if requested == "agent":
        return ApiModeDecision("agent", "agent mode forced")
    if requested != "auto":
        raise MinerUApiError(f"Unsupported api mode: {requested}")

    extra_formats = parse_extra_formats(getattr(args, "extra_formats", None))
    if extra_formats:
        return ApiModeDecision("precision", "extra formats require Precision API")
    if getattr(args, "data_id", None):
        return ApiModeDecision("precision", "data_id tracking requires Precision API")

    suffix = source.suffix.lower()
    if suffix not in AGENT_LOCAL_EXTENSIONS:
        return ApiModeDecision("precision", f"{suffix or 'extensionless files'} are not supported by Agent lightweight API")

    try:
        size = source.stat().st_size
    except OSError as exc:
        raise MinerUApiError(f"Cannot stat input file: {source}") from exc
    if size > AGENT_MAX_FILE_BYTES:
        return ApiModeDecision("precision", f"file is larger than Agent lightweight API limit ({AGENT_MAX_FILE_BYTES} bytes)")

    pages = getattr(args, "pages", None)
    if not is_simple_agent_page_range(pages):
        return ApiModeDecision("precision", "complex page range requires Precision API")
    requested_page_count = simple_agent_page_count(pages)
    if requested_page_count is not None and requested_page_count > AGENT_MAX_PAGES:
        return ApiModeDecision("precision", "requested page range exceeds Agent lightweight API limit")

    estimated_pages = estimate_pdf_page_count(source)
    if requested_page_count is None and estimated_pages is not None and estimated_pages > AGENT_MAX_PAGES:
        return ApiModeDecision("precision", "PDF page count exceeds Agent lightweight API limit")

    return ApiModeDecision("agent", "eligible for Agent lightweight API")


def build_request_data(source: Path, args: argparse.Namespace) -> dict[str, Any]:
    file_entry: dict[str, Any] = {
        "name": source.name,
        "data_id": args.data_id or source.stem,
        "is_ocr": args.ocr,
    }
    if args.pages:
        file_entry["page_ranges"] = args.pages

    request_data: dict[str, Any] = {
        "files": [file_entry],
        "model_version": args.model,
        "enable_formula": not args.no_formula,
        "enable_table": not args.no_table,
        "language": args.language,
    }

    extra_formats = parse_extra_formats(args.extra_formats)
    if extra_formats:
        request_data["extra_formats"] = extra_formats
    return request_data


def build_agent_request_data(source: Path, args: argparse.Namespace) -> dict[str, Any]:
    request_data: dict[str, Any] = {
        "file_name": source.name,
        "language": args.language,
        "enable_table": not args.no_table,
        "is_ocr": args.ocr,
        "enable_formula": not args.no_formula,
    }
    if args.pages:
        request_data["page_range"] = args.pages
    return request_data


def should_fallback_from_agent(exc: MinerUApiError) -> bool:
    message = str(exc)
    if "HTTP 429" in message:
        return True
    for code in AGENT_FALLBACK_ERROR_CODES:
        if str(code) in message:
            return True
    return "standard API" in message or "lightweight API limit" in message


def convert_precision(args: argparse.Namespace, source: Path, output_dir: Path) -> dict[str, Any]:
    token = get_token([Path.cwd(), output_dir, source.parent], args.token)
    headers = {"Authorization": f"Bearer {token}"}

    request_data = build_request_data(source, args)

    print(f"[MinerU Precision API] Requesting upload URL for {source.name} ...")
    init = json_request(f"{API_BASE}/file-urls/batch", method="POST", data=request_data, headers=headers)
    if init.get("code") != 0:
        raise MinerUApiError(f"Upload URL request failed: {init.get('msg')}")

    data = init.get("data") or {}
    batch_id = data.get("batch_id")
    upload_urls = data.get("file_urls") or data.get("files")
    if not batch_id or not upload_urls:
        raise MinerUApiError("MinerU API did not return batch_id and upload URL.")

    print(f"[MinerU Precision API] Uploading file. batch_id={batch_id}")
    put_file(source, upload_urls[0])

    print("[MinerU Precision API] Waiting for extraction ...")
    start = time.time()
    full_zip_url = None
    while True:
        if time.time() - start > args.timeout:
            raise MinerUApiError(f"Timed out after {args.timeout} seconds.")

        poll = json_request(f"{API_BASE}/extract-results/batch/{batch_id}", headers=headers)
        if poll.get("code") != 0:
            raise MinerUApiError(f"Polling failed: {poll.get('msg')}")

        results = (poll.get("data") or {}).get("extract_result") or []
        for item in results:
            state = item.get("state")
            if state == "done":
                full_zip_url = item.get("full_zip_url")
            elif state == "failed":
                raise MinerUApiError(f"Extraction failed: {item.get('err_msg')}")
            elif state == "running":
                progress = item.get("extract_progress") or {}
                if progress:
                    print(
                        "[MinerU Precision API] "
                        f"{progress.get('extracted_pages', '?')}/{progress.get('total_pages', '?')} pages"
                    )
        if full_zip_url:
            break
        time.sleep(args.poll_interval)

    raw_dir = output_dir / f"{source.stem}_raw"
    if raw_dir.exists():
        shutil.rmtree(raw_dir)
    raw_dir.mkdir(parents=True)

    zip_path = raw_dir / "result.zip"
    print("[MinerU Precision API] Downloading result archive ...")
    download(full_zip_url, zip_path)
    safe_extract(zip_path, raw_dir)
    zip_path.unlink()

    manifest = normalize_outputs(raw_dir, output_dir, source.stem, source)
    manifest["api_mode"] = "precision"
    Path(manifest["manifest_path"]).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def convert_agent(args: argparse.Namespace, source: Path, output_dir: Path) -> dict[str, Any]:
    request_data = build_agent_request_data(source, args)
    print(f"[MinerU Agent API] Requesting signed upload URL for {source.name} ...")
    init = json_request(f"{AGENT_API_BASE}/parse/file", method="POST", data=request_data)
    if init.get("code") != 0:
        raise MinerUApiError(f"Agent upload URL request failed {init.get('code')}: {init.get('msg')}")

    data = init.get("data") or {}
    task_id = data.get("task_id")
    file_url = data.get("file_url")
    if not task_id or not file_url:
        raise MinerUApiError("MinerU Agent API did not return task_id and signed upload URL.")

    print(f"[MinerU Agent API] Uploading file. task_id={task_id}")
    put_file(source, file_url)

    print("[MinerU Agent API] Waiting for Markdown result ...")
    start = time.time()
    markdown_url = None
    while True:
        if time.time() - start > args.timeout:
            raise MinerUApiError(f"Timed out after {args.timeout} seconds.")

        poll = json_request(f"{AGENT_API_BASE}/parse/{task_id}")
        if poll.get("code") != 0:
            raise MinerUApiError(f"Agent polling failed: {poll.get('msg')}")
        data = poll.get("data") or {}
        state = data.get("state")
        if state == "done":
            markdown_url = data.get("markdown_url")
            break
        if state == "failed":
            err_msg = data.get("err_msg") or "unknown error"
            err_code = data.get("err_code")
            code_part = f" {err_code}" if err_code is not None else ""
            raise MinerUApiError(f"Agent extraction failed{code_part}: {err_msg}")
        if state in {"uploading", "pending", "running", "waiting-file"}:
            print(f"[MinerU Agent API] state={state}")
        time.sleep(args.poll_interval)

    if not markdown_url:
        raise MinerUApiError("MinerU Agent API finished without a Markdown URL.")
    markdown_path = output_dir / f"{source.stem}_agent.md"
    print("[MinerU Agent API] Downloading Markdown result ...")
    download(markdown_url, markdown_path)
    markdown = markdown_path.read_text(encoding="utf-8")
    markdown_path.unlink(missing_ok=True)
    manifest = normalize_agent_markdown(markdown, output_dir, source.stem, source, markdown_url)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def convert(args: argparse.Namespace) -> dict[str, Any]:
    source = Path(args.source).expanduser().resolve()
    if not source.exists():
        raise MinerUApiError(f"Input file does not exist: {source}")

    output_dir = Path(args.output).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    decision = choose_api_mode(source, args)
    print(f"[MinerU API] mode={decision.mode} ({decision.reason})")
    if decision.mode == "precision":
        return convert_precision(args, source, output_dir)

    try:
        return convert_agent(args, source, output_dir)
    except MinerUApiError as exc:
        if getattr(args, "api_mode", "auto") == "auto" and should_fallback_from_agent(exc):
            print(f"[MinerU API] Agent lightweight failed with a standard-API condition; falling back. {exc}")
            return convert_precision(args, source, output_dir)
        raise


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert a document with MinerU Agent or Precision API.")
    parser.add_argument("source", nargs="?", help="Local document path")
    parser.add_argument("-o", "--output", default="mineru-output", help="Output directory")
    parser.add_argument("--check-token", action="store_true", help="Check token visibility and exit")
    parser.add_argument("--save-token", action="store_true", help="Prompt for a token and save user-level MINERU_API_TOKEN")
    parser.add_argument(
        "--save-token-stdin",
        action="store_true",
        help="Read a token from stdin and save user-level MINERU_API_TOKEN without printing it",
    )
    parser.add_argument("--token", default=None, help="API token for one-off use; prefer --save-token instead")
    parser.add_argument(
        "--api-mode",
        choices=("auto", "agent", "precision"),
        default="auto",
        help="API route: auto uses Agent lightweight when eligible, precision otherwise",
    )
    parser.add_argument("--model", default="vlm", help="MinerU model_version, default: vlm")
    parser.add_argument("--language", default="en", help="OCR/document language, default: en")
    parser.add_argument("--pages", default=None, help='Page ranges, e.g. "1-10,15"')
    parser.add_argument("--ocr", action="store_true", help="Enable OCR for scanned/image-only documents")
    parser.add_argument("--no-formula", action="store_true", help="Disable formula recognition")
    parser.add_argument("--no-table", action="store_true", help="Disable table recognition")
    parser.add_argument("--extra-formats", default=None, help="Optional comma list: docx,html,latex")
    parser.add_argument("--data-id", default=None, help="Optional API data_id")
    parser.add_argument("--timeout", type=int, default=POLL_TIMEOUT, help="Polling timeout seconds")
    parser.add_argument("--poll-interval", type=int, default=POLL_INTERVAL, help="Polling interval seconds")
    return parser


def main() -> int:
    parser = create_parser()
    args = parser.parse_args()

    if args.save_token or args.save_token_stdin:
        try:
            save_user_token(read_token_for_save(args.save_token_stdin))
        except MinerUApiError as exc:
            print(f"[MinerU API] ERROR: {exc}", file=sys.stderr)
            return 1
        print("[MinerU API] Token saved to user-level MINERU_API_TOKEN.")
        print("[MinerU API] Restart Codex/PowerShell if a different process cannot see it.")
        return 0

    if args.check_token:
        try:
            get_token([Path.cwd()], args.token)
        except MinerUApiError as exc:
            print(f"[MinerU API] ERROR: {exc}", file=sys.stderr)
            return 1
        print("[MinerU API] Token is configured.")
        return 0

    if not args.source:
        parser.error("source is required unless --check-token is used")

    try:
        convert(args)
    except MinerUApiError as exc:
        print(f"[MinerU API] ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
