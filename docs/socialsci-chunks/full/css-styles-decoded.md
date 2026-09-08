## ChartRenderer-CdknWGyK.css
  .ade-chart-renderer { width:100%;min-height:220px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 1px 3px #0000000a }
  .ade-chart-renderer__error { padding:16px;color:#ef4444;font-size:12px;font-weight:500 }
  .ade-chart-renderer__mermaid { padding:20px;display:flex;justify-content:center;background:#fafafa }
  .ade-chart-renderer__mermaid svg { max-width:100%;height:auto }
  .ade-chart-renderer__echarts { width:100%;height:350px }

## EditorView-CkEB1QCK.css
  .ade-topbar { background:#fff;border-bottom:1px solid #e2e8f0;flex-shrink:0;position:sticky;top:0;z-index:30 }
  .ade-topbar__inner { display:flex;align-items:center;justify-content:space-between;padding:8px 16px }
  .ade-topbar__left { display:flex;align-items:center;gap:10px }
  .ade-topbar__logo { width:36px;height:36px;border-radius:2px;display:flex;align-items:center;justify-content:center;background:#2563eb;flex-shrink:0;color:#fff;font-weight:700;font-size:15px }
  .ade-topbar__title-group { display:flex;flex-direction:column }
  .ade-topbar__title { font-size:12px;font-weight:400;color:#64748b;line-height:1.3 }
  .ade-topbar__subtitle { font-size:16px;font-weight:700;color:#1e293b;line-height:1.2 }
  .ade-topbar__right { display:flex;align-items:center;gap:8px }
  .ade-topbar__new-btn { display:inline-flex;align-items:center;gap:4px;padding:5px 10px;font-size:11px;font-weight:600;border:1.5px solid #2563eb;border-radius:6px;background:#fff;color:#2563eb;cursor:pointer;transition:all .2s;white-space:nowrap;font-family:inherit }
  .ade-topbar__new-btn:hover { background:#eff6ff;color:#1d4ed8 }
  .ade-topbar__action-btn { display:inline-flex;align-items:center;gap:5px;padding:5px 10px;font-size:11px;font-weight:600;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#475569;cursor:pointer;transition:all .18s ease;white-space:nowrap }
  .ade-topbar__action-btn:hover { background:#eff6ff;border-color:#bfdbfe;color:#2563eb }
  .ade-topbar__action-btn--active { background:#eff6ff;border-color:#93c5fd;color:#2563eb }
  .ade-topbar__action-btn--active:hover { background:#dbeafe;border-color:#60a5fa;color:#1d4ed8 }
  .ade-topbar__status { font-size:12px;padding:3px 8px;border-radius:2px;font-weight:500;white-space:nowrap }
  .ade-topbar__status--green { background:#ecfdf5;color:#059669 }
  .ade-topbar__status--yellow { background:#fffbeb;color:#d97706 }
  .ade-topbar__status--gray { background:#f3f4f6;color:#9ca3af }
  .ade-document-rail { width:218px;min-width:218px;min-height:0;display:flex;flex-direction:column;border-right:1px solid #e2e8f0;background:#fff }
  .ade-document-rail__header { min-height:54px;padding:10px 10px 9px 13px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #e2e8f0 }
  .ade-document-rail__header>div { min-width:0;display:flex;align-items:baseline;gap:6px }
  .ade-document-rail__header h2 { margin:0;color:#1e293b;font-size:13px;font-weight:700 }
  .ade-document-rail__header>div span { color:#94a3b8;font-size:10px;font-variant-numeric:tabular-nums }
  .ade-document-rail__create { height:28px;padding:0 8px;display:inline-flex;align-items:center;gap:3px;border:1px solid #bfdbfe;border-radius:5px;background:#fff;color:#2563eb;font-size:11px;font-weight:650;white-space:nowrap;cursor:pointer }
  .ade-document-rail__create:hover { border-color:#2563eb;background:#eff6ff;color:#1d4ed8 }
  .ade-document-rail__list { min-height:0;padding:6px;flex:1;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent }
  .ade-document-entry { position:relative;margin-bottom:2px;border-left:2px solid transparent }
  .ade-document-entry.is-active { border-left-color:#2563eb;background:#eff6ff }
  .ade-document-entry__main { width:100%;min-height:52px;padding:8px 29px 7px 9px;display:flex;flex-direction:column;align-items:flex-start;gap:5px;border:0;background:transparent;text-align:left;cursor:pointer }
  .ade-document-entry__main:hover { background:#f8fafc }
  .ade-document-entry__title { width:100%;overflow:hidden;color:#334155;font-size:12px;font-weight:600;line-height:1.35;text-overflow:ellipsis;white-space:nowrap }
  .ade-document-entry__meta { color:#94a3b8;font-size:10px;line-height:1.2;white-space:nowrap }
  .ade-document-entry__delete { position:absolute;top:9px;right:6px;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:4px;background:transparent;color:#a1a1aa;opacity:0;cursor:pointer }
  .ade-document-entry__delete:hover { background:#fee2e2;color:#b91c1c }
  .ade-document-entry__delete svg { width:14px;height:14px }
  .ade-document-rail__empty { padding:28px 12px;color:#9ca3af;font-size:11px;text-align:center }
  .ade-ai-panel { width:var(--ade-ai-panel-width);min-width:340px;max-width:720px;display:flex;flex-direction:column;position:relative;background:#fff;border-left:1px solid #e5e7eb;flex-shrink:0;overflow:hidden }
  .ade-ai-panel__resize-handle { position:absolute;left:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:10 }
  .ade-ai-panel__resize-handle:hover { background:#334155 }
  .ade-ai-panel__header { display:flex;align-items:flex-start;justify-content:space-between;padding:14px 16px 12px;border-bottom:1px solid #e5e7eb;background:#fff }
  .ade-ai-panel__header h3 { margin:2px 0 0;font-size:15px;font-weight:700;color:#1f2937 }
  .ade-ai-panel__eyebrow { margin:0;font-size:11px;font-weight:700;color:#64748b }
  .ade-ai-panel__close { border:0;background:transparent;color:#94a3b8;font-size:22px;line-height:1;cursor:pointer }
  .ade-ai-panel__tabs { display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid #e5e7eb;background:#f8fafc;overflow-x:auto }
  .ade-ai-panel__tab { height:30px;padding:0 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:#64748b;font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer }
  .ade-ai-panel__tab:hover { background:#eef2f7;color:#334155 }
  .ade-ai-panel__tab--active { background:#eff6ff;color:#2563eb;border-color:#93c5fd }
  .ade-ai-panel__body { padding:14px 16px;overflow-y:auto;flex-shrink:0;max-height:38% }
  .ade-ai-section-intro h4 { margin:0 0 4px;font-size:14px;font-weight:700;color:#1f2937 }
  .ade-ai-section-intro p { margin:0;font-size:12px;line-height:1.6;color:#64748b }
  .ade-task-list { display:flex;flex-direction:column;gap:8px }
  .ade-task-card { display:flex;flex-direction:column;gap:4px;text-align:left;padding:11px 12px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;transition:background .15s,border-color .15s }
  .ade-task-card:hover:not(:disabled) { background:#f8fafc;border-color:#cbd5e1 }
  .ade-task-card span { font-size:13px;font-weight:700;color:#1f2937 }
  .ade-task-card small { font-size:12px;line-height:1.45;color:#64748b }
  .ade-task-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px }
  .ade-task-chip { height:34px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#334155;font-size:12px;font-weight:700;cursor:pointer }
  .ade-task-chip:hover:not(:disabled) { background:#f1f5f9 }
  .ade-result-card { margin:12px 14px 14px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;overflow:hidden;display:flex;flex-direction:column;min-height:0 }
  .ade-result-card__header { display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0 }

## EditorView-CkEB1QCK.expanded.css
  .ade-topbar { background:#fff;border-bottom:1px solid #e2e8f0;flex-shrink:0;position:sticky;top:0;z-index:30 }
  .ade-topbar__inner { display:flex;align-items:center;justify-content:space-between;padding:8px 16px }
  .ade-topbar__left { display:flex;align-items:center;gap:10px }
  .ade-topbar__logo { width:36px;height:36px;border-radius:2px;display:flex;align-items:center;justify-content:center;background:#2563eb;flex-shrink:0;color:#fff;font-weight:700;font-size:15px }
  .ade-topbar__title-group { display:flex;flex-direction:column }
  .ade-topbar__title { font-size:12px;font-weight:400;color:#64748b;line-height:1.3 }
  .ade-topbar__subtitle { font-size:16px;font-weight:700;color:#1e293b;line-height:1.2 }
  .ade-topbar__right { display:flex;align-items:center;gap:8px }
  .ade-topbar__new-btn { display:inline-flex;align-items:center;gap:4px;padding:5px 10px;font-size:11px;font-weight:600;border:1.5px solid #2563eb;border-radius:6px;background:#fff;color:#2563eb;cursor:pointer;transition:all .2s;white-space:nowrap;font-family:inherit }
  .ade-topbar__new-btn:hover { background:#eff6ff;color:#1d4ed8 }
  .ade-topbar__action-btn { display:inline-flex;align-items:center;gap:5px;padding:5px 10px;font-size:11px;font-weight:600;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#475569;cursor:pointer;transition:all .18s ease;white-space:nowrap }
  .ade-topbar__action-btn:hover { background:#eff6ff;border-color:#bfdbfe;color:#2563eb }
  .ade-topbar__action-btn--active { background:#eff6ff;border-color:#93c5fd;color:#2563eb }
  .ade-topbar__action-btn--active:hover { background:#dbeafe;border-color:#60a5fa;color:#1d4ed8 }
  .ade-topbar__status { font-size:12px;padding:3px 8px;border-radius:2px;font-weight:500;white-space:nowrap }
  .ade-topbar__status--green { background:#ecfdf5;color:#059669 }
  .ade-topbar__status--yellow { background:#fffbeb;color:#d97706 }
  .ade-topbar__status--gray { background:#f3f4f6;color:#9ca3af }
  .ade-document-rail { width:218px;min-width:218px;min-height:0;display:flex;flex-direction:column;border-right:1px solid #e2e8f0;background:#fff }
  .ade-document-rail__header { min-height:54px;padding:10px 10px 9px 13px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #e2e8f0 }
  .ade-document-rail__header>div { min-width:0;display:flex;align-items:baseline;gap:6px }
  .ade-document-rail__header h2 { margin:0;color:#1e293b;font-size:13px;font-weight:700 }
  .ade-document-rail__header>div span { color:#94a3b8;font-size:10px;font-variant-numeric:tabular-nums }
  .ade-document-rail__create { height:28px;padding:0 8px;display:inline-flex;align-items:center;gap:3px;border:1px solid #bfdbfe;border-radius:5px;background:#fff;color:#2563eb;font-size:11px;font-weight:650;white-space:nowrap;cursor:pointer }
  .ade-document-rail__create:hover { border-color:#2563eb;background:#eff6ff;color:#1d4ed8 }
  .ade-document-rail__list { min-height:0;padding:6px;flex:1;overflow-x:hidden;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent }
  .ade-document-entry { position:relative;margin-bottom:2px;border-left:2px solid transparent }
  .ade-document-entry.is-active { border-left-color:#2563eb;background:#eff6ff }
  .ade-document-entry__main { width:100%;min-height:52px;padding:8px 29px 7px 9px;display:flex;flex-direction:column;align-items:flex-start;gap:5px;border:0;background:transparent;text-align:left;cursor:pointer }
  .ade-document-entry__main:hover { background:#f8fafc }
  .ade-document-entry__title { width:100%;overflow:hidden;color:#334155;font-size:12px;font-weight:600;line-height:1.35;text-overflow:ellipsis;white-space:nowrap }
  .ade-document-entry__meta { color:#94a3b8;font-size:10px;line-height:1.2;white-space:nowrap }
  .ade-document-entry__delete { position:absolute;top:9px;right:6px;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:4px;background:transparent;color:#a1a1aa;opacity:0;cursor:pointer }
  .ade-document-entry__delete:hover { background:#fee2e2;color:#b91c1c }
  .ade-document-entry__delete svg { width:14px;height:14px }
  .ade-document-rail__empty { padding:28px 12px;color:#9ca3af;font-size:11px;text-align:center }
  .ade-ai-panel { width:var(--ade-ai-panel-width);min-width:340px;max-width:720px;display:flex;flex-direction:column;position:relative;background:#fff;border-left:1px solid #e5e7eb;flex-shrink:0;overflow:hidden }
  .ade-ai-panel__resize-handle { position:absolute;left:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:10 }
  .ade-ai-panel__resize-handle:hover { background:#334155 }
  .ade-ai-panel__header { display:flex;align-items:flex-start;justify-content:space-between;padding:14px 16px 12px;border-bottom:1px solid #e5e7eb;background:#fff }
  .ade-ai-panel__header h3 { margin:2px 0 0;font-size:15px;font-weight:700;color:#1f2937 }
  .ade-ai-panel__eyebrow { margin:0;font-size:11px;font-weight:700;color:#64748b }
  .ade-ai-panel__close { border:0;background:transparent;color:#94a3b8;font-size:22px;line-height:1;cursor:pointer }
  .ade-ai-panel__tabs { display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid #e5e7eb;background:#f8fafc;overflow-x:auto }
  .ade-ai-panel__tab { height:30px;padding:0 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:#64748b;font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer }
  .ade-ai-panel__tab:hover { background:#eef2f7;color:#334155 }
  .ade-ai-panel__tab--active { background:#eff6ff;color:#2563eb;border-color:#93c5fd }
  .ade-ai-panel__body { padding:14px 16px;overflow-y:auto;flex-shrink:0;max-height:38% }
  .ade-ai-section-intro h4 { margin:0 0 4px;font-size:14px;font-weight:700;color:#1f2937 }
  .ade-ai-section-intro p { margin:0;font-size:12px;line-height:1.6;color:#64748b }
  .ade-task-list { display:flex;flex-direction:column;gap:8px }
  .ade-task-card { display:flex;flex-direction:column;gap:4px;text-align:left;padding:11px 12px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;transition:background .15s,border-color .15s }
  .ade-task-card:hover:not(:disabled) { background:#f8fafc;border-color:#cbd5e1 }
  .ade-task-card span { font-size:13px;font-weight:700;color:#1f2937 }
  .ade-task-card small { font-size:12px;line-height:1.45;color:#64748b }
  .ade-task-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px }
  .ade-task-chip { height:34px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#334155;font-size:12px;font-weight:700;cursor:pointer }
  .ade-task-chip:hover:not(:disabled) { background:#f1f5f9 }
  .ade-result-card { margin:12px 14px 14px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;overflow:hidden;display:flex;flex-direction:column;min-height:0 }
  .ade-result-card__header { display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0 }

## FinalizeView-DLWtk8kO.css
  .merge-timeline { position:relative;width:100%;max-width:640px;margin:0 auto }
  .merge-timeline__track,.merge-timeline__progress { position:absolute;top:0;left:50%;width:2px;transform:translate(-50%) }
  .merge-timeline__track { bottom:0;background:#e5e7eb }
  .merge-timeline__progress { background:#f59e0b }
  .merge-timeline__items { position:relative;display:flex;flex-direction:column;gap:32px }
  .merge-timeline__item { position:relative;display:grid;grid-template-columns:minmax(0,1fr) 36px minmax(0,1fr);-moz-column-gap:16px;column-gap:16px;align-items:start }
  .merge-timeline__content { grid-column:3;grid-row:1;min-width:0;padding-top:6px;text-align:left }
  .merge-timeline { max-width:360px }
  body.paper-print-mode .paper-preview-modal,body.paper-print-mode .paper-preview-shell,body.paper-print-mode .paper-preview-scroll { position:static!important;display:block!important;width:auto!important;max-width:none!important;height:auto!important;min-height:0!important;margin:0!important;padding:0!important;overflow:visible!important;transform:none!important;box-shadow:none!important;background:#fff!important }
  body.paper-print-mode .paper-print-running-header { position:fixed!important;top:0!important;left:20mm!important;right:20mm!important;display:flex!important;justify-content:space-between!important;align-items:center!important;height:8mm!important;color:#555!important;font-family:SimSun,serif!important;font-size:9pt!important;line-height:1!important;visibility:visible!important;z-index:1!important }
  body.paper-print-mode .paper-preview { position:static!important;width:170mm!important;min-height:auto!important;margin:0 auto!important;padding:0!important;box-shadow:none!important;overflow:visible!important }

## InputView-D7ddvbNn.css
  .op-btn { flex-shrink:0;opacity:0;width:22px;height:22px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#9ca3af;transition:all .15s;border:none;background:transparent;cursor:pointer }
  .op-btn:hover:not(:disabled) { color:#ef4444;background:#fef2f2 }
  .op-btn-danger:hover { color:#ef4444!important;background:#fef2f2!important }
  .op-btn-sm { flex-shrink:0;opacity:0;width:18px;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#9ca3af;transition:all .15s;border:none;background:transparent;cursor:pointer }
  .op-btn-sm:hover { color:#ef4444;background:#fef2f2 }
  .tree-child { position:relative }
  .tree-child:before { content:"";position:absolute;left:-20px;top:50%;width:16px;height:1.5px;background:#e5e7eb }
  .tree-child-last:after { content:"";position:absolute;left:-21px;bottom:0;width:3px;height:50%;background:#fff;pointer-events:none }

## MaterialsView-a6ohyy1j.css
  .three-line-table { border-collapse:collapse;width:100% }
  .three-line-table th { padding:6px 10px;text-align:left;color:#1e293b;white-space:nowrap }
  .three-line-table td { padding:5px 10px;color:#334155;border:none }
  .three-line-table tbody tr:hover { background:#f8fafc }

## PaperPreview-DVOZcwe9.css
  .paper-preview { width:min(100%,860px);min-height:100%;margin:0 auto;padding:64px 76px 80px;background:#fff;color:#111;box-shadow:0 8px 28px #0f172a14;font-family:SimSun,Songti SC,STSong,"Noto Serif SC",Times New Roman,serif;font-size:12pt;line-height:1.65 }
  .paper-title { margin:0 0 32px;color:#111827;font-family:SimHei,Heiti SC,Noto Sans CJK SC,sans-serif;font-size:18pt;line-height:1.35;font-weight:700;text-align:center }
  .paper-abstract { margin:0 auto 14px;max-width:720px }
  .paper-abstract h2,.paper-references h2 { margin:0 0 8px;color:#111827;font-family:SimHei,Heiti SC,Noto Sans CJK SC,sans-serif;font-size:12pt;font-weight:700;line-height:1.5;text-align:center }
  .paper-abstract p { margin:0;font-size:10.5pt;line-height:1.65;text-align:justify;text-indent:2em }
  .paper-keywords { margin:12px auto 0;max-width:720px;font-size:10.5pt;line-height:1.65 }
  .paper-body .markdown-body,.paper-body .paper-renderer { font-size:12pt;font-family:SimSun,Songti SC,STSong,"Noto Serif SC",Times New Roman,serif }
  .paper-body p { margin:0 0 1em;line-height:1.65;text-align:justify;text-indent:2em }
  .paper-body .rf-citation { position:relative;top:-.35em;padding:0 .08em;color:inherit;font-size:.72em;line-height:0;vertical-align:baseline;text-indent:0 }
  .paper-body h1,.paper-body h2,.paper-body h3,.paper-body h4 { color:#111827;font-family:SimHei,Heiti SC,Noto Sans CJK SC,sans-serif;line-height:1.45;text-indent:0 }
  .paper-body h1 { margin:1.7em 0 .8em;font-size:14pt;text-align:left }
  .paper-body h2 { margin:1.45em 0 .65em;font-size:13pt }
  .paper-body h3 { margin:1.2em 0 .5em;font-size:12pt }
  .paper-body .rf-table-caption { display:block;max-width:92%;margin:18px auto 6px;color:#111;font-family:SimHei,Heiti SC,Noto Sans CJK SC,sans-serif;font-size:10.5pt;font-weight:700;line-height:1.5;text-align:center;text-indent:0;white-space:normal;overflow-wrap:anywhere }
  .paper-body table { width:100%;margin:0 auto 18px;border-collapse:collapse;border-top:1.5px solid #111!important;border-bottom:1.5px solid #111!important;font-size:10.5pt;text-align:center }
  .paper-body th,.paper-body td { padding:6px 9px;border:0!important;color:#111;text-align:center;vertical-align:middle }
  .paper-body figcaption,.paper-body .rf-fig-caption { color:#111;font-family:SimSun,Songti SC,STSong,"Noto Serif SC",serif;font-size:10.5pt;font-style:normal;line-height:1.5;text-align:center }
  .paper-references pre { margin:0;padding-left:2em;white-space:pre-wrap;font:inherit;font-size:10.5pt;line-height:1.65;text-indent:-2em }
  .paper-preview { padding:36px 24px 48px }
  .paper-title { font-size:22px }

## QuickModeView-sxJdb82J.css
  .vue-flow { position:relative;width:100%;height:100%;overflow:hidden;z-index:0;direction:ltr }
  .vue-flow__container { position:absolute;height:100%;width:100%;left:0;top:0 }
  .vue-flow__transformationpane { transform-origin:0 0;z-index:2;pointer-events:none }
  .vue-flow__viewport { z-index:4;overflow:clip }
  .vue-flow__edge-labels { position:absolute;width:100%;height:100%;pointer-events:none;-webkit-user-select:none;-moz-user-select:none;user-select:none }
  .vue-flow__edge-path,.vue-flow__connection-path { stroke:#b1b1b7;stroke-width:1;fill:none }
  .vue-flow__connectionline { z-index:1001 }
  .vue-flow__node { position:absolute;-webkit-user-select:none;-moz-user-select:none;user-select:none;pointer-events:all;transform-origin:0 0;box-sizing:border-box;cursor:default }
  .vue-flow__nodesselection { z-index:3;transform-origin:left top;pointer-events:none }
  .vue-flow__nodesselection-rect { position:absolute;pointer-events:all;cursor:grab }
  .vue-flow__handle { position:absolute;pointer-events:none;min-width:5px;min-height:5px }
  .vue-flow__panel { position:absolute;z-index:5;margin:15px }
  .vue-flow__edge-text { font-size:10px }
  .vue-flow__node-default,.vue-flow__node-input,.vue-flow__node-output { padding:10px;border-radius:3px;width:150px;font-size:12px;text-align:center;border-width:1px;border-style:solid;color:var(--vf-node-text);background-color:var(--vf-node-bg);border-color:var(--vf-node-color) }
  .vue-flow__nodesselection-rect,.vue-flow__selection { background:#0059dc14;border:1px dotted rgba(0,89,220,.8) }
  .vue-flow__handle { width:6px;height:6px;background:var(--vf-handle);border:1px solid #fff;border-radius:100% }
  .agent-flow-node { position:relative;box-sizing:border-box;width:190px;min-height:190px;max-height:224px;overflow:hidden;padding:11px 12px 10px;border:1px solid #d5dded;border-radius:7px;background:#fff;color:#263548;box-shadow:0 6px 18px #384c7614;cursor:grab;transition:border-color .16s,box-shadow .16s,transform .16s }
  .agent-flow-node.is-active { border-color:#7184f5;background:#fbfcff }
  .agent-flow-node.is-system-start { border-color:#56b9c0;background:#fbffff;box-shadow:0 0 0 2px #00a7b51f,0 8px 20px #3876821f }
  .node-header,.node-footer,.node-meta { display:flex;align-items:center;justify-content:space-between;gap:8px }
  .node-index { color:#73809b;font-size:9px;font-weight:750;letter-spacing:.1em }
  .node-module { color:#7e8da8;font-size:8px;font-weight:700;letter-spacing:.1em }
  .node-menu { color:#aab3c5;font-size:10px;letter-spacing:.12em }
  .node-title-row { display:flex;align-items:flex-start;gap:7px;min-height:34px;margin:12px 0 10px }
  .node-title-row strong { display:-webkit-box;overflow:hidden;font-size:12px;font-weight:700;line-height:1.45;-webkit-box-orient:vertical;-webkit-line-clamp:2 }
  .node-progress { display:flex;align-items:center;gap:7px;margin:5px 0 6px;color:#7f8ca3;font-size:9px }
  .node-progress-track { display:block;height:4px;flex:1;overflow:hidden;border-radius:5px;background:#e9edf5 }
  .node-progress-track i { display:block;height:100%;border-radius:inherit;background:#6379ed }
  .node-state { display:flex;align-items:center;gap:5px }
  .node-status-dot { width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#bdc6d5 }
  .is-active .node-status-dot { background:#647bf2;box-shadow:0 0 0 3px #647bf224 }
  .is-done .node-status-dot { background:#43a18d }
  .is-error .node-status-dot { background:#d75e5e }
  .node-meta { padding:4px 0;color:#9aa6b8;font-size:9px }
  .node-value { max-width:108px;overflow:hidden;color:#66758c;text-overflow:ellipsis;white-space:nowrap }
  .node-footer { margin-top:8px;padding-top:8px;border-top:1px solid #edf0f5;color:#8290a8;font-size:9px }
  .node-hint { margin-top:7px;color:#6379ed;font-size:9px;line-height:1.4 }
  .node-execution-detail { margin-top:6px;color:#6379ed;font-size:9px;line-height:1.35 }
  .node-output-preview { max-height:54px;margin-top:6px;overflow:hidden;padding:6px 7px;border-left:2px solid #9aaaf0;background:#f5f7ff;color:#68758d;font-size:9px;line-height:1.45 }
  .node-arrow { color:#7387ec;font-size:13px }
  .flow-handle { width:8px;height:8px;border:2px solid #fff;background:#7184f5;box-shadow:0 0 0 1px #7184f5 }
  .agent-flow-canvas { position:relative;min-height:0;height:100%;overflow:hidden;background:#f0f8ff }
  .agent-flow-canvas.is-expanded { height:100%;border:0;border-radius:0 }
  .agent-flow { width:100%;height:100%;background:#f0f8ff }
  .flow-toolbar { position:absolute;z-index:4;top:0;left:0;right:0;display:flex;align-items:center;gap:8px;min-height:36px;padding:0 14px;border-bottom:1px solid rgba(190,211,229,.8);background:#f0f8fff0;pointer-events:none }
  .flow-zone-chip { display:inline-flex;align-items:center;min-height:20px;padding:0 8px;border-left:2px solid #00bfc4;color:#577187;font-size:10px;font-weight:700;letter-spacing:.04em }
   .vue-flow__background { background:#f0f8ff }
   .vue-flow__minimap { right:12px;bottom:12px;border:1px solid #d6deec;border-radius:5px;background:#ffffffe6 }
   .vue-flow__controls-button { width:26px;height:26px;border-bottom-color:#e4e8f0;background:#fff }
  body { background:#edf1f6 }
  .quick-view { --ink: #172235;--muted: #7c879a;--line: #dce2ec;--soft: #f5f7fb;--blue: #6379ed;height:100%;min-height:0;width:calc(100% + 48px);margin:-20px -24px;display:flex;flex-direction:column;overflow:hidden;background:#f3f5f8;color:var(--ink) }
  .quick-header { z-index:4;display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:62px;padding:10px 22px;border-bottom:1px solid #dfe4ec;background:#fffffff5 }
  .brand-lockup,.agent-identity,.agent-name-row,.canvas-caption-title,.drawer-title-row,.message-meta,.progress-heading { display:flex;align-items:center }
  .brand-lockup { gap:11px;min-width:240px }
  .brand-mark,.agent-avatar { display:grid;place-items:center;background:#1d2b48;color:#fff;font-weight:800 }
  .brand-mark { width:32px;height:32px;border-radius:8px;font-size:13px }
  .brand-lockup h1 { font-size:15px;letter-spacing:.01em }
  .brand-lockup p { margin-top:3px;color:var(--muted);font-size:10px }
  .mode-tabs { display:flex;gap:2px;padding:3px;border:1px solid #e4e8ef;border-radius:7px;background:#f3f5f8 }
  .mode-tab { padding:6px 15px;border-radius:5px;color:#7b8699;font-size:11px;text-decoration:none }

## ReviewView-gnBufk0W.css
  .docx-annotation-rect { background:#facc1547;box-shadow:inset 0 -2px #d97706d9;border-radius:2px;transition:background-color .15s,box-shadow .15s }
  .docx-annotation-rect:hover { background:#fbbf2480 }
  .docx-annotation-rect.is-active { z-index:1;background:#f871716b;box-shadow:inset 0 -2px #dc2626e6 }
  .pdf-annotation-rect { background:#facc154d;box-shadow:inset 0 -2px #d97706d9;border-radius:2px;transition:background-color .15s,box-shadow .15s }
  .pdf-annotation-rect:hover { background:#fbbf2480 }
  .pdf-annotation-rect.is-active { background:#f871716b;box-shadow:inset 0 -2px #dc2626e6 }
  .annotation-highlight { background-color:#fef08a99;border-bottom:2px solid #f59e0b;cursor:pointer;padding:0 1px;border-radius:2px;transition:background-color .15s,border-color .15s }
  .review-history-rail { position:sticky;top:0;align-self:stretch;width:218px;min-width:218px;max-height:calc(100vh - 136px);display:flex;flex-direction:column;border-right:1px solid #e2e8f0;background:#fff;overflow:hidden }
  .review-history-rail__header { min-height:54px;padding:10px 10px 9px 13px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #e2e8f0 }
  .review-history-rail__header h2 { margin:0;color:#1e293b;font-size:13px;font-weight:700 }
  .review-history-rail__header span { color:#94a3b8;font-size:10px;font-variant-numeric:tabular-nums }
  .review-history-rail__list { min-height:0;padding:6px;flex:1;overflow-x:hidden;overflow-y:auto }
  .review-history-entry { position:relative;margin-bottom:2px;border-left:2px solid transparent }
  .review-history-entry.is-active { border-left-color:#2563eb;background:#eff6ff }
  .review-history-entry__main { width:100%;min-height:52px;padding:8px 9px 7px;display:flex;flex-direction:column;gap:5px;border:0;background:transparent;text-align:left;cursor:pointer }
  .review-history-entry__main:hover:not(:disabled) { background:#f8fafc }
  .review-history-entry__title { width:100%;overflow:hidden;color:#334155;font-size:12px;font-weight:600;line-height:1.35;text-overflow:ellipsis;white-space:nowrap }
  .review-history-entry__meta { width:100%;display:flex;align-items:center;justify-content:space-between;gap:6px;color:#94a3b8;font-size:10px;font-variant-numeric:tabular-nums }
  .review-history-entry__status { display:inline-flex;align-items:center;gap:4px;white-space:nowrap }
  .review-history-entry__status i { width:5px;height:5px;border-radius:50%;background:currentColor }
  .review-history-entry__retry { position:absolute;right:7px;bottom:5px;padding:1px 3px;border:0;background:#fff;color:#2563eb;font-size:10px;cursor:pointer }
  .review-history-rail__empty { padding:28px 12px;color:#94a3b8;font-size:11px;text-align:center }
  .review-history-rail { position:static;width:100%;min-width:0;max-height:none;padding:0 0 12px;display:block;border-right:0;border-bottom:1px solid #e5e7eb }
  .review-history-rail__list { max-height:none;display:flex;gap:5px;overflow-x:auto;overflow-y:hidden }
  .review-history-entry { width:172px;min-width:172px;margin-bottom:0 }
  .review-workspace { width:100%;max-width:none;margin-left:0;margin-right:0;padding-left:0;padding-right:0;display:flex;align-items:flex-start;gap:0 }
  .review-workspace__main { min-width:0;padding-left:22px;flex:1 }
  .review-workspace { width:100%;padding-left:16px;padding-right:16px;flex-direction:column;gap:16px }
  .review-workspace__main { width:100%;padding-left:0 }

## ReviewView-gnBufk0W.expanded.css
  .docx-annotation-rect { background:#facc1547;box-shadow:inset 0 -2px #d97706d9;border-radius:2px;transition:background-color .15s,box-shadow .15s }
  .docx-annotation-rect:hover { background:#fbbf2480 }
  .docx-annotation-rect.is-active { z-index:1;background:#f871716b;box-shadow:inset 0 -2px #dc2626e6 }
  .pdf-annotation-rect { background:#facc154d;box-shadow:inset 0 -2px #d97706d9;border-radius:2px;transition:background-color .15s,box-shadow .15s }
  .pdf-annotation-rect:hover { background:#fbbf2480 }
  .pdf-annotation-rect.is-active { background:#f871716b;box-shadow:inset 0 -2px #dc2626e6 }
  .annotation-highlight { background-color:#fef08a99;border-bottom:2px solid #f59e0b;cursor:pointer;padding:0 1px;border-radius:2px;transition:background-color .15s,border-color .15s }
  .review-history-rail { position:sticky;top:0;align-self:stretch;width:218px;min-width:218px;max-height:calc(100vh - 136px);display:flex;flex-direction:column;border-right:1px solid #e2e8f0;background:#fff;overflow:hidden }
  .review-history-rail__header { min-height:54px;padding:10px 10px 9px 13px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #e2e8f0 }
  .review-history-rail__header h2 { margin:0;color:#1e293b;font-size:13px;font-weight:700 }
  .review-history-rail__header span { color:#94a3b8;font-size:10px;font-variant-numeric:tabular-nums }
  .review-history-rail__list { min-height:0;padding:6px;flex:1;overflow-x:hidden;overflow-y:auto }
  .review-history-entry { position:relative;margin-bottom:2px;border-left:2px solid transparent }
  .review-history-entry.is-active { border-left-color:#2563eb;background:#eff6ff }
  .review-history-entry__main { width:100%;min-height:52px;padding:8px 9px 7px;display:flex;flex-direction:column;gap:5px;border:0;background:transparent;text-align:left;cursor:pointer }
  .review-history-entry__main:hover:not(:disabled) { background:#f8fafc }
  .review-history-entry__title { width:100%;overflow:hidden;color:#334155;font-size:12px;font-weight:600;line-height:1.35;text-overflow:ellipsis;white-space:nowrap }
  .review-history-entry__meta { width:100%;display:flex;align-items:center;justify-content:space-between;gap:6px;color:#94a3b8;font-size:10px;font-variant-numeric:tabular-nums }
  .review-history-entry__status { display:inline-flex;align-items:center;gap:4px;white-space:nowrap }
  .review-history-entry__status i { width:5px;height:5px;border-radius:50%;background:currentColor }
  .review-history-entry__retry { position:absolute;right:7px;bottom:5px;padding:1px 3px;border:0;background:#fff;color:#2563eb;font-size:10px;cursor:pointer }
  .review-history-rail__empty { padding:28px 12px;color:#94a3b8;font-size:11px;text-align:center }
  .review-history-rail { position:static;width:100%;min-width:0;max-height:none;padding:0 0 12px;display:block;border-right:0;border-bottom:1px solid #e5e7eb }
  .review-history-rail__list { max-height:none;display:flex;gap:5px;overflow-x:auto;overflow-y:hidden }
  .review-history-entry { width:172px;min-width:172px;margin-bottom:0 }
  .review-workspace { width:100%;max-width:none;margin-left:0;margin-right:0;padding-left:0;padding-right:0;display:flex;align-items:flex-start;gap:0 }
  .review-workspace__main { min-width:0;padding-left:22px;flex:1 }
  .review-workspace { width:100%;padding-left:16px;padding-right:16px;flex-direction:column;gap:16px }
  .review-workspace__main { width:100%;padding-left:0 }

## StatisticsView-huzBM7kl.css
  .statistics-page { width:100%;overflow-x:auto }
  .statistics-workspace { height:calc(100dvh - 180px);min-height:520px }
  .statistics-page>* { min-width:1080px }
  .cat-title { font-size:11px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;padding-left:4px;display:flex;align-items:center;gap:6px }
  .method-grid { display:grid;grid-template-columns:1fr 1fr;gap:5px }
  .method-item { padding:7px 6px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:7px;cursor:pointer;color:#64748b;font-size:11.5px;text-align:center;transition:all .2s ease }
  .method-item:hover { background:#e8eaf6;color:#1e293b;border-color:#6366f1;transform:translateY(-1px) }
  .method-item.active { background:#6366f1;color:#fff;border-color:#6366f1;box-shadow:0 3px 10px #6366f14d }
  .global-upload-bar { display:flex;align-items:center;gap:10px;padding:10px 14px;background:linear-gradient(135deg,#f0f4ff,#faf5ff);border:2px dashed #c7d2fe;border-radius:8px;cursor:pointer;transition:all .2s;margin:12px }
  .global-upload-bar.dragover { border-color:#6366f1;background:#eef2ff;transform:scale(1.01) }
  .global-upload-bar.loaded { border-style:solid;border-color:#10b981;background:#10b9810a }
  .upload-icon-sm { font-size:18px;flex-shrink:0 }
  .upload-label-sm { font-size:13px;color:#64748b;white-space:nowrap }
  .file-name-display-sm { font-size:12px;font-weight:600;color:#10b981;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
  .panel-section-sm { padding:14px;background:#f8fafc;border-radius:10px;border-left:3px solid #f97316 }
  .section-title-sm { font-size:12px;font-weight:600;color:#1e293b;margin-bottom:0;text-transform:uppercase;letter-spacing:.3px }
  .checkbox-group-sm { display:flex;flex-direction:column;gap:5px }
  .radio-group-sm { display:flex;flex-direction:column;gap:6px }
  .var-icon-sm { width:18px;text-align:center;font-size:12px }
  .type-badge-sm { font-size:9px;padding:1px 6px;border-radius:4px;font-weight:500 }
  .type-badge-sm.scale { background:#3b82f626;color:#3b82f6 }
  .type-badge-sm.nominal { background:#6366f126;color:#6366f1 }
  .var-item-mb:hover { background:#f8fafc;color:#1e293b }
  .var-item-mb.selected { background:#6366f11f;color:#6366f1;font-weight:500 }
  .btn-run-mb { background:#fff!important;border:1px solid #9bb8d8!important;color:#1e4d8c!important }
  .results-header-mb { background:#f8fafc }
  .results-body-mb { background:#fff }
  .welcome-screen-mb { height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center }
  .welcome-icon-sm { font-size:56px;opacity:.7 }
  .spinner-mb { width:40px;height:40px;border:3px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:spin-38a82752 .8s linear infinite }
  .warning-bar-mb { padding:10px 14px;background:#f59e0b1a;border:1px solid rgba(245,158,11,.3);border-radius:8px }
  .three-line-table-mb { font-size:12.5px;border-collapse:collapse;width:100% }
  .three-line-top th { border-top:2px solid #1e293b;border-bottom:1px solid #475569;padding:8px 14px;font-weight:600;font-size:12px;text-align:left;color:#1e293b;white-space:nowrap }
  .three-line-table-mb td { padding:6px 14px;color:#334155;border:none }
  .even-row-mb td { background:#f8fafc }
  .three-line-bottom td { border-top:2px solid #1e293b;padding:0;line-height:0;font-size:0 }
  .item-export-bar-mb { display:flex;align-items:center;gap:6px;justify-content:flex-end }
  .btn-export-mini-mb { display:inline-flex;align-items:center;gap:3px;padding:4px 10px;border-radius:5px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;transition:all .15s }
  .btn-export-mini-mb:hover { background:#6366f1;color:#fff;border-color:#6366f1 }
  .btn-report-mb { background:#fff!important;border:1px solid #9bb8d8!important;color:#1e4d8c!important }
  .btn-pdf-mb { background:#fff!important;border:1px solid #9bb8d8!important;color:#1e4d8c!important }
  .btn-run-mb:hover,.btn-report-mb:hover,.btn-pdf-mb:hover { background:#eef4fa!important;border-color:#1e4d8c!important;color:#173a6a!important }
  .method-item.active { background:#eef4fa!important;border-color:#9bb8d8!important;color:#1e4d8c!important;box-shadow:none!important }
  .chart-container-mb { background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px }
  .chart-title-sm { font-size:13px;font-weight:600;color:#1e293b }
  .chart-plot-area { min-height:350px }
  ::-webkit-scrollbar { width:5px;height:5px }
  ::-webkit-scrollbar-thumb { background:#e2e8f0;border-radius:3px }
  ::-webkit-scrollbar-thumb:hover { background:#94a3b8 }

## VizView-D_KoFWB6.css
  .thinking-trace { width:min(100%,520px);margin:4px 0 8px;color:#526174 }
  .goal-line { display:flex;align-items:center;gap:8px;min-height:28px;padding:3px 4px;background:#fff }
  .goal-rule { width:16px;height:2px;flex:0 0 16px;background:#9aa9ba }
  .goal-text { color:#34445a;font-size:12px;font-weight:600;line-height:1.45 }
  .thinking-header { display:flex;align-items:center;gap:6px;width:100%;min-height:26px;padding:3px 7px;border:0;background:#f5f6f8;color:#526174;font-size:11px;text-align:left;cursor:pointer }
  .thinking-chevron { width:12px;height:12px;transition:transform .16s ease }
  .thinking-state { margin-left:auto;color:#94a3b8;font-size:10px }
  .thinking-body { max-height:138px;margin:0;overflow-y:auto;padding:5px 8px 7px;border-top:1px solid #e5e8ec;background:#f5f6f8;scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent }
  .thinking-entries { display:grid;gap:5px }
  .thinking-entry,.thinking-waiting { display:flex;align-items:center;gap:7px;min-height:20px;color:#7c8795;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px }
  .thinking-waiting { padding:5px 8px;background:#f5f6f8 }
  .entry-title { flex:0 0 auto;color:#5f6c7b;line-height:1.35 }
  .entry-detail { min-width:0;overflow:hidden;color:#97a1ad;line-height:1.35;text-overflow:ellipsis;white-space:nowrap }
  .command-cursor { width:6px;height:11px;flex:0 0 6px;background:#788798;animation:command-blink-8281c8a5 .8s steps(1,end) infinite }
  .viz-chat-panel-v2 { height:100% }
  .viz-task-window { scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent }
  .viz-page { width:calc(100% + 48px);height:calc(100% + 40px);max-height:calc(100% + 40px);min-height:0;margin:-20px -24px;overflow:auto;font-family:PingFang SC,Microsoft YaHei,sans-serif }
  .viz-workbench { width:max(100%,1024px);height:100%;overflow:hidden }
  .viz-page { width:calc(100% + 24px);height:calc(100% + 24px);max-height:calc(100% + 24px);margin:-12px }

## WorkspaceView-BbOF6Urj.css
  .workspace-container { flex:1;min-height:0 }