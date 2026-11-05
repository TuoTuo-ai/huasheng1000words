import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { WordDetail } from "@/lib/wordbookService";
import { getWordDetail } from "@/lib/wordbookService";
import type { ReviewLog } from "@/types";

const gradeLabel: Record<number, string> = { 1: "不会", 2: "模糊", 3: "学会了" };
const categoryLabel: Record<string, string> = {
  new: "新词",
  learning: "学习中",
  reviewing: "复习中",
  relearning: "重学中",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(
    d.getHours(),
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDue(ts: number): string {
  const diffDays = Math.ceil((ts - Date.now()) / 86_400_000);
  if (diffDays <= 0) return "今天到期";
  if (diffDays === 1) return "明天";
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日（${diffDays}天后）`;
}

/** 词语详情页：只展示真实存在的数据字段 */
export default function WordDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<WordDetail | null | undefined>(
    undefined,
  );

  useEffect(() => {
    (async () => {
      if (!id) {
        setDetail(null);
        return;
      }
      setDetail(await getWordDetail(id));
    })();
  }, [id]);

  if (detail === undefined) {
    return (
      <div className="page-container">
        <p className="mt-10 text-center text-slate-400">正在加载…</p>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="page-container">
        <div className="card mt-6 text-center">
          <p className="text-sm text-slate-500">未找到该词语</p>
          <button className="btn-secondary mt-5" onClick={() => navigate(-1)}>
            返回
          </button>
        </div>
      </div>
    );
  }

  const { word, progress, logs } = detail;

  return (
    <div className="page-container">
      {/* 返回 */}
      <Link
        to="/wordbook"
        className="mb-4 inline-flex items-center gap-1 text-sm text-brand-600"
      >
        ‹ 返回词库
      </Link>

      {/* 词语与释义 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{word.term}</h1>
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs text-brand-600">
            {categoryLabel[detail.category]}
          </span>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-slate-700">
          {word.definition}
        </p>
        {/* 全部原文例句（正式词库）；旧数据回退到单例句字段 */}
        {(word.examples?.length ? word.examples : word.example ? [word.example] : []).map(
          (ex, i) => (
            <p
              key={i}
              className="mt-3 rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-500"
            >
              例：{ex}
            </p>
          ),
        )}
        {(word.section || word.groupTitle) && (
          <p className="mt-3 text-xs text-slate-400">
            {[word.volume, word.section, word.groupTitle, word.subcategory]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {word.source && (
          <p className="mt-1 text-xs text-slate-400">来源：{word.source}</p>
        )}
      </section>

      {/* 记忆数据 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">记忆数据</h2>
        {progress && progress.reps > 0 ? (
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 text-center">
            <div>
              <p className="text-xl font-semibold text-brand-600">
                {detail.learnCount}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">学习次数</p>
            </div>
            <div>
              <p className="text-xl font-semibold text-accent-500">
                {detail.reviewCount}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">复习次数</p>
            </div>
            <div>
              <p className="text-xl font-semibold text-danger-500">
                {progress.lapses}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">遗忘次数</p>
            </div>
            <div>
              <p className="text-xl font-semibold">{progress.stability.toFixed(1)}</p>
              <p className="mt-0.5 text-xs text-slate-500">记忆强度</p>
            </div>
            <div>
              <p className="text-sm font-medium">
                {detail.lastReviewedAt ? formatTime(detail.lastReviewedAt) : "—"}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">上次学习</p>
            </div>
            <div>
              <p className="text-sm font-medium">{formatDue(progress.due)}</p>
              <p className="mt-0.5 text-xs text-slate-500">下次复习</p>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-400">
            该词还未学习，将在每日新词队列中安排。
          </p>
        )}
      </section>

      {/* 学习历史 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">学习历史</h2>
        {logs.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">暂无学习记录</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {logs
              .slice()
              .reverse()
              .map((log: ReviewLog) => (
                <li
                  key={log.id}
                  className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-xs"
                >
                  <span
                    className={
                      log.grade === 3
                        ? "text-success-500"
                        : log.grade === 2
                          ? "text-accent-500"
                          : "text-danger-500"
                    }
                  >
                    {gradeLabel[log.grade]}
                  </span>
                  <span className="text-slate-400">
                    {log.wasNew ? "首次学习" : "复习"} · {formatTime(log.reviewedAt)}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>

      {/* 去学习 */}
      <Link to="/study" className="btn-primary mb-4 w-full">
        去学习
      </Link>
    </div>
  );
}
