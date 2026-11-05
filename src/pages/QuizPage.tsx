/**
 * 分类辨析训练 · 入口与组卷设置页
 *
 * 职责：
 * - 展示可用分类（仅 approved 的近义词题）与每类可用题数
 * - 选择分类、选择题量 → 抽题预览（不重复、不足按实际可用量）
 * - 点击「开始训练」才创建 synonym 会话并跳转答题页（全页唯一建会话处）
 *
 * 边界：
 * - 不生成题目（题目由管理端生成与审核），只读 quiz_questions
 * - 不新增底部导航 Tab，不改动学习侧数据
 * - 无可用题时明确提示，不伪造题目、不允许开始训练
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import {
  QuizServiceError,
  categoryLabel,
  getApprovedQuestions,
  insufficientHint,
  loadQuizCategories,
  pickQuestions,
  quizStudyPath,
  startQuizSession,
  type PickResult,
  type QuizCategory,
} from "@/lib/quizService";

/* ---------------- 可导出的纯逻辑（供测试复用） ---------------- */

/** 题量选项 */
export const QUIZ_COUNT_OPTIONS = [5, 10, 20] as const;
export type QuizCount = (typeof QUIZ_COUNT_OPTIONS)[number];

/** 默认题量 */
export const DEFAULT_QUIZ_COUNT: QuizCount = 10;

/** 「全部分类」的筛选值（null 表示不限分类） */
export const ALL_CATEGORIES = null;

/** 分类下拉/分段的展示文本：section · subcategory（X 题） */
export function categoryOptionText(c: QuizCategory): string {
  return `${categoryLabel(c)}（${c.count} 题）`;
}

/** 可用题目总数 */
export function totalAvailable(categories: readonly QuizCategory[]): number {
  return categories.reduce((sum, c) => sum + c.count, 0);
}

/** 无题提示文案（可用题目为 0 时使用） */
export const NO_QUESTION_HINT =
  "当前没有已通过审核的近义词辨析题，无法开始训练。请先在学习设置中的「辨析题库管理」生成题目并完成审核。";

/** 抽题预览摘要 */
export interface PreviewSummary {
  total: number;
  requested: number;
  /** 是否因题量不足缩减 */
  insufficient: boolean;
  /** 不足提示（不不足时为 null） */
  hint: string | null;
}

export function summarizePreview(result: PickResult): PreviewSummary {
  return {
    total: result.questions.length,
    requested: result.requested,
    insufficient: result.insufficient,
    hint: insufficientHint(result),
  };
}

/** 预览是否可用作训练（至少 1 题） */
export function canStart(preview: PickResult | null): boolean {
  return preview !== null && preview.questions.length > 0;
}

/* ---------------- 页面组件 ---------------- */

export default function QuizPage() {
  const navigate = useNavigate();

  const [categories, setCategories] = useState<QuizCategory[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(ALL_CATEGORIES);
  const [count, setCount] = useState<QuizCount>(DEFAULT_QUIZ_COUNT);
  const [preview, setPreview] = useState<PickResult | null>(null);
  const [previewCategory, setPreviewCategory] = useState<string | null>(ALL_CATEGORIES);
  const [previewCount, setPreviewCount] = useState<QuizCount>(DEFAULT_QUIZ_COUNT);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** 同步闸门：连续点击只创建一次会话 */
  const startingRef = useRef(false);

  async function loadCategories() {
    setLoadError(null);
    setCategories(null);
    try {
      setCategories(await loadQuizCategories());
    } catch (e) {
      setLoadError(e instanceof QuizServiceError ? e.message : "题库读取失败，请稍后重试。");
    }
  }

  useEffect(() => {
    void loadCategories();
  }, []);

  const total = useMemo(() => (categories ? totalAvailable(categories) : 0), [categories]);
  const conditionsChanged =
    preview !== null && (previewCategory !== selected || previewCount !== count);

  async function handleGenerate() {
    if (generating || categories === null) return;
    setGenerating(true);
    setGenError(null);
    setStartError(null);
    try {
      // 显式重新读一次 approved 题目，保证抽题池是最新审核结果
      const pool = await getApprovedQuestions();
      const result = await pickQuestions({
        categoryKey: selected,
        count,
        questions: pool,
      });
      setPreview(result);
      setPreviewCategory(selected);
      setPreviewCount(count);
    } catch (e) {
      setPreview(null);
      setGenError(e instanceof QuizServiceError ? `抽题失败：${e.message}` : "抽题失败，请稍后重试。");
    } finally {
      setGenerating(false);
    }
  }

  /** 开始训练：用当前预览的题目与顺序创建会话（唯一建会话处） */
  async function handleStart() {
    if (startingRef.current || !canStart(preview)) return;
    startingRef.current = true;
    setStarting(true);
    setStartError(null);
    try {
      const session = await startQuizSession(preview!.questions.map((q) => q.id));
      navigate(quizStudyPath(session.trainingId));
    } catch (e) {
      setStartError(
        e instanceof QuizServiceError ? `创建训练失败：${e.message}` : "创建训练失败，请稍后重试。",
      );
      startingRef.current = false;
      setStarting(false);
    }
    // 成功路径不重置闸门：页面即将跳转，避免重复创建
  }

  const summary = preview ? summarizePreview(preview) : null;

  return (
    <div className="page-container">
      <PageHeader title="分类辨析" subtitle="近义词辨析训练 · 题目均来自教材原文，需人工审核通过" />

      {/* 加载 / 错误 */}
      {categories === null && !loadError && (
        <div className="card mb-4">
          <p className="text-sm text-slate-500">正在读取题库…</p>
        </div>
      )}
      {loadError && (
        <div className="card mb-4">
          <p className="text-sm text-danger-500">{loadError}</p>
          <button type="button" className="btn-secondary mt-4 w-full" onClick={() => void loadCategories()}>
            重试
          </button>
        </div>
      )}

      {/* 无可用题：明确提示，禁止开始 */}
      {categories !== null && total === 0 && (
        <div className="card mb-4">
          <h2 className="text-lg font-medium">暂无可训练题目</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">{NO_QUESTION_HINT}</p>
          <Link to="/quiz-admin" className="btn-secondary mt-4 w-full text-center">
            前往辨析题库管理
          </Link>
        </div>
      )}

      {categories !== null && total > 0 && (
        <div className="card mb-4 space-y-5">
          <div>
            <h2 className="text-lg font-medium">选择题分类</h2>
            <p className="mt-1 text-sm text-slate-500">共 {total} 道已审核题目可用</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSelected(ALL_CATEGORIES)}
                className={`rounded-2xl px-4 py-2 text-sm transition-colors ${
                  selected === ALL_CATEGORIES ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700"
                }`}
              >
                全部分类
              </button>
              {categories.map((c) => (
                <button
                  key={c.categoryKey}
                  type="button"
                  onClick={() => setSelected(c.categoryKey)}
                  className={`rounded-2xl px-4 py-2 text-sm transition-colors ${
                    selected === c.categoryKey ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700"
                  }`}
                >
                  {categoryOptionText(c)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-slate-700">选择题量</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {QUIZ_COUNT_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCount(n)}
                  className={`rounded-2xl px-4 py-2 text-sm transition-colors ${
                    count === n ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700"
                  }`}
                >
                  {n} 题
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            className="btn-primary w-full"
            disabled={generating}
            onClick={() => void handleGenerate()}
          >
            {generating ? "正在抽题…" : "抽题预览"}
          </button>

          {conditionsChanged && !generating && (
            <p className="text-xs text-accent-500">条件已变更，请重新点击「抽题预览」。</p>
          )}
          {genError && <p className="text-sm text-danger-500">{genError}</p>}
        </div>
      )}

      {/* 抽题预览 */}
      {preview !== null && summary !== null && (
        <div className="card mb-4">
          <h2 className="text-lg font-medium">本次训练</h2>

          {preview.questions.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              该分类下暂无可用题目，请更换分类后重新抽题。
            </p>
          ) : (
            <>
              {summary.hint && <p className="mt-3 text-sm text-accent-500">{summary.hint}</p>}
              <div className="mt-4 grid grid-cols-2 gap-3 text-center">
                <div className="rounded-2xl bg-slate-50 py-3">
                  <p className="text-xl font-semibold text-brand-600">{summary.total}</p>
                  <p className="mt-0.5 text-xs text-slate-500">本次题量</p>
                </div>
                <div className="rounded-2xl bg-slate-50 py-3">
                  <p className="text-xl font-semibold text-brand-600">{summary.requested}</p>
                  <p className="mt-0.5 text-xs text-slate-500">所选题量</p>
                </div>
              </div>
              <button
                type="button"
                className="btn-primary mt-4 w-full"
                disabled={starting}
                onClick={() => void handleStart()}
              >
                {starting ? "正在创建训练…" : "开始训练"}
              </button>
              {startError && <p className="mt-3 text-sm text-danger-500">{startError}</p>}
              <p className="mt-3 text-xs text-slate-400">
                训练记录保存在本机，中途退出后可返回本页重新进入继续作答。
              </p>
            </>
          )}
        </div>
      )}

      <div className="mt-2 text-center">
        <Link to="/" className="text-xs text-slate-400 underline">
          返回首页
        </Link>
      </div>
    </div>
  );
}
