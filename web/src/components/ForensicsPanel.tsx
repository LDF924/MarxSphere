// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ForensicsPanel.tsx — 论文取证面板(integrity-auditor forensics_tools 前端, ai4s MIT)
// 图像查重(上传 ≥2 图)+ 数值取证(上传 xlsx/数值表, decimal/magnitude/aggregate 三模式)
import { useRef, useState } from "react";
import { ImageIcon, Loader2, ScanSearch, Table2, X } from "lucide-react";

interface UploadedFile { name: string; base64: string }

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function RawOutput({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false);
  if (!raw) return null;
  const flagged = (raw.match(/★|FLAG|flag|WARN|可疑|不一致|重复/g) ?? []).length;
  return (
    <div className="mt-2 rounded-md border border-border/60 bg-background/50">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground">
        <ScanSearch className="h-3.5 w-3.5" /> 取证输出
        <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-300">{flagged} 处疑似标记</span>
        <span className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && <pre className="max-h-64 overflow-auto border-t border-border/50 p-3 font-mono text-[10px] leading-4 text-muted-foreground">{raw}</pre>}
    </div>
  );
}

export function ForensicsPanel() {
  const [mode, setMode] = useState<"image" | "numeric">("image");
  const [numMode, setNumMode] = useState<"decimal" | "magnitude" | "aggregate">("decimal");
  const [images, setImages] = useState<UploadedFile[]>([]);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const imgRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addImages = async (list: FileList | null): Promise<void> => {
    if (!list) return;
    for (const f of Array.from(list).slice(0, 12)) {
      if (f.size > 15 * 1024 * 1024) { setError("图片超过 15MB, 请压缩"); continue; }
      try {
        const b64 = await fileToBase64(f);
        setImages((prev) => [...prev, { name: f.name, base64: b64 }]);
      } catch { /* 忽略单文件失败 */ }
    }
    setError("");
  };
  const addFiles = async (list: FileList | null): Promise<void> => {
    if (!list) return;
    for (const f of Array.from(list).slice(0, 6)) {
      if (f.size > 40 * 1024 * 1024) { setError("文件超过 40MB"); continue; }
      try {
        const b64 = await fileToBase64(f);
        setFiles((prev) => [...prev, { name: f.name, base64: b64 }]);
      } catch { /* 忽略 */ }
    }
    setError("");
  };

  const runImageDup = async () => {
    if (images.length < 2) { setError("至少上传 2 张图片"); return; }
    setLoading(true); setError(""); setRaw("");
    try {
      const res = await fetch("/api/forensics/image-dup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? `查重失败: HTTP ${res.status}`); return; }
      setRaw(data.raw ?? "");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  const runNumeric = async () => {
    if (files.length === 0) { setError("请上传数值文件(xlsx/csv)"); return; }
    setLoading(true); setError(""); setRaw("");
    try {
      const res = await fetch("/api/forensics/numeric", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files, mode: numMode }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? `数值取证失败: HTTP ${res.status}`); return; }
      setRaw(data.raw ?? "");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  return (
    <div className="mt-3 rounded-lg border border-orange-400/20 bg-orange-400/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-orange-200/90">
        <ScanSearch className="h-4 w-4" /> 论文取证
        <span className="text-[9px] font-normal text-muted-foreground/60">图像查重 · 数值取证(integrity-auditor, MIT)</span>
        <div className="ml-auto flex gap-1">
          {([["image", "图像查重"], ["numeric", "数值取证"]] as const).map(([id, label]) => (
            <button key={id} type="button" onClick={() => { setMode(id); setRaw(""); }}
              className={`rounded px-2 py-1 text-[11px] ${mode === id ? "bg-orange-400/15 text-orange-200" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>
          ))}
        </div>
      </div>

      {mode === "image" ? (
        <div className="mt-2">
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => imgRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] hover:bg-accent/40">
              <ImageIcon className="h-3 w-3" /> {images.length === 0 ? "上传论文图片(≥2 张)" : "追加图片"}
            </button>
            {images.map((img, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px]">
                {img.name.length > 18 ? img.name.slice(0, 18) + "…" : img.name}
                <button type="button" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} className="text-muted-foreground/60 hover:text-red-400"><X className="h-3 w-3" /></button>
              </span>
            ))}
            <input ref={imgRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void addImages(e.target.files); e.target.value = ""; }} />
            <button type="button" onClick={runImageDup} disabled={loading || images.length < 2}
              className="ml-auto inline-flex items-center gap-1 rounded-md bg-orange-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-orange-400 disabled:opacity-40">
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanSearch className="h-3 w-3" />} 开始查重
            </button>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground/60">dHash + aHash 感知哈希两两比较, 检测论文插图复用/翻转/裁切嫌疑</p>
        </div>
      ) : (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-2">
            <select value={numMode} onChange={(e) => setNumMode(e.target.value as typeof numMode)}
              className="h-7 rounded border border-border/70 bg-background px-1.5 text-[11px]">
              <option value="decimal">尾数匹配(跨单元格末位数字)</option>
              <option value="magnitude">量级一致性(SI 前缀/千倍误差)</option>
              <option value="aggregate">跨表聚合(合计系统性偏差)</option>
            </select>
            <button type="button" onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] hover:bg-accent/40">
              <Table2 className="h-3 w-3" /> 上传数值文件(xlsx/csv)
            </button>
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px]">
                {f.name.length > 18 ? f.name.slice(0, 18) + "…" : f.name}
                <button type="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-muted-foreground/60 hover:text-red-400"><X className="h-3 w-3" /></button>
              </span>
            ))}
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xltx,.xltm,.csv" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
            <button type="button" onClick={runNumeric} disabled={loading || files.length === 0}
              className="ml-auto inline-flex items-center gap-1 rounded-md bg-orange-500 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-orange-400 disabled:opacity-40">
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanSearch className="h-3 w-3" />} 开始取证
            </button>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground/60">检测跨单元格/跨表数值造假手法(参考实证案例基线)</p>
        </div>
      )}
      {error && <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">{error}</div>}
      {raw && <RawOutput raw={raw} />}
    </div>
  );
}
