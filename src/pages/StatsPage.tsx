import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  getStudyStatistics,
  getTrend7Days,
  getStateDistribution,
  type StudyStatistics,
  type TrendDay,
  type StateDistribution,
} from "@/lib/statsService";

/** 记忆状态四类的展示配置 */
const stateMeta = [
  { key: "newCount", label: "新词", color: "#94a3b8" },
  { key: "learning", label: "学习中", color: "#f59e0b" },
  { key: "reviewing", label: "复习中", color: "#4f46e5" },
  { key: "relearning", label: "重学中", color: "#ef4444" },
] as const;

/** 统计页：学习数据总览（全部来自 IndexedDB 真实数据） */
export default function StatsPage() {
  const [stats, setStats] = useState<StudyStatistics | null>(null);
  const [trend, setTrend] = useState<TrendDay[]>([]);
  const [dist, setDist] = useState<StateDistribution | null>(null);

  useEffect(() => {
    (async () => {
      setStats(await getStudyStatistics());
      setTrend(await getTrend7Days());
      setDist(await getStateDistribution());
    })();
  }, []);

  if (!stats || !dist) {
    return (
      <div className="page-container">
        <PageHeader title="统计" subtitle="学习成果与记忆情况" />
        <p className="text-center text-slate-400">正在加载…</p>
      </div>
    );
  }

  const maxBar = Math.max(
    1,
    ...trend.map((d) => d.newCount + d.reviewCount),
  );
  const total = dist.newCount + dist.learning + dist.reviewing + dist.relearning;

  const cards = [
    { label: "累计学习词数", value: stats.totalLearnedWords, color: "text-brand-600" },
    { label: "累计复习次数", value: stats.totalReviewCount, color: "text-accent-500" },
    { label: "已掌握词数", value: stats.masteredWords, color: "text-success-500" },
    { label: "词库总数", value: stats.totalWords, color: "text-slate-700" },
    { label: "今日学习词数", value: stats.todayLearnedWords, color: "text-brand-600" },
    { label: "连续学习天数", value: stats.streakDays, color: "text-accent-500" },
  ];

  return (
    <div className="page-container">
      <PageHeader title="统计" subtitle="学习成果与记忆情况" />

      {/* 六项核心数据 */}
      <section className="card mb-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-6">
          {cards.map((c) => (
            <div key={c.label} className="text-center">
              <p className={`text-3xl font-semibold ${c.color}`}>{c.value}</p>
              <p className="mt-1 text-xs text-slate-500">{c.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 最近 7 天趋势 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">最近 7 天学习趋势</h2>
        {/* 图例 */}
        <div className="mt-2 flex gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <i className="inline-block h-2.5 w-2.5 rounded-sm bg-brand-600" />
            新学词数
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block h-2.5 w-2.5 rounded-sm bg-accent-500" />
            复习次数
          </span>
        </div>
        <div className="mt-4 flex h-40 items-end justify-between gap-2">
          {trend.map((d) => {
            const hNew = (d.newCount / maxBar) * 100;
            const hRev = (d.reviewCount / maxBar) * 100;
            const totalH = hNew + hRev;
            return (
              <div key={d.key} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[10px] text-slate-400">
                  {d.newCount + d.reviewCount > 0 ? d.newCount + d.reviewCount : ""}
                </span>
                {/* 堆叠柱：下段复习（琥珀），上段新学（靛蓝） */}
                <div className="flex w-full max-w-6 flex-col justify-end" style={{ height: "120px" }}>
                  <div
                    className="w-full rounded-t-md bg-brand-600"
                    style={{ height: `${hNew}%` }}
                  />
                  <div
                    className="w-full bg-accent-500"
                    style={{ height: `${hRev}%` }}
                  />
                  {totalH === 0 && (
                    <div className="h-0.5 w-full rounded bg-slate-200" />
                  )}
                </div>
                <span className="text-[10px] text-slate-500">{d.label}</span>
              </div>
            );
          })}
        </div>
      </section>

      {/* 记忆状态分布 */}
      <section className="card">
        <h2 className="text-base font-medium">记忆状态分布</h2>
        {/* 横向比例条 */}
        <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
          {total > 0 &&
            stateMeta.map((m) => (
              <div
                key={m.key}
                style={{
                  width: `${(dist[m.key] / total) * 100}%`,
                  backgroundColor: m.color,
                }}
              />
            ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
          {stateMeta.map((m) => (
            <div key={m.key} className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm text-slate-600">
                <i
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: m.color }}
                />
                {m.label}
              </span>
              <span className="text-base font-medium">{dist[m.key]}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
