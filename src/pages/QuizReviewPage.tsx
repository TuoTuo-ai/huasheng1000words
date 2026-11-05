import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/pages/QuizAdminPage";
import {
  buildReviewChecks,
  loadQuizAdminData,
  parseCategoryKey,
} from "@/lib/quizAdminService";
import { reviewQuestion, resetQuestionReview } from "@/db/quizRepository";
import type { Word } from "@/types";
import type { QuizQuestion } from "@/types/quiz";

/**
 * 单题审核页：展示题干、原文释义、选项、来源，并给出客观审核要点。
 * 通过 / 驳回 均为人工点击，无任何自动审核逻辑。
 * 已审核题目可「撤销审核」重置为待审核（需二次确认），改判必须先撤销。
 */
export default function QuizReviewPage() {
  const { id } = useParams<{ id: string }>();
  const [question, setQuestion] = useState<QuizQuestion | null | undefined>(undefined);
  const [wordMap, setWordMap] = useState<Map<string, Word>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* 撤销审核二次确认 */
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await loadQuizAdminData();
      if (cancelled) return;
      setWordMap(data.wordMap);
      setQuestion(data.questions.find((q) => q.id === id) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const checks = useMemo(
    () => (question ? buildReviewChecks(question, wordMap) : []),
    [question, wordMap],
  );

  const act = async (status: "approved" | "rejected") => {
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await reviewQuestion(question.id, status);
      setQuestion(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "审核失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  /** 撤销审核：重置为待审核（内容与来源不变） */
  const doReset = async () => {
    if (!question || busy) return;
    setConfirmReset(false);
    setBusy(true);
    setError(null);
    try {
      setQuestion(await resetQuestionReview(question.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤销失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  if (question === undefined) {
    return (
      <div className="page-container">
        <PageHeader title="题目审核" />
        <p className="text-center text-slate-400">正在加载…</p>
      </div>
    );
  }

  if (question === null) {
    return (
      <div className="page-container">
        <PageHeader title="题目审核" />
        <div className="card text-center">
          <p className="text-sm text-slate-500">题目不存在或已被删除。</p>
          <Link to="/quiz-admin" className="btn-secondary mt-4 w-full">
            返回题目管理
          </Link>
        </div>
      </div>
    );
  }

  const { section, groupId, subcategory } = parseCategoryKey(question.categoryKey);
  const correct = question.options.find((o) => o.isCorrect);
  const correctWord = correct?.wordId ? wordMap.get(correct.wordId) : undefined;
  const stemText = question.stem.replace(/^.*？\n/, "").replace(/^「|」$/g, "");

  return (
    <div className="page-container">
      <Link to="/quiz-admin" className="mb-3 inline-block text-sm text-brand-600">
        ‹ 返回题目管理
      </Link>

      <div className="mb-4 flex items-start justify-between">
        <PageHeader title="题目审核" subtitle={`${section} · ${groupId}组 · ${subcategory}`} />
        <StatusBadge status={question.reviewStatus} />
      </div>

      {/* 题干（教材原文释义） */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">题干 · 教材原文释义</h2>
        <p className="mt-3 rounded-2xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
          {stemText}
        </p>
        <dl className="mt-4 space-y-1.5 text-xs text-slate-500">
          <div className="flex justify-between">
            <dt>正确答案</dt>
            <dd className="font-medium text-slate-700">{correctWord?.term ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt>来源</dt>
            <dd>{question.source.citation}</dd>
          </div>
          <div className="flex justify-between">
            <dt>页码</dt>
            <dd>
              {question.source.sourcePage ? `第 ${question.source.sourcePage} 页` : "—"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>引用字段</dt>
            <dd>{question.source.sourceField ?? "—"}</dd>
          </div>
        </dl>
      </section>

      {/* 选项 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">选项与干扰项</h2>
        <ul className="mt-3 space-y-2">
          {question.options.map((o) => {
            const w = o.wordId ? wordMap.get(o.wordId) : undefined;
            return (
              <li
                key={o.id}
                className={`rounded-2xl p-3 text-sm ${
                  o.isCorrect ? "bg-success-500/10" : "bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {o.id}. {o.content}
                    {o.isCorrect && (
                      <span className="ml-2 text-xs text-success-500">正确</span>
                    )}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                  释义：{w?.definition ?? "—"}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 解析 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">解析</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {question.explanation}
        </p>
      </section>

      {/* 审核要点 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">审核要点</h2>
        <p className="mt-1 text-xs text-slate-400">
          以下为可机器核对的客观事实，最终通过或驳回由你人工判断。
        </p>
        <ul className="mt-3 space-y-2">
          {checks.map((c) => (
            <li key={c.label} className="flex items-start gap-2 text-sm">
              <span
                className={`mt-0.5 shrink-0 text-xs ${
                  c.ok ? "text-success-500" : "text-danger-500"
                }`}
              >
                {c.ok ? "✓" : "✗"}
              </span>
              <span className="flex-1">
                <span className="text-slate-700">{c.label}</span>
                <span className="ml-2 text-xs text-slate-400">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {error && (
        <p className="mb-4 rounded-xl bg-danger-500/10 p-3 text-xs text-danger-500">
          {error}
        </p>
      )}

      {/* 审核操作 */}
      {question.reviewStatus === "pending" ? (
        <div className="grid grid-cols-2 gap-3">
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => act("rejected")}
          >
            {busy ? "处理中…" : "驳回"}
          </button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() => act("approved")}
          >
            {busy ? "处理中…" : "通过"}
          </button>
        </div>
      ) : (
        <>
          <p className="rounded-2xl bg-slate-50 p-4 text-center text-xs leading-relaxed text-slate-500">
            该题已审核为「
            {question.reviewStatus === "approved" ? "已通过" : "已驳回"}
            」。如需改判，请先撤销审核（重置为待审核），再重新审核。
          </p>
          <button
            className="btn-secondary mt-3 w-full"
            disabled={busy}
            onClick={() => setConfirmReset(true)}
          >
            {busy ? "处理中…" : "撤销审核"}
          </button>
        </>
      )}

      {/* 撤销审核二次确认 */}
      {confirmReset && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-slate-900/40 p-5 md:items-center"
          onClick={() => !busy && setConfirmReset(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-6 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-medium">确认撤销审核？</h3>
            <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-slate-500">
              <li>
                · 该题将从「
                {question.reviewStatus === "approved" ? "已通过" : "已驳回"}
                」重置为「待审核」
              </li>
              <li>· 题目内容、选项和来源信息保持不变</li>
              <li>· 重置后会重新出现在待审核列表中</li>
            </ul>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => setConfirmReset(false)}
              >
                取消
              </button>
              <button className="btn-primary" disabled={busy} onClick={doReset}>
                {busy ? "处理中…" : "确认撤销"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
