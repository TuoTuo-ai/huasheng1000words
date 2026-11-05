/**
 * 真题训练 · 结果页（3d-b 骨架 + 3d-c 逐题列表与内联详情 + 3d-d 耗时卡）
 *
 * 职责：
 * - 进入时通过 getExamSessionResult(trainingId) 从 IndexedDB 恢复结果（刷新后同样如此）
 * - 展示成绩总览（总题数 / 已答 / 正确 / 错误 / 未答 / 正确率）
 * - 展示成语篇、实词篇统计（固定两篇，空篇补 0）
 * - 展示耗时卡（整套训练耗时 + 有效答题用时合计，双口径并列）
 * - 加载中 / 加载失败 / 会话不存在 三类状态
 * - 未完成会话：顶部提示条 +「继续答题」入口，不阻断展示
 * - 逐题列表（三态徽标）+ 内联详情展开（题干原文 / 原始选项 / 判定 / 解析）
 *
 * 边界：
 * - **只读**：不创建会话、不写训练记录、不结束会话
 * - 统计与详情判定一律调用 `@/lib/examStats` 的纯函数，页面内不重复实现统计公式
 * - 选项与题干按题库原始顺序原样渲染，不排序、不改写、不重新判题
 * - 详情为内联展开，不新增子路由；不增加题型统计；无错题重练入口
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import {
  ExamDataError,
  getExamSessionResult,
  type ExamSessionResult,
} from "@/lib/examService";
import {
  answerStateOf,
  computeDurationStats,
  computeOverview,
  computeSectionStats,
  durationOf as durationOfQuestion,
  optionState as statsOptionState,
  explanationText,
  formatDuration,
  questionStatus as statsQuestionStatus,
  type OptionState,
  type QuestionStatus,
  type ResultOverview,
  type SectionStat,
} from "@/lib/examStats";
import type { ExamSessionResultItem } from "@/lib/examService";

/* ---------------- 可导出的纯逻辑（供测试复用） ---------------- */

/** 结果页路径（3d-d 由答题页完成态跳转使用） */
export function examResultPath(trainingId: string): string {
  return `/exam/result/${trainingId}`;
}

/** 未完成会话的「继续答题」路径（复用答题页已有路由，不新增） */
export function examContinuePath(trainingId: string): string {
  return `/exam/study/${trainingId}`;
}

/** 加载状态机 */
export type ResultLoadState = "loading" | "error" | "missing" | "empty" | "ready";

/**
 * 由一次加载结果推导加载状态：
 * - 加载中 / 加载失败由调用方直接置位；
 * - 结果为 null → 会话不存在；
 * - items 为空 → 空数据（会话无题目）；
 * - 其余 → ready。
 */
export function resolveLoadState(
  data: ExamSessionResult | null,
  error: string | null,
  loading: boolean,
): ResultLoadState {
  if (loading) return "loading";
  if (error !== null) return "error";
  if (data === null) return "missing";
  if (data.items.length === 0) return "empty";
  return "ready";
}

/** 未完成提示文案（已答 X/Y 题），与总览数字同源 */
export function unfinishedHint(overview: ResultOverview): string {
  return `本次训练未完成（已答 ${overview.answered}/${overview.total} 题），以下为当前进度`;
}

/** 空篇章提示文案 */
export const EMPTY_SECTION_HINT = "本次试卷未包含该篇题目";

/** 未完成会话的总耗时占位文案（不用当前时间估算，保证可复现） */
export const UNFINISHED_DURATION_HINT = "训练未完成，无总耗时";

/** 统计卡片展示项（避免在 JSX 里散落口径说明） */
export interface OverviewCard {
  key: string;
  label: string;
  value: string;
  /** 主数值（正确率）高亮 */
  emphasize?: boolean;
}

/** 总览卡片：顺序固定，正确率带 % */
export function overviewCards(overview: ResultOverview): OverviewCard[] {
  return [
    { key: "total", label: "总题数", value: String(overview.total) },
    { key: "answered", label: "已答", value: String(overview.answered) },
    { key: "correct", label: "正确", value: String(overview.correct) },
    { key: "wrong", label: "错误", value: String(overview.wrong) },
    { key: "unanswered", label: "未答", value: String(overview.unanswered) },
    {
      key: "accuracy",
      label: "正确率",
      value: `${overview.accuracy}%`,
      emphasize: true,
    },
  ];
}

/** 篇章卡片：篇章名 + 六项指标文本（空篇展示提示文案） */
export interface SectionCard {
  section: string;
  isEmpty: boolean;
  total: number;
  answered: number;
  correct: number;
  wrong: number;
  unanswered: number;
  accuracyText: string;
}

export function sectionCards(stats: SectionStat[]): SectionCard[] {
  return stats.map((stat) => ({
    section: stat.section,
    isEmpty: stat.total === 0,
    total: stat.total,
    answered: stat.answered,
    correct: stat.correct,
    wrong: stat.wrong,
    unanswered: stat.unanswered,
    accuracyText: `${stat.accuracy}%`,
  }));
}

/* ---------------- 逐题列表（3d-c） ---------------- */

/** 未作答行展示的占位符（用户答案 / 用时） */
export const BLANK_PLACEHOLDER = "—";

/** 状态徽标文案（三态严格互斥，由 record 判定，不由答案字符串判定） */
export const STATUS_LABEL: Record<QuestionStatus, string> = {
  correct: "正确",
  wrong: "错误",
  unanswered: "未作答",
};

/** 逐题列表行（折叠态）展示模型 */
export interface ResultRow {
  /** 试卷内序号（items 下标 + 1），非 questionNumber */
  index: number;
  questionId: string;
  examSource: string;
  questionType: string;
  section: string;
  /** 用户答案；未作答为 "—" */
  userAnswerText: string;
  /** 正确答案（未作答也照常显示，便于复盘） */
  correctAnswer: string;
  /** 三态：correct / wrong / unanswered */
  status: QuestionStatus;
  statusLabel: string;
  /** 用时文本；未作答为 "—"（不显示 0 秒） */
  durationText: string;
}

/**
 * 构造逐题列表行。
 * 顺序严格等于 items（即 session.questionIds 顺序），不重排。
 * 状态判定调用 examStats.questionStatus（record === null → unanswered）。
 */
export function buildResultRows(
  items: readonly ExamSessionResultItem[],
  durationOfQuestion: (questionId: string) => number | null,
): ResultRow[] {
  return items.map((item, i) => {
    const status = statsQuestionStatus(item);
    const answered = status !== "unanswered";
    return {
      index: i + 1,
      questionId: item.question.id,
      examSource: item.question.examSource,
      questionType: item.question.questionType,
      section: item.question.section,
      userAnswerText: answered ? item.record!.userAnswer : BLANK_PLACEHOLDER,
      correctAnswer: item.question.answer,
      status,
      statusLabel: STATUS_LABEL[status],
      durationText: answered ? formatDuration(durationOfQuestion(item.question.id)) : BLANK_PLACEHOLDER,
    };
  });
}

/** 详情模型（内联展开内容） */
export interface ResultDetail {
  questionId: string;
  /** 元信息行：{section}篇 · {examSource} · {questionType} */
  meta: string;
  /** 题干原文（不截断、不改写） */
  questionText: string;
  /** 选项原始顺序（A/B/C/D，与 JSON 一致，不排序） */
  options: { id: string; content: string; state: OptionState }[];
  status: QuestionStatus;
  statusLabel: string;
  /** 判定文案：答对 / 答错 / 未作答 */
  verdict: string;
  /** 用户答案文本；未作答为 "—" */
  userAnswerText: string;
  correctAnswer: string;
  /** 解析；空则为「本题暂无解析」 */
  explanation: string;
}

/**
 * 构造单题详情。
 * - 选项严格按 question.options 原始顺序渲染，不排序、不改写；
 * - 选项三态由 examStats.optionState 判定（未作答全 idle，正确项 correct，用户错选项 wrong）；
 * - 判定一律取 record.isCorrect，不重新判题；
 * - 解析空则显示「本题暂无解析」（examStats.explanationText）。
 */
export function buildResultDetail(item: ExamSessionResultItem): ResultDetail {
  const q = item.question;
  const status = statsQuestionStatus(item);
  const answer = answerStateOf(item.question, item.record);
  return {
    questionId: q.id,
    meta: `${q.section}篇 · ${q.examSource} · ${q.questionType}`,
    questionText: q.questionText,
    options: q.options.map((opt) => ({
      id: opt.id,
      content: opt.content,
      state: statsOptionState(opt.id, answer, q.answer),
    })),
    status,
    statusLabel: STATUS_LABEL[status],
    verdict: status === "correct" ? "答对" : status === "wrong" ? "答错" : "未作答",
    userAnswerText: item.record ? item.record.userAnswer : BLANK_PLACEHOLDER,
    correctAnswer: q.answer,
    explanation: explanationText(q.explanation),
  };
}

/** 徽标样式（三态互斥，颜色不共用） */
export const STATUS_STYLE: Record<QuestionStatus, string> = {
  correct: "bg-green-50 text-success-500",
  wrong: "bg-red-50 text-danger-500",
  unanswered: "bg-slate-50 text-slate-500",
};

/** 选项样式：正确项绿边绿底 / 用户错选项红边红底 / 其余（已答灰底、未答白底） */
export function optionClass(state: OptionState, answered: boolean): string {
  if (state === "correct") return "border-success-500 bg-green-50";
  if (state === "wrong") return "border-danger-500 bg-red-50";
  return answered ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white";
}

/* ---------------- 详情面板（内联展开） ---------------- */

/**
 * 单题详情：元信息 + 题干原文 + 四个原始选项 + 判定 + 解析。
 * 只读渲染，不排序、不改写、不重新判题，不提供任何训练/重练入口。
 */
function ResultDetailPanel({ detail }: { detail: ResultDetail }) {
  const answered = detail.status !== "unanswered";
  return (
    <div className="border-t border-slate-200 px-4 py-4">
      <p className="text-xs text-slate-500">{detail.meta}</p>
      <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">
        {detail.questionText}
      </p>
      <ul className="mt-3 space-y-2">
        {detail.options.map((opt) => (
          <li
            key={opt.id}
            className={`rounded-xl border px-3 py-2 text-sm text-slate-800 ${optionClass(
              opt.state,
              answered,
            )}`}
          >
            <span className="font-medium">{opt.id}.</span> {opt.content}
          </li>
        ))}
      </ul>
      <div className="mt-3 text-sm">
        <p className="text-slate-800">{detail.verdict}</p>
        <p className="mt-1 text-slate-600">
          你的答案 {detail.userAnswerText} ｜ 正确答案 {detail.correctAnswer}
        </p>
      </div>
      <div className="mt-3">
        <p className="text-xs text-slate-500">解析</p>
        <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-slate-700">
          {detail.explanation}
        </p>
      </div>
    </div>
  );
}

/* ---------------- 页面组件 ---------------- */

export default function ExamResultPage() {
  const { trainingId } = useParams<{ trainingId: string }>();
  const [data, setData] = useState<ExamSessionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 请求世代守卫：旧请求晚到时不覆盖新状态（与组件存活无关） */
  const guard = useRef({ seq: 0 }).current;
  /** 内联展开的题目 ID（一次只展开一题；null 为全部折叠） */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /**
   * 组件存活标记（引用对象，跨渲染稳定）：
   * useEffect cleanup 时置 false，卸载后异步回调不再执行任何状态更新。
   * 与 guard.seq 职责不同：seq 处理「同一组件内旧请求覆盖新请求」，
   * alive 处理「组件已卸载仍回写状态」，两者不可互相替代。
   */
  const aliveRef = useRef({ alive: true });

  const load = useCallback(async () => {
    const seq = (guard.seq += 1);
    if (!trainingId) {
      if (!aliveRef.current.alive) return;
      setError("缺少训练会话标识，无法加载成绩。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    try {
      // 只读：仅读取会话与记录，不写库、不 finish
      const result = await getExamSessionResult(trainingId);
      if (seq !== guard.seq) return; // 过期响应丢弃
      if (!aliveRef.current.alive) return; // 已卸载：丢弃
      setData(result);
    } catch (e) {
      if (seq !== guard.seq) return;
      if (!aliveRef.current.alive) return; // 已卸载：丢弃
      setError(
        e instanceof ExamDataError
          ? `成绩加载失败：${e.message}`
          : "成绩加载失败，请检查网络后重试。",
      );
    } finally {
      if (seq === guard.seq && aliveRef.current.alive) setLoading(false);
    }
  }, [trainingId, guard]);

  useEffect(() => {
    // 挂载开始加载前先标记存活（重试按钮复用 load，不经过此处，但 alive 保持 true）
    aliveRef.current.alive = true;
    void load();
    return () => {
      aliveRef.current.alive = false;
    };
  }, [load]);

  const state = resolveLoadState(data, error, loading);

  const overview = useMemo(
    () => (data ? computeOverview(data.items) : null),
    [data],
  );
  const sections = useMemo(
    () => (data ? computeSectionStats(data.items) : []),
    [data],
  );
  const finished = data?.finished ?? false;
  const cards = overview ? overviewCards(overview) : [];
  const sectionList = sectionCards(sections);

  /** 每题耗时查询（3d-c 列表行展示用；耗时卡在 3d-d） */
  const durations = useMemo(
    () => (data ? computeDurationStats(data.session, data.items) : null),
    [data],
  );
  /** 逐题列表行（顺序 = items 顺序） */
  const rows = useMemo(
    () =>
      data
        ? buildResultRows(data.items, (id) => (durations ? durationOfQuestion(durations, id) : null))
        : [],
    [data, durations],
  );

  return (
    <div className="page-container">
      <PageHeader title="训练成绩" subtitle="本次真题训练的作答结果" />

      {state === "loading" && (
        <div className="card mb-4">
          <p className="text-sm text-slate-500">正在加载成绩…</p>
        </div>
      )}

      {state === "error" && (
        <div className="card mb-4">
          <p className="text-sm text-danger-500">{error}</p>
          <button
            type="button"
            className="btn-secondary mt-4 w-full"
            onClick={() => void load()}
          >
            重试
          </button>
          <Link to="/exam" className="btn-secondary mt-3 block text-center">
            返回组卷设置
          </Link>
        </div>
      )}

      {state === "missing" && (
        <div className="card mb-4">
          <p className="text-sm text-slate-600">
            未找到该训练会话，可能已过期或不存在。
          </p>
          <Link to="/exam" className="btn-primary mt-4 block text-center">
            返回组卷设置
          </Link>
        </div>
      )}

      {state === "empty" && (
        <div className="card mb-4">
          <p className="text-sm text-slate-600">该训练会话没有题目数据。</p>
          <Link to="/exam" className="btn-secondary mt-4 block text-center">
            返回组卷设置
          </Link>
        </div>
      )}

      {state === "ready" && overview && (
        <>
          {/* 未完成会话：提示条 + 继续答题（不自动结束会话） */}
          {!finished && trainingId && (
            <div className="card mb-4 border-l-4 border-accent-500 bg-amber-50">
              <p className="text-sm leading-relaxed text-amber-700">
                {unfinishedHint(overview)}
              </p>
              <Link
                to={examContinuePath(trainingId)}
                className="btn-primary mt-3 block text-center"
              >
                继续答题
              </Link>
            </div>
          )}

          {/* 成绩总览 */}
          <div className="card mb-4">
            <h2 className="text-lg font-medium">成绩总览</h2>
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              {cards.map((card) => (
                <div key={card.key} className="rounded-2xl bg-slate-50 py-3">
                  <p
                    className={`text-xl font-semibold ${
                      card.emphasize ? "text-brand-600" : "text-slate-800"
                    }`}
                  >
                    {card.value}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">{card.label}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              正确率 = 正确数 / 已答题数（四舍五入取整），未答题不计入分母。
            </p>
          </div>

          {/* 篇章统计 */}
          <div className="card mb-4">
            <h2 className="text-lg font-medium">篇章统计</h2>
            <ul className="mt-4 space-y-3">
              {sectionList.map((card) => (
                <li key={card.section} className="rounded-2xl bg-slate-50 p-4">
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-medium text-slate-800">
                      {card.section}篇
                    </p>
                    <p className="text-sm text-slate-500">
                      正确率 {card.accuracyText}
                    </p>
                  </div>
                  {card.isEmpty ? (
                    <p className="mt-2 text-xs text-slate-500">
                      {EMPTY_SECTION_HINT}
                    </p>
                  ) : (
                    <div className="mt-2 grid grid-cols-5 gap-2 text-center">
                      <div>
                        <p className="text-base font-semibold text-slate-800">
                          {card.total}
                        </p>
                        <p className="text-xs text-slate-500">总题数</p>
                      </div>
                      <div>
                        <p className="text-base font-semibold text-slate-800">
                          {card.answered}
                        </p>
                        <p className="text-xs text-slate-500">已答</p>
                      </div>
                      <div>
                        <p className="text-base font-semibold text-success-500">
                          {card.correct}
                        </p>
                        <p className="text-xs text-slate-500">正确</p>
                      </div>
                      <div>
                        <p className="text-base font-semibold text-danger-500">
                          {card.wrong}
                        </p>
                        <p className="text-xs text-slate-500">错误</p>
                      </div>
                      <div>
                        <p className="text-base font-semibold text-slate-800">
                          {card.unanswered}
                        </p>
                        <p className="text-xs text-slate-500">未答</p>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* 耗时卡（3d-d）：两种口径并列，互不替代 */}
          {durations && (
            <div className="card mb-4">
              <h2 className="text-lg font-medium">训练耗时</h2>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-2xl bg-slate-50 py-3 text-center">
                  <p
                    className={`font-semibold ${
                      durations.totalMs === null ? "text-sm text-slate-500" : "text-xl text-brand-600"
                    }`}
                  >
                    {durations.totalMs === null
                      ? UNFINISHED_DURATION_HINT
                      : formatDuration(durations.totalMs)}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">整套训练耗时</p>
                </div>
                <div className="rounded-2xl bg-slate-50 py-3 text-center">
                  <p className="text-xl font-semibold text-brand-600">
                    {formatDuration(durations.activeMs)}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">有效答题用时合计</p>
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                整套训练耗时为开始到结束的实际时长；有效答题用时合计只累加已答题的作答时长（不含翻页与停留间隙）。
              </p>
            </div>
          )}

          {/* 逐题结果（3d-c）：三态徽标 + 内联展开详情，不跳转、不改写题型统计 */}
          <div className="card mb-4">
            <h2 className="text-lg font-medium">逐题结果</h2>
            <ul className="mt-4 space-y-2">
              {rows.map((row) => {
                const item = data!.items[row.index - 1];
                const expanded = expandedId === row.questionId;
                return (
                  <li key={row.questionId} className="rounded-2xl bg-slate-50">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : row.questionId)}
                      aria-expanded={expanded}
                      className="flex w-full items-start justify-between gap-3 p-4 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs text-slate-500">
                          第 {row.index} 题 · {row.examSource} · {row.questionType} ·{" "}
                          {row.section}篇
                        </span>
                        <span className="mt-1 block text-sm text-slate-800">
                          答 {row.userAnswerText} ｜ 正确 {row.correctAnswer}
                        </span>
                        <span className="mt-1 block text-xs text-slate-500">
                          用时 {row.durationText}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                          STATUS_STYLE[row.status]
                        }`}
                      >
                        {row.statusLabel}
                      </span>
                    </button>

                    {expanded && <ResultDetailPanel detail={buildResultDetail(item)} />}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="card">
            <Link to="/exam" className="btn-secondary w-full text-center">
              重新组卷
            </Link>
            <Link to="/" className="btn-secondary mt-3 block text-center">
              返回首页
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
