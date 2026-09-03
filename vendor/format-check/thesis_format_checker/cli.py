"""CLI entry point for thesis-format-checker."""

from __future__ import annotations

import sys
from pathlib import Path

import click

from .checker import load_preset, check as run_check
from .fixer import apply_fixes
from .report import render_terminal, render_json, render_markdown, write_output


@click.group()
def main():
    """thesis-format-checker: validate DOCX formatting against rules."""
    pass


@main.command("check")
@click.argument("docx_path", type=click.Path(exists=True))
@click.option("--preset", "-p", default=None, help="Preset name or path (default: ncwu)")
@click.option("--rules", "-r", default=None, help="Custom rules YAML path")
@click.option("--json", "output_json", is_flag=True, help="JSON output")
@click.option("--md", "md_path", default=None, help="Markdown report path")
@click.option("--fix", "fix_path", default=None, help="Auto-fix output path")
@click.pass_context
def check_command(ctx, docx_path, preset, rules, output_json, md_path, fix_path):
    """Check a DOCX file against the format rules."""
    try:
        preset_data = load_preset(rules or preset)
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        ctx.exit(3)
        return

    try:
        docx_result, content_result, findings = run_check(docx_path, preset_data)
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        ctx.exit(3)
        return
    except Exception as e:
        click.echo(f"Error during check: {type(e).__name__}: {e}", err=True)
        import traceback
        traceback.print_exc()
        ctx.exit(3)
        return

    if output_json:
        click.echo(render_json(findings, preset_data, docx_path))
    else:
        render_terminal(findings, preset_data, docx_path)

    if md_path:
        write_output(findings, preset_data, docx_path, md_path=Path(md_path))

    if fix_path:
        fixable = [f for f in findings if f.fixable]
        if not fixable:
            click.echo("No fixable issues found.")
        else:
            count, msgs = apply_fixes(docx_path, fix_path, fixable, preset_data)
            click.echo(f"\nApplied {count} fix groups to {fix_path}:")
            for m in msgs:
                click.echo(f"  - {m}")

    errors = sum(1 for f in findings if f.severity == "error")
    warnings = sum(1 for f in findings if f.severity == "warning")
    if errors:
        ctx.exit(2)
    elif warnings:
        ctx.exit(1)
    else:
        ctx.exit(0)


@main.command("list-rules")
@click.option("--preset", "-p", default=None, help="Preset name or path")
def list_rules(preset):
    """List all available rules and their status."""
    from .standard.rules import RULES, _get_rule_config

    try:
        preset_data = load_preset(preset)
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(3)

    click.echo(f"Rules for preset: {preset_data.get('name', 'unknown')}\n")
    click.echo(f"{'ID':<30} {'Severity':<10} {'Enabled':<8}")
    click.echo("-" * 50)
    for rule_id, spec in RULES.items():
        severity, enabled = _get_rule_config(preset_data, rule_id)
        status = "ON" if enabled else "OFF"
        click.echo(f"{rule_id:<30} {severity:<10} {status:<8}")


@main.command("inspect")
@click.argument("docx_path", type=click.Path(exists=True))
def inspect_command(docx_path):
    """Dump raw inspection JSON without running rules."""
    import json
    from .docx_inspector import inspect as docx_inspect
    from .content_inspector import inspect as content_inspect

    docx_result = docx_inspect(docx_path)
    content_result = content_inspect(docx_path)
    out = {
        "docx": docx_result.to_dict(),
        "content": {k: v for k, v in content_result.to_dict().items() if k != "full_text"},
    }
    click.echo(json.dumps(out, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
