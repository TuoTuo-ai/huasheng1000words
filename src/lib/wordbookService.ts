/**
 * 词库查询辅助模块：列表、搜索、筛选、详情
 * 全部数据来自真实 IndexedDB，不修改原始词库数据
 */
import type { Word, WordProgress, ReviewLog } from "@/types";
import { getDB } from "@/db/database";

/** 词语分类（与 FSRS state 对应） */
export type WordCategory = "all" | "new" | "learning" | "reviewing" | "relearning";

/** 词语的当前分类：无 progress 或 state=0 → 新词 */
export function categoryOf(progress: WordProgress | undefined): Exclude<
  WordCategory,
  "all"
> {
  switch (progress?.state) {
    case 1:
      return "learning";
    case 2:
      return "reviewing";
    case 3:
      return "relearning";
    default:
      return "new";
  }
}

/** 词库条目 */
export interface WordbookEntry {
  word: Word;
  progress: WordProgress | undefined;
  category: Exclude<WordCategory, "all">;
}

export interface WordbookStats {
  total: number;
  learned: number;
  unlearned: number;
}

/** 词库总览：全部词语 + 进度 + 统计 */
export async function getWordbook(): Promise<{
  entries: WordbookEntry[];
  stats: WordbookStats;
}> {
  const db = await getDB();
  const [words, progressList] = await Promise.all([
    db.getAllFromIndex("words", "by-createdAt"),
    db.getAll("progress"),
  ]);
  const progressMap = new Map(progressList.map((p) => [p.wordId, p]));
  const entries: WordbookEntry[] = words.map((word) => {
    const progress = progressMap.get(word.id);
    return { word, progress, category: categoryOf(progress) };
  });
  const learned = entries.filter((e) => e.progress && e.progress.reps > 0).length;
  return {
    entries,
    stats: { total: entries.length, learned, unlearned: entries.length - learned },
  };
}

/** 搜索 + 分类筛选（纯过滤，不修改数据；词与释义均参与匹配） */
export function filterEntries(
  entries: WordbookEntry[],
  query: string,
  category: WordCategory,
): WordbookEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (category !== "all" && e.category !== category) return false;
    if (!q) return true;
    return (
      e.word.term.toLowerCase().includes(q) ||
      e.word.definition.toLowerCase().includes(q)
    );
  });
}

/** 词语详情（含学习/复习统计与历史） */
export interface WordDetail {
  word: Word;
  progress: WordProgress | undefined;
  category: Exclude<WordCategory, "all">;
  /** 首次学习以来总评分次数 */
  totalGrades: number;
  /** 学习次数（wasNew=true 的日志数，即实际首次学习/重学安排次数） */
  learnCount: number;
  /** 复习次数（不含首次学习） */
  reviewCount: number;
  /** 上次学习时间 */
  lastReviewedAt: number | undefined;
  logs: ReviewLog[];
}

/** 读取单个词语详情；不存在返回 null */
export async function getWordDetail(id: string): Promise<WordDetail | null> {
  const db = await getDB();
  const word = await db.get("words", id);
  if (!word) return null;
  const progress = await db.get("progress", id);
  const logs = (
    await db.getAllFromIndex("logs", "by-wordId", id)
  ).sort((a, b) => a.reviewedAt - b.reviewedAt);
  return {
    word,
    progress,
    category: categoryOf(progress),
    totalGrades: logs.length,
    learnCount: logs.filter((l) => l.wasNew).length,
    reviewCount: logs.filter((l) => !l.wasNew).length,
    lastReviewedAt: logs.at(-1)?.reviewedAt,
    logs,
  };
}
