import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import type { WordProgress } from "@/types";
import type { Grade } from "ts-fsrs";
import {
  getTodayStudyList,
  submitGrade,
  type QueueItem,
} from "@/lib/studyService";
import { getReviewLogs } from "@/db/wordRepository";
import type { ReviewLog } from "@/types";

/** 评分按钮配置：不会=Again / 模糊=Hard / 学会了=Good */
const gradeOptions: Array<{
  grade: Grade;
  label: string;
  className: string;
}> = [
  { grade: 1, label: "不会", className: "bg-danger-500 text-white" },
  { grade: 2, label: "模糊", className: "bg-accent-500 text-white" },
  { grade: 3, label: "学会了", className: "bg-success-500 text-white" },
];

/** 学习页：卡片式学习流程（显示词语 → 回忆 → 查看释义 → 三档评分） */
export default function StudyPage() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<ReviewLog[]>([]);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getTodayStudyList();
      setQueue(list);
      setIndex(0);
      setRevealed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const current = queue[index];

  const handleGrade = useCallback(
    async (grade: Grade) => {
      if (!current || submitting) return;
      setSubmitting(true);
      try {
        await submitGrade(current.word, grade, current.isNew);
        const logs = await getReviewLogs(current.word.id);
        setHistory(logs);
        setIndex((i) => i + 1);
        setRevealed(false);
      } catch (err) {
        console.error("评分保存失败:", err);
        alert("保存失败，请重试");
      } finally {
        setSubmitting(false);
      }
    },
    [current, submitting],
  );

  if (loading) {
    return (
      <div className="page-container">
        <PageHeader title="学习" subtitle="新词学习与到期复习" />
        <p className="text-center text-slate-400">正在加载今日任务…</p>
      </div>
    );
  }

  /* 今日任务完成 */
  if (!current) {
    return (
      <div className="page-container">
        <PageHeader title="学习" subtitle="新词学习与到期复习" />
        <div className="card text-center">
          <p className="text-3xl">🎉</p>
          <h2 className="mt-3 text-lg font-medium">今日任务已完成</h2>
          <p className="mt-2 text-sm text-slate-500">
            新词与复习均由记忆算法安排，明天再见！
          </p>
          <button className="btn-secondary mt-6" onClick={loadQueue}>
            重新检查任务
          </button>
        </div>
      </div>
    );
  }

  const progress: WordProgress | undefined = current.progress;
  const isNew = current.isNew;

  return (
    <div className="page-container">
      <PageHeader
        title="学习"
        subtitle={`${isNew ? "新词" : "复习"} · 第 ${index + 1} / ${queue.length} 个`}
      />

      {/* 卡片 */}
      <div className="card min-h-56 flex flex-col items-center justify-center text-center">
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-600">
          {isNew ? "新词" : progress?.state === 3 ? "重新学习" : "复习"}
        </span>
        <h2 className="mt-4 text-3xl font-semibold tracking-wide">
          {current.word.term}
        </h2>
        {revealed ? (
          <div className="mt-5 w-full">
            <p className="text-left text-sm leading-relaxed text-slate-700">
              {current.word.definition}
            </p>
            {current.word.example && (
              <p className="mt-3 text-left text-sm text-slate-400">
                例：{current.word.example}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-400">先主动回忆词义，再看释义</p>
        )}
      </div>

      {/* 操作区 */}
      {!revealed ? (
        <button
          className="btn-primary mt-6 w-full"
          onClick={() => setRevealed(true)}
        >
          查看释义
        </button>
      ) : (
        <div className="mt-6 grid grid-cols-3 gap-3">
          {gradeOptions.map((opt) => (
            <button
              key={opt.grade}
              disabled={submitting}
              onClick={() => handleGrade(opt.grade)}
              className={`rounded-2xl py-3.5 text-base font-medium transition-opacity active:opacity-80 disabled:opacity-40 ${opt.className}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* 当前词的历史记录（真实数据展示） */}
      {history.length > 0 && history[0]?.wordId === current?.word.id && (
        <div className="mt-6">
          <p className="mb-2 text-xs text-slate-400">
            该词已有 {history.length} 条学习记录
          </p>
        </div>
      )}
    </div>
  );
}
