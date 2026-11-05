/**
 * 真题训练 · 组卷设置页面（3b）
 *
 * 职责：筛选条件（篇章/年份/题型/题量）→ 调用 getRandomExamQuestions 组卷 → 组卷预览。
 * 边界：生成预览本身不创建训练会话；只有用户点击「开始答题」才用当前预览的题目与顺序
 *       创建会话并跳转答题页（3c）。不写训练数据，不修改正式真题数据，选项保持原始顺序。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Link, useNavigate } from "react-router-dom";
import {
  getRandomExamQuestions,
  loadExamQuestions,
  startExamSession,
  ExamDataError,
} from "@/lib/examService";
import type {
  ExamFilters,
} from "@/lib/examService";
import type {
  ExamQuestion,
  ExamQuestionType,
  ExamSection,
} from "@/types/exam";

/* ---------------- 可导出的纯逻辑（供测试复用） ---------------- */

export type SectionFilter = "全部" | ExamSection;
export type YearFilter = "全部" | number;
export type TypeFilter = "全部" | ExamQuestionType;
export type CountFilter = 10 | 20 | 50;

/** 组卷设置（页面状态的最小表示） */
export interface PaperOptions {
  section: SectionFilter;
  year: YearFilter;
  questionType: TypeFilter;
  count: CountFilter;
}

/** 默认设置：全部篇章 / 全部年份 / 全部题型 / 20 题 */
export const DEFAULT_PAPER_OPTIONS: PaperOptions = {
  section: "全部",
  year: "全部",
  questionType: "全部",
  count: 20,
};

/** 从正式题目动态提取年份（去重、降序），不硬编码年份列表 */
export function extractYears(questions: ExamQuestion[]): number[] {
  return [...new Set(questions.map((q) => q.year))].sort((a, b) => b - a);
}

/** 将页面筛选状态映射为 examService 的 ExamFilters（"全部" → 不传该条件） */
export function toExamFilters(options: PaperOptions): ExamFilters {
  return {
    ...(options.section !== "全部" ? { section: options.section } : {}),
    ...(options.year !== "全部" ? { year: options.year } : {}),
    ...(options.questionType !== "全部" ? { questionType: options.questionType } : {}),
  };
}

/**
 * 组卷：调用现有 getRandomExamQuestions（不重复抽题、不足返回实际数量）。
 * 不修改题库数据、不改变选项顺序。
 */
export async function generatePaper(
  options: PaperOptions,
  fetchImpl?: typeof fetch,
): Promise<ExamQuestion[]> {
  return getRandomExamQuestions({
    count: options.count,
    ...toExamFilters(options),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** 组卷预览摘要 */
export interface PaperSummary {
  total: number;
  chengyu: number;
  shici: number;
  singleBlank: number;
  multiBlank: number;
}

/** 统计组卷的篇章与题型分布 */
export function summarizePaper(paper: ExamQuestion[]): PaperSummary {
  return {
    total: paper.length,
    chengyu: paper.filter((q) => q.section === "成语").length,
    shici: paper.filter((q) => q.section === "实词").length,
    singleBlank: paper.filter((q) => q.questionType === "单空").length,
    multiBlank: paper.filter((q) => q.questionType === "多空").length,
  };
}

/** 两份设置是否一致（用于「条件已变更」提示） */
export function sameOptions(a: PaperOptions, b: PaperOptions): boolean {
  return (
    a.section === b.section &&
    a.year === b.year &&
    a.questionType === b.questionType &&
    a.count === b.count
  );
}

/** 答题页路径 */
export function examStudyPath(trainingId: string): string {
  return `/exam/study/${trainingId}`;
}

/** 组卷预览 → 会话题目 ID（严格保持预览顺序，不重新随机） */
export function paperQuestionIds(paper: ExamQuestion[]): string[] {
  return paper.map((q) => q.id);
}

/* ---------------- 页面组件 ---------------- */

const SECTION_OPTIONS: SectionFilter[] = ["全部", "成语", "实词"];
const TYPE_OPTIONS: TypeFilter[] = ["全部", "单空", "多空"];
const COUNT_OPTIONS: CountFilter[] = [10, 20, 50];

/** 单选按钮组（与设置页分段按钮风格一致） */
function OptionGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format,
  disabled,
}: {
  label: string;
  options: T[];
  value: T;
  onChange: (v: T) => void;
  format: (v: T) => string;
  disabled?: boolean;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-700">{label}</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={String(opt)}
              type="button"
              disabled={disabled}
              onClick={() => onChange(opt)}
              className={`rounded-2xl px-4 py-2 text-sm transition-colors disabled:opacity-40 ${
                active ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700"
              }`}
            >
              {format(opt)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ExamPage() {
  const navigate = useNavigate();
  const [options, setOptions] = useState<PaperOptions>(DEFAULT_PAPER_OPTIONS);
  const [years, setYears] = useState<number[] | null>(null); // null = 年份加载中
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [paper, setPaper] = useState<ExamQuestion[] | null>(null);
  const [paperOptions, setPaperOptions] = useState<PaperOptions | null>(null); // 当前预览对应的条件
  const [genError, setGenError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** 同步闸门：连续点击只创建一次会话 */
  const startingRef = useRef(false);

  // 首次进入：加载正式题目并动态提取年份（不写库、不建会话）
  async function loadYears() {
    setLoadError(null);
    setYears(null);
    try {
      const all = await loadExamQuestions();
      setYears(extractYears(all));
    } catch (e) {
      setLoadError(
        e instanceof ExamDataError
          ? `真题数据加载失败：${e.message}`
          : "真题数据加载失败，请检查网络后重试",
      );
    }
  }
  useEffect(() => {
    void loadYears();
  }, []);

  const summary = useMemo(
    () => (paper ? summarizePaper(paper) : null),
    [paper],
  );
  const conditionsChanged =
    paperOptions !== null && !sameOptions(options, paperOptions);

  async function handleGenerate() {
    if (generating || years === null) return; // 连续点击保护
    setGenerating(true);
    setGenError(null);
    setStartError(null);
    try {
      const result = await generatePaper(options);
      setPaper(result);
      setPaperOptions({ ...options });
    } catch (e) {
      setPaper(null);
      setPaperOptions(null);
      setGenError(
        e instanceof ExamDataError
          ? `组卷失败：${e.message}`
          : "组卷失败，请稍后重试",
      );
    } finally {
      setGenerating(false);
    }
  }

  /** 开始答题：用当前预览的题目与顺序创建会话（只此一处创建会话） */
  async function handleStart() {
    if (startingRef.current || !paper || paper.length === 0) return;
    startingRef.current = true;
    setStarting(true);
    setStartError(null);
    try {
      const session = await startExamSession(paperQuestionIds(paper));
      navigate(examStudyPath(session.trainingId));
    } catch (e) {
      setStartError(
        e instanceof ExamDataError
          ? `创建训练会话失败：${e.message}`
          : "创建训练会话失败，请稍后重试",
      );
      startingRef.current = false;
      setStarting(false);
    }
    // 成功路径不重置闸门：页面即将跳转，避免重复创建
  }

  return (
    <div className="page-container">
      <PageHeader
        title="真题训练"
        subtitle="选择条件生成试卷，正式 204 道公务员考试言语理解真题"
      />

      {/* 年份数据加载中 / 加载失败 */}
      {years === null && !loadError && (
        <div className="card mb-4">
          <p className="text-sm text-slate-500">正在加载真题数据…</p>
        </div>
      )}
      {loadError && (
        <div className="card mb-4">
          <p className="text-sm text-danger-500">{loadError}</p>
          <button type="button" className="btn-secondary mt-4 w-full" onClick={() => void loadYears()}>
            重试
          </button>
        </div>
      )}

      {years !== null && (
        <div className="card mb-4 space-y-5">
          <OptionGroup
            label="篇章"
            options={SECTION_OPTIONS}
            value={options.section}
            onChange={(section) => setOptions({ ...options, section })}
            format={(v) => (v === "全部" ? "全部" : `${v}篇`)}
          />
          <OptionGroup
            label="年份"
            options={["全部" as const, ...years]}
            value={options.year}
            onChange={(year) => setOptions({ ...options, year })}
            format={(v) => (v === "全部" ? "全部" : String(v))}
          />
          <OptionGroup
            label="题型"
            options={TYPE_OPTIONS}
            value={options.questionType}
            onChange={(questionType) => setOptions({ ...options, questionType })}
            format={(v) => (v === "全部" ? "全部" : `${v}题`)}
          />
          <OptionGroup
            label="题量"
            options={COUNT_OPTIONS}
            value={options.count}
            onChange={(count) => setOptions({ ...options, count })}
            format={(v) => `${v}题`}
          />

          <button
            type="button"
            className="btn-primary w-full"
            disabled={generating}
            onClick={() => void handleGenerate()}
          >
            {generating ? "正在生成试卷…" : "生成试卷"}
          </button>

          {conditionsChanged && !generating && (
            <p className="text-xs text-accent-500">
              筛选条件已变更，点击「生成试卷」重新组卷。
            </p>
          )}
          {genError && <p className="text-sm text-danger-500">{genError}</p>}
        </div>
      )}

      {/* 组卷预览 */}
      {paper !== null && paperOptions !== null && summary !== null && (
        <div className="card mb-4">
          <h2 className="text-lg font-medium">组卷预览</h2>

          {paper.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              该条件下暂无题目，请调整篇章、年份或题型后重新生成。
            </p>
          ) : (
            <>
              {paper.length < paperOptions.count && (
                <p className="mt-3 text-sm text-accent-500">
                  该条件下可用题目不足 {paperOptions.count} 道，实际生成{" "}
                  {paper.length} 道。
                </p>
              )}

              <div className="mt-4 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                <div className="rounded-2xl bg-slate-50 py-3">
                  <p className="text-xl font-semibold text-brand-600">{summary.total}</p>
                  <p className="mt-0.5 text-xs text-slate-500">实际题量</p>
                </div>
                <div className="rounded-2xl bg-slate-50 py-3">
                  <p className="text-xl font-semibold text-brand-600">{summary.chengyu}</p>
                  <p className="mt-0.5 text-xs text-slate-500">成语篇</p>
                </div>
                <div className="rounded-2xl bg-slate-50 py-3">
                  <p className="text-xl font-semibold text-brand-600">{summary.shici}</p>
                  <p className="mt-0.5 text-xs text-slate-500">实词篇</p>
                </div>
                <div className="rounded-2xl bg-slate-50 py-3">
                  <p className="text-xl font-semibold text-brand-600">
                    {summary.singleBlank} / {summary.multiBlank}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">单空 / 多空</p>
                </div>
              </div>

              <ul className="mt-5 space-y-3">
                {paper.map((q, i) => (
                  <li key={q.id} className="rounded-2xl bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">
                      第 {i + 1} 题 · {q.examSource} · {q.questionType} ·{" "}
                      {q.section}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">
                      {q.questionText}
                    </p>
                    {/* 题干仅预览；可交互选项在答题页（3c）呈现 */}
                  </li>
                ))}
              </ul>

              <button
                type="button"
                className="btn-primary mt-5 w-full"
                disabled={starting || conditionsChanged}
                onClick={() => void handleStart()}
              >
                {starting ? "正在创建试卷…" : "开始答题"}
              </button>
              {conditionsChanged && (
                <p className="mt-2 text-xs text-slate-500">
                  筛选条件已变更，请先重新生成试卷再开始答题。
                </p>
              )}
              {startError && (
                <p className="mt-2 text-sm text-danger-500">{startError}</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="card">
        <p className="text-sm leading-relaxed text-slate-500">
          题目全部来自历年公务员考试真题（成语篇 177 道、实词篇 27
          道）。点击「生成试卷」仅做组卷预览，开始答题后才会记录训练数据。
        </p>
        <Link to="/" className="btn-secondary mt-4 w-full">
          返回首页
        </Link>
      </div>
    </div>
  );
}
