"""Report generation: rich terminal table + JSON + markdown output."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from rich.console import Console
from rich.table import Table
from rich.panel import Panel

from .standard.rules import Finding


SEVERITY_STYLE = {
    "error": "bold red",
    "warning": "yellow",
    "info": "cyan",
}

SEVERITY_ICON = {
    "error": "[X]",
    "warning": "[!]",
    "info": "[i]",
}


def render_terminal(findings: list[Finding], preset: dict, docx_path: str) -> None:
    console = Console()
    console.print()
    console.print(Panel.fit(
        f"[bold]{preset.get('name', 'unknown preset')}[/bold]\n"
        f"目标: [cyan]{docx_path}[/cyan]\n"
        f"问题数: {len(findings)} (error={sum(1 for f in findings if f.severity == 'error')}, "
        f"warning={sum(1 for f in findings if f.severity == 'warning')})",
        title="thesis-format-checker", border_style="blue",
    ))

    if not findings:
        console.print("\n[bold green]全部规则通过[/bold green]\n")
        return

    by_sev = {"error": [], "warning": [], "info": []}
    for f in findings:
        by_sev.setdefault(f.severity, []).append(f)

    for sev in ("error", "warning", "info"):
        items = by_sev.get(sev, [])
        if not items:
            continue
        table = Table(
            title=f"{SEVERITY_ICON[sev]} {sev.upper()} ({len(items)})",
            title_style=SEVERITY_STYLE[sev], show_lines=False,
        )
        table.add_column("规则", style="bold")
        table.add_column("位置", style="dim")
        table.add_column("说明")
        table.add_column("可修", justify="center")
        for f in items:
            table.add_row(
                f.rule_id,
                f.location or "-",
                f.message,
                "[green]Y[/green]" if f.fixable else "-",
            )
        console.print(table)
        console.print()


def render_json(findings: list[Finding], preset: dict, docx_path: str) -> str:
    data = {
        "preset": preset.get("name"),
        "preset_id": preset.get("preset_id"),
        "target": docx_path,
        "summary": {
            "total": len(findings),
            "error": sum(1 for f in findings if f.severity == "error"),
            "warning": sum(1 for f in findings if f.severity == "warning"),
            "info": sum(1 for f in findings if f.severity == "info"),
        },
        "findings": [asdict(f) for f in findings],
    }
    return json.dumps(data, ensure_ascii=False, indent=2)


def render_markdown(findings: list[Finding], preset: dict, docx_path: str) -> str:
    lines = [
        f"# 论文格式校验报告",
        "",
        f"- 规则集: **{preset.get('name')}**",
        f"- 目标文件: `{docx_path}`",
        f"- 问题总数: {len(findings)}",
        "",
    ]
    by_sev = {"error": [], "warning": [], "info": []}
    for f in findings:
        by_sev.setdefault(f.severity, []).append(f)
    for sev in ("error", "warning", "info"):
        items = by_sev.get(sev, [])
        if not items:
            continue
        lines.append(f"## {sev.upper()} ({len(items)})")
        lines.append("")
        lines.append("| 规则 | 位置 | 说明 | 可修 |")
        lines.append("|------|------|------|------|")
        for f in items:
            msg = f.message.replace("|", "\\|")
            loc = (f.location or "-").replace("|", "\\|")
            lines.append(f"| `{f.rule_id}` | {loc} | {msg} | {'Y' if f.fixable else '-'} |")
        lines.append("")
    return "\n".join(lines)


def write_output(findings: list[Finding], preset: dict, docx_path: str,
                 json_path: Path | None = None, md_path: Path | None = None) -> None:
    if json_path:
        json_path.write_text(render_json(findings, preset, docx_path), encoding="utf-8")
    if md_path:
        md_path.write_text(render_markdown(findings, preset, docx_path), encoding="utf-8")
