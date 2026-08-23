// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortId(id?: string | null) {
  return id ? id.slice(0, 8) : "";
}

export function formatDate(value?: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

/** 毫秒 → 友好时长：<1s 显示 ms，≥1s 显示 x.xs */
export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 两条消息的时间间隔（分钟） */
export function timeGapMinutes(a?: string | null, b?: string | null) {
  const ta = a ? new Date(a).getTime() : 0;
  const tb = b ? new Date(b).getTime() : 0;
  if (!ta || !tb || tb <= ta) return 0;
  return (tb - ta) / 60000;
}

/** 分割线用完整时间：跨天显示日期+时间，当天显示时间 */
export function formatMessageDate(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(sameDay ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

/** ArrayBuffer → Base64（FileReader 分块读取，避免 btoa(String.fromCharCode(...bytes)) 展开超过 64KB 抛 RangeError） */
export function bufferToBase64(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // 拷贝为独立 ArrayBuffer：兼容 SharedArrayBuffer 等 ArrayBufferLike（Blob 只接受 ArrayBuffer 视图）
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([copy]));
  });
}
