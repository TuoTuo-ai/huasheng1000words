/**
 * 全局错误边界
 *
 * 职责：捕获下层组件渲染 / 生命周期中抛出的异常，展示中文友好界面，
 * 提供「重新加载」与「返回首页」两个恢复动作。
 *
 * 安全约束：
 *   - 不向普通用户展示任何堆栈、文件路径、内部状态
 *   - 捕获异常时只把 message 写入控制台，便于开发排查
 *   - 不影响正常渲染：未出错时原样返回 children
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 自定义兜底界面（测试用，可选） */
  fallback?: (reset: () => void) => ReactNode;
  /** 出错时的额外回调（如上报），默认只打印控制台 */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
}

/** 面向用户的通用文案：不包含任何技术细节 */
export const ERROR_BOUNDARY_TITLE = "页面出了点问题";
export const ERROR_BOUNDARY_MESSAGE =
  "刚才的操作没有完成，您的本地数据仍然安全。可以重新加载页面继续使用；如果多次出现，请先到设置页导出备份。";

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只在控制台保留排查信息，不渲染到界面
    console.error("[ErrorBoundary] 页面渲染异常:", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  /** 复位边界状态（供「返回首页」使用，重新渲染子树） */
  reset = (): void => {
    this.setState({ hasError: false });
  };

  /** 重新加载整页（最彻底，可绕过残留的坏状态） */
  reload = (): void => {
    if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
      window.location.reload();
    } else {
      this.reset();
    }
  };

  /** 回到首页：改变 hash/路径后复位，避免整页刷新丢上下文 */
  goHome = (): void => {
    try {
      if (typeof window !== "undefined" && window.location) {
        window.location.href = "/";
      }
    } catch {
      /* ignore */
    }
    this.reset();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.reset);

    return (
      <div className="page-container">
        <div className="card mt-10 text-center">
          <p className="text-4xl" aria-hidden="true">
            🌧️
          </p>
          <h1 className="mt-4 text-lg font-medium">{ERROR_BOUNDARY_TITLE}</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-500">
            {ERROR_BOUNDARY_MESSAGE}
          </p>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <button className="btn-secondary" onClick={this.goHome}>
              返回首页
            </button>
            <button className="btn-primary" onClick={this.reload}>
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
