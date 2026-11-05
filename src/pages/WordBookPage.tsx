import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import {
  getWordbook,
  filterEntries,
  type WordbookEntry,
  type WordbookStats,
  type WordCategory,
} from "@/lib/wordbookService";

/** 筛选项配置 */
const filters: Array<{ key: WordCategory; label: string }> = [
  { key: "all", label: "全部" },
  { key: "new", label: "新词" },
  { key: "learning", label: "学习中" },
  { key: "reviewing", label: "复习中" },
  { key: "relearning", label: "重学中" },
];

/** 状态角标样式（克制区分） */
const badgeStyle: Record<string, string> = {
  new: "bg-slate-100 text-slate-500",
  learning: "bg-accent-500/10 text-accent-500",
  reviewing: "bg-brand-50 text-brand-600",
  relearning: "bg-danger-500/10 text-danger-500",
};
const badgeLabel: Record<string, string> = {
  new: "新词",
  learning: "学习中",
  reviewing: "复习中",
  relearning: "重学中",
};

/** 分页大小：避免一次渲染过多卡片造成卡顿 */
const PAGE_SIZE = 50;

function formatDue(due: number): string {
  const d = new Date(due);
  const diffDays = Math.ceil((due - Date.now()) / 86_400_000);
  const time = `${d.getMonth() + 1}/${d.getDate()}`;
  if (diffDays <= 0) return "今天到期";
  if (diffDays === 1) return "明天";
  return `${time}（${diffDays}天后）`;
}

/** 词库页：总览统计 + 搜索 + 分类筛选 + 词语列表 */
export default function WordBookPage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<WordbookEntry[]>([]);
  const [stats, setStats] = useState<WordbookStats | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<WordCategory>("all");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { entries, stats } = await getWordbook();
      setEntries(entries);
      setStats(stats);
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(
    () => filterEntries(entries, query, category),
    [entries, query, category],
  );

  // 切换搜索/筛选后重置分页
  useEffect(() => setVisible(PAGE_SIZE), [query, category]);

  if (loading || !stats) {
    return (
      <div className="page-container">
        <PageHeader title="词库" subtitle="全部高频词一览" />
        <p className="text-center text-slate-400">正在加载…</p>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader title="词库" subtitle="全部高频词一览" />

      {/* 词库统计 */}
      <section className="card mb-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-2xl font-semibold">{stats.total}</p>
            <p className="mt-1 text-xs text-slate-500">总词数</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-success-500">
              {stats.learned}
            </p>
            <p className="mt-1 text-xs text-slate-500">已学习</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-slate-400">
              {stats.unlearned}
            </p>
            <p className="mt-1 text-xs text-slate-500">未学习</p>
          </div>
        </div>
      </section>

      {/* 分类学习入口 */}
      <Link
        to="/category"
        className="card mb-4 flex items-center justify-between p-4 active:scale-[0.99]"
      >
        <div>
          <p className="text-base font-medium">分类学习</p>
          <p className="mt-0.5 text-xs text-slate-400">
            按词库原始分类集中学习
          </p>
        </div>
        <span className="text-slate-300">›</span>
      </Link>

      {/* 搜索框 */}
      <div className="relative mb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索词语或释义"
          className="w-full rounded-2xl bg-white px-4 py-3 pr-10 text-sm shadow-sm outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500/30"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            aria-label="清空搜索"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          >
            ✕
          </button>
        )}
      </div>

      {/* 分类筛选 */}
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
        {filters.map((f) => {
          const active = category === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setCategory(f.key)}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm transition-colors ${
                active
                  ? "bg-brand-600 text-white"
                  : "bg-white text-slate-500 shadow-sm"
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* 词语列表 */}
      {filtered.length === 0 ? (
        <div className="card text-center">
          <p className="text-3xl">🔍</p>
          <p className="mt-3 text-sm text-slate-500">
            {query ? `没有找到与「${query}」相关的词语` : "该分类下暂无词语"}
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {filtered.slice(0, visible).map(({ word, progress, category: c }) => (
            <li key={word.id}>
              <button
                onClick={() => navigate(`/wordbook/${word.id}`)}
                className="card w-full p-4 text-left transition-transform active:scale-[0.99]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-medium">{word.term}</span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${badgeStyle[c]}`}
                  >
                    {badgeLabel[c]}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500">
                  {word.definition}
                </p>
                {progress && progress.due > 0 && (
                  <p className="mt-2 text-[10px] text-slate-400">
                    下次复习：{formatDue(progress.due)}
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 加载更多 */}
      {filtered.length > visible && (
        <button
          className="btn-secondary mt-4 w-full"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
        >
          加载更多（还有 {filtered.length - visible} 个）
        </button>
      )}
    </div>
  );
}
