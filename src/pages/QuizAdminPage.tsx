import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import {
  countStats,
  filterQuestions,
  groupByCategory,
  loadQuizAdminData,
  findSimilarQuestions,
  parseCategoryKey,
  type QuizCategoryGroup,
} from "@/lib/quizAdminService";
import {
  generateSynonymQuestions,
  collectSynonymCategories,
  type SynonymGenerationResult,
} from "@/lib/quizGenerator";
import type { Word } from "@/types";
import type { QuizQuestion, ReviewStatus } from "@/types/quiz";

const SECTIONS = ["成语篇", "实词篇"] as const;

/** 单次生成数量范围（默认 50） */
const GEN_MIN = 10;
const GEN_MAX = 200;
const GEN_DEFAULT = 50;

const STATUS_TABS: Array<{ value: ReviewStatus | ""; label: string }> = [
  { value: "", label: "全部" },
  { value: "pending", label: "待审核" },
  { value: "approved", label: "已通过" },
  { value: "rejected", label: "已驳回" },
];

/** 题目管理页：批量生成 + 分类浏览 + 状态筛选 */
export default function QuizAdminPage() {
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [wordMap, setWordMap] = useState<Map<string, Word>>(new Map());
  const [section, setSection] = useState<string>("");
  const [status, setStatus] = useState<ReviewStatus | "">("pending");
  const [categoryKey, setCategoryKey] = useState<string>("");

  /* 生成流程状态 */
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<SynonymGenerationResult | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [categoryCount, setCategoryCount] = useState<number>(0);
  /** 本次生成数量上限 */
  const [genCount, setGenCount] = useState<number>(GEN_DEFAULT);

  const reload = useCallback(async () => {
    const data = await loadQuizAdminData();
    setQuestions(data.questions);
    setWordMap(data.wordMap);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await loadQuizAdminData();
      const cats = await collectSynonymCategories();
      if (cancelled) return;
      setQuestions(data.questions);
      setWordMap(data.wordMap);
      setCategoryCount(cats.length);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* 稳定引用：避免每次渲染都新建空数组导致 useMemo 失效 */
  const EMPTY: QuizQuestion[] = useMemo(() => [], []);
  const all = questions ?? EMPTY;
  const stats = useMemo(() => countStats(all), [all]);

  /* 按当前 section 过滤后的题目（分类列表随篇章联动） */
  const sectionQuestions = useMemo(
    () => filterQuestions(all, { section }),
    [all, section],
  );
  const categories: QuizCategoryGroup[] = useMemo(
    () => groupByCategory(sectionQuestions),
    [sectionQuestions],
  );
  const visible = useMemo(
    () => filterQuestions(all, { section, status, categoryKey }),
    [all, section, status, categoryKey],
  );
  const duplicates = useMemo(() => findSimilarQuestions(sectionQuestions), [sectionQuestions]);

  const doGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    setGenResult(null);
    try {
      // 按篇章生成：已出过题的分类会被 30 天窗口与 ID 幂等自动跳过
      const result = await generateSynonymQuestions({
        section: section || undefined,
        limit: genCount,
      });
      setGenResult(result);
      await reload();
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "生成失败，请重试");
    } finally {
      setGenerating(false);
    }
  };

  if (questions === null) {
    return (
      <div className="page-container">
        <PageHeader title="题目管理" subtitle="近义词辨析题 · 人工审核" />
        <p className="text-center text-slate-400">正在加载…</p>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader title="题目管理" subtitle="近义词辨析题 · 生成与人工审核" />

      {/* 题库统计 */}
      <section className="card mb-4">
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            { label: "总题数", value: stats.total, cls: "" },
            { label: "待审核", value: stats.pending, cls: "text-accent-500" },
            { label: "已通过", value: stats.approved, cls: "text-success-500" },
            { label: "已驳回", value: stats.rejected, cls: "text-danger-500" },
          ].map((x) => (
            <div key={x.label}>
              <p className={`text-2xl font-semibold ${x.cls}`}>{x.value}</p>
              <p className="mt-1 text-xs text-slate-500">{x.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 批量生成 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">批量生成辨析题</h2>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          依据教材原文释义，从「同篇章 · 同组 · 同二级分类」且至少 2 个词的分类中出题。
          当前可出题分类 {categoryCount} 个。新生成题目一律为「待审核」，不会自动通过。
          近 30 天已出过题的分类会自动跳过。
        </p>
        {/* 本次生成数量 */}
        <div className="mt-4 rounded-2xl bg-slate-50 p-4">
          <div className="flex items-baseline justify-between">
            <label htmlFor="gen-count" className="text-sm text-slate-600">
              每次生成数量
            </label>
            <span className="text-lg font-semibold text-brand-600">
              {genCount} 道
            </span>
          </div>
          <input
            id="gen-count"
            type="range"
            min={GEN_MIN}
            max={GEN_MAX}
            step={10}
            value={genCount}
            onChange={(e) => setGenCount(Number(e.target.value))}
            className="mt-3 w-full accent-brand-600"
            aria-label="每次生成数量"
          />
          <div className="mt-1 flex justify-between text-xs text-slate-400">
            <span>{GEN_MIN}</span>
            <span>{GEN_MAX}</span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            仅控制本次新增数量。30 天去重与同分类去重规则不变；
            可出题分类不足时按实际数量生成，不会凑题。
          </p>
        </div>

        <button
          className="btn-primary mt-4 w-full"
          disabled={generating || categoryCount === 0}
          onClick={doGenerate}
        >
          {generating
            ? "正在生成…"
            : section
              ? `生成${section}辨析题（最多 ${genCount} 道）`
              : `生成全部辨析题（最多 ${genCount} 道）`}
        </button>

        {genResult && (
          <div className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm">
            <p className="font-medium text-slate-700">
              生成完成：本次实际新增{" "}
              <span className="text-brand-600">{genResult.created}</span> 道
            </p>
            <div className="mt-2 grid grid-cols-2 gap-y-1 text-xs text-slate-500">
              <span>可用分类：{genResult.categoryCount} 个</span>
              <span>本次上限：{genResult.limit ?? "不限"}</span>
              <span>分类已出过题跳过：{genResult.skippedRepeat}</span>
              <span>题目已存在跳过：{genResult.skippedExists}</span>
              <span>不满足质量要求略过：{genResult.rejected}</span>
            </div>
          </div>
        )}
        {genError && (
          <p className="mt-3 rounded-xl bg-danger-500/10 p-3 text-xs text-danger-500">
            生成失败：{genError}
          </p>
        )}
      </section>

      {/* 篇章筛选 */}
      <section className="mb-3 flex gap-2">
        {[{ value: "", label: "全部篇章" }, ...SECTIONS.map((s) => ({ value: s, label: s }))].map(
          (s) => (
            <button
              key={s.value}
              onClick={() => {
                setSection(s.value);
                setCategoryKey("");
              }}
              className={`rounded-full px-4 py-2 text-sm transition-colors ${
                section === s.value
                  ? "bg-brand-600 text-white"
                  : "bg-white text-slate-500 shadow-sm"
              }`}
            >
              {s.label}
            </button>
          ),
        )}
      </section>

      {/* 状态筛选 */}
      <section className="mb-4 flex gap-2 overflow-x-auto">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setStatus(t.value)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm transition-colors ${
              status === t.value
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-500 shadow-sm"
            }`}
          >
            {t.label}
          </button>
        ))}
      </section>

      {/* 分类筛选 */}
      {categories.length > 0 && (
        <section className="card mb-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium">按分类查看</h2>
            {categoryKey && (
              <button
                className="text-xs text-brand-600"
                onClick={() => setCategoryKey("")}
              >
                清除筛选
              </button>
            )}
          </div>
          <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
            {categories.map((c) => {
              const active = categoryKey === c.categoryKey;
              const hasDup = duplicates.has(c.categoryKey);
              return (
                <button
                  key={c.categoryKey}
                  onClick={() => setCategoryKey(active ? "" : c.categoryKey)}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm ${
                    active ? "bg-brand-50 text-brand-700" : "text-slate-600"
                  }`}
                >
                  <span className="truncate">
                    {c.groupId}组 · {c.groupTitle}
                    <span className="text-slate-400"> › {c.subcategory}</span>
                    {hasDup && (
                      <span className="ml-2 rounded bg-accent-500/10 px-1.5 py-0.5 text-[10px] text-accent-500">
                        疑似重复
                      </span>
                    )}
                  </span>
                  <span className="ml-2 shrink-0 text-xs text-slate-400">
                    {c.pending}/{c.total}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* 题目列表 */}
      {visible.length === 0 ? (
        <div className="card text-center">
          <p className="text-sm text-slate-500">
            {stats.total === 0
              ? "题库为空。点击上方「生成辨析题」开始创建题目。"
              : "当前筛选条件下没有题目。"}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((q) => {
            const { section: sec, groupId, subcategory } = parseCategoryKey(q.categoryKey);
            const correctWord = wordMap.get(
              q.options.find((o) => o.isCorrect)?.wordId ?? "",
            );
            return (
              <li key={q.id}>
                <Link
                  to={`/quiz-admin/${q.id}`}
                  className="card block transition-colors active:bg-slate-50"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">
                      {sec} · {groupId}组 · {subcategory}
                    </span>
                    <StatusBadge status={q.reviewStatus} />
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-slate-700">
                    {q.stem.replace(/^.*？\n/, "")}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    正确词：{correctWord?.term ?? "—"} · {q.options.length} 个选项
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** 审核状态徽标 */
export function StatusBadge({ status }: { status: ReviewStatus }) {
  const map: Record<ReviewStatus, { text: string; cls: string }> = {
    pending: { text: "待审核", cls: "bg-accent-500/10 text-accent-500" },
    approved: { text: "已通过", cls: "bg-success-500/10 text-success-500" },
    rejected: { text: "已驳回", cls: "bg-danger-500/10 text-danger-500" },
    draft: { text: "草稿", cls: "bg-slate-100 text-slate-500" },
  };
  const m = map[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${m.cls}`}>{m.text}</span>
  );
}
