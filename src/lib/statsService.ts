/**
 * 统计模块：全部数据来自真实 IndexedDB（words / progress / logs）
 * 所有日期计算使用设备本地时区（用 getFullYear/getMonth/getDate，避免 UTC 偏差）
 */
import type { Word, WordProgress } from "@/types";
import { getDB } from "@/db/database";

/** 本地日期起点（当天 00:00:00.000 的时间戳） */
export function startOfLocalDay(d: Date = new Date()): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 本地日期键（如 2026-11-5），用于连续天数计算 */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 全量统计结果 */
export interface StudyStatistics {
  /** 累计学习词数（logs 按 wordId 去重） */
  totalLearnedWords: number;
  /** 累计复习次数（logs 中 wasNew=false 的记录数，不含首次学习） */
  totalReviewCount: number;
  /** 已掌握词数（FSRS 卡片状态为复习中 state=2 的所有词） */
  masteredWords: number;
  /** 词库总数 */
  totalWords: number;
  /** 今日学习词数（今天有评分记录的词，去重） */
  todayLearnedWords: number;
  /** 连续学习天数（从今天或昨天往前连续有记录的自然日数） */
  streakDays: number;
}

/** 最近 7 天趋势（含今天） */
export interface TrendDay {
  /** 本地日期键 */
  key: string;
  /** 横坐标标签（如「11/5」「今天」） */
  label: string;
  newCount: number;
  reviewCount: number;
}

/** 记忆状态分布 */
export interface StateDistribution {
  newCount: number;
  learning: number;
  reviewing: number;
  relearning: number;
}

/** 六项核心指标 */
export async function getStudyStatistics(): Promise<StudyStatistics> {
  const db = await getDB();
  const [logs, progressList, words] = await Promise.all([
    db.getAll("logs"),
    db.getAll("progress"),
    db.getAll("words"),
  ]);

  const todayStart = startOfLocalDay();
  const learnedIds = new Set<string>();
  const todayIds = new Set<string>();
  let reviewCount = 0;
  const daySet = new Set<string>();

  for (const log of logs) {
    if (log.wasNew) learnedIds.add(log.wordId); // 首次学习过的词去重
    daySet.add(localDateKey(new Date(log.reviewedAt)));
    if (log.reviewedAt >= todayStart) todayIds.add(log.wordId);
    if (!log.wasNew) reviewCount++;
  }

  // 已掌握 = FSRS 卡片状态为复习中(state=2)的所有词（到期与否不改变卡片状态）
  const mastered = progressList.filter((p) => p.state === 2).length;

  return {
    totalLearnedWords: learnedIds.size,
    totalReviewCount: reviewCount,
    masteredWords: mastered,
    totalWords: words.length,
    todayLearnedWords: todayIds.size,
    streakDays: calcStreak(daySet),
  };
}

/** 连续学习天数：从今天开始往前数；今天还没学则从昨天开始（不断签） */
export function calcStreak(daySet: Set<string>): number {
  if (daySet.size === 0) return 0;
  const d = new Date();
  if (!daySet.has(localDateKey(d))) {
    d.setDate(d.getDate() - 1); // 今天未学，从昨天起算
    if (!daySet.has(localDateKey(d))) return 0;
  }
  let streak = 0;
  while (daySet.has(localDateKey(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

/** 最近 7 天趋势：含今天的 7 个自然日，无记录的天为 0 */
export async function getTrend7Days(): Promise<TrendDay[]> {
  const db = await getDB();
  const logs = await db.getAll("logs");
  const todayStart = startOfLocalDay();
  const dayMs = 86_400_000;

  // 预聚合，避免按天多次遍历
  const agg = new Map<string, { n: number; r: number }>();
  for (const log of logs) {
    const key = localDateKey(new Date(log.reviewedAt));
    const cur = agg.get(key) ?? { n: 0, r: 0 };
    if (log.wasNew) cur.n++;
    else cur.r++;
    agg.set(key, cur);
  }

  const result: TrendDay[] = [];
  const labels = ["6天前", "5天前", "4天前", "3天前", "前天", "昨天", "今天"];
  for (let i = 6; i >= 0; i--) {
    const dayStart = todayStart - i * dayMs;
    const d = new Date(dayStart);
    const key = localDateKey(d);
    const stat = agg.get(key) ?? { n: 0, r: 0 };
    result.push({
      key,
      label: labels[6 - i],
      newCount: stat.n,
      reviewCount: stat.r,
    });
  }
  return result;
}

/**
 * 记忆状态分布：每个词归入且仅归入一个状态
 * 无 progress 或 state=0 → 新词；1 → 学习中；2 → 复习中；3 → 重学中
 * 缺少 progress 的词安全归入「新词」，不会导致统计崩溃
 */
export async function getStateDistribution(): Promise<StateDistribution> {
  const db = await getDB();
  const [words, progressList] = await Promise.all([
    db.getAll("words"),
    db.getAll("progress"),
  ]);
  const progressMap = new Map(progressList.map((p) => [p.wordId, p]));

  const dist: StateDistribution = {
    newCount: 0,
    learning: 0,
    reviewing: 0,
    relearning: 0,
  };
  for (const _w of words as Word[]) {
    const p = progressMap.get(_w.id) as WordProgress | undefined;
    switch (p?.state) {
      case 1:
        dist.learning++;
        break;
      case 2:
        dist.reviewing++;
        break;
      case 3:
        dist.relearning++;
        break;
      default:
        dist.newCount++; // 无 progress 或 state=0
    }
  }
  return dist;
}
