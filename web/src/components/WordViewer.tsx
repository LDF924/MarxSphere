// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// WordViewer.tsx — .docx / .doc 预览(2026-10-03)
//
// 由来(用户: 「.docx、.doc 无法读取和显现出来进行查看」):
//   · .docx 此前被当作**纯文本**渲染 —— 上游给的是 HTML(mammoth), 而预览器直接
//     `<MarkdownReader content={html}>`, 于是屏幕上出现的是一堆 `<p>甲方</p>` 标签。
//   · .doc 此前**根本没有入口** —— 全链路写着"请另存为 .docx", 而资料库里 .doc 比 .docx 还多。
//
// 现在两条都走服务端解析(/api/preview/parse):
//   · .docx → 结构化 HTML(标题/段落/粗斜体/表格), 在这里注入并在**受限容器**里渲染;
//   · .doc  → 纯文本(旧二进制格式取不到版式), 按段落渲染并如实标注"版式不还原"。
//
// ⚠ 为什么不直接把服务端返回的 HTML 丢进 dangerouslySetInnerHTML:
//   解析结果里虽然只有我们自己生成的标签, 但**正文文本**可能包含 `<script>` 这类字面量
//   (研究人员引用 HTML 代码是常见的事)。本仓是自托管研究平台, 这份内容还会被其他用户
//   (同实例的协作者)打开, 所以按"内容不可全信"处理: 用 DOMPurify 白名单过滤后再注入。
//   白名单只放我们**真的会生成**的标签 —— 生成器加了新标签而这里没放开会表现为"某部分不显示",
//   所以两处必须一起改。
import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { AlertTriangle, FileText, Loader2 } from "lucide-react";

const ALLOWED_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "table", "tr", "td", "br"];
const ALLOWED_ATTR = ["class"];

type State =
  | { kind: "loading" }
  | { kind: "html"; html: string }
  | { kind: "text"; text: string }
  | { kind: "err"; message: string };

export function WordViewer({ path: vaultPath, fileId, fileName }: {
  path?: string;
  fileId?: string;
  fileName: string;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        // ⚠ 必须带鉴权头 —— 这个端点在全局鉴权中间件后面(局域网/远程部署下裸 fetch 一律 401)。
        //   与 SheetViewer / DiagramViewer 用同一段取值: 优先 skf_auth_token, 退回 sag_token。
        //   我第一版漏了它, 实测表现是"点开 Word 什么都不出来", 也没有任何报错。
        const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
        const r = await fetch("/api/preview/parse", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(vaultPath ? { path: vaultPath } : { fileId }),
        });
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok || d?.ok === false) {
          setState({ kind: "err", message: String(d?.error ?? `解析失败(HTTP ${r.status})`) });
          return;
        }
        if (typeof d?.html === "string") setState({ kind: "html", html: d.html });
        else if (typeof d?.text === "string") setState({ kind: "text", text: d.text });
        else setState({ kind: "err", message: "解析结果里既没有正文也没有 HTML" });
      } catch (e) {
        if (!cancelled) setState({ kind: "err", message: String((e as Error)?.message ?? e).slice(0, 160) });
      }
    })();
    return () => { cancelled = true; };
  }, [vaultPath, fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "loading") {
    return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />解析 Word 文档…
    </div>;
  }
  if (state.kind === "err") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <AlertTriangle className="h-7 w-7 text-amber-400" />
        <div className="text-sm font-medium">{fileName}</div>
        <div className="max-w-md text-xs text-muted-foreground">{state.message}</div>
        <div className="text-[11px] text-muted-foreground/70">可以先用右上角「下载」在本地打开。</div>
      </div>
    );
  }

  // .doc: 旧二进制格式只取得到正文, 版式(字号/页边距/表格线)不在提取范围内
  if (state.kind === "text") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mb-3 flex items-rec gap-1.5 rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200/90">
          <FileText className="h-3 w-3 shrink-0" />
          旧版 .doc：这里只提取**正文文字**，字号、页边距、表格线等版式不还原。要看原样请下载后用 Word 打开。
        </div>
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90" data-control="preview:word-body">{state.text}</div>
      </div>
    );
  }

  const clean = DOMPurify.sanitize(state.html, { ALLOWED_TAGS, ALLOWED_ATTR });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
      {/**
        * 排版用 Tailwind 的任意变体写在容器上, 而不是给解析结果挂 class ——
        * 解析器只输出语义标签(p/h1-6/table), 观感由这里一套规则统管。
        * 字号按"阅读"而不是"还原"给: 用户看的是内容, 屏幕宽度也不是 A4。
        */}
      <div
        className={[
          "max-w-3xl text-sm leading-relaxed text-foreground/90",
          "[&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-foreground",
          "[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground",
          "[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-foreground",
          "[&_h4]:mb-1.5 [&_h4]:mt-3 [&_h4]:font-semibold [&_h4]:text-foreground",
          "[&_h5]:mb-1.5 [&_h5]:mt-3 [&_h5]:font-medium [&_h5]:text-foreground [&_h6]:mb-1.5 [&_h6]:mt-3 [&_h6]:font-medium",
          "[&_p]:my-2 [&_p.docx-li]:my-1 [&_p.docx-li]:pl-3",
          "[&_strong]:font-semibold [&_strong]:text-foreground",
          "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
          "[&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
        ].join(" ")}
        data-control="preview:word-body"
        dangerouslySetInnerHTML={{ __html: clean }}
      />
    </div>
  );
}

export default WordViewer;
