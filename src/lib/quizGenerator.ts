/**
 * 近义词辨析题生成器（第二阶段 · 第一项）
 *
 * 题型：「给出教材原文释义 → 从词语选项中选出对应词语」
 *   题干 = 正确词语的原文 definition（逐字引用）
 *   选项 = 词语本身（正确项为正确词，干扰项为同分类其他词）
 *   解析 = 正确词语 + 其原文释义 + 教材出处
 *
 * 严格规则：
 * 1. 只从「同一 section + groupId + subcategory」且至少 2 个词的分类中出题，绝不跨分类凑题。
 * 2. 题目内容全部来自教材原文（definition / examples / sourcePage），不做任何近义关系的模型猜测。
 * 3. 每题恰好一个正确答案；干扰项只从同分类其他词中取。
 * 4. 若题干释义中出现任何干扰词词面，题目会自相矛盾，该题作废；不降级、不替换、不强行凑题。
 * 5. 生成结果统一 reviewStatus = "pending"，不自动通过审核。
 * 6. 去重：题目 ID 由「mode + 正确词 ID + 全部干扰词 ID」稳定哈希得到；
 *    同一 ID 已存在、近 30 天内出现过同一辨析对、或同一分类在 30 天内已出过题，均跳过。
 * 7. 纯读取 words，写入只发生在 quiz_questions；不触碰 progress / logs / FSRS。
 */
import type { Word } from "@/types";
import type { ContentMeta, QuizOption, QuizQuestion } from "@/types/quiz";
import { getDB } from "@/db/database";
import { getAllQuestions, putQuestionsBatch } from "@/db/quizRepository";

/** 30 天不重复窗口（毫秒） */
export const REPEAT_WINDOW_DAYS = 30;
export const REPEAT_WINDOW_MS = REPEAT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** 无二级分类的词语不进入辨析题（避免把「未设置二级分类」当作真实分类凑题） */
const PENDING_SUBCATEGORY = "未设置二级分类";

/** 选项数量上限（干扰项最多取 3 个） */
const MAX_OPTIONS = 4;

/** 一条可出题的分类（section + groupId + subcategory）内的词 */
export interface SynonymCategory {
  section: string;
  groupId: number;
  groupTitle: string;
  subcategory: string;
  /** 分类键：section::groupId::subcategory */
  categoryKey: string;
  words: Word[];
  /** 该分类的页码（取自组内首个带页码的词，仅作溯源展示） */
  sourcePages: number[];
}

export interface SynonymOptions {
  /** 仅从指定篇章生成（成语篇 / 实词篇），不传表示全部 */
  section?: string;
  /** 最大出题数，默认不限 */
  limit?: number;
  /** 已存在的题目（传入可避免重复查询），默认从数据库读取 */
  existing?: QuizQuestion[];
  /** 当前时间（测试注入） */
  now?: number;
}

export interface SynonymGenerationStats {
  /** 候选分类数（≥2 词的分类） */
  categoryCount: number;
  /** 因词面泄漏等原因作废的候选数 */
  rejected: number;
  /** 因 30 天窗口内已出现而跳过 */
  skippedRepeat: number;
  /** 因题目 ID 已存在而跳过 */
  skippedExists: number;
  /** 成功生成并写入的题目数 */
  created: number;
  /** 本次生成的数量上限（未设置时为 null，表示不限） */
  limit: number | null;
}

export interface SynonymGenerationResult extends SynonymGenerationStats {
  questions: QuizQuestion[];
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 归一化文本：去掉所有空白（原文存在 PDF 折行残留的空格） */
export function normalizeText(s: string): string {
  return (s ?? "").replace(/[\s\u3000]+/g, "").trim();
}

/** FNV-1a 32 位哈希（稳定、无依赖，保证 ID 可复现） */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 辨析对签名（与方向无关，用于 30 天去重）：按词 ID 字典序 */
export function pairSignature(a: string, b: string): string {
  return [a, b].sort().join("::");
}

/**
 * 稳定题目 ID：mode + 正确词 + 全部干扰词（排序后）
 * 同一分类同一正确词的题目，选项集合固定，因此 ID 可复现
 */
export function buildQuestionId(
  termWordId: string,
  distractorWordIds: string[],
): string {
  const sorted = [...distractorWordIds].sort().join(",");
  return `syn_${fnv1a(`synonym::${termWordId}::${sorted}`)}`;
}

/** 分类键（与训练数据的 categoryKey 约定一致） */
export function buildCategoryKey(
  section: string,
  groupId: number,
  subcategory: string,
): string {
  return `${section}::${groupId}::${subcategory}`;
}

/* ------------------------------------------------------------------ */
/* 候选分类收集                                                        */
/* ------------------------------------------------------------------ */

/** 取词语在其全部分类来源中的归属（旧数据无 categoryEntries 时回退顶层字段） */
function entriesOf(word: Word) {
  if (word.categoryEntries?.length) return word.categoryEntries;
  if (word.groupTitle && typeof word.groupId === "number") {
    return [
      {
        volume: word.volume ?? "",
        section: word.section ?? "",
        groupId: word.groupId,
        groupTitle: word.groupTitle,
        subcategory: word.subcategory,
        sourcePage: word.sourcePage,
        source: word.source,
      },
    ];
  }
  return [];
}

/**
 * 收集可出题的分类：同一 section + groupId + subcategory 下至少 2 个不同词。
 * 只读 words 表。
 */
export async function collectSynonymCategories(): Promise<SynonymCategory[]> {
  const db = await getDB();
  const words = (await db.getAll("words")) as Word[];

  const map = new Map<string, SynonymCategory>();
  for (const word of words) {
    // 出题依赖释义与例句，缺失则不入池（不编造内容）
    if (!word.term?.trim() || !word.definition?.trim()) continue;
    if (!(word.examples?.length ?? 0) && !word.example) continue;

    for (const src of entriesOf(word)) {
      const sub = src.subcategory?.trim();
      // 无二级分类的词不参与辨析出题
      if (!sub || sub === PENDING_SUBCATEGORY) continue;

      const key = buildCategoryKey(src.section, src.groupId, sub);
      let cat = map.get(key);
      if (!cat) {
        cat = {
          section: src.section,
          groupId: src.groupId,
          groupTitle: src.groupTitle,
          subcategory: sub,
          categoryKey: key,
          words: [],
          sourcePages: [],
        };
        map.set(key, cat);
      }
      if (!cat.words.some((w) => w.id === word.id)) cat.words.push(word);
      if (typeof src.sourcePage === "number" && !cat.sourcePages.includes(src.sourcePage)) {
        cat.sourcePages.push(src.sourcePage);
      }
    }
  }

  return Array.from(map.values())
    .filter((c) => c.words.length >= 2)
    .map((c) => ({ ...c, sourcePages: c.sourcePages.sort((a, b) => a - b) }))
    .sort(
      (a, b) =>
        a.section.localeCompare(b.section, "zh-CN") ||
        a.groupId - b.groupId ||
        a.subcategory.localeCompare(b.subcategory, "zh-CN"),
    );
}

/* ------------------------------------------------------------------ */
/* 题干与解析拼装（全部基于原文）                                      */
/* ------------------------------------------------------------------ */

/**
 * 题干：直接给出正确词语的教材原文释义，要求选出对应词语。
 * 释义逐字取自 word.definition，不裁剪、不改写、不加修饰。
 */
export function buildStem(target: Word): string {
  return `下列教材原文释义对应的是哪一个词语？\n「${target.definition}」`;
}

/** 题干来源：被考察词语的原文释义 */
export function buildStemMeta(target: Word): ContentMeta {
  return { sourceType: "original", excerpt: target.definition };
}

/** 正确项：词语本身（answer 即选项文本，不含释义） */
function buildCorrectOption(word: Word): QuizOption {
  return {
    id: "A",
    content: word.term,
    wordId: word.id,
    isCorrect: true,
    explain: `正确。${word.term}：${word.definition}`,
    sourceType: "original",
  };
}

/** 干扰项：同为词语本身；解析给出该干扰词的原文释义以说明为何不对 */
function buildDistractorOption(word: Word, id: string): QuizOption {
  return {
    id,
    content: word.term,
    wordId: word.id,
    isCorrect: false,
    explain: `这是「${word.term}」，其原文释义为：${word.definition}`,
    sourceType: "original",
  };
}

/** 总解析：点明正确词语，并回引其原文释义 */
function buildExplanation(word: Word, category: SynonymCategory): {
  text: string;
  meta: ContentMeta;
} {
  return {
    text:
      `正确答案为「${word.term}」。教材原文释义：${word.definition}` +
      ` 该词收录于${category.section} · ${category.groupTitle} · ${category.subcategory}。`,
    meta: { sourceType: "original", excerpt: word.definition },
  };
}

/** 示例句（溯源用，取原文例句第一条，未做改写） */
function firstExample(word: Word): string | undefined {
  return word.examples?.find((e) => e?.trim()) ?? word.example ?? undefined;
}

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

/**
 * 答案泄漏检查：正确答案的「词语」出现在题干释义或其他选项词中被视为泄漏。
 * 题干释义本身就是正确词的 definition，其中若包含干扰词词面，
 * 会让用户在题干里直接看到干扰词，属于干扰项设计缺陷。
 */
function stemLeaksTerm(target: Word, distractor: Word): boolean {
  const stemText = normalizeText(target.definition);
  const term = normalizeText(distractor.term);
  return term.length >= 2 && stemText.includes(term);
}

/**
 * 构造单道辨析题（不写库）。
 * 返回 null 表示该辨析对不满足「唯一正确答案 / 无泄漏」要求，调用方应跳过该题，不强行凑题。
 */
export function buildSynonymQuestion(
  category: SynonymCategory,
  target: Word,
  distractors: Word[],
  createdAt: number,
): QuizQuestion | null {
  // 题干释义必须存在
  if (!target.definition?.trim()) return null;
  // 唯一正确答案：选项词 ID 不重复
  const optionWords = [target, ...distractors];
  const ids = new Set(optionWords.map((w) => w.id));
  if (ids.size !== optionWords.length) return null;
  // 选项是词语本身 → 词语文本不得重复（同形词无法形成唯一答案）
  const terms = new Set(optionWords.map((w) => normalizeText(w.term)));
  if (terms.size !== optionWords.length) return null;
  // 题干释义中不得出现任何干扰词词面（否则题目自相矛盾）
  for (const d of distractors) {
    if (stemLeaksTerm(target, d)) return null;
  }

  const options: QuizOption[] = [
    buildCorrectOption(target),
    ...distractors.map((d, i) => buildDistractorOption(d, String.fromCharCode(66 + i))),
  ];

  const { text, meta } = buildExplanation(target, category);
  const example = firstExample(target);
  const page = category.sourcePages[0];

  return {
    id: buildQuestionId(
      target.id,
      distractors.map((d) => d.id),
    ),
    mode: "synonym",
    wordIds: optionWords.map((w) => w.id),
    // 题干 = 正确词的原文释义
    stem: buildStem(target),
    stemMeta: buildStemMeta(target),
    options,
    correctOptionId: "A",
    explanation: text,
    explanationMeta: meta,
    relatedWordIds: distractors.map((w) => w.id),
    source: {
      type: "original",
      wordIds: [target.id, ...distractors.map((d) => d.id)],
      citation: `${target.source ?? `${category.section} · ${category.groupTitle}`} · ${target.term} · 释义`,
      sourcePage: target.sourcePage ?? page,
      sourceField: "definition",
      // 逐字引用原文释义（未做任何裁剪或改写）
      sourceExcerpt: target.definition,
      ...(example ? { exampleIndex: 0 } : {}),
    },
    aiGenerated: false,
    // 难度按干扰项数量分级：2 项=1，3 项=2，4 项=3
    difficulty: Math.min(3, options.length - 1) as 1 | 2 | 3,
    tags: [category.section, category.groupTitle, category.subcategory],
    categoryKey: category.categoryKey,
    // 统一待审核，不自动通过
    reviewStatus: "pending",
    qualityLevel: "high",
    questionVersion: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

/** 从分类中挑干扰项：按固定顺序取同分类其他词，最多 3 个 */
function pickDistractors(category: SynonymCategory, target: Word): Word[] {
  const others = category.words
    .filter((w) => w.id !== target.id)
    .slice(0, MAX_OPTIONS - 1);
  // 正确项固定放在 A 位，干扰项在其余位置按 ID 排序，保证题干与选项稳定可复现
  return others.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 生成近义词辨析题（只写 quiz_questions，不改动学习数据）。
 *
 * @param options.limit   最多生成多少题
 * @param options.existing 已有题目（增量生成时传入，默认读库）
 * @param options.now     当前时间戳（测试可注入）
 */
export async function generateSynonymQuestions(
  options: SynonymOptions = {},
): Promise<SynonymGenerationResult> {
  const now = options.now ?? Date.now();
  const existing = options.existing ?? (await getAllQuestions());

  // 题目 ID 已存在 → 跳过；近 30 天窗口内出现过的辨析对 / 分类 → 跳过
  const existingIds = new Set(existing.map((q) => q.id));
  const recentPairs = new Set<string>();
  const categoriesInWindow = new Set<string>();
  for (const q of existing) {
    if (now - q.createdAt > REPEAT_WINDOW_MS) continue;
    categoriesInWindow.add(q.categoryKey);
    for (const other of q.relatedWordIds ?? []) {
      recentPairs.add(pairSignature(q.wordIds[0], other));
    }
  }

  const allCategories = await collectSynonymCategories();
  const categories = options.section
    ? allCategories.filter((c) => c.section === options.section)
    : allCategories;
  const stats: SynonymGenerationStats = {
    categoryCount: categories.length,
    rejected: 0,
    skippedRepeat: 0,
    skippedExists: 0,
    created: 0,
    limit: options.limit ?? null,
  };
  const questions: QuizQuestion[] = [];
  /** 本次待写入的题目，循环结束后一次性提交（单事务） */
  const pending: QuizQuestion[] = [];

  // 近 30 天内已出过题的分类整组剔除：保证「同一分类 30 天不重复」
  const available = categories.filter(
    (c) => !categoriesInWindow.has(c.categoryKey),
  );
  stats.skippedRepeat += categories.length - available.length;

  outer: for (const category of available) {
    // 同一次生成中一个分类只出一题：避免同批词反复组合出高度重复的题目
    let categoryUsed = false;
    for (const target of category.words) {
      if (categoryUsed) break;
      const distractors = pickDistractors(category, target);
      if (distractors.length === 0) continue;

      const question = buildSynonymQuestion(category, target, distractors, now);
      if (!question) {
        stats.rejected++;
        continue;
      }
      if (existingIds.has(question.id)) {
        stats.skippedExists++;
        continue;
      }
      const duplicated = distractors.some((d) =>
        recentPairs.has(pairSignature(target.id, d.id)),
      );
      if (duplicated) {
        stats.skippedRepeat++;
        continue;
      }

      pending.push(question);
      questions.push(question);
      existingIds.add(question.id);
      categoriesInWindow.add(category.categoryKey);
      categoryUsed = true;
      for (const d of distractors) {
        recentPairs.add(pairSignature(target.id, d.id));
      }
      stats.created++;
      if (options.limit && stats.created >= options.limit) break outer;
    }
  }

  // 统一落库：单事务批量写入，避免逐条往返
  await putQuestionsBatch(pending);

  return { ...stats, questions };
}
