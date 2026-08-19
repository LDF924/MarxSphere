// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ErrorBoundary.tsx — 全局错误边界（防渲染异常导致整页白屏）
// 组件渲染抛错 → 显示错误提示 + 刷新按钮, 而非卸载整个 React 树
import { Component, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { hasError: boolean; message: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-8 text-center">
          <div className="text-lg font-semibold text-red-600">页面渲染出错</div>
          <div className="max-w-md text-sm text-muted-foreground">{this.state.message}</div>
          <button
            type="button"
            onClick={() => { this.setState({ hasError: false, message: "" }); }}
            className="rounded-md bg-primary px-4 py-2 text-sm text-white hover:bg-primary/90"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
