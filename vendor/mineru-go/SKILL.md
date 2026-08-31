---
name: mineru-go
description: "Use when the user asks to convert documents with MinerU API, parse PDFs/images/Office/HTML into Markdown or JSON, extract tables, formulas, OCR text, images, layout data, or prepare RAG/PPT-ready document structure."
---

# MinerU Go

## Scope

This skill is for MinerU API document conversion. Default to `auto` API routing: use Agent Lightweight API for eligible small Markdown-only jobs, and use token-backed Precision Extract API for everything else. Do not treat CLI, MCP, SDK, or local deployment as the normal path unless the user explicitly asks for those forms.

Use this for PDF/article/report conversion, OCR, table/formula extraction, image extraction, layout JSON, RAG ingestion, and PPT-ready document preprocessing.

This skill is agent-agnostic. It is intended for Codex, Claude Code, OpenClaw, Hermes, and other agents that can install a GitHub skill or read a `SKILL.md` file. Resolve script paths relative to the installed skill/repository directory.

## API Routing

Preferred helper command:

```powershell
python .\scripts\mineru_api_convert.py "C:\path\document.pdf" -o "C:\path\mineru-output"
```

The helper defaults to `--api-mode auto`.

Before conversion, classify the user's output intent. If the user only asks a vague request like "convert this", "parse this", or "try MinerU" and does not say whether Markdown-only is enough, ask once:

> Do you want a fast Markdown-only conversion, or full structured extraction with Markdown, JSON sidecars, and assets?

Do not choose Agent Lightweight API merely because the file is small. Agent is only correct when Markdown-only output satisfies the user need.

Use **Agent Lightweight API** first when all are true:

- local file is supported by Agent: PDF, png/jpg/jpeg/jp2/webp/gif/bmp, docx, pptx, or xlsx
- file size is 10 MB or smaller
- requested page range is empty, a single page, or one simple `from-to` range of 20 pages or fewer
- no `extra_formats`, `data_id`, layout JSON, raw model JSON, extracted asset index, or machine-coordinate output is required
- Markdown-only output is acceptable

Use **Precision Extract API** when any are true:

- file is larger than 10 MB, unsupported by Agent, or known to exceed 20 pages
- page range is complex, such as `1-3,5`
- the user asks for JSON sidecars, layout coordinates, table reconstruction, image assets, docx/html/latex export, `data_id`, high-accuracy structure, or PPT/RAG preprocessing that depends on assets/metadata
- Agent returns a lightweight limit or unsupported-file error (`-30001`, `-30002`, `-30003`) or HTTP 429; in `auto` mode the helper falls back to Precision

Force a route only when needed:

```powershell
python .\scripts\mineru_api_convert.py "C:\path\document.pdf" --api-mode agent
python .\scripts\mineru_api_convert.py "C:\path\document.pdf" --api-mode precision
```

Agent Lightweight API configuration:

- no login token and no `Authorization` header
- local upload endpoint: `POST https://mineru.net/api/v1/agent/parse/file`
- upload returned signed `file_url` with `PUT`
- result polling endpoint: `GET https://mineru.net/api/v1/agent/parse/{task_id}`
- done result returns `markdown_url`
- request fields: `file_name`, `language`, `enable_table`, `is_ocr`, `enable_formula`, and optional `page_range`

Precision API configuration:

- requires `Authorization: Bearer <Token>`
- local upload endpoint: `POST https://mineru.net/api/v4/file-urls/batch`
- result polling endpoint: `GET https://mineru.net/api/v4/extract-results/batch/{batch_id}`

## First Use: Token Setup

Precision Extract API requires a token. Agent Lightweight API does not. Official docs:

- API docs and token entry: `https://mineru.net/apiManage/docs?openApplyModal=true`
- Normal docs page: `https://mineru.net/apiManage/docs`
- The Precision API uses `Authorization: Bearer <Token>` in request headers.
- Local file upload conversion uses `/api/v4/file-urls/batch`; URL conversion uses `/api/v4/extract/task`.

When a first-time user has no token, guide them through this exact flow:

1. Open `https://mineru.net/apiManage/docs?openApplyModal=true`.
2. Sign in if MinerU asks for login.
3. Create/copy a token from the API management page.
4. Save it once with the interactive helper:

```powershell
python .\scripts\mineru_api_convert.py --save-token
```

5. Verify configuration without revealing the token:

```powershell
python .\scripts\mineru_api_convert.py --check-token
```

The helper stores the token as the Windows user-level `MINERU_API_TOKEN`, updates the current helper process environment, and never prints the token. A newly saved user environment variable may require restarting the agent session or PowerShell before other processes can see it.

Do not ask the user to paste the token into chat. Do not print, summarize, log, or commit token values. Avoid command-line literals such as `--token YOUR_TOKEN` except for deliberate one-off debugging, because shell history and process listings can expose them.

Manual fallback if the interactive helper is unavailable:

```powershell
[Environment]::SetEnvironmentVariable("MINERU_API_TOKEN", "YOUR_TOKEN", "User")
```

Project-local fallback for private, non-shared projects:

```powershell
Set-Content -NoNewline -Path .\.mineru_token -Value "YOUR_TOKEN"
```

If using `.mineru_token`, ensure it is private and ignored by git before creating or committing files.

## Token Check

Before Precision conversion, check for a token without printing it. The helper can do this directly:

```powershell
python .\scripts\mineru_api_convert.py --check-token
```

Token lookup order:

1. `MINERU_API_TOKEN`
2. `MINERU_API_KEY`
3. Windows user environment registry values for those names
4. `.mineru_token` in the working directory, output directory, or source file directory

On Windows, if a user-level environment variable was set after the current agent session started, it may not appear in the process environment. The helper reads the Windows user environment registry as a fallback, but never prints the token.

If no token is available and Precision is required, stop conversion and walk the user through **First Use: Token Setup**. In `auto` mode, the helper may still use Agent Lightweight API without a token when the input is eligible.

If the user has already created a token and asks the agent to store it, prefer the interactive helper above. If they explicitly provide the token in another secure local channel, save it to user-level `MINERU_API_TOKEN`, verify with `--check-token`, and do not echo the token in any command output or response.

For non-interactive local terminal setup without putting the token in shell history:

```powershell
$token = Read-Host "Paste MinerU API token"
$token | python .\scripts\mineru_api_convert.py --save-token-stdin
Remove-Variable token
```

This still shows typed input on some terminals; use the interactive `--save-token` command when possible because it hides input.

## Default Output Policy

Default primary output is **Markdown**.

Reason: document conversion users usually need a readable, LLM/RAG/PPT-friendly artifact first.

For Agent Lightweight API, save Markdown plus a manifest only. Agent returns Markdown only, so do not promise JSON sidecars or local asset indexes for Agent conversions.

For Precision API, MinerU already returns Markdown and JSON by default, so do not frame this as Markdown versus JSON. Save both:

- `*.md` as the primary artifact for reading, summarization, RAG chunks, and slide generation.
- `*.json` files as structural sidecars for layout, content lists, coordinates, tables, formulas, and downstream automation.
- extracted images renamed to stable, readable paths such as `assets/figures/fig-001-p03-caption.jpg`.
- a small manifest listing all normalized paths.
- an asset index mapping normalized figure names back to MinerU's original image paths, page numbers, captions, type/subtype, bounding boxes, and extracted chart/table content.

Use JSON as the primary artifact only when the user asks for layout coordinates, machine parsing, table reconstruction, or programmatic post-processing.

Only request `extra_formats` such as `docx`, `html`, or `latex` when the user explicitly asks for them. Markdown and JSON are default Precision API outputs and do not need `extra_formats`. Requesting `extra_formats` forces Precision API.

## API Defaults

For Agent Lightweight API:

- `enable_formula`: `true`
- `enable_table`: `true`
- `is_ocr`: `false` unless the document is scanned, image-only, or has broken text
- `language`: infer from the document/user request; use `en` for English papers and `ch` for Chinese documents
- `page_range`: only use a single page or simple `from-to` range; complex ranges force Precision

For academic PDFs and complex reports:

- `model_version`: `vlm`
- `enable_formula`: `true`
- `enable_table`: `true`
- `is_ocr`: `false` unless the document is scanned, image-only, or has broken text
- `language`: infer from the document/user request; use `en` for English papers and `ch` for Chinese documents
- `page_ranges`: only set when the user asks for partial conversion

For HTML input, use the API's HTML model path instead of PDF defaults.

## Conversion Workflow

For Agent Lightweight API, the helper normalizes output this way:

- downloads the Markdown result from `markdown_url`
- writes `<stem>/<stem>.md`
- writes empty asset indexes for manifest consistency
- writes `<stem>/mineru_manifest.json` with `api_mode: agent`

For Precision API, the helper normalizes API output this way:

- downloads the Precision API result zip
- keeps the raw extraction directory
- copies `full.md` or the best Markdown file to `<stem>/<stem>.md`
- copies all JSON files to `<stem>/json/`
- copies image assets to `<stem>/assets/figures/` with readable names
- rewrites Markdown image links to the readable asset paths
- writes `<stem>/assets/index.json` and `<stem>/assets/index.md`
- writes `<stem>/mineru_manifest.json`

Manifest contract:

- `primary`: default `markdown`
- `primary_path`: same as `markdown_path` for default conversions
- `markdown_path`: readable conversion result
- `json_dir` and `json_paths`: structural sidecars
- `asset_dirs` and `asset_count`: extracted assets
- `asset_index_json` and `asset_index_markdown`: human/machine lookup from friendly names to original MinerU image files and metadata
- `raw_result_dir`: untouched API archive extraction

For `D:\easyslides`, use these normalized outputs as the handoff artifacts for PPT generation. Only use the easyslides project import command when the user asks for the full easyslides import workflow, and still check that a token is configured before relying on MinerU.

```powershell
python D:\easyslides\scripts\source_to_md\mineru_preprocess.py "C:\path\document.pdf" -o "D:\easyslides\tmp\mineru"
```

## Verification

Do not claim conversion succeeded until you verify:

- the primary Markdown file exists and is non-empty
- `api_mode` in the manifest matches the route used
- at least one JSON file exists when Precision output was expected
- JSON sidecars are absent/empty when Agent Lightweight API was used
- image/assets folders are present when the document contains extractable figures or when the API returned them
- asset index exists and answers which normalized image corresponds to which original MinerU image, page, and caption/context
- the manifest exists
- logs show `done`, not `failed`, timeout, or authentication errors

If conversion fails, report the non-secret error, the API mode used, and the next recovery step.
