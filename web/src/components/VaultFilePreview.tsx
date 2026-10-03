// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// VaultFilePreview.tsx — 统一的「选文件 → 看内容」分派器(2026-10-02)
//
// 由来: 改前这套分派**被复制了三遍**(VaultPanel / PolicyPanel / EducationPanel),
//   各自维护一份 PREVIEWABLE_EXT 与五个手写 state, 且都把"不是 md/pdf/图片"的文件
//   一律报成「Office 文档（Word/Excel/PPT）浏览器不支持内联预览」——
//   对 csv / geojson / shp / kml / drawio 来说这句**是错的**, 用户按提示去用
//   Word 打开一个 .kml 只会更困惑。
//
// 现在: 类型判断收敛到 lib/file-kind.ts, 预览分派收敛到这里, 三个面板只负责
// "给一个 path/name"和"显示我自己的空态"。
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Download, FileText, Loader2, X } from "lucide-react";
import { api } from "../lib/api";
import { fetchBinaryObjectUrl } from "../lib/authed-image";
import { fileKind, unsupportedReason, type FileKind } from "../lib/file-kind";
import { PdfReader } from "./PdfReader";
import { MarkdownReader } from "./MarkdownReader";
import { SheetViewer, CsvViewer } from "./SheetViewer";
import { SlideViewer } from "./SlideViewer";
import { DiagramViewer } from "./DiagramViewer";
import { GeoViewer } from "./GeoViewer";
import { WordViewer } from "./WordViewer";

/** 下载链接 —— 三条路径(资料库 / 上传文件 / 无)统一成一个 */
function downloadHref(opts: { path?: string; fileId?: string }): string {
  if (opts.path) return `/api/vault/binary?path=${encodeURIComponent(opts.path)}&download=1`;
  if (opts.fileId) return `/api/files/${encodeURIComponent(opts.fileId)}/content?download=1`;
  return "#";
}

/** 加载中 / 出错 —— 两个面板都要同一种观感 */
function CenterNote({ icon, title, detail }: { icon: ReactNode; title: string; detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {icon}
      <div className="max-w-sm text-sm font-medium">{title}</div>
      {detail ? <div className="max-w-md text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export function VaultFilePreview({ path: vaultPath, fileId, name, onClose, headerExtra }: {
  /** 资料库内路径(与 fileId 二选一) */
  path?: string;
  fileId?: string;
  name: string;
  onClose: () => void;
  headerExtra?: ReactNode;
}) {
  const kind: FileKind = fileKind(name);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  /** 文本类内容(md/txt/csv/json/geojson/kml/gpx 都是读同一份字节) */
  const [text, setText] = useState("");
  /** PDF/图片用 object URL */
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(""); setBinaryUrl(null); setErr(""); setLoading(false);
    const wantsBinary = kind === "pdf" || kind === "image";
    const wantsText = kind === "markdown" || kind === "text" || kind === "csv" || kind === "geo";
    // 结构化预览(sheets/slides/diagram)由各自的 viewer 自己发 /api/preview/parse ——
    // 它们要的是 fileId/path 而不是内容, 在这里先拉一遍反而多一次往返
    if (!wantsBinary && !wantsText) return;

    setLoading(true);
    (async () => {
      try {
        if (wantsBinary) {
          if (!vaultPath) { setErr("该来源暂不支持二进制预览"); return; }
          // 带鉴权取成 object URL —— 裸路径进 <img>/<iframe> 带不了 Authorization 头,
          // 该端点被全局鉴权中间件挡住(实测局域网 IP 401) → 远程部署下预览全白
          const url = await fetchBinaryObjectUrl(`/api/vault/binary?path=${encodeURIComponent(vaultPath)}`);
          if (!cancelled) setBinaryUrl(url);
          return;
        }
        // 文本: 资料库走 getVaultFile(直接返回 content), 上传文件走 /content
        if (vaultPath) {
          const data = await api.getVaultFile(vaultPath);
          if (!cancelled) setText(data.file.content);
        } else if (fileId) {
          const token = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
          const t = await fetch(`/api/files/${encodeURIComponent(fileId)}/content`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }).then((r) => r.text());
          if (!cancelled) setText(t);
        } else {
          setErr("没有可读取的来源");
        }
      } catch (e) {
        if (!cancelled) setErr(String((e as Error)?.message ?? e).slice(0, 160));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [vaultPath, fileId, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = (() => {
    /**
     * ⚠ 2026-10-03: `.doc` 从"看不了"变成**能看**(旧版 .doc 由服务端提取正文)。
     *   `legacy-doc` 仍在 FileKind 里(它确实是个特殊类型 —— 版式不还原), 但它现在
     *   和 `word` 走同一个 viewer, 所以不再落进下面那条"不支持"分支。
     */
    if (kind === "download-only") {
      return (
        <CenterNote
          icon={<AlertTriangle className="h-8 w-8 text-amber-400" />}
          title={name}
          detail={unsupportedReason(name)}
        />
      );
    }
    if (kind === "sheets") return <SheetViewer path={vaultPath} fileId={fileId} fileName={name} />;
    if (kind === "slides") return <SlideViewer path={vaultPath} fileId={fileId} fileName={name} />;
    if (kind === "diagram") return <DiagramViewer path={vaultPath} fileId={fileId} fileName={name} />;
    // Word(.docx 结构化 / .doc 纯文本) —— 服务端解析, 见 WordViewer 的说明
    if (kind === "word" || kind === "legacy-doc") return <WordViewer path={vaultPath} fileId={fileId} fileName={name} />;
    if (loading) return <CenterNote icon={<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />} title="读取文件…" />;
    if (err) return <CenterNote icon={<AlertTriangle className="h-6 w-6 text-amber-400" />} title={name} detail={err} />;
    if (kind === "pdf") {
      // PDF → PdfReader 深度阅读（xl+: flex-1 填满详情列; 窄屏: 固定高度防 Viewport 高度循环塌陷）
      return <div className="min-h-0 flex-1 max-lg:h-[50vh]"><PdfReader source={binaryUrl ?? ""} fileName={name} /></div>;
    }
    if (kind === "image") {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          {binaryUrl ? <img src={binaryUrl} alt={name} className="max-h-full max-w-full object-contain" /> : null}
        </div>
      );
    }
    if (kind === "csv") return <CsvViewer text={text} fileName={name} />;
    if (kind === "geo") return <GeoViewer text={text} fileName={name} />;
    // markdown / text / word 都是文本渲染(word 由服务端 mammoth 抽过之后落在这条)
    return <div className="min-h-0 flex-1 overflow-y-auto"><MarkdownReader content={text} /></div>;
  })();

  return (
    <div className="flex min-h-full flex-col">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{name}</span>
          {headerExtra}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={downloadHref({ path: vaultPath, fileId })}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <Download className="h-3 w-3" /> 下载
          </a>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
            title="关闭预览"
          >
            <X className="h-3 w-3" /> 关闭
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  );
}

export default VaultFilePreview;
