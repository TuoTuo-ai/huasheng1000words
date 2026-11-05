/**
 * 数据操作层：所有业务数据真实读写 IndexedDB
 * 仓库结构沿用 database.ts（words / progress / logs），不重建数据库
 */
import type { Word, WordProgress, ReviewLog } from "@/types";
import { getDB } from "@/db/database";
import { newCard } from "@/lib/fsrs";

/** 生成词语唯一 ID（term 内容哈希，天然防重复） */
function wordId(term: string): string {
  let h = 5381;
  for (let i = 0; i < term.length; i++) {
    h = (h * 33) ^ term.charCodeAt(i);
  }
  return `w_${(h >>> 0).toString(16)}`;
}

/** 添加单个词语，已存在则返回 null（避免重复创建） */
export async function addWord(
  input: Omit<Word, "id" | "createdAt"> & { id?: string },
): Promise<Word | null> {
  try {
    const db = await getDB();
    const id = input.id ?? wordId(input.term);
    const existing = await db.get("words", id);
    if (existing) return null;
    const word: Word = { ...input, id, createdAt: Date.now() };
    await db.put("words", word);
    return word;
  } catch (err) {
    console.error("[DB] 添加词语失败:", err);
    throw err;
  }
}

/** 批量导入词语，返回 { added, skipped } */
export async function addWords(
  inputs: Array<Omit<Word, "id" | "createdAt"> & { id?: string }>,
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for (const input of inputs) {
    const result = await addWord(input);
    result ? added++ : skipped++;
  }
  return { added, skipped };
}

/**
 * 导入式写入：已存在同名词则仅更新内容字段（保留原 id/createdAt），
 * 学习进度（progress）与历史（logs）完全不受影响；不存在则新建。
 */
export async function upsertWord(
  input: Omit<Word, "id" | "createdAt"> & { id?: string },
): Promise<"added" | "updated"> {
  try {
    const db = await getDB();
    const id = input.id ?? wordId(input.term);
    const existing = await db.get("words", id);
    if (existing) {
      // 只覆盖内容字段，保留 id 与 createdAt
      const updated: Word = { ...input, id, createdAt: existing.createdAt };
      await db.put("words", updated);
      return "updated";
    }
    const word: Word = { ...input, id, createdAt: Date.now() };
    await db.put("words", word);
    return "added";
  } catch (err) {
    console.error("[DB] 导入词语失败:", err);
    throw err;
  }
}

/** 获取所有词语 */
export async function getAllWords(): Promise<Word[]> {
  try {
    const db = await getDB();
    const all = await db.getAllFromIndex("words", "by-createdAt");
    return all.sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    console.error("[DB] 获取词语列表失败:", err);
    throw err;
  }
}

/** 获取单个词语 */
export async function getWord(id: string): Promise<Word | undefined> {
  try {
    const db = await getDB();
    return await db.get("words", id);
  } catch (err) {
    console.error("[DB] 获取词语失败:", err);
    throw err;
  }
}

/** 获取词语学习状态（无记录返回 undefined，表示新词） */
export async function getProgress(
  wordId: string,
): Promise<WordProgress | undefined> {
  try {
    const db = await getDB();
    return await db.get("progress", wordId);
  } catch (err) {
    console.error("[DB] 获取学习状态失败:", err);
    throw err;
  }
}

/** 更新词语学习状态（按 wordId 主键覆盖，不串词） */
export async function updateProgress(
  progress: WordProgress,
): Promise<WordProgress> {
  try {
    const db = await getDB();
    await db.put("progress", progress);
    return progress;
  } catch (err) {
    console.error("[DB] 更新学习状态失败:", err);
    throw err;
  }
}

/** 为新词创建初始进度（FSRS 空卡片） */
export async function createInitialProgress(
  wordId: string,
): Promise<WordProgress> {
  const card = newCard();
  const progress: WordProgress = {
    wordId,
    state: card.state,
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    learningSteps: card.learning_steps,
    updatedAt: Date.now(),
  };
  return updateProgress(progress);
}

/** 保存复习记录 */
export async function saveReviewLog(
  log: Omit<ReviewLog, "id">,
): Promise<void> {
  try {
    const db = await getDB();
    await db.add("logs", log as ReviewLog);
  } catch (err) {
    console.error("[DB] 保存复习记录失败:", err);
    throw err;
  }
}

/** 获取某词的全部复习历史（按时间升序） */
export async function getReviewLogs(wordId: string): Promise<ReviewLog[]> {
  try {
    const db = await getDB();
    const logs = await db.getAllFromIndex("logs", "by-wordId", wordId);
    return logs.sort((a, b) => a.reviewedAt - b.reviewedAt);
  } catch (err) {
    console.error("[DB] 获取复习历史失败:", err);
    throw err;
  }
}

function startOfDay(d: Date): number {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return t.getTime();
}
function endOfDay(d: Date): number {
  const t = new Date(d);
  t.setHours(23, 59, 59, 999);
  return t.getTime();
}

/** 今日待复习词语：状态非新词 且 到期时间 ≤ 今天结束（含逾期，逾期排在最前） */
export async function getTodayReviewQueue(now = new Date()): Promise<
  WordProgress[]
> {
  try {
    const db = await getDB();
    const all = await db.getAllFromIndex("progress", "by-due");
    const end = endOfDay(now);
    return all
      .filter((p) => p.state !== 0 && p.due <= end)
      .sort((a, b) => a.due - b.due); // 逾期最久的排最前
  } catch (err) {
    console.error("[DB] 获取今日复习队列失败:", err);
    throw err;
  }
}

/** 今日已学习新词数（依据 logs 中 wasNew 标记） */
export async function getTodayNewLearnedCount(
  now = new Date(),
): Promise<number> {
  try {
    const db = await getDB();
    const logs = await db.getAllFromIndex("logs", "by-reviewedAt");
    const start = startOfDay(now);
    return logs.filter(
      (l) => l.wasNew && l.reviewedAt >= start && l.reviewedAt <= endOfDay(now),
    ).length;
  } catch (err) {
    console.error("[DB] 统计今日新词失败:", err);
    throw err;
  }
}

/** 获取今日新词队列（受每日新词数限制），limit 为剩余可学新词数 */
export async function getTodayNewWords(limit: number): Promise<Word[]> {
  if (limit <= 0) return [];
  try {
    const db = await getDB();
    const words = await db.getAllFromIndex("words", "by-createdAt");
    const result: Word[] = [];
    for (const w of words.sort((a, b) => a.createdAt - b.createdAt)) {
      const p = await db.get("progress", w.id);
      if (!p) {
        result.push(w);
        if (result.length >= limit) break;
      }
    }
    return result;
  } catch (err) {
    console.error("[DB] 获取今日新词失败:", err);
    throw err;
  }
}

/** 每日学习统计 */
export interface DailyStats {
  date: string;
  newLearned: number;
  reviewed: number;
}

/** 获取指定日期的统计（默认今天），跨日期自动反映新的一天 */
export async function getDailyStats(now = new Date()): Promise<DailyStats> {
  try {
    const db = await getDB();
    const logs = await db.getAllFromIndex("logs", "by-reviewedAt");
    const start = startOfDay(now);
    const end = endOfDay(now);
    const today = logs.filter(
      (l) => l.reviewedAt >= start && l.reviewedAt <= end,
    );
    return {
      date: new Date(now).toLocaleDateString("zh-CN"),
      newLearned: today.filter((l) => l.wasNew).length,
      reviewed: today.filter((l) => !l.wasNew).length,
    };
  } catch (err) {
    console.error("[DB] 获取每日统计失败:", err);
    throw err;
  }
}
