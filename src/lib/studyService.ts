/**
 * 学习服务：串联「数据层 + FSRS」的核心业务
 * 职责：组织每日队列（逾期优先 → 到期复习 → 新词限额）+ 记录评分
 */
import type { Grade } from "ts-fsrs";
import type { Word, WordProgress } from "@/types";
import {
  addWord,
  getTodayNewLearnedCount,
  getTodayNewWords,
  getTodayReviewQueue,
  getProgress,
  createInitialProgress,
  updateProgress,
  saveReviewLog,
  getAllWords,
} from "@/db/wordRepository";
import { loadSettings } from "@/lib/settings";
import {
  cardFromProgress,
  reviewCard,
  isDue,
  GRADES,
} from "@/lib/fsrs";

/** 词语释义输入 */
export type WordInput = Omit<Word, "id" | "createdAt"> & { id?: string };

export { GRADES };

/** 今日学习任务概览 */
export interface StudyOverview {
  /** 逾期词语数（已超过应复习日期） */
  overdue: number;
  /** 今日到期待复习数（含逾期） */
  reviewDue: number;
  /** 今日还可学习的新词数（已扣除已学） */
  newRemaining: number;
  /** 今日已学新词数 */
  newLearned: number;
}

/** 组装今日学习概览（每日任务系统只负责组织队列，复习时间由 FSRS 决定） */
export async function getStudyOverview(): Promise<StudyOverview> {
  const settings = loadSettings();
  const queue = await getTodayReviewQueue();
  const newLearned = await getTodayNewLearnedCount();
  return {
    overdue: queue.filter((p) => p.due <= Date.now()).length,
    reviewDue: queue.length,
    newLearned,
    newRemaining: Math.max(0, settings.dailyNewCount - newLearned),
  };
}

/** 今日学习队列：逾期/到期复习词在前，其后为限额内的新词 */
export async function getStudyQueue(): Promise<{
  reviewWords: Array<{ word: Word; progress: WordProgress }>;
  newWords: Word[];
}> {
  const overview = await getStudyOverview();
  const reviewQueue = await getTodayReviewQueue();
  const newWords = await getTodayNewWords(overview.newRemaining);

  const reviewWords: Array<{ word: Word; progress: WordProgress }> = [];
  // 一次性批量读取词语，建 Map 查找，避免逐词查询（1000 词规模下 O(n²) → O(n)）
  const allWords = await getAllWords();
  const wordMap = new Map(allWords.map((w) => [w.id, w]));
  for (const p of reviewQueue) {
    const w = wordMap.get(p.wordId);
    if (w) reviewWords.push({ word: w, progress: p });
  }
  return { reviewWords, newWords };
}

/** 学习队列项（供学习页逐张消费） */
export interface QueueItem {
  word: Word;
  progress: WordProgress | undefined;
  isNew: boolean;
}

/** 获取扁平化的今日学习列表（复习优先，新词在后） */
export async function getTodayStudyList(): Promise<QueueItem[]> {
  const { reviewWords, newWords } = await getStudyQueue();
  const items: QueueItem[] = reviewWords.map(({ word, progress }) => ({
    word,
    progress,
    isNew: false,
  }));
  for (const word of newWords) {
    items.push({ word, progress: undefined, isNew: true });
  }
  return items;
}

/**
 * 对一个词语评分（核心流程）：
 * 1. 新词先初始化卡片 2. FSRS 原生调度 3. 持久化进度 + 历史
 */
export async function submitGrade(
  word: Word,
  grade: Grade,
  wasNew: boolean,
): Promise<WordProgress> {
  let progress = await getProgress(word.id);
  if (!progress) {
    progress = await createInitialProgress(word.id);
  }
  const card = cardFromProgress(progress);
  const result = reviewCard(card, grade);
  const updated: WordProgress = {
    wordId: word.id,
    state: result.card.state,
    due: result.card.due.getTime(),
    stability: result.card.stability,
    difficulty: result.card.difficulty,
    reps: result.card.reps,
    lapses: result.card.lapses,
    learningSteps: result.card.learning_steps,
    updatedAt: Date.now(),
  };
  await updateProgress(updated);
  await saveReviewLog({
    wordId: word.id,
    grade,
    reviewedAt: Date.now(),
    wasNew,
    stateAfter: result.card.state,
    scheduledDays: result.log.scheduled_days,
  });
  return updated;
}

/** 判断词语是否需要复习（已到期） */
export function needsReview(progress: WordProgress): boolean {
  return progress.state !== 0 && isDue(progress);
}

/** 确保测试词库存在（仅当词库为空时写入；正式词库导入后不再混入测试词） */
export async function ensureTestWords(): Promise<void> {
  const existing = await getAllWords();
  if (existing.length > 0) return; // 词库非空，不写入测试词
  const testWords: WordInput[] = [
    {
      term: "不刊之论",
      definition:
        "刊：削改，修订。不可改动或不可磨灭的言论，形容文章或言辞精准得当，无懈可击。",
      example: "这篇社论逻辑严密，堪称不刊之论。",
      source: "测试词库",
    },
    {
      term: "首当其冲",
      definition: "最先受到攻击或遭受灾难，并非「首先冲在前面」。",
      example: "洪水来袭时，下游的村庄首当其冲。",
      source: "测试词库",
    },
    {
      term: "差强人意",
      definition: "大体上还能使人满意（差：稍微），并非「不能令人满意」。",
      example: "这次考试成绩差强人意，还有提升空间。",
      source: "测试词库",
    },
    {
      term: "文不加点",
      definition: "写文章一气呵成，无须修改（点：涂改），形容文思敏捷。",
      example: "他文不加点，一挥而就。",
      source: "测试词库",
    },
    {
      term: "空穴来风",
      definition: "现多指消息和传说毫无根据；本义为「有根据、事出有因」。",
      example: "传闻并非空穴来风，董事会确实在商讨重组。",
      source: "测试词库",
    },
    {
      term: "目无全牛",
      definition: "技艺达到极纯熟的境地，并非「没有全局观念」。",
      example: "三十年经验的老技师操作起来目无全牛。",
      source: "测试词库",
    },
  ];
  await Promise.all(testWords.map((w) => addWord(w)));
}
