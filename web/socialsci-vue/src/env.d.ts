/** 全局引用声明(vue SFC + 无类型依赖) */
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>;
  export default component;
}

declare module "plotly.js-dist-min" {
  const Plotly: {
    newPlot(el: HTMLElement, data: unknown, layout: unknown, config?: Record<string, unknown>): Promise<unknown>;
    toImage(el: HTMLElement, opts: Record<string, unknown>): Promise<string>;
    purge(el: HTMLElement): void;
  };
  export default Plotly;
}

declare module "docx-preview" {
  export function renderAsync(
    data: ArrayBuffer,
    bodyContainer: HTMLElement,
    styleContainer?: HTMLElement,
    options?: Record<string, unknown>
  ): Promise<void>;
}

declare module "file-saver" {
  export function saveAs(blob: Blob, name: string): void;
  const _default: { saveAs: typeof saveAs };
  export default _default;
}
