import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import {
  getCategoryTree,
  groupKey,
  type GroupNode,
} from "@/lib/categoryService";

/** 篇章展示顺序 */
const SECTIONS = ["成语篇", "实词篇"];

/** 一级分类展示名：「组号 · 分类名称」（仅展示层，不改 groupTitle 原值） */
export function groupLabel(g: { groupId: number; groupTitle: string }): string {
  return `${g.groupId}组 · ${g.groupTitle}`;
}

/** 分类浏览页：按篇章分区 → 一级分类 → 二级分类 */
export default function CategoryPage() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<GroupNode[] | null>(null);
  /* 展开状态使用唯一键 section-groupId，避免两篇同号联动 */
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => setGroups(await getCategoryTree()))();
  }, []);

  /** 按篇章分组，保证两篇都展示（空篇也显示标题） */
  const bySection = useMemo(() => {
    const map = new Map<string, GroupNode[]>();
    for (const s of SECTIONS) map.set(s, []);
    for (const g of groups ?? []) {
      const k = g.section || "其他";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(g);
    }
    return map;
  }, [groups]);

  if (!groups) {
    return (
      <div className="page-container">
        <PageHeader title="分类学习" subtitle="按词库原始分类浏览学习" />
        <p className="text-center text-slate-400">正在加载…</p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="page-container">
        <PageHeader title="分类学习" subtitle="按词库原始分类浏览学习" />
        <div className="card text-center">
          <p className="text-sm text-slate-500">
            尚未包含分类信息，请先在设置页导入正式词库。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader title="分类学习" subtitle="按词库原始分类浏览学习" />

      {Array.from(bySection.entries()).map(([section, list]) => (
        <section key={section} className="mb-6">
          {/* 章节标题 */}
          <div className="mb-3 flex items-baseline justify-between px-1">
            <h2 className="text-base font-semibold text-slate-700">{section}</h2>
            <span className="text-xs text-slate-400">{list.length} 组</span>
          </div>

          <ul className="space-y-2.5">
            {list.map((g) => {
              const key = groupKey(g.groupId, g.section);
              const open = expanded === key;
              const pct = g.total
                ? Math.round((g.learned / g.total) * 100)
                : 0;
              return (
                <li key={key} className="card p-4">
                  <button
                    className="flex w-full items-center justify-between gap-3 text-left"
                    onClick={() => setExpanded(open ? null : key)}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-base font-medium">
                        {groupLabel(g)}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {g.total} 个词 · 已学 {g.learned}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="text-sm font-medium text-brand-600">
                        {pct}%
                      </span>
                      <span className="ml-2 text-slate-300">
                        {open ? "▾" : "›"}
                      </span>
                    </div>
                  </button>

                  <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  {open && (
                    <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                      {g.subs.map((s) => (
                        <li key={s.name}>
                          <button
                            className="flex w-full items-center justify-between rounded-xl px-2 py-2 text-left active:bg-slate-50"
                            onClick={() =>
                              navigate(
                                `/category/${key}/${encodeURIComponent(s.name)}`,
                              )
                            }
                          >
                            <span className="text-sm text-slate-600">
                              {s.name}
                            </span>
                            <span className="text-xs text-slate-400">
                              {s.entries.length} 词
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
