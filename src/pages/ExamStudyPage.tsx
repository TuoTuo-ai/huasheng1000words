/**
 * 真题训练 · 答题页面（3c）
 *
 * 职责：
 * - 进入时通过 getExamSessionResult 从 IndexedDB 恢复会话（题目顺序 / 已答答案 / 当前题号）
 * - 单题作答：点击选项 → submitExamAnswer → 持久化成功后显示反馈并锁定
 * - 上一题回看、下一题（未作答不得跳过）、全部答完调用 finishExamSession 并显示完成态
 *
 * 边界：不新建会话（会话由组卷页「开始答题」创建）、不重新随机组卷、
 * 不改写题库数据、不开发结果页与错题重练。选项严格保持原始 A/B/C/D 顺序。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import {
  ExamDataError,
  finishExamSession,
  getExamSessionResult,
  submitExamAnswer,
  type ExamSessionResult,
} from "@/lib/examService";
import type { ExamQuestion } from "@/types/exam";
import type { TrainingRecord } from "@/types/quiz";

/* ---------------- 可导出的纯逻辑（供测试复用） ---------------- */

/** 单题答复状态：已答（来自 IndexedDB 记录）或未答 */
export interface AnswerState {
  questionId: string;
  userAnswer: string;
  isCorrect: boolean;
}

/** 答题页视图模型 */
export interface StudyView {
  /** 题目列表（严格按会话 questionIds 顺序） */
  questions: ExamQuestion[];
  /** 已答记录，按 questionId 索引 */
  answers: Map<string, AnswerState>;
  /** 已答题数 */
  answeredCount: number;
  /** 总题数 */
  total: number;
  /** 是否全部答完 */
  allAnswered: boolean;
  /** 会话是否已结束 */
  finished: boolean;
}

/** 从 getExamSessionResult 构造答题页视图模型（保持题目顺序、恢复已答内容） */
export function buildStudyView(result: ExamSessionResult): StudyView {
  const answers = new Map<string, AnswerState>();
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

/**
 * 计算进入答题页时的定位题号：
 * 默认定位到第一道未答题；全部答完则定位到最后一题（供完成态展示）。
 */
export function firstUnansweredIndex(
  questions: ExamQuestion[],
  answers: Map<string, AnswerState>,
): number {
  if (questions.length === 0) return 0;
  const idx = questions.findIndex((q) => !answers.has(q.id));
  return idx === -1 ? questions.length - 1 : idx;
}

/** 下一题校验：当前题未作答则不允许跳转 */
export function canGoNext(
  questions: ExamQuestion[],
  answers: Map<string, AnswerState>,
  index: number,
): boolean {
  const current = questions[index];
  return !!current && answers.has(current.id) && index < questions.length - 1;
}

/** 是否可进入上一题（仅回看） */
export function canGoPrev(index: number): boolean {
  return index > 0;
}

/** 选项字母集合（原始顺序，固定 A/B/C/D） */
export const OPTION_LETTERS = ["A", "B", "C", "D"] as const;

/** 判定选项的视觉状态：正确项 / 用户选错项 / 普通 */
export type OptionState = "correct" | "wrong" | "idle";

/**
 * 计算某个选项在反馈中的状态。
 * 选项顺序不参与计算，仅依据原始字母，保证展示顺序与数据顺序一致。
 */
export function optionState(
  optionId: string,
  answer: AnswerState | undefined,
  correctAnswer: string,
): OptionState {
  if (!answer) return "idle";
  if (optionId === correctAnswer) return "correct";
  if (optionId === answer.userAnswer) return "wrong";
  return "idle";
}

/** 解析展示文本：空字符串显示占位提示 */
export function explanationText(explanation: string | undefined | null): string {
  const text = (explanation ?? "").trim();
  return text.length > 0 ? text : "本题暂无解析";
}

/** 单题耗时：首次展示 → 提交（毫秒，非负） */
export function computeDurationMs(startedAt: number, submittedAt: number): number {
  return Math.max(0, submittedAt - startedAt);
}

/**
 * 提交结果应用到视图：accepted 与 already-submitted 都视为已答。
 * 服务端 already-submitted 时以返回的正误为准（恢复原判定）。
 */
export function applySubmitResult(
  answers: Map<string, AnswerState>,
  question: ExamQuestion,
  userAnswer: string,
  status: "accepted" | "already-submitted",
  isCorrect: boolean,
): Map<string, AnswerState> {
  if (status === "already-submitted" && answers.has(question.id)) {
    return answers; // 已有记录：保持原答案不变（不覆盖、不新增）
  }
  const next = new Map(answers);
  next.set(question.id, { questionId: question.id, userAnswer, isCorrect });
  return next;
}

/**
 * 提交成功后推进视图状态（纯函数，供页面与测试共用）：
 * - 更新答案表与已答题数
 * - **同步重算 allAnswered**：答完最后一题必须立刻为 true，否则结束会话不会被触发
 *   （与 QuizStudyPage.advanceAfterSubmit 同款修复，回归：真题完成态缺陷）
 */
export function advanceAfterSubmit(
  view: StudyView,
  question: ExamQuestion,
  userAnswer: string,
  status: "accepted" | "already-submitted",
  isCorrect: boolean,
): StudyView {
  const already = view.answers.has(question.id);
  const answers = applySubmitResult(view.answers, question, userAnswer, status, isCorrect);
  const answeredCount = already ? view.answeredCount : view.answeredCount + 1;
  return {
    ...view,
    answers,
    answeredCount,
    allAnswered: answeredCount === view.total && view.total > 0,
  };
}

/**
 * 请求世代守卫（3c.1）：用于判断异步响应是否仍属于当前有效请求。
 * 用法：发起前 `const seq = guard.begin()`，响应后 `if (!guard.isCurrent(seq)) return;`
 */
export function createRequestGuard() {
  let current = 0;
  return {
    begin(): number {
      return ++current;
    },
    isCurrent(seq: number): boolean {
      return seq === current;
    },
    get current(): number {
      return current;
    },
  };
}

/**
 * 取当前题的答题记录（用于展示耗时等只读字段） */
export function recordOf(
  result: ExamSessionResult | null,
  questionId: string,
): TrainingRecord | null {
  if (!result) return null;
  return result.items.find((it) => it.question.id === questionId)?.record ?? null;
}

/**
 * already-submitted 时的反馈恢复（3c.1）：
 * submitExamAnswer 只返回 { status, isCorrect, recordId }，不含 userAnswer，
 * 因此必须从数据库记录恢复原答案——绝不能用本次点击的 letter 兜底。
 * 返回 null 表示未能取得可信记录（调用方应提示刷新，不显示伪造反馈）。
 */
export function restoreSubmittedFeedback(
  record: TrainingRecord | null,
  questionId: string,
): AnswerState | null {
  if (!record || record.questionId !== questionId) return null;
  const userAnswer = (record.userAnswer ?? "").trim();
  if (!userAnswer) return null;
  return {
    questionId,
    userAnswer,
    isCorrect: record.isCorrect,
  };
}

/* ---------------- 页面组件 ---------------- */

export default function ExamStudyPage() {
  const { trainingId = "" } = useParams();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<StudyView | null>(null);
  const [index, setIndex] = useState(0);
  /** 反馈按 questionId 归属（3c.1）：切题后旧响应不会显示在新题下 */
  const [feedbackByQuestion, setFeedbackByQuestion] = useState<
    Record<string, AnswerState>
  >({});
  /** 服务端返回 already-submitted 但无法恢复原记录时的提示（不显示伪反馈） */
  const [restoreHint, setRestoreHint] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  /** 完成态是否已选择回看（回看后不再强制展示完成占位页） */
  const [completionDismissed, setCompletionDismissed] = useState(false);

  /** 当前题首次展示时间（毫秒），用于计算耗时；每次切题重置 */
  const shownAtRef = useRef<number>(Date.now());
  /** 防止重复创建/重复提交的同步闸门 */
  const submittingRef = useRef(false);
  const finishingRef = useRef(false);
  /** 请求世代号（3c.1）：旧加载请求晚到时不覆盖新状态 */
  const loadGuard = useRef(createRequestGuard()).current;

  /** 应用一次服务端结果：重建视图并定位到第一道未答题 */
  const applyResult = useCallback((data: ExamSessionResult) => {
    const v = buildStudyView(data);
    setView(v);
    setIndex(firstUnansweredIndex(v.questions, v.answers));
    setFinished(data.finished);
    setRestoreHint(null);
    setSubmitError(null);
    shownAtRef.current = Date.now();
  }, []);

  const load = useCallback(async () => {
    const seq = loadGuard.begin(); // 每次加载分配新世代
    if (!trainingId) {
      setLoadError("缺少训练会话标识，无法加载试卷。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getExamSessionResult(trainingId);
      if (!loadGuard.isCurrent(seq)) return; // 过期响应，丢弃
      if (!data) {
        setLoadError("未找到该训练会话，可能已过期或不存在。");
      } else if (data.items.length === 0) {
        setLoadError("该训练会话没有题目数据，无法继续。");
      } else {
        applyResult(data);
      }
    } catch (e) {
      if (!loadGuard.isCurrent(seq)) return; // 过期失败同样丢弃
      setLoadError(
        e instanceof ExamDataError
          ? `试卷加载失败：${e.message}`
          : "试卷加载失败，请检查网络后重试。",
      );
    } finally {
      if (loadGuard.isCurrent(seq)) setLoading(false);
    }
  }, [trainingId, applyResult]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 从数据库重新读取某题的原答题记录（3c.1）。
   * 优先使用当前视图中的记录；否则重新调用 getExamSessionResult 拉取。
   * 取不到时返回 null（调用方不得伪造反馈）。
   */
  const restoreRecordFor = useCallback(
    async (questionId: string): Promise<AnswerState | null> => {
      const fresh = await getExamSessionResult(trainingId).catch(() => null);
      if (!fresh) return null;
      // 用最新记录同步视图（保持既有答案不被覆盖：applySubmitResult 已按 id 键控）
      setView((prev) => (prev ? { ...prev, answers: buildStudyView(fresh).answers } : prev));
      return restoreSubmittedFeedback(recordOf(fresh, questionId), questionId);
    },
    [trainingId],
  );

  const questions = view?.questions ?? [];
  const answers = view?.answers ?? new Map<string, AnswerState>();
  const current: ExamQuestion | undefined = questions[index];

  /** 切题：重置计时与错误（反馈按 questionId 归属，无需在此切换） */
  function goTo(nextIndex: number) {
    if (nextIndex < 0 || nextIndex >= questions.length) return;
    setIndex(nextIndex);
    setSubmitError(null);
    setRestoreHint(null);
    shownAtRef.current = Date.now(); // 未答题计时从重新展示开始
  }

  async function handleSelect(letter: string) {
    if (!current || submittingRef.current) return;
    if (answers.has(current.id)) return; // 已提交锁定
    const startedAt = shownAtRef.current;
    const submittedAt = Date.now();
    const durationMs = computeDurationMs(startedAt, submittedAt);
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await submitExamAnswer(trainingId, current, letter, {
        submittedAt,
        durationMs,
      });
      // 记录已成功写入数据库：先按 questionId 更新答案表（与当前展示的题目无关），
      // 并同步重算 allAnswered（答完最后一题立刻触发结束会话）
      setView((prev) =>
        prev ? advanceAfterSubmit(prev, current, letter, res.status, res.isCorrect) : prev,
      );

      // 反馈按 questionId 归属（3c.1）：旧题反馈不会显示在新题下
      if (res.status === "accepted") {
        setFeedbackByQuestion((prev) => ({
          ...prev,
          [current.id]: { questionId: current.id, userAnswer: letter, isCorrect: res.isCorrect },
        }));
      } else {
        // already-submitted：submitExamAnswer 不返回 userAnswer，
        // 必须从数据库记录恢复，绝不用本次点击的 letter 兜底
        const restored = await restoreRecordFor(current.id);
        if (restored) {
          setFeedbackByQuestion((prev) => ({ ...prev, [current.id]: restored }));
        } else {
          setRestoreHint("该题已作答，但未能读取到原记录，请刷新页面恢复。");
        }
      }
    } catch (e) {
      // 失败：不标记为已答，允许重试
      setSubmitError(
        e instanceof ExamDataError
          ? `提交失败：${e.message}`
          : "提交失败，请检查网络后重试。",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  /** 全部答完时结束会话（仅一次；未答完绝不调用） */
  useEffect(() => {
    if (!view || !view.allAnswered || view.finished || finishingRef.current) return;
    finishingRef.current = true;
    (async () => {
      try {
        await finishExamSession(trainingId);
        setFinished(true);
        setFinishError(null);
      } catch (e) {
        finishingRef.current = false;
        setFinishError(
          e instanceof ExamDataError ? `结束会话失败：${e.message}` : "结束会话失败，请稍后重试。",
        );
      }
    })();
  }, [view, trainingId]);

  const answeredBefore = view ? view.answeredCount : 0;

  /* ---- 加载 / 错误态 ---- */
  if (loading) {
    return (
      <div className="page-container">
        <PageHeader title="真题答题" subtitle="正在加载试卷…" />
        <div className="card">
          <p className="text-sm text-slate-500">正在加载试卷与已答记录…</p>
        </div>
      </div>
    );
  }

  if (loadError || !view || !current) {
    return (
      <div className="page-container">
        <PageHeader title="真题答题" />
        <div className="card">
          <p className="text-sm text-danger-500">{loadError ?? "试卷数据异常，无法继续。"}</p>
          <Link to="/exam" className="btn-primary mt-4 w-full">
            返回组卷设置
          </Link>
        </div>
      </div>
    );
  }

  const currentAnswer = answers.get(current.id) ?? feedbackByQuestion[current.id];
  const isAnswered = answers.has(current.id);
  const progressPct = Math.round((answeredBefore / view.total) * 100);

  /* ---- 完成态（3d-d：查看成绩 / 回看第 1 题） ---- */
  if (view.allAnswered && finished && !completionDismissed) {
    return (
      <div className="page-container">
        <PageHeader title="真题答题" subtitle="本套题已完成" />
        <div className="card">
          <p className="text-lg font-medium">本套题已完成</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            共 {view.total} 题，已全部作答。可查看成绩与逐题回顾。
          </p>
          <div className="mt-4 flex gap-3">
            <Link
              to={`/exam/result/${trainingId}`}
              className="btn-primary flex-1 text-center"
            >
              查看成绩
            </Link>
            <button
              type="button"
              className="btn-secondary flex-1"
              onClick={() => {
                setCompletionDismissed(true); // 允许回看已答题目
                goTo(0);
              }}
            >
              回看第 1 题
            </button>
          </div>
          <Link to="/exam" className="btn-secondary mt-3 block text-center">
            返回组卷设置
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title="真题答题"
        subtitle={`第 ${index + 1} / ${view.total} 题 · 已答 ${answeredBefore} 题`}
      />

      {/* 进度条 */}
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
          {current.section}篇 · {current.examSource} · {current.questionType}
        </p>
        <p className="mt-3 text-base leading-relaxed whitespace-pre-wrap text-slate-900">
          {current.questionText}
        </p>

        <div className="mt-5 space-y-2.5">
          {current.options.map((opt) => {
            const state = optionState(opt.id, currentAnswer, current.answer);
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
                <span className="mr-2 font-semibold">{opt.id}.</span>
                <span className="whitespace-pre-wrap">{opt.content}</span>
              </button>
            );
          })}
        </div>

        {submitting && <p className="mt-3 text-xs text-slate-500">正在保存答案…</p>}
        {restoreHint && (
          <div className="mt-3">
            <p className="text-sm text-accent-500">{restoreHint}</p>
            <button
              type="button"
              className="mt-2 text-xs text-brand-600 underline"
              onClick={() => void load()}
            >
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

        {/* 反馈 */}
        {isAnswered && currentAnswer && (
          <div className="mt-5 rounded-2xl bg-slate-50 p-4">
            <p
              className={`text-sm font-medium ${
                currentAnswer.isCorrect ? "text-green-700" : "text-danger-500"
              }`}
            >
              {currentAnswer.isCorrect ? "回答正确" : "回答错误"}
              <span className="ml-2 font-normal text-slate-600">
                正确答案：{current.answer}
              </span>
            </p>
            {!currentAnswer.isCorrect && (
              <p className="mt-1 text-xs text-slate-500">
                你的答案：{currentAnswer.userAnswer}
              </p>
            )}
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-slate-700">
              {explanationText(current.explanation)}
            </p>
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
        <p className="mt-3 text-center text-xs text-slate-400">
          请先作答本题，再进入下一题。
        </p>
      )}
      <div className="mt-4 text-center">
        <Link to="/exam" className="text-xs text-slate-400 underline">
          返回组卷设置
        </Link>
      </div>
    </div>
  );
}
