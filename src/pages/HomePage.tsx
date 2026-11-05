import { useEffect, useState } from "react";
import { PageHeader, PlaceholderCard } from "@/components/PageHeader";
import { Link } from "react-router-dom";
import { getStudyOverview, ensureTestWords, type StudyOverview } from "@/lib/studyService";
import { loadSettings } from "@/lib/settings";

/** 首页：今日学习概览（真实 IndexedDB 数据） */
export default function HomePage() {
  const [overview, setOverview] = useState<StudyOverview | null>(null);
  const [dailyNew, setDailyNew] = useState(20);

  useEffect(() => {
    (async () => {
      await ensureTestWords(); // 幂等：仅首次写入测试词
      setDailyNew(loadSettings().dailyNewCount);
      setOverview(await getStudyOverview());
    })();
  }, []);

  return (
    <div className="page-container">
      <PageHeader title="言语1000词" subtitle="公务员考试言语理解高频词" />

      <div className="card mb-4">
        <h2 className="text-lg font-medium">今日任务</h2>
        {overview ? (
          <>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-2xl font-semibold text-danger-500">
                  {overview.overdue}
                </p>
                <p className="mt-1 text-xs text-slate-500">逾期</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-accent-500">
                  {overview.reviewDue}
                </p>
                <p className="mt-1 text-xs text-slate-500">待复习</p>
              </div>
              <div>
                <p className="text-2xl font-semibold text-brand-600">
                  {overview.newRemaining}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  可学新词 / 每日 {dailyNew}
                </p>
              </div>
            </div>
            <Link to="/study" className="btn-primary mt-6 w-full">
              开始学习
            </Link>
          </>
        ) : (
          <p className="mt-3 text-sm text-slate-500">正在加载…</p>
        )}
      </div>

      <Link to="/exam" className="card mb-4 block transition-colors active:bg-slate-50">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">真题训练</h2>
            <p className="mt-1 text-sm text-slate-500">
              历年公务员考试言语理解真题 · 204 道
            </p>
          </div>
          <span className="text-xl text-slate-300">›</span>
        </div>
      </Link>

      <Link to="/quiz" className="card mb-4 block transition-colors active:bg-slate-50">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">分类辨析</h2>
            <p className="mt-1 text-sm text-slate-500">
              近义词辨析训练 · 按教材分类逐组辨析
            </p>
          </div>
          <span className="text-xl text-slate-300">›</span>
        </div>
      </Link>

      {overview && (
        <PlaceholderCard>
          今日已学新词 {overview.newLearned} 个；复习安排由 FSRS
          记忆算法自动计算。
        </PlaceholderCard>
      )}
    </div>
  );
}
