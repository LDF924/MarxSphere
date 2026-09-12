/** Toast + 确认弹层 — 闭源全局 addToast / tc()(无头安全 confirm)语义还原 */
import { reactive, h } from "vue";

export interface ToastItem {
  id: number;
  type: "success" | "error" | "warning" | "info";
  text: string;
}
export const toasts = reactive<{ items: ToastItem[] }>({ items: [] });
let seq = 1;

export function toast(text: string, type: ToastItem["type"] = "info", duration = 3200): void {
  const id = seq++;
  toasts.items.push({ id, type, text });
  setTimeout(() => {
    const i = toasts.items.findIndex((t) => t.id === id);
    if (i >= 0) toasts.items.splice(i, 1);
  }, duration);
}

export const addToast = toast;

export function dismissToast(id: number): void {
  const i = toasts.items.findIndex((t) => t.id === id);
  if (i >= 0) toasts.items.splice(i, 1);
}

// ── 全局 toast 渲染挂件(在各视图根放置 <ToastHost/>) ──
export const ToastHost = {
  setup() {
    return () => {
      return h(
        "div",
        {
          class: "soc-toasts",
          style: "position:fixed;top:64px;right:16px;z-index:100;display:flex;flex-direction:column;gap:8px;max-width:340px"
        },
        toasts.items.map((t) =>
          h(
            "div",
            {
              key: t.id,
              class: `soc-toast soc-toast--${t.type}`,
              style:
                "background:#fff;border:1px solid #e2e8f0;border-left:3px solid " +
                (t.type === "error" ? "#dc2626" : t.type === "success" ? "#059669" : t.type === "warning" ? "#d97706" : "#2563eb") +
                ";border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,.12);padding:10px 26px 10px 14px;font-size:13px;color:#1e293b;position:relative;line-height:1.5"
            },
            [
              t.text,
              h(
                "button",
                {
                  onClick: () => dismissToast(t.id),
                  style: "position:absolute;top:6px;right:8px;border:0;background:transparent;color:#94a3b8;cursor:pointer;font-size:14px;line-height:1"
                },
                "✕"
              )
            ]
          )
        )
      );
    };
  }
};

// 避免循环 import vue

/** 全局确认(闭源 tc()): 返回 Promise<bool>; 渲染自绘 confirm 层 */
export interface ConfirmOptions {
  message: string;
  title?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}
interface ConfirmState extends ConfirmOptions {
  visible: boolean;
  resolve: ((v: boolean) => void) | null;
}
export const confirmState: ConfirmState = reactive({ visible: false, message: "", title: "", okText: "确认", cancelText: "取消", danger: false, resolve: null });

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  confirmState.message = opts.message;
  confirmState.title = opts.title ?? "提示";
  confirmState.okText = opts.okText ?? "确认";
  confirmState.cancelText = opts.cancelText ?? "取消";
  confirmState.danger = opts.danger ?? false;
  confirmState.visible = true;
  return new Promise<boolean>((resolve) => {
    confirmState.resolve = resolve;
  });
}
export const tc = confirmDialog;

export function settleConfirm(v: boolean): void {
  confirmState.visible = false;
  confirmState.resolve?.(v);
  confirmState.resolve = null;
}

export const ConfirmHost = {
  setup() {
    return () => {
      if (!confirmState.visible) return null;
      // 深色主题: 原来是白底弹窗, 在 MarxSphere 深色界面里像一块打了补丁的纸(实测刺眼)。
      //   整站都是 #0a1120/#11192C 一族, 这里对齐; 确认键用同族蓝, 危险动作用低饱和红。
      const D = {
        overlay: "position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(8,13,24,.62);backdrop-filter:blur(2px)",
        card: "background:#11192C;border:1px solid #2A3A55;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.55);width:440px;max-width:92vw;overflow:hidden",
        head: "padding:16px 20px;border-bottom:1px solid #222F44;display:flex;justify-content:space-between;align-items:center",
        title: "margin:0;font-size:15px;font-weight:700;color:#E8EEF7",
        close: "border:0;background:none;font-size:18px;color:#7A8AA0;cursor:pointer;line-height:1",
        body: "padding:18px 20px;font-size:13.5px;color:#A9BBD0;line-height:1.7;white-space:pre-wrap",
        foot: "padding:14px 20px;border-top:1px solid #222F44;display:flex;justify-content:flex-end;gap:10px",
        cancel: "padding:7px 18px;border:1px solid #2A3A55;border-radius:8px;background:#16233A;color:#A9BBD0;font-size:13px;cursor:pointer",
      };
      const okStyle = `padding:7px 18px;border:0;border-radius:8px;color:#F1F5F9;font-size:13px;cursor:pointer;background:${confirmState.danger ? "#B4453F" : "#4D84CB"}`;
      return h("div", { style: D.overlay }, [
        h("div", { style: D.card }, [
          h("div", { style: D.head }, [
            h("h3", { style: D.title }, confirmState.title),
            h("button", { onClick: () => settleConfirm(false), style: D.close }, "×")
          ]),
          h("div", { style: D.body }, confirmState.message),
          h("div", { style: D.foot }, [
            h("button", { onClick: () => settleConfirm(false), style: D.cancel }, confirmState.cancelText),
            h("button", { onClick: () => settleConfirm(true), style: okStyle }, confirmState.okText)
          ])
        ])
      ]);
    };
  }
};
