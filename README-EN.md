<p align="center">
  <img src="docs/assets/marx-logo-512.png" alt="MarxSphere" width="200" />
</p>

<p align="center">
  <strong>English</strong> · <a href="README.md">中文</a> · <a href="https://ldf924.github.io/MarxSphere/">📚 Docs</a>
</p>

<p align="center">
  <a href="https://github.com/LDF924/MarxSphere/actions"><img src="https://img.shields.io/github/actions/workflow/status/LDF924/MarxSphere/ci.yml?branch=main&label=CI&logo=github" alt="CI" /></a>
  <a href="https://github.com/LDF924/MarxSphere/actions"><img src="https://img.shields.io/badge/tests-736%20passed-green" alt="Tests" /></a>
  <a href="https://github.com/LDF924/MarxSphere/blob/main/BENCHMARK.md"><img src="https://img.shields.io/badge/eval-0.884-blue" alt="Eval" /></a>
  <a href="https://github.com/LDF924/MarxSphere/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPLv3-blue" alt="License" /></a>
</p>

# MarxSphere

**An AI-driven research hub for humanities & social sciences** — a complete research workbench spanning literature retrieval, knowledge graphs, AI Agents, and a desktop app.

Built on an event-centric retrieval structure (`chunk → event → entities`): literature knowledge is organized around events as semantic units, and multi-hop recall surfaces cross-document concept evolution and viewpoint connections.

**RAG architecture**: SAG event-centric hybrid retrieval-augmented generation — a four-source fusion of **SAG (event retrieval) + Graphiti (hyperedges/communities) + Cognee (HYBRID chunks) + PG (vector/lexical)**, combined with a 52-step reasoning chain for traceable, auditable research Q&A.

---

## Feature Overview

> 📖 **Full feature spec**: [docs/FEATURES-DETAILED.md](docs/FEATURES-DETAILED.md) (52-step reasoning walkthrough / 66 scenario catalog / 70-tool matrix (65 Agent + 22 view) / 17 empirical features / desktop details / eval metrics)

### 🏗 System Architecture

![MarxSphere System Architecture](docs/assets/marxsphere-architecture.svg)

### 🖼 UI at a Glance

| | | |
|---|---|---|
| **AI Chat** (default home) | **52-Step Reasoning** | **Ask Search** |
| ![AI Chat](docs/assets/sag-assistant.png) | ![Reasoning](docs/assets/sag-reason.png) | ![Ask](docs/assets/sag-ask.png) |
| **Knowledge Graph** | **Literature Library** | **Research Scenario Workbench** |
| ![Graph](docs/assets/sag-graph.png) | ![Library](docs/assets/sag-literature.png) | ![Scenarios](docs/assets/sag-scenarios.png) |
| **Agent Console** | **Empirical Workbench** | **Evaluation** |
| ![Agent](docs/assets/sag-agent-console.png) | ![Empirical](docs/assets/sag-empirical-research.png) | ![Eval](docs/assets/sag-eval.png) |

> All 43 view screenshots live in [docs/assets/](docs/assets/).

### 💬 AI Chat (Default Home)

> The AI conversation page you land on at startup — one sentence can dispatch every capability of the system.

- **Conversation sidebar**: full history list with new (Ctrl+K) / rename / delete / pin, collapsible to an icon rail
- **Message stream**: user/AI bubbles; AI replies support syntax-highlighted code blocks, KaTeX formulas, Mermaid diagrams, chart-JSON visualization, citation badges, collapsible tool-call cards, scrollable long replies
- **Thinking process**: DeepSeek reasoning chain (`reasoning_content`) shown in a dedicated fixed block (DeepSeek-style "deeply thought" collapsible area) that scrolls open in real time; three thinking-intensity levels (low / high / max)
- **Agent tool loop**: LLM plans → picks tools → executes → loops (≤12 rounds, 20 in deep mode) → streams the answer; the tool-chain panel shows each step (Chinese label + data source + latency + decision rationale)
- **70-tool dispatch**: 48 Agent tools (search/reason/empirical/writing/code/web/image/file/education/format-eval/paper-quality) + 22 view tools (policy library / knowledge pages / literature / graph / tasks / eval / alerts, etc. — full 43-view coverage)
- **Command syntax**: `/` opens the skill command palette (208 skills, searchable); `@skill:name task` loads a skill; `@tool:name task` forces a specific tool
- **Composer**: multi-line input (Enter to send / Shift+Enter for newline), model dropdown (DeepSeek / Qwen family), web-search toggle (web_search injection), deep-mode toggle (12→20 rounds), three thinking levels, attachments (image/PDF/Word/Excel/PPT/text — server parses text and injects into the LLM)
- **Vision**: SenseNova multimodal model (free quota: 1500 calls / 5h); pure-text DeepSeek models get "eyes" via a vision bridge (enable with `SENSENOVA_API_KEY`)
- **Light / dark themes**: one-click toggle in the header, persisted in localStorage
- **Empty-state home**: welcome message + hot-topic suggestions (click to ask) + core entry points (Ask / 52-step / Empirical workbench)

### 🤖 AI Agent (50+ capabilities · 87 tools · 5-layer security · 5-layer memory)

> All 50 Agent capabilities are implemented. Full capability profile: [docs/AGENT-CAPABILITIES.md](docs/AGENT-CAPABILITIES.md).

**① Core Orchestration**

| Capability | Implementation |
|---|---|
| Decision loop | plan → pick tool → execute → reflect → replan (≤3 rounds) |
| Negotiated revision | supervisor reviews worker output → issues revision → re-produce (deterministic rule fallback) |
| Plan validation | auto-fills missing write/retrieve steps; clarifies ambiguous goals first (assessGoalClarity) |
| Plan confirmation | plan shown before execution; requires human confirmation (`POST /tasks/:id/confirm-plan`) |
| Checkpoint | snapshot every round (loop/plan/failures), resume after restart (migration 069) |
| Token budget | 400K-token per-task cap, auto-terminates over budget |
| Task DAG | LLM decomposes subtasks → depends_on orchestration → concurrent queue (semaphore) → SSE progress |
| Failure handling | tool timeout circuit breaker (90s) → exponential backoff → failure feedback loop → error classification (recoverable/unrecoverable) |

**② Tool Matrix (48 Agent tools; plus 22 view tools = 70)**

| Category | Tools | Engineering |
|---|---|---|
| Cognition | sag_reason / sag_retrieve / sag_search / sag_get_event / concept_trace / policy_search / review_output / summarize / llm_write | parallel execution, LRU cache (50 entries/5min), param-schema validation, dispatch tracing, fallback chains |
| Action | empirical_analysis (real execution) / run_code (3-level sandbox) / run_command / apply_patch / file_read / file_write / web_search / web_fetch / sag_ingest / github_repo / runtime_exec | timeout breaker, degradation chains |
| Multimodal | image_analyze / audio_transcribe | attachment pre-compression |
| Collaboration | agent_subagent (external Agent dispatch) / attachment_read / code_search / todo_update | subprocess governance (orphan prevention) |

**③ Security (5 layers)**

1. **Guardian policy files** (editable, hot-reload) — risk × authorization → allow / deny / review
2. **3-level sandbox** — read-only (no network) / workspace-write (pre-authorized) / full-access (allowlist proxy)
3. **Network approval** — SSRF-high-risk domains rejected outright; non-allowlisted domains need human confirmation
4. **Approval gate** — high-risk tools four states (approve/edit/reject/respond) + autonomy levels (suggest/auto-edit/full-auto)
5. **Credential isolation** — credentials stored masked (sk-\*\*\*\*), API keys stripped from sandbox environments

**④ Memory (5 layers)**

- **Episodic memory**: research trajectories, retrievable, forgettable
- **Strategic memory**: project goals and constraints injected
- **Skill distillation**: EDV review (incl. tool usage), auto-precipitates new skills
- **Error-prevention rules**: user feedback / eval failures auto-distill (negative reviews become rules)
- **Corpus**: four sub-libraries (text/concept/logic/sentence patterns), auto-injected into Agent writing

**⑤ Scheduling & Operations**

- Concurrent queue (priority enterprise/pro/free) + DAG dependencies
- Session recovery (prefix anchors + cross-session retrieval)
- Settings persistence (presets/autonomy/sandbox level persisted + restored at startup)
- Diagnostics panel (LLM concurrency / queue / SSE / memory / subprocesses)
- Hooks lifecycle (7 events: register/unregister/timeout isolation)
- **Proactive research**: daily autonomous patrol (failed tasks / eval regressions / hotspots → new research tasks)
- **Feedback loop**: 👍👎 → error-prevention rules + memory recycle
- Notifications (completion alerts + toast) + introspection reports + failure-recovery suggestions

**⑥ Agent Evaluation**

- Regression set (gold tasks + fault injection: 429/timeout/degradation)
- 24h automated regression + pass-rate alerts
- Trajectory metrics: plan adherence / tool accuracy / reasoning quality (judge-scored)
- Learning curve + cost audit (real-time token stats)

**⑦ Learning loop**: reflect → attribute → minimal-diff patch → bad-case recycle → re-evaluate

**⑧ Reliability hardening (Agent reliability pack)**

| Capability | Implementation |
|---|---|
| **Citation verification** (citation-service.ts) | local-literature citation extraction & verification (source-level tracing, blocks forged citations) |
| **Layered context compression** (context-compressor.ts) | five layers: tool-result budget → noise removal → API-level micro-compression → archival summarization → full compression; 80% threshold + batch compression + [COMPRESSED] anti-duplication markers |
| **Fault taxonomy** (error-recovery-map.ts) | classification rules + recovery-strategy mapping; core principle: "the first question isn't whether to retry, but whether it's worth retrying" (pure functions, unit-testable) |
| **Circuit breaker** (circuit-breaker.ts) | independent breaker per recovery path + termination cap + death-spiral protection (disabled error paths never re-invoke the model's side effects) |

### 🧠 Reasoning & Retrieval

**52-step deep reasoning chain** (`Reasoning` view)
- Fully expandable chain: question classification → intent recognition → term variants → subproblem decomposition → entity extraction → Cognee 17-way coarse retrieval → Graphiti refinement → hyperedge three-way retrieval → fusion generation → self-evaluation & self-healing
- Per-step visualization: current step highlighted, live token consumption, traceable retrieval sources
- Both template / adaptive reasoning modes, conditional triggers (parallel subproblems, temporal analysis, PG entity backfill)

**Ask 18-step retrieval pipeline** (`Ask` view)
- Multi-arm recall: vectorize → alias resolution → entity extraction → entity/relation recall → event association → title vectors → multi-query variants → graph traversal
- Fusion ranking: weighted RRF → Cosine rescoring → boost chain → dedup → LLM rerank → chunk re-fetch
- Answers carry numbered citations; click through to the original chunk; the right-hand 18-step pipeline lights up step by step
- **Relation to the 52-step chain**: both share the same four-source retrieval core (SAG events + Graphiti + Cognee + PG). Ask is **lightweight, fast retrieval** (18 steps ≈ 10s); the 52-step chain is **deep reasoning** (hypothesis generation / self-evaluation / agentic search, ≈ 230s) — ask a question quickly with Ask, then drill down with 52-step

**Three-library knowledge graph** (`Graph` view)
- Graphiti: self-built corpus distilled, 21,337 entities, 1,085 knowledge communities, 11,702 hyperedges
- Cognee: 31,253 entities, 248,417 relations, 11,550 chunks (Neo4j 11003)
- PG pgvector: 7,550 chunk vectors (1024-dim) + full-text search
- Graph visualization: draggable entity/event nodes, zoom, click-to-expand, double-click details

**17 retrieval strategies**: HyDE / entity boost / keyword weighting / event expansion / temporal analysis / concept search / literature distillation, etc.

### 🔬 52-Step Reasoning Chain — Full Architecture (SAG + Graphiti + Cognee + PG four sources + hyperedge knowledge layer)

**Core positioning**: event-centric multi-source hybrid retrieval-augmented generation — a hyperedge knowledge layer that goes beyond HyperGraphRAG.

**Four-source retrieval**:

| Source | Content | Code |
|---|---|---|
| **SAG event retrieval** | event-centric structure (chunk→event→entities), 2-hop graph expansion, recursive SQL multi-hop, three-arm RRF fusion (content vector / title vector / BM25) | `search-service.ts` |
| **Cognee** | HYBRID_COMPLETION paper-chunk recall (17-way coarse retrieval: vector/lexical/graph traversal/triples/summary/subproblem/temporal/entity direct… ) | `inference-service.ts` stage2 |
| **Graphiti** | entity refinement / concept search / literature distillation / domain knowledge / entity neighbors / passage backtrack / paper tracing / DeepWalk / relation queries | `inference-service.ts` stage3 |
| **Hyperedge knowledge layer** (hyperedge layer) | hyperedge vector retrieval / hyperedge entity-directed / hyperedge BM25 / three-way RRF fusion / temporal decay | `inference-service.ts` stage3.5 |
| **PG pgvector** | 1024-dim vectors + CHUNKS lexical + full-text + SQL multi-hop | `inference-service.ts` stage2/4 |

**The full 52-step chain** (template mode; adaptive mode lets the LLM pick operators dynamically):

```
Stage 0-1  classify + outline (4 steps): question classification → intent recognition → term variants → subproblem decomposition
Stage 2    Cognee coarse retrieval (14 steps): entity extraction → Cognee HYBRID → RAG completion → graph traversal
           → relation triples → summary retrieval → subproblem reasoning → context expansion
           → temporal analysis (triggered) → PG entity backfill → PG vectors → CHUNKS lexical → semantic retrieval → entity direct
Stage 3    Graphiti refinement (9 steps): entity refinement → concept search → literature distillation → domain knowledge → entity neighbors
           → passage backtrack → paper tracing (triggered) → DeepWalk expansion (triggered) → relation queries (triggered)
Stage 3.5 Hyperedge knowledge layer (5 steps): hyperedge vector retrieval → hyperedge entity-directed → hyperedge BM25
           → three-way RRF fusion → temporal decay
Stage 4    Fusion generation (20 steps): Compiled Truth → multi-query variants → HyDE expansion (triggered) → intent-based quotas
           → three-arm RRF → Cosine rescoring → boost chain → hyperedge quota (triggered) → LLM rerank → compressed passages
           → CoT reasoning (triggered) → agentic search (triggered) → hypothesis generation → self-evaluation → confidence assessment
           → citation annotation → knowledge-page write-back (triggered) → failure degradation (triggered) → fast fallback (triggered) → response
```

**Fusion chain**: multi-arm recall → weighted RRF (intent-tuned k + Compiled Truth ×2.0 boost) → Cosine rescoring → boost chain → dedup → LLM rerank → chunk re-fetch → generation (numbered citations).

**21 ablatable operators**: 12 retrieval-stack (compiled_truth/title/cosine/dedup/alias/relational/expansion/graph_traversal/multi_query/rerank, etc.) + 9 reasoning-chain (outline/expand/candidate_papers/cognee_arm/graphiti_arm/pg_arm/entity_extract/hypothesis/evaluate) — ablation experiments verify each component's contribution.

**Reasoning modes**: template (fixed 52 steps, the eval-baseline mode) / adaptive (LLM picks operators dynamically; 4–6 steps for short questions).

### 📚 Research Scenario Workbench (66 scenarios · 8 stages)

**Full scenario catalog (S01–S66; each scenario has a business description + capability badge + step-by-step guide + full-screen workbench)**:

| Stage | Scenarios (S IDs) |
|---|---|
| **Topic ideation** (S01–S10) | research-direction generation / scientific brainstorming / research-design planning / proposal planning / literature review / systematic literature search / external academic search / research evidence pack / paper comparison matrix / citation tracing |
| **Literature research** (S11–S20) | literature relation graphs / policy-text retrieval / scientific Q&A (RAG) / multi-hop reasoning chains / teaching & research Q&A / full-text evidence finding / research-trend scanning / econometric empirical analysis / causal inference / macroeconomic modeling |
| **Data analysis** (S21–S30) | statistical inference & testing / academic paper writing / literature-review writing / polishing & rewriting / citation management / research-figure design / visualization & slides / peer-review simulation / pre-submission checks / reviewer-response drafting |
| **Paper writing** (S31–S40) | grant applications / external-literature ingestion / knowledge-base automation / Obsidian asset management / document management / core-concept tracing & semantic drift / argument-structure decomposition / multi-text intertextual comparison / obscure-text interpretation / edition collation & textual differences |
| **Theoretical debate** (S41–S50) | school-lineage panorama / core-viewpoint comparison / academic-controversy reconstruction / scholar genealogy / frontier-topic tracking / research-question refinement & gap identification / research framework & argument design / argument-chain completion & logic checks / methodology matching / counterargument & rebuttal generation |
| **Paper output** (S51–S60) | high-quality literature-review generation / paragraph expansion & polishing / standardized academic-elements generation / citation & reference formatting / multi-context style adaptation / conceptual-consistency checks / citation-accuracy verification / logical-consistency checks / academic-misconduct risk warnings / format compliance |
| **Theory expansion** (S61–S66) | premise reflection / cross-disciplinary perspectives / theory-reality connection / theoretical-innovation identification / theoretical-system construction / political-economy C-journal topic selection |

**Each scenario** = business description + unique capability badge + actions (jump to reasoning/Ask/skill/knowledge page) + full-screen workbench (input → algorithm execution → output), with step-by-step guides including concrete tool tips (e.g., S01: reasoning workbench → research-ideation skill → idea-evaluator → Ask search → reasoning verification → knowledge-page accumulation).

Political-economy C-journal methodology: four-step topic selection / topic matrix / paradox topics / concept naming / cross-disciplinary / template detection / editorial checks / foreign-review translation / journal matching (80-journal library).

### 🎓 Domain Research Engines (Classical Texts / Academic Research / Pol-Econ C-Journal / AI+Education)

**Classical text research** (S36–S40, `classical-text-service.ts`) — 5 capabilities purpose-built for classical text study:
- **Concept tracing**: historical evolution of core concepts (semanticDrift detection)
- **Argument decomposition**: automatic labeling of thesis/evidence/reasoning chains (alignParagraphs)
- **Intertextual comparison**: passage-level similarity across texts (lcsDiff)
- **Obscure-text interpretation**: layered reading of difficult sentences/concepts
- **Edition collation**: diff between versions
- Algorithms are pure computation (lcsDiff/alignParagraphs/semanticDrift) — **no LLM tokens consumed**

**Academic research** (S41–S45, `academic-research-service.ts`) — 5 panoramic capabilities:
- **School-lineage panorama**: lineage development mapping
- **Core-viewpoint comparison**: side-by-side scholar comparisons (viewpoint-clustering algorithm)
- **Academic controversy reconstruction**: event-timeline reconstruction
- **Scholar genealogy**: mentorship-chain construction
- **Frontier tracking**: hotspot & frontier identification (high-frequency terms)
- Reuses: retrieval (ILIKE + embedding) + entities graph + LLM synthesis

**Pol-econ C-journal research** (S66, `cjournal-service.ts`) — built on eight C-journal topic-selection methodologies:
- **Four-step topic selection**: era problem → pol-econ object → classical theory → intermediate mechanism (theory-interface mapping table)
- **Topic matrix**: core concept × relation object cross-generation
- **Paradox topics**: paradoxical proposition generation
- **Editorial three-criterion checks**: value/novelty/feasibility auto-assessment
- **Journal matching**: 80-journal library (67 CSSCI / 9 C-extended / 4 PKU) auto-recommendation
- **2026 topic seed library**: preloaded annual directions

**AI + Education** (84 education routes, 12 services) — an education Agent workbench (top nav "AI+Education" tab, student/teacher dual roles), deeply wired to the 52-step chain:
- **Six core capabilities**: personalized learning plans / course tutoring (hints, never answers) / learning diagnostics / preview & review / lesson planning / study companion
- **Education Agent closed loop**: Socratic questioning / scaffolded hints / wrong-question-to-mastery linkage / progress tracking / five-step polishing / idea cards / step follow-up
- **Homework closed loop**: question solving (4 modes) / wrong-question collection / variant generation / grading / wrong-question reports / discussion / quiz / lecture summary
- **Education-specific tech**: BKT cognitive diagnosis / knowledge-point prerequisite graph + topological path / ideology four-dimension audit + authority calibration
- **End-to-end auto loop**: auto-collect → diagnose → iterate → weekly report; **education multimodal**: homework photo / speech assessment / blackboard recognition
- **Reusable assets**: templates / case library / sample courses / external resource sources (school libraries, public platforms), role-scoped isolation
- Implementation: 52-step chain + four-source retrieval + citation tracing + memory injection; one-sentence invocation from AI chat (`education_service` tool, 83 actions)

**Adaptive learning system** (`adaptive-learning-service.ts`) — four layers:
- **Learning modeling**: answer history → concept mastery (mastered/fuzzy/unmastered), smoothed updates
- **Adaptive content push**: weak points → micro-lessons/examples/extension; advanced learners → harder content
- **Pacing**: difficulty/duration tuned to mastery (no repetitive or overwhelming tasks)
- **Differentiated teaching**: same concept at multiple levels (basic/advanced/challenge)

**Learning engine** ([docs/LEARNING-ENGINE.md](docs/LEARNING-ENGINE.md)) — evidence-driven adaptive learning loop:
- **Learner event ledger + BKT mastery**: append-only ledger + strong-evidence gate (only server-graded answers update BKT) + honest reads (no numbers until calibrated) + time-decay read projection + offline calibration script
- **Versioned learning plan chain**: replan only the unstarted tail (started prefix immutable) + supersede audit chain + component state machine
- **Deterministic component selector**: BKT four-stage branches (goal map → concept → diagnostic → guided practice+calibration → transfer → retrieval)
- **Material analysis snapshot**: subject/difficulty/concept candidates/page evidence/modality + augmentation decision (LLM + heuristic fallback)
- **Review tri-state + one material many artifacts**: needs_review→confirm→attach (courseware/flashcards/quiz share the pack), answers held server-side (stripped from projections)
- **Spaced repetition queue**: 4 knowledge-type interval sequences + jump/back/reset + repair-first ordering
- **Compass memory governance**: preference tri-state + 90-day TTL + candidate-confirm gate + delete-and-rebuild
- **Intent double-layer routing** (injection scan → LLM classify → low-confidence confirm) + **Quota Rotation gateway** (circuit breaker + deadline) + component whitelist
- **Full-screen learning canvas**: path/component/"why this step" evidence; E9 learning-engine panel + artifact hub
- Agent one-liner calls (`education_service` tool: plan-chain/intent/material-analyze/pref-*/reviews-* actions)

### 🖥 Desktop App (Electron + NSIS)

- Single-process architecture: `node dist/src/index.js` serves both API + frontend (zero extra dependencies)
- First-launch full bootstrap: one-click PostgreSQL (Docker) / Neo4j detection / Python probe / LLM key setup
- Automatic port avoidance (4173→4183), crash auto-restart, process-tree cleanup (taskkill /T)
- Self-extracting dependencies: node_modules.zip auto-extracted via bsdtar on first launch (installer 159MB)

### 🎯 Empirical Research Workbench (10 features)

**End-to-end workflow**: `data upload → questionnaire generation/recognition → reliability & validity tests → diagnostics → LLM imputation → variable finalization → analysis pipeline → regression modeling → evidence ledger → quality gate`

| Feature | Details |
|---|---|
| Questionnaire generation | topic → structured questionnaire (auto variable names/question types/option encoding, up to 120 items) |
| Questionnaire recognition | import existing questionnaire text → structure parsing |
| Reliability & validity | Cronbach's α / KMO / Bartlett's sphericity |
| Questionnaire diagnostics | item-quality analysis, problem detection |
| LLM imputation | paper-reproduction-grade missing-value handling (three-way: numeric/categorical/text) |
| Variable finalization | anti-hallucination allowlist + coordinate-read coefficients |
| Analysis pipeline | descriptive stats → correlation → regression modeling |
| Regression analysis | OLS progressive controls (M1–M6) / panel regression / Logit-Probit binary models (coefficient tables + 95%CI + marginal effects + R²) |
| Evidence ledger | every analysis leaves a trace (data/code/results), reproducible |
| Quality gate | pre-publication quality checks |

**Implementation**: Python sandbox (`empirical_runner.py` multi-script dispatch: reliability/imputation/pipeline/regression/diagnostics), 300s timeout protection, results include LaTeX tables + SVG coefficient plots.

### 🏛 Policy & Archive

- **Policy library**: local policy directory tree + **live gov.cn search** (via gov-cn-policy MCP: `get_latest_policies` + `get_policy_fulltext`, one-click store into the local policy library)
- **Archive**: Obsidian research-library browser (directory tree + inline md/PDF/image/Office preview + download)
- **Knowledge pages**: Compiled Truth (best understanding, human-rewritable) + timeline (evidence trail, append-only)
- **Memory management**: memory stats card (total/archived/conflicts/vectorized) + recent-memory list + sleep-learning report (10s polling)
- **Writing corpus**: four sub-libraries (text examples / core concepts / argument logic / vocabulary patterns), paste-to-accumulate + LLM-assisted extraction + tag search + pre-writing retrieval
- **Journal library**: 80 journals (67 CSSCI / 9 C-extended / 4 PKU), tier filters + hotspot expansion + one-click into the four-step topic selector

### 🛠 Custom Skills (10, fully open-sourced)

MarxSphere's 10 custom Skills ship with the repo (`skills/`), covering the full pipeline "acquisition → conversion → cleaning → ingestion → retrieval → reasoning → research dispatch":

| Skill | Function | Pipeline position |
|---|---|---|
| **cnki** | CNKI batch download (PDFs + citation network: references/citations/co-citations) | ① acquisition |
| **pdf2obsidian** | batch PDF→Obsidian conversion (1-to-6: original/summary/glossary/QA/index/info + MinerU integration) | ② conversion |
| **md-clean** | paper-MD cleaning (6-to-4: trim frontmatter, drop index/info files) | ③ cleaning |
| **marx-ingest-all** | one-command three-library ingestion (PG + Graphiti + Cognee) | ④ ingestion |
| **marx-cognee-ingest** | Cognee batch ingestion (30 papers/batch, resumable, integrity checks, cost estimation) | ④ ingestion |
| **marx-graphiti-ingest** | Graphiti batch ingestion (6 phases: entity extraction/distillation/vectorization/disambiguation/hyperedges, atomic checkpoints + 34-pitfall audit) | ④ ingestion |
| **marx-cognee** | Cognee KG retrieval (17 strategies: HYBRID/semantic/graph traversal…) | ⑤ retrieval |
| **marx-graphiti** | Graphiti knowledge retrieval (five-layer distillation + community discovery + hyperedge reasoning, 23 MCP tools) | ⑤ retrieval |
| **marx-sag** | SAG reasoning workbench (52-step chain + token capture + eval, 53-question 0.884 baseline) | ⑥ reasoning |
| **marx-agent** | Agent master entry (52-step reasoning + Ask + 66 scenarios + 208 skills) | ⑦ dispatch |

**Pipeline panorama**: `cnki acquire → pdf2obsidian convert → md-clean clean → marx-*-ingest three-library ingest → marx-cognee/marx-graphiti retrieve → marx-sag reason → marx-agent dispatch`

**Skill system (Web)**: skill registry (201 dynamically scanned) + trigger words + Skillify solidification + auto-update detection + GitHub discovery.

### 📊 Evaluation System (empirical validation of multi-source fusion)

**Method**: dual-track evaluation (rule scoring + LLM judge, three rounds, median), 53 questions in 4 types (concept definition 15 / factual retrieval 13 / multi-hop reasoning 14 / policy assessment 11), 31 scoring metrics + overall.

**31 metrics** ([full definitions](docs/SCORING_STANDARD.md)):

| Dimension | Metrics | Weight |
|---|---|---|
| A Retrieval quality (12) | context_recall / precision / relevancy / entity_utilization / mrr / ndcg / diversity / cross_doc_coverage / json_contamination / **paper_hit / paper_recall@k / source_grounded** | 0.40 |
| B Answer quality (9) | correctness / completeness / relevancy / faithfulness / hallucination_rate / consistency / citation_f1 / conciseness / readability | 0.35 |
| C Reasoning quality (3) | cot_quality / reasoning_depth / multi_hop_accuracy | 0.25 |
| D Performance (7) | 3-segment latency / end-to-end / token efficiency / Neo4j+PG query counts | observed |

**53-question scores** (`evaluation/eval_32metrics.json` + `perq.json` per-question detail):

| Metric | Score |
|---|---|
| **overall** | **0.884** |
| A Retrieval quality | 0.795 |
| B Answer quality | **0.985** |
| C Reasoning quality | 0.886 |
| Pass rate | **53/53 (100%)** |
| Highest/lowest | Q40 concept definition 0.965 / Q39 policy assessment 0.753 |

**Why four sources? — empirical evidence from 53 questions' actual retrieval contributions**:

| Source | Contribution |
|---|---|
| **Graphiti** (entities/distillation/passages) | **37.4%** |
| **PG** (vectors/entity backfill) | **36.7%** |
| **Cognee** (chunks/coarse retrieval) | **22.8%** |
| Paper location | 3.1% |

> **Conclusion**: any single retrieval technique covers at most ~1/3 of retrieval needs — pure vector RAG loses graph relations (37%), pure GraphRAG loses chunk-level semantics (23%), pure lexical search loses vector semantics (37%). **Only the four-source fusion of SAG event structure + Graphiti hyperedges + Cognee chunks + PG vectors reaches 0.884 overall.** This is the foundation of the entire research workbench — it's what makes all 66 research scenarios viable.

**Agent trajectory evaluation**: plan adherence / tool accuracy / reasoning quality (judge-scored) + learning curves
**Learning engine**: significance / attribution / trajectory prefixes / calibration (kappa=1.0) / model-swap infrastructure
**Ablation system**: 21 ablatable operators (retrieval stack 12 + reasoning chain 9), `scripts/ablation-eval.ts`
**Unit tests**: 736 green (CI continuous)

---

## Quick Start

> 🚀 Full deployment (Docker / systemd / Nginx / troubleshooting): [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

### 1. Requirements
- Node.js ≥ 20
- PostgreSQL 16 + pgvector (Docker recommended: `docker compose up -d`)
- (Optional) Python 3.12 + venv (reasoning MCP pool / empirical analysis)
- (Optional) Neo4j (Graphiti 11001 / Cognee 11003, graph enhancement)

### 2. Install & Init

```bash
git clone <your-repo-url>
cd SAG-main
npm run quickstart       # 🚀 one-command start: install deps → env check → migrate → http://localhost:4173
```

> Or step by step: `cp .env.example .env` (fill in LLM/Embedding keys) → `npm install` → `npm run db:setup` → `npm run dev`

> **PDF2Obsidian (optional)**: `cd vendor/pdf2obsidian && pnpm install && pnpm -r --filter "./packages/**" build && cd ../..`

### 3. Production

```bash
npm run build
npm start                 # http://localhost:4173
```

### 4. Desktop

```bash
npm run build:desktop     # NSIS installer: release/MarxSphere Setup <ver>.exe
npm run dev:desktop       # dev-mode Electron
```

---

## Configuration

Key `.env` entries (full list in `.env.example`):

```env
DATABASE_URL=postgres://user:pass@localhost:5432/sag_lite
LLM_API_KEY=sk-xxx            # OpenAI-compatible endpoint
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=qwen-plus
EMBEDDING_API_KEY=sk-xxx
EMBEDDING_BASE_URL=https://api.302ai.cn/v1
EMBEDDING_MODEL=text-embedding-3-large
RERANK_MODEL=qwen3-rerank
HTTP_PORT=4173
```

Optional enhancements: `COGNEE_PYTHON` (reasoning MCP venv path), `EMPIRICAL_PYTHON` (empirical venv),
`AGENT_EDGE_PATH` (browser tool), `NEO4J_PASSWORD` (graph credentials).

### Data source configuration (Literature / Policy / Archive)

The three "library" pages read **local folders** (recursively scanning PDF/MD files), pointed to via environment variables — **no Obsidian installation required**, any local folder works:

```env
# Literature: academic journal PDF directory (topic subfolders recommended; scanned and marked as ingested)
LITERATURE_DIR=D:\MyPapers\AcademicJournals
# Policy: policy/document directory (any tree)
POLICY_DIR=D:\MyPapers\PolicyDocs
# Archive: document library root (tree browsing + inline preview)
VAULT_ROOT=D:\MyPapers
```

> **Notes**:
> - **Unconfigured** defaults to `~/1.Obsidian Vault` (developer machine path) — pages show empty if missing, but **Ask search / 52-step reasoning still work** (using the bundled seed corpus)

### 📚 Seed Corpus (search immediately after clone)

The repo ships **50 papers aligned with the eval gold set** (`examples/seed-corpus/`, 1-to-6 outputs: full text + summary + glossary + QA) — no private literature needed to experience four-source retrieval:

```bash
npm run quickstart        # after the service starts
npx tsx examples/seed-corpus/ingest-seed-corpus.ts   # one-command ingest of 50 papers
# Ask search / 52-step reasoning now retrieve this corpus
# Verify with the 53 gold questions in evaluation/gold_dataset.json (npx tsx scripts/eval-32-metrics.ts)
```

> Public academic journal papers (with provenance), for demo only; request removal via Issue if you hold copyright.
> - **Recommended layout**: topic subfolders under the literature dir (e.g. `capital-rural/`, `rural-revitalization/`), PDFs named `title_author.pdf`
> - **Obsidian is optional**: pair with the `pdf2obsidian` skill to convert PDFs to Markdown for browsing; PDFs work directly without it
> - Full variable list at the bottom of `.env.example`

---

## Core Capabilities

| Capability | Description |
|---|---|
| 🧠 **52-step reasoning** | classify → 17-way coarse retrieval → Graphiti refine → hyperedge 3-way → fusion generation → self-healing |
| 🔍 **Ask 18-step search** | multi-arm recall → weighted RRF → LLM rerank → numbered citation tracing |
| 🗄 **Four-source retrieval** | SAG events + Graphiti hyperedges/communities + Cognee chunks + PG vector/lexical, RRF fusion |
| 🤖 **AI Agent** | 29 tools (incl. Notebook chart templates / desktop control) / 5-layer security / 5-layer memory / task DAG / approval gates / execution lease |
| 💰 **Auditable cost ledger** | per-turn real usage (by model / 3-state cost source) + platform cost audit panel |
| 🔀 **3-tier cost routing** | rule-first + local ML classifier (lite/deep) conservative fusion, upgrade-only, never downgrade |
| 🔁 **B5 multi-model ensemble** | hard tasks → parallel drafters + aggregator fusion, progressive results / per-draft timeout / preset & custom squads |
| 📚 **Research scenarios** | 66 scenarios × 8 stages, full-screen workbench + dedicated algorithms |
| 📊 **Empirical workbench** | questionnaire → reliability → imputation → regression (M1–M6) → evidence ledger |
| 📓 **Notebook workbench** | lightweight Jupyter: code/Markdown cells · 9 chart templates (3-line table/heatmap/box) · file upload · Restart & Run All |
| 📡 **IM integration** | Feishu / DingTalk / Telegram / WeCom bot remote chat (WeCom corp-app bidirectional incl.; config panel) |
| 🖥 **Computer Use** | desktop control: screenshot / mouse / keyboard / window list (Agent can see & act on screen) |
| 🔀 **Model-neutral** | DeepSeek / OpenAI / Anthropic Claude / Ollama / custom endpoints auto-detected |
| 🔐 **Hash versioning** | doc content dedup · eval data fingerprint · stale detection · version history · data profiling |
| 🖥 **Desktop app** | Electron + NSIS installer, first-launch guided bootstrap |
| 📈 **Evaluation** | 53-question dual-track 0.884 / 736 unit tests / 21-operator ablation / CI+E2E |

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + Vite 8 + Tailwind CSS |
| Backend | Fastify 5 + TypeScript (full-stack TS) |
| Data | PostgreSQL + pgvector + full-text + SQL multi-hop |
| Graphs | Neo4j (Graphiti communities/hyperedges + Cognee entities/chunks) |
| Agent | MCP SDK + autonomous orchestration + tool registry |
| Desktop | Electron + electron-builder (NSIS) |
| Models | OpenAI-compatible LLM / Embedding / Rerank APIs |

## Directory Structure

```text
src/                 backend source (AI/API/services/db)
web/                 frontend source (43 views · Mega Menu navigation)
electron/            desktop main process / bootstrap pages
scripts/             Python runners / eval scripts / tool scripts / launcher scripts
evaluation/          eval assets (results / gold sets / archives)
reports/             eval reports (7)
knowledge-graph/     knowledge-graph data (entities/mappings/normalization dictionaries)
docs/                documentation (architecture/spec/disclosure/usage)
migrations/          PostgreSQL schema (80+ migrations)
plugins/             Agent plugin directory
test/                unit tests (736)
vendor/              third-party components (pdf2obsidian)
data/                runtime data (gold candidates, etc.)
```

## Testing

```bash
npm test                # 736 unit tests
npm run typecheck       # frontend + backend type checks
```

## Acknowledgements (AI-assisted development)

Developed by Deng Fu (LDF924). **DeepSeek** (LLM reasoning/code generation) and **Claude Code** (AI coding agent) were used to assist writing, reviewing, and debugging. All AI-generated code was manually reviewed, tested, and verified by the developer (736 unit tests green; CI continuous; 53-question eval 0.884).

## License

**AGPL v3 + commercial dual license** (logos retained, derivatives stay open, commercial use requires license) — see [LICENSE](LICENSE).

## Compliance Disclosure

📋 [Open-Source Compliance Disclosure](docs/OPEN-SOURCE-DISCLOSURE.md) — full disclosure: runtime dependencies / risk warnings (model hallucination, missing data, API errors) / commercial API usage & costs / closed-source models & alternatives / Agent frameworks / multimodal capabilities / run verification / **data governance (data provenance & authorization, knowledge-base construction & error handling, user-data desensitization & deletion, Agent context & memory management)**.

> 📦 **Third-party source usage**: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (SAG base MIT / GBrain MIT / PDF2Obsidian MIT / Codex·DeepSeek·wisp references / Cognee·Graphiti·OpenViking integration).

> ⚠️ **Important**: this system depends on commercial LLM/Embedding APIs (metered by token). All AI-generated content **may hallucinate** — verify research conclusions against primary sources. See sections 2, 4, 5 of the [disclosure doc](docs/OPEN-SOURCE-DISCLOSURE.md).

## Docs & Verifiable Materials

| Material | Location |
|---|---|
| 📘 Project overview (users/pain points/features/Agent design/tech route/innovation/value) | [docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md) |
| ❓ FAQ | [docs/FAQ.md](docs/FAQ.md) |
| 📘 Usage (environment/deploy/permissions/workflows/examples/outputs/notes) | [docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md) §2 |
| 📘 Technical architecture (models/Agent/tools/RAG/context/workflows/data flow/architecture diagrams) | [docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md) §3 |
| 📘 Compliance disclosure (data/risks/commercial APIs/closed-source models) | [docs/OPEN-SOURCE-DISCLOSURE.md](docs/OPEN-SOURCE-DISCLOSURE.md) |
| 🔧 API docs (HTTP API / MCP) | [docs/api-reference.md](docs/api-reference.md) / [docs/agent-api.md](docs/agent-api.md) |
| 🖥 Desktop installer | `npm run build:desktop` → `release/MarxSphere Setup <ver>.exe` |
| 🐳 Database containers | `docker compose up -d` (pgvector/pgvector:pg16) |
| 📊 Screenshots | [docs/assets/](docs/assets/) (home/chat/reasoning/Ask/library/graph/scenarios/empirical/Agent/eval) |
| 📈 Sample eval reports | `reports/` (7 reports) · `evaluation/` (results + gold + archives) |
| ✅ Unit tests | `npm test` (736, CI green) |
| 🎬 Demo scripts | `scripts/demo-ingest.ts` / `demo-search.ts` / `demo-agent.ts` (CLI demos) · `examples/` (same batch) · `plugins/demo-calculator.ts` (plugin example) · frontend `ask-demo` / `reason-demo` / `learning-demo` (UI demo data) |
| 📚 Seed corpus | `examples/seed-corpus/` (50 papers aligned with the eval gold set + one-command ingestion script `ingest-seed-corpus.ts`) |
| 📄 Sample data | questionnaire: `scripts/问卷演示数据*.csv` (seed=42) · retrieval: `examples/seed-corpus/` (50 papers) · eval: `evaluation/gold_dataset.json` (53 gold Qs) · graph: `knowledge-graph/` |
| 🕸 Knowledge-graph data | `knowledge-graph/` (entity mappings / normalization dictionaries) |
