/**
 * 全局错误边界测试（无 DOM / 无 testing-library 环境）
 *
 * 测试环境为 node，且没有安装 jsdom，无法用 react-dom/client 真正挂载组件；
 * react-dom/server 的 renderToString 也不会执行 error boundary（错误直接抛出）。
 * 因此这里分三层验证：
 *   1. 正常渲染：renderToString 原样输出 children（证明不干扰正常页面）
 *   2. 异常链路：手动驱动类组件的生命周期（getDerivedStateFromError →
 *      componentDidCatch → render），断言兜底界面与不泄露堆栈
 *   3. 契约与文案：导出常量、实例方法、静态方法
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import type { ErrorInfo } from "react";
import {
  ErrorBoundary,
  ERROR_BOUNDARY_MESSAGE,
  ERROR_BOUNDARY_TITLE,
} from "@/components/ErrorBoundary";

const h = createElement;

/** 正常子组件 */
function Fine(): ReactElement {
  return h("p", null, "正常内容");
}

/**
 * 模拟 React 在捕获到渲染错误时的调用序列：
 * getDerivedStateFromError → componentDidCatch → render
 */
function driveErrorPath(boundary: ErrorBoundary, err: Error): string {
  const state = ErrorBoundary.getDerivedStateFromError();
  // 与 React 内部行为一致：先落 state 再回调
  (boundary as unknown as { state: { hasError: boolean } }).state = state;
  boundary.componentDidCatch(err, { componentStack: "Boom\n  at Fine" } as ErrorInfo);
  const out = boundary.render() as ReactElement;
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    return renderToString(out);
  } finally {
    spy.mockRestore();
  }
}

describe("ErrorBoundary · 正常路径（不影响正常渲染）", () => {
  it("未出错时原样渲染 children，不出现兜底界面", () => {
    const boundary = new ErrorBoundary({ children: h(Fine) });
    const out = boundary.render() as ReactElement;
    const html = renderToString(out);

    expect(html).toContain("正常内容");
    expect(html).not.toContain(ERROR_BOUNDARY_TITLE);
    expect(boundary.state.hasError).toBe(false);
  });

  it("多个正常子节点全部渲染（不吞内容）", () => {
    const boundary = new ErrorBoundary({
      children: [h(Fine, { key: "a" }), h("span", { key: "b" }, "第二块")],
    });
    const html = renderToString(boundary.render() as ReactElement);
    expect(html).toContain("正常内容");
    expect(html).toContain("第二块");
  });

  it("children 为 null 时不崩溃", () => {
    const boundary = new ErrorBoundary({ children: null });
    expect(() => boundary.render()).not.toThrow();
  });
});

describe("ErrorBoundary · 异常路径（捕获并展示恢复界面）", () => {
  it("进入错误态后展示中文兜底界面，并提供两个恢复操作", () => {
    const boundary = new ErrorBoundary({ children: h(Fine) });
    const html = driveErrorPath(boundary, new Error("组件内部炸了"));

    expect(html).toContain(ERROR_BOUNDARY_TITLE);
    expect(html).toContain(ERROR_BOUNDARY_MESSAGE);
    expect(html).toContain("返回首页");
    expect(html).toContain("重新加载");
    // 兜底界面替代了原内容
    expect(html).not.toContain("正常内容");
  });

  it("兜底界面不泄露异常信息与堆栈", () => {
    const boundary = new ErrorBoundary({ children: h(Fine) });
    const html = driveErrorPath(
      boundary,
      new Error("secret-stack-detail at /src/secret.tsx:42"),
    );

    expect(html).not.toContain("secret-stack-detail");
    expect(html).not.toContain("/src/secret.tsx");
    expect(html).not.toContain("Error:");
    expect(html).not.toMatch(/\.tsx?:\d+/);
    expect(html).not.toContain("componentStack");
  });

  it("componentDidCatch 只把技术细节写入控制台（便于排查）", () => {
    const boundary = new ErrorBoundary({ children: h(Fine) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    boundary.componentDidCatch(new Error("detail-for-dev"), {
      componentStack: "stack-here",
    } as ErrorInfo);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("自定义 fallback 生效", () => {
    const boundary = new ErrorBoundary({
      children: h(Fine),
      fallback: () => h("p", null, "自定义兜底"),
    });
    const html = driveErrorPath(boundary, new Error("x"));
    expect(html).toContain("自定义兜底");
    expect(html).not.toContain(ERROR_BOUNDARY_TITLE);
  });

  it("reset 可将边界复位（下次渲染恢复 children）", () => {
    const boundary = new ErrorBoundary({ children: h(Fine) });
    driveErrorPath(boundary, new Error("x"));
    expect(boundary.state.hasError).toBe(true);

    // 复位的实际效果由 setState 触发，这里断言状态字段与方法被调用
    const spy = vi
      .spyOn(boundary, "setState")
      .mockImplementation(() => undefined);
    boundary.reset();
    expect(spy).toHaveBeenCalledWith({ hasError: false });
    spy.mockRestore();
  });
});

describe("ErrorBoundary · 契约与文案", () => {
  it("getDerivedStateFromError 返回 hasError 状态", () => {
    expect(typeof ErrorBoundary.getDerivedStateFromError).toBe("function");
    expect(ErrorBoundary.getDerivedStateFromError!()).toEqual({
      hasError: true,
    });
  });

  it("实例提供复位 / 重载 / 回首页能力", () => {
    const instance = new ErrorBoundary({ children: null });
    expect(typeof instance.reset).toBe("function");
    expect(typeof instance.reload).toBe("function");
    expect(typeof instance.goHome).toBe("function");
  });

  it("文案友好且明确说明数据安全，不含技术细节", () => {
    expect(ERROR_BOUNDARY_TITLE).toBe("页面出了点问题");
    expect(ERROR_BOUNDARY_MESSAGE).toContain("本地数据仍然安全");
    expect(ERROR_BOUNDARY_MESSAGE).toContain("导出备份");
    expect(ERROR_BOUNDARY_MESSAGE).not.toContain("Error");
    expect(ERROR_BOUNDARY_MESSAGE).not.toContain("undefined");
  });
});
