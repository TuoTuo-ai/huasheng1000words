import type { ReactNode } from "react";

/** 统一页面标题栏 */
export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
    </header>
  );
}

/** 占位卡片：用于尚未实现的模块，避免虚构功能 */
export function PlaceholderCard({ children }: { children: ReactNode }) {
  return (
    <div className="card">
      <p className="text-sm leading-relaxed text-slate-500">{children}</p>
    </div>
  );
}
