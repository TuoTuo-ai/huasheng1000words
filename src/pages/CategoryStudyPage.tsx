import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Grade } from "ts-fsrs";
import {
  getCategoryStudyQueue,
  gradeInCategory,
  type CategoryStudyItem,
  type CategoryResult,
} from "@/lib/categoryStudyService";
import { NO_SUBCATEGORY, groupLabel, parseGroupKey } from "@/lib/categoryService";

const gradeOptions: Array<{ grade: Grade; label: string; className: string }> = [
  { grade: 1, label: "不会", className: "bg-danger-500 text-white" },
  { grade: 2, label: "模糊", className: "bg-accent-500 text-white" },
  { grade: 3, label: "学会了", className: "bg-success-500 text-white" },
];

/** 分类集中学习页：复用现有卡片结构 + 三档评分 + FSRS 调度 */
export default function CategoryStudyPage() {
  const { groupKey = "", sub = "" } = useParams();
  const subName = decodeURIComponent(sub);
  const { section, groupId } = parseGroupKey(groupKey);

  const [queue, setQueue] = useState<CategoryStudyItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CategoryResult>({
    studied: 0,
    again: 0,
    hard: 0,
    good: 0,
  });

  const load = useCallback(async () => {
    const list = await getCategoryStudyQueue(
      groupId,
      section,
      subName,
      NO_SUBCATEGORY,
    );
    setQueue(list);
    setIndex(0);
    setRevealed(false);
    setResult({ studied: 0, again: 0, hard: 0, good: 0 });
  }, [groupId, section, subName]);

  useEffect(() => {
    load();
  }, [load]);

  const handleGrade = async (grade: Grade) => {
    if (!queue || busy) return;
    const cur = queue[index];
    if (!cur) return;
    setBusy(true);
    try {
      // 已学过的词不重复建档：wasNew 仅在首次学习时为 true
      await gradeInCategory(cur.word, grade, !cur.learned);
      setResult((r) => ({
        studied: r.studied + 1,
        again: r.again + (grade === 1 ? 1 : 0),
        hard: r.hard + (grade === 2 ? 1 : 0),
        good: r.good + (grade === 3 ? 1 : 0),
      }));
      setIndex((i) => i + 1);
      setRevealed(false);
    } catch (err) {
      console.error("分类学习保存失败:", err);
      alert("保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  if (!queue) {
    return (
      <div className="page-container">
        <p className="mt-10 text-center text-slate-400">正在加载…</p>
      </div>
    );
  }

  const current = queue[index];

  // 完成页
  if (!current) {
    return (
      <div className="page-container">
        <Link
          to={`/category/${groupKey}/${encodeURIComponent(subName)}`}
          className="mb-4 inline-flex items-center gap-1 text-sm text-brand-600"
        >
          ‹ 返回词语列表
        </Link>
        <div className="card text-center">
          <p className="text-3xl">🎉</p>
          <h2 className="mt-3 text-lg font-medium">本分类学习完成</h2>
          <div className="mt-5 grid grid-cols-2 gap-y-3 text-sm">
            <span className="text-slate-500">本次学习</span>
            <span className="font-medium">{result.studied} 个词</span>
            <span className="text-success-500">学会了</span>
            <span className="font-medium">{result.good}</span>
            <span className="text-accent-500">模糊</span>
            <span className="font-medium">{result.hard}</span>
            <span className="text-danger-500">不会</span>
            <span className="font-medium">{result.again}</span>
          </div>
          <button className="btn-secondary mt-6 w-full" onClick={load}>
            再学一遍本分类
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <Link
        to={`/category/${groupKey}/${encodeURIComponent(subName)}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-brand-600"
      >
        ‹ 返回词语列表
      </Link>

      <header className="mb-4">
        <h1 className="text-xl font-semibold">{subName}</h1>
        <p className="mt-1 text-xs text-slate-400">
          {section}
          {current.word.groupTitle
            ? ` · ${groupLabel({ groupId, groupTitle: current.word.groupTitle })}`
            : ""}{" "}
          · {current.learned ? "复习" : "新学"} · 第 {index + 1} / {queue.length} 个
        </p>
      </header>

      <div className="card flex min-h-56 flex-col items-center justify-center text-center">
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-600">
          {current.learned ? "已学过" : "未学过"}
        </span>
        <h2 className="mt-4 text-3xl font-semibold tracking-wide">
          {current.word.term}
        </h2>
        {revealed ? (
          <div className="mt-5 w-full">
            <p className="text-left text-sm leading-relaxed text-slate-700">
              {current.word.definition}
            </p>
            {current.word.examples?.[0] && (
              <p className="mt-3 text-left text-sm text-slate-400">
                例：{current.word.examples[0]}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-400">
            先主动回忆词义，再看释义
          </p>
        )}
      </div>

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
              disabled={busy}
              onClick={() => handleGrade(opt.grade)}
              className={`rounded-2xl py-3.5 text-base font-medium active:opacity-80 disabled:opacity-40 ${opt.className}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
