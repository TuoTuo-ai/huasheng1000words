/**
 * 分类辨析训练 · 答题页
 *
 * 职责：
 * - 进入时从 IndexedDB 恢复会话（题目顺序 / 已答记录 / 定位到第一道未答题）
 * - 单题作答：点击选项 → submitQuizAnswer → 成功后显示判定并锁定
 * - 展示题目**已有**的 explanation 与 option.explain，缺失时显示「暂无解析」，不编造
 * - 上一题回看、下一题（未作答不得跳过）、全部答完自动结束会话并进入完成态
 *
 * 边界：
 * - 不新建会话、不重新抽题、不改写题目
 * - 选项按题目原始顺序渲染
 * - 中途退出后再次进入本页可继续作答（数据全部来自库）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import {
  QuizServiceError,
  correctOptionText,
  explanationText,
  finishQuizSession,
  getQuizSessionResult,
  hasAiContent,
  optionExplainText,
  optionLines,
  quizResultPath,
  stemText,
  submitQuizAnswer,
  type QuizSessionResult,
} from "@/lib/quizService";
import type { QuizQuestion, TrainingRecord } from "@/types/quiz";

/* ---------------- 可导出的纯逻辑（供测试复用） ---------------- */

/** 单题答复状态 */
export interface QuizAnswerState {
  questionId: string;
  /** 用户选择的选项 ID */
  userAnswer: string;
  isCorrect: boolean;
}

/** 答题页视图模型 */
export interface QuizStudyView {
  questions: QuizQuestion[];
  answers: Map<string, QuizAnswerState>;
  answeredCount: number;
  total: number;
  allAnswered: boolean;
  finished: boolean;
}

/** 从结果构造答题页视图（保持题目顺序、恢复已答内容） */
export function buildQuizStudyView(result: QuizSessionResult): QuizStudyView {
  const answers = new Map<string, QuizAnswerState>();
  for (const item of result.items) {
    const rec: TrainingRecord | null = item.record;
    if (rec) {
      answers.set(item.question.id, {
        questionId: item.question.id,
        userAnswer: rec.userAnswer,
        isCorrect: rec.isCorrect,
      });
    }
  }
  return {
    questions: result.items.map((it) => it.question),
    answers,
    answeredCount: answers.size,
    total: result.items.length,
    allAnswered: answers.size === result.items.length && result.items.length > 0,
    finished: result.finished,
  };
}

/** 进入答题页的定位题号：第一道未答题；全部答完则最后一题 */
export function firstUnansweredIndex(
  questions: readonly QuizQuestion[],
  answers: ReadonlyMap<string, QuizAnswerState>,
): number {
  if (questions.length === 0) return 0;
  const idx = questions.findIndex((q) => !answers.has(q.id));
  return idx === -1 ? questions.length - 1 : idx;
}

/** 是否可进入下一题（当前题必须已作答） */
export function canGoNext(
  questions: readonly QuizQuestion[],
  answers: ReadonlyMap<string, QuizAnswerState>,
  index: number,
): boolean {
  const current = questions[index];
  return !!current && answers.has(current.id) && index < questions.length - 1;
}

export function canGoPrev(index: number): boolean {
  return index > 0;
}

/** 选项视觉状态 */
export type QuizOptionState = "correct" | "wrong" | "idle";

/** 选项状态：已答时正确项标绿、用户选错项标红，其余保持中性 */
export function quizOptionState(
  optionId: string,
  answer: QuizAnswerState | undefined,
  correctOptionId: string,
): QuizOptionState {
  if (!answer) return "idle";
  if (optionId === correctOptionId) return "correct";
  if (optionId === answer.userAnswer) return "wrong";
  return "idle";
}

/** 单题耗时（毫秒，非负） */
export function computeQuizDurationMs(startedAt: number, submittedAt: number): number {
  return Math.max(0, submittedAt - startedAt);
}

/**
 * 应用提交结果到答案表：
 * - accepted → 写入本次选择
 * - already-submitted 且已有记录 → 保持原记录不变（不覆盖）
 */
export function applyQuizSubmitResult(
  answers: Map<string, QuizAnswerState>,
  questionId: string,
  userAnswer: string,
  status: "accepted" | "already-submitted",
  isCorrect: boolean,
): Map<string, QuizAnswerState> {
  if (status === "already-submitted" && answers.has(questionId)) return answers;
  const next = new Map(answers);
  next.set(questionId, { questionId, userAnswer, isCorrect });
  return next;
}

/**
 * 提交成功后推进视图状态（纯函数，供页面与测试共用）：
 * - 更新答案表与已答题数
 * - **同步重算 allAnswered**：答完最后一题必须立刻为 true，否则结束会话不会被触发
 */
export function advanceAfterSubmit(
  view: QuizStudyView,
  questionId: string,
  userAnswer: string,
  status: "accepted" | "already-submitted",
  isCorrect: boolean,
): QuizStudyView {
  const already = view.answers.has(questionId);
  const answers = applyQuizSubmitResult(view.answers, questionId, userAnswer, status, isCorrect);
  const answeredCount = already ? view.answeredCount : view.answeredCount + 1;
  return {
    ...view,
    answers,
    answeredCount,
    allAnswered: answeredCount === view.total && view.total > 0,
  };
}

/**
 * already-submitted 时从数据库记录恢复原始反馈。
 * submitQuizAnswer 不返回 userAnswer，因此绝不能用本次点击的选项兜底。
 */
export function restoreQuizFeedback(
  record: TrainingRecord | null,
  questionId: string,
): QuizAnswerState | null {
  if (!record || record.questionId !== questionId) return null;
  const userAnswer = (record.userAnswer ?? "").trim();
  if (!userAnswer) return null;
  return { questionId, userAnswer, isCorrect: record.isCorrect };
}

/** 请求世代守卫：区分「当前有效请求」与「过期响应」 */
export function createQuizRequestGuard() {
  let current = 0;
  return {
    begin(): number {
      return ++current;
    },
    isCurrent(seq: number): boolean {
      return seq === current;
    },
  };
}

/* ---------------- 页面组件 ---------------- */

export default function QuizStudyPage() {
  const { trainingId = "" } = useParams();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<QuizStudyView | null>(null);
  const [index, setIndex] = useState(0);
  /** 反馈按 questionId 归属：切题后旧响应不会显示在新题下 */
  const [feedback, setFeedback] = useState<Record<string, QuizAnswerState>>({});
  const [restoreHint, setRestoreHint] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [completionDismissed, setCompletionDismissed] = useState(false);

  /** 当前题首次展示时间（0 表示尚未展示，进入时在加载完成处赋值） */
  const shownAtRef = useRef<number>(0);
  const submittingRef = useRef(false);
  const finishingRef = useRef(false);
  /** 世代守卫实例（ref 稳定，不参与依赖） */
  const guardRef = useRef(createQuizRequestGuard());

  const applyResult = useCallback((data: QuizSessionResult) => {
    const v = buildQuizStudyView(data);
    setView(v);
    setIndex(firstUnansweredIndex(v.questions, v.answers));
    setFinished(data.finished);
    setRestoreHint(null);
    setSubmitError(null);
    shownAtRef.current = Date.now();
  }, []);

  const load = useCallback(async () => {
    const guard = guardRef.current;
    const seq = guard.begin();
    if (!trainingId) {
      setLoadError("缺少训练标识，无法加载本次训练。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getQuizSessionResult(trainingId);
      if (!guard.isCurrent(seq)) return;
      if (!data) {
        setLoadError("未找到该次训练，可能已被清除。");
      } else if (data.items.length === 0) {
        setLoadError("本次训练没有题目，无法继续。");
      } else {
        applyResult(data);
      }
    } catch (e) {
      if (!guard.isCurrent(seq)) return;
      setLoadError(e instanceof QuizServiceError ? `训练加载失败：${e.message}` : "训练加载失败，请重试。");
    } finally {
      if (guard.isCurrent(seq)) setLoading(false);
    }
  }, [trainingId, applyResult]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 从数据库重新读取某题记录（already-submitted 场景） */
  const restoreRecordFor = useCallback(
    async (questionId: string): Promise<QuizAnswerState | null> => {
      const fresh = await getQuizSessionResult(trainingId).catch(() => null);
      if (!fresh) return null;
      const v = buildQuizStudyView(fresh);
      setView((prev) => (prev ? { ...prev, ...v, questions: prev.questions } : prev));
      const rec = fresh.items.find((it) => it.question.id === questionId)?.record ?? null;
      return restoreQuizFeedback(rec, questionId);
    },
    [trainingId],
  );

  const questions = view?.questions ?? [];
  const answers = view?.answers ?? new Map<string, QuizAnswerState>();
  const current: QuizQuestion | undefined = questions[index];

  function goTo(nextIndex: number) {
    if (nextIndex < 0 || nextIndex >= questions.length) return;
    setIndex(nextIndex);
    setSubmitError(null);
    setRestoreHint(null);
    shownAtRef.current = Date.now();
  }

  async function handleSelect(optionId: string) {
    if (!current || submittingRef.current) return;
    if (answers.has(current.id)) return; // 已答锁定
    const submittedAt = Date.now();
    const durationMs = computeQuizDurationMs(shownAtRef.current, submittedAt);
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await submitQuizAnswer(trainingId, current, optionId, { submittedAt, durationMs });
      const qid = current.id;
      setView((prev) =>
        prev ? advanceAfterSubmit(prev, qid, optionId, res.status, res.isCorrect) : prev,
      );

      if (res.status === "accepted") {
        setFeedback((prev) => ({
          ...prev,
          [qid]: { questionId: qid, userAnswer: optionId, isCorrect: res.isCorrect },
        }));
      } else {
        const restored = await restoreRecordFor(qid);
        if (restored) {
          setFeedback((prev) => ({ ...prev, [qid]: restored }));
        } else {
          setRestoreHint("该题已作答，但未能读取到原记录，请刷新页面恢复。");
        }
      }
    } catch (e) {
      setSubmitError(
        e instanceof QuizServiceError ? `提交失败：${e.message}` : "提交失败，请重试。",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /** 全部答完 → 结束会话（只调用一次；未答完绝不调用） */
  useEffect(() => {
    if (!view || !view.allAnswered || view.finished || finishingRef.current) return;
    finishingRef.current = true;
    (async () => {
      try {
        await finishQuizSession(trainingId);
        setFinished(true);
        setFinishError(null);
      } catch (e) {
        finishingRef.current = false;
        setFinishError(
          e instanceof QuizServiceError ? `结束训练失败：${e.message}` : "结束训练失败，请稍后重试。",
        );
      }
    })();
  }, [view, trainingId]);

  /* ---- 加载 / 错误 ---- */
  if (loading) {
    return (
      <div className="page-container">
        <PageHeader title="分类辨析" subtitle="正在加载本次训练…" />
        <div className="card">
          <p className="text-sm text-slate-500">正在读取题目与已作答记录…</p>
        </div>
      </div>
    );
  }

  if (loadError || !view || !current) {
    return (
      <div className="page-container">
        <PageHeader title="分类辨析" />
        <div className="card">
          <p className="text-sm text-danger-500">{loadError ?? "训练数据异常，无法继续。"}</p>
          <Link to="/quiz" className="btn-primary mt-4 w-full text-center">
            返回辨析训练
          </Link>
        </div>
      </div>
    );
  }

  const currentAnswer = answers.get(current.id) ?? feedback[current.id];
  const isAnswered = answers.has(current.id);
  const progressPct = Math.round((view.answeredCount / view.total) * 100);

  /* ---- 完成态 ---- */
  if (view.allAnswered && finished && !completionDismissed) {
    return (
      <div className="page-container">
        <PageHeader title="分类辨析" subtitle="本次训练已完成" />
        <div className="card">
          <p className="text-lg font-medium">本次训练已完成</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            共 {view.total} 题，已全部作答。可查看成绩与逐题回顾。
          </p>
          <div className="mt-4 flex gap-3">
            <Link
              to={quizResultPath(trainingId)}
              className="btn-primary flex-1 text-center"
            >
              查看结果
            </Link>
            <button
              type="button"
              className="btn-secondary flex-1"
              onClick={() => {
                setCompletionDismissed(true);
                goTo(0);
              }}
            >
              回看第 1 题
            </button>
          </div>
          <Link to="/quiz" className="btn-secondary mt-3 block text-center">
            再练一组
          </Link>
        </div>
      </div>
    );
  }

  const options = optionLines(current);
  const correctText = correctOptionText(current);
  const correctExplain = optionExplainText(current.correctOptionId, current);
  const userExplain =
    currentAnswer && currentAnswer.userAnswer !== current.correctOptionId
      ? optionExplainText(currentAnswer.userAnswer, current)
      : null;

  return (
    <div className="page-container">
      <PageHeader
        title="分类辨析"
        subtitle={`第 ${index + 1} / ${view.total} 题 · 已答 ${view.answeredCount} 题`}
      />

      <div className="mb-4">
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-brand-600 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      <div className="card mb-4">
        <p className="text-xs text-slate-500">
          {current.tags?.[0] ?? ""}
          {current.tags?.[2] ? ` · ${current.tags[2]}` : ""}
          {hasAiContent(current) ? " · 含 AI 辅助内容" : ""}
        </p>
        <p className="mt-3 text-base leading-relaxed whitespace-pre-wrap text-slate-900">
          {stemText(current)}
        </p>

        <div className="mt-5 space-y-2.5">
          {options.map((opt) => {
            const state = quizOptionState(opt.id, currentAnswer, current.correctOptionId);
            const base =
              "w-full rounded-2xl border px-4 py-3 text-left text-sm leading-relaxed transition-colors";
            const tone =
              state === "correct"
                ? "border-success-500 bg-green-50 text-green-900"
                : state === "wrong"
                  ? "border-danger-500 bg-red-50 text-red-900"
                  : isAnswered
                    ? "border-slate-200 bg-slate-50 text-slate-500"
                    : "border-slate-200 bg-white text-slate-800 active:bg-brand-50";
            return (
              <button
                key={opt.id}
                type="button"
                disabled={isAnswered || submitting}
                onClick={() => void handleSelect(opt.id)}
                className={`${base} ${tone} disabled:cursor-default`}
              >
                <span className="mr-2 font-semibold">{opt.label}.</span>
                <span className="whitespace-pre-wrap">{opt.content}</span>
              </button>
            );
          })}
        </div>

        {submitting && <p className="mt-3 text-xs text-slate-500">正在保存答案…</p>}

        {restoreHint && (
          <div className="mt-3">
            <p className="text-sm text-accent-500">{restoreHint}</p>
            <button type="button" className="mt-2 text-xs text-brand-600 underline" onClick={() => void load()}>
              立即刷新
            </button>
          </div>
        )}

        {submitError && (
          <div className="mt-3">
            <p className="text-sm text-danger-500">{submitError}</p>
            <p className="mt-1 text-xs text-slate-500">可重新点击选项重试。</p>
          </div>
        )}

        {/* 反馈：判定 + 题目已有解析 */}
        {isAnswered && currentAnswer && (
          <div className="mt-5 rounded-2xl bg-slate-50 p-4">
            <p
              className={`text-sm font-medium ${
                currentAnswer.isCorrect ? "text-green-700" : "text-danger-500"
              }`}
            >
              {currentAnswer.isCorrect ? "回答正确" : "回答错误"}
              <span className="ml-2 font-normal text-slate-600">正确答案：{correctText}</span>
            </p>
            {!currentAnswer.isCorrect && (
              <p className="mt-1 text-xs text-slate-500">
                你的答案：
                {options.find((o) => o.id === currentAnswer.userAnswer)?.content ??
                  currentAnswer.userAnswer}
              </p>
            )}
            {correctExplain && (
              <p className="mt-2 text-xs leading-relaxed text-slate-500">{correctExplain}</p>
            )}
            {userExplain && (
              <p className="mt-1 text-xs leading-relaxed text-slate-500">你选的：{userExplain}</p>
            )}
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-slate-700">
              {explanationText(current)}
            </p>
            {current.source?.citation && (
              <p className="mt-2 text-xs text-slate-400">出处：{current.source.citation}</p>
            )}
          </div>
        )}
      </div>

      {finishError && <p className="mb-3 text-sm text-danger-500">{finishError}</p>}

      <div className="flex gap-3">
        <button
          type="button"
          className="btn-secondary flex-1"
          disabled={!canGoPrev(index)}
          onClick={() => goTo(index - 1)}
        >
          上一题
        </button>
        <button
          type="button"
          className="btn-primary flex-1"
          disabled={!canGoNext(questions, answers, index)}
          onClick={() => goTo(index + 1)}
        >
          下一题
        </button>
      </div>
      {!isAnswered && (
        <p className="mt-3 text-center text-xs text-slate-400">请先作答本题，再进入下一题。</p>
      )}

      <div className="mt-4 text-center">
        <Link to="/quiz" className="text-xs text-slate-400 underline">
          退出并返回（进度已保存）
        </Link>
      </div>
    </div>
  );
}
