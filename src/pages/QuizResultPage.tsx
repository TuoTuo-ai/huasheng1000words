/**
 * 分类辨析训练 · 结果页
 *
 * 职责：
 * - 从 IndexedDB 恢复结果（session + records），刷新后同样可恢复
 * - 总览：总题数 / 已答 / 正确 / 错误 / 未答 / 正确率（整数百分比）
 * - 耗时：整套训练耗时（完成会话）+ 各题用时合计（双口径并列）
 * - 逐题回看：用户选择、正确答案、用时、题目已有解析；无解析显示「暂无解析」
 * - 未完成会话：提示条 +「继续作答」入口，不阻断展示
 *
 * 边界：
 * - **只读**：不创建会话、不写记录、不结束会话、不重新判题
 * - 选项按题目原始顺序渲染，不排序、不改写
 * - 解析全部取题目自身字段，缺失即「暂无解析」，绝不编造
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import {
  NO_EXPLANATION_TEXT,
  QuizServiceError,
  computeAccuracy,
  correctOptionText,
  formatDuration,
  getQuizSessionResult,
  optionExplainText,
  optionLines,
  quizStudyPath,
  stemText,
  type QuizSessionResult,
} from "@/lib/quizService";
import type { QuizSessionItem } from "@/lib/quizService";

/* ---------------- 可导出的纯逻辑（供测试复用） ---------------- */

/** 加载状态机 */
export type QuizResultLoadState = "loading" | "error" | "missing" | "ready";

export function resolveQuizLoadState(
  data: QuizSessionResult | null,
  error: string | null,
  loading: boolean,
): QuizResultLoadState {
  if (loading) return "loading";
  if (error !== null) return "error";
  if (data === null) return "missing";
  return "ready";
}

/** 三态：正确 / 错误 / 未作答（由 record 判定，不由答案字符串判定） */
export type QuizQuestionStatus = "correct" | "wrong" | "unanswered";

export function quizQuestionStatus(item: QuizSessionItem): QuizQuestionStatus {
  if (item.record === null) return "unanswered";
  return item.record.isCorrect ? "correct" : "wrong";
}

export const QUIZ_STATUS_LABEL: Record<QuizQuestionStatus, string> = {
  correct: "正确",
  wrong: "错误",
  unanswered: "未作答",
};

/** 未作答占位符 */
export const QUIZ_BLANK = "—";

/** 总览卡片项 */
export interface QuizOverviewCard {
  key: string;
  label: string;
  value: string;
  emphasize?: boolean;
}

export function quizOverviewCards(result: QuizSessionResult): QuizOverviewCard[] {
  return [
    { key: "total", label: "总题数", value: String(result.total) },
    { key: "answered", label: "已答", value: String(result.answeredCount) },
    { key: "correct", label: "正确", value: String(result.correctCount) },
    { key: "wrong", label: "错误", value: String(result.wrongCount) },
    { key: "unanswered", label: "未答", value: String(result.unansweredCount) },
    {
      key: "accuracy",
      label: "正确率",
      value: `${computeAccuracy(result.correctCount, result.answeredCount)}%`,
      emphasize: true,
    },
  ];
}

/** 逐题行（折叠态） */
export interface QuizResultRow {
  index: number;
  questionId: string;
  /** 用户选择文本；未作答为「—」 */
  userAnswerText: string;
  /** 正确答案文本 */
  correctAnswerText: string;
  status: QuizQuestionStatus;
  statusLabel: string;
  /** 用时文本；未作答为「—」 */
  durationText: string;
}

export function buildQuizResultRows(items: readonly QuizSessionItem[]): QuizResultRow[] {
  return items.map((item, i) => {
    const status = quizQuestionStatus(item);
    const answered = status !== "unanswered";
    const opt = item.question.options.find((o) => o.id === item.record?.userAnswer);
    return {
      index: i + 1,
      questionId: item.question.id,
      userAnswerText: answered ? (opt?.content ?? item.record!.userAnswer) : QUIZ_BLANK,
      correctAnswerText: correctOptionText(item.question),
      status,
      statusLabel: QUIZ_STATUS_LABEL[status],
      durationText: answered ? formatDuration(item.record!.durationMs) : QUIZ_BLANK,
    };
  });
}

/** 详情模型 */
export interface QuizResultDetail {
  index: number;
  questionId: string;
  stem: string;
  meta: string;
  options: { id: string; label: string; content: string; state: "correct" | "wrong" | "idle" }[];
  status: QuizQuestionStatus;
  statusLabel: string;
  userAnswerText: string;
  correctAnswerText: string;
  /** 题目已有解析；缺失为「暂无解析」 */
  explanation: string;
  /** 是否为占位文案（页面据此弱化显示） */
  explanationMissing: boolean;
  /** 正确项与用户所选项的解释（若题目已有） */
  correctExplain: string | null;
  userExplain: string | null;
  /** 出处（若题目已有） */
  citation: string | null;
  durationText: string;
}

export function buildQuizResultDetail(
  item: QuizSessionItem,
  index: number,
): QuizResultDetail {
  const q = item.question;
  const status = quizQuestionStatus(item);
  const userAnswer = item.record?.userAnswer ?? "";
  const explanation = (q.explanation ?? "").trim();
  const opts = optionLines(q);
  const userOpt = q.options.find((o) => o.id === userAnswer);
  return {
    index: index + 1,
    questionId: q.id,
    stem: stemText(q),
    meta: [q.tags?.[0], q.tags?.[2]].filter(Boolean).join(" · "),
    options: opts.map((o) => ({
      id: o.id,
      label: o.label,
      content: o.content,
      state: status === "unanswered" ? "idle" : o.id === q.correctOptionId ? "correct" : o.id === userAnswer ? "wrong" : "idle",
    })),
    status,
    statusLabel: QUIZ_STATUS_LABEL[status],
    userAnswerText:
      status === "unanswered" ? QUIZ_BLANK : (userOpt?.content ?? userAnswer),
    correctAnswerText: correctOptionText(q),
    explanation: explanation.length > 0 ? explanation : NO_EXPLANATION_TEXT,
    explanationMissing: explanation.length === 0,
    correctExplain: optionExplainText(q.correctOptionId, q),
    userExplain:
      status !== "unanswered" && userAnswer !== q.correctOptionId
        ? optionExplainText(userAnswer, q)
        : null,
    citation: q.source?.citation ?? null,
    durationText:
      status === "unanswered" ? QUIZ_BLANK : formatDuration(item.record!.durationMs),
  };
}

/** 未完成提示文案 */
export function unfinishedQuizHint(result: QuizSessionResult): string {
  return `本次训练未完成（已答 ${result.answeredCount}/${result.total} 题），以下为当前进度`;
}

/** 未完成会话的总耗时占位（不用当前时间估算，保证可复现） */
export const UNFINISHED_SESSION_DURATION = "训练未完成，无总耗时";

/** 顶部提示：本次题量少于所选（题量不足场景）——由调用方判定，此处只提供文案 */
export function shortageHint(requested: number, actual: number): string | null {
  if (requested <= actual) return null;
  return `本次可用题目仅 ${actual} 道（少于所选的 ${requested} 道），已按实际可用量出题。`;
}

/* ---------------- 页面组件 ---------------- */

export default function QuizResultPage() {
  const { trainingId = "" } = useParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuizSessionResult | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** 卸载保护：异步响应回来时组件已卸载则不 setState */
  const aliveRef = useRef(true);
  const loadGuard = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadGuard.current;
    if (!trainingId) {
      setError("缺少训练标识，无法读取结果。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await getQuizSessionResult(trainingId);
      if (!aliveRef.current || seq !== loadGuard.current) return;
      setResult(data);
      if (data === null) setError(null); // missing 由 resolveQuizLoadState 判定
    } catch (e) {
      if (!aliveRef.current || seq !== loadGuard.current) return;
      setError(e instanceof QuizServiceError ? `结果读取失败：${e.message}` : "结果读取失败，请重试。");
    } finally {
      if (aliveRef.current && seq === loadGuard.current) setLoading(false);
    }
  }, [trainingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const state = resolveQuizLoadState(result, error, loading);
  const cards = useMemo(() => (result ? quizOverviewCards(result) : []), [result]);
  const rows = useMemo(() => (result ? buildQuizResultRows(result.items) : []), [result]);

  if (state === "loading") {
    return (
      <div className="page-container">
        <PageHeader title="辨析结果" subtitle="正在读取…" />
        <div className="card">
          <p className="text-sm text-slate-500">正在读取本次训练结果…</p>
        </div>
      </div>
    );
  }

  if (state !== "ready" || !result) {
    return (
      <div className="page-container">
        <PageHeader title="辨析结果" />
        <div className="card">
          <p className="text-sm text-danger-500">
            {state === "missing" ? "未找到该次训练，可能已被清除。" : (error ?? "结果异常，无法展示。")}
          </p>
          {error && state === "error" && (
            <button type="button" className="btn-secondary mt-4 w-full" onClick={() => void load()}>
              重试
            </button>
          )}
          <Link to="/quiz" className="btn-primary mt-3 block text-center">
            返回辨析训练
          </Link>
        </div>
      </div>
    );
  }

  const unfinished = !result.finished;
  const openItem = result.items.find((it) => it.question.id === openId) ?? null;
  const openIndex = openItem ? result.items.indexOf(openItem) : -1;
  const openDetail = openItem ? buildQuizResultDetail(openItem, openIndex) : null;

  return (
    <div className="page-container">
      <PageHeader title="辨析结果" subtitle={unfinished ? "未完成" : "已完成"} />

      {unfinished && (
        <div className="card mb-4 border border-accent-500/30">
          <p className="text-sm text-accent-500">{unfinishedQuizHint(result)}</p>
          <Link to={quizStudyPath(trainingId)} className="btn-primary mt-3 w-full text-center">
            继续作答
          </Link>
        </div>
      )}

      {/* 总览 */}
      <div className="card mb-4">
        <h2 className="text-lg font-medium">成绩总览</h2>
        <div className="mt-4 grid grid-cols-3 gap-3 text-center">
          {cards.map((c) => (
            <div key={c.key} className="rounded-2xl bg-slate-50 py-3">
              <p
                className={`text-xl font-semibold ${
                  c.emphasize ? "text-accent-500" : "text-brand-600"
                }`}
              >
                {c.value}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">{c.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 耗时双口径 */}
      <div className="card mb-4">
        <h2 className="text-lg font-medium">用时</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 text-center">
          <div className="rounded-2xl bg-slate-50 py-3">
            <p className="text-lg font-semibold text-brand-600">
              {result.sessionDurationMs === null
                ? "—"
                : formatDuration(result.sessionDurationMs)}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">整套训练耗时</p>
          </div>
          <div className="rounded-2xl bg-slate-50 py-3">
            <p className="text-lg font-semibold text-brand-600">
              {formatDuration(result.totalDurationMs)}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">各题用时合计</p>
          </div>
        </div>
        {result.sessionDurationMs === null && (
          <p className="mt-3 text-xs text-slate-400">{UNFINISHED_SESSION_DURATION}</p>
        )}
      </div>

      {/* 逐题回看 */}
      <div className="card mb-4">
        <h2 className="text-lg font-medium">逐题回看</h2>
        <ul className="mt-3 divide-y divide-slate-100">
          {rows.map((row) => {
            const open = openId === row.questionId;
            return (
              <li key={row.questionId} className="py-3">
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 text-left"
                  onClick={() => setOpenId(open ? null : row.questionId)}
                >
                  <span className="flex-1 text-sm text-slate-800">
                    <span className="mr-1 text-slate-400">{row.index}.</span>
                    {row.userAnswerText}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      row.status === "correct"
                        ? "bg-green-50 text-green-700"
                        : row.status === "wrong"
                          ? "bg-red-50 text-danger-500"
                          : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {row.statusLabel}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{row.durationText}</span>
                  <span className="shrink-0 text-slate-300">{open ? "▴" : "▾"}</span>
                </button>

                {open && openDetail && (
                  <div className="mt-3 rounded-2xl bg-slate-50 p-4">
                    {openDetail.meta && (
                      <p className="text-xs text-slate-400">{openDetail.meta}</p>
                    )}
                    <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">
                      {openDetail.stem}
                    </p>
                    <ul className="mt-3 space-y-1.5">
                      {openDetail.options.map((o) => (
                        <li
                          key={o.id}
                          className={`rounded-xl px-3 py-2 text-xs leading-relaxed ${
                            o.state === "correct"
                              ? "bg-green-50 text-green-900"
                              : o.state === "wrong"
                                ? "bg-red-50 text-red-900"
                                : "text-slate-600"
                          }`}
                        >
                          <span className="mr-1 font-semibold">{o.label}.</span>
                          {o.content}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-xs text-slate-600">
                      你的选择：{openDetail.userAnswerText} · 正确答案：{openDetail.correctAnswerText}
                      {openDetail.durationText !== QUIZ_BLANK && ` · 用时 ${openDetail.durationText}`}
                    </p>
                    {openDetail.correctExplain && (
                      <p className="mt-2 text-xs leading-relaxed text-slate-500">
                        {openDetail.correctExplain}
                      </p>
                    )}
                    {openDetail.userExplain && (
                      <p className="mt-1 text-xs leading-relaxed text-slate-500">
                        你选的：{openDetail.userExplain}
                      </p>
                    )}
                    <p
                      className={`mt-3 text-sm leading-relaxed whitespace-pre-wrap ${
                        openDetail.explanationMissing ? "text-slate-400" : "text-slate-700"
                      }`}
                    >
                      {openDetail.explanation}
                    </p>
                    {openDetail.citation && (
                      <p className="mt-2 text-xs text-slate-400">出处：{openDetail.citation}</p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {rows.length === 0 && <p className="mt-3 text-sm text-slate-500">本次训练没有题目。</p>}
      </div>

      <div className="flex gap-3">
        <Link to="/quiz" className="btn-secondary flex-1 text-center">
          再练一组
        </Link>
        <Link to="/" className="btn-primary flex-1 text-center">
          返回首页
        </Link>
      </div>
    </div>
  );
}
