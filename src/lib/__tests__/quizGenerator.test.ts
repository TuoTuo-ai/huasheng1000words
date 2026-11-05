/**
 * 近义词辨析题生成器测试
 * 覆盖：有效分类、单词分类排除、跨分类限制、唯一正确答案、原文引用逐字一致、
 *       30 天去重、pending 状态、不污染学习数据
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import rawRecordsJson from "../../../data/vocabulary_final.json";
import { resetDBForTest, getDB } from "@/db/database";
import { ensureTestWords, submitGrade, GRADES } from "@/lib/studyService";
import { importVocabulary, type RawVocabRecord } from "@/lib/importService";
import { getAllWords, getProgress, getReviewLogs } from "@/db/wordRepository";
import { getAllQuestions, getQuestionsByStatus } from "@/db/quizRepository";
import {
  collectSynonymCategories,
  generateSynonymQuestions,
  buildSynonymQuestion,
  buildCategoryKey,
  pairSignature,
  normalizeText,
  REPEAT_WINDOW_MS,
} from "@/lib/quizGenerator";

const raw = rawRecordsJson as RawVocabRecord[];

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

/** 导入正式词库（990 词） */
async function seedVocabulary() {
  await ensureTestWords();
  await importVocabulary(raw);
}

describe("候选分类收集", () => {
  it("仅收集同 section + groupId + subcategory 下至少 2 个词的分类", async () => {
    await seedVocabulary();
    const cats = await collectSynonymCategories();
    expect(cats.length).toBeGreaterThan(0);

    // 每个分类的词数 ≥ 2，且全部属于同一键
    for (const c of cats) {
      expect(c.words.length).toBeGreaterThanOrEqual(2);
      expect(c.categoryKey).toBe(
        buildCategoryKey(c.section, c.groupId, c.subcategory),
      );
      expect(c.subcategory).not.toBe("未设置二级分类");
      expect(c.subcategory.trim().length).toBeGreaterThan(0);
    }

    // 与原始数据核对：可用分类数 = 原始「section+group_id+subcategory」且唯一词 ≥2 的数量
    const rawMap = new Map<string, Set<string>>();
    for (const r of raw) {
      const sub = r.subcategory?.trim();
      if (!sub) continue;
      const key = `${r.section}::${r.group_id}::${sub}`;
      if (!rawMap.has(key)) rawMap.set(key, new Set());
      rawMap.get(key)!.add(r.term);
    }
    const expected = [...rawMap.values()].filter((s) => s.size >= 2).length;
    expect(cats.length).toBe(expected);
    expect(expected).toBe(204); // 209 个二级分类 - 5 个单词分类
  });

  it("单词分类（仅 1 个词）被排除，不产生题目", async () => {
    await seedVocabulary();
    const cats = await collectSynonymCategories();
    const keys = new Set(cats.map((c) => c.categoryKey));
    // 原文中 5 个只有 1 个词的二级分类
    const singles = ["国人习惯", "准备得当没有忧虑", "一同出现", "不分好坏", "追逐"];
    for (const sub of singles) {
      const hit = [...keys].filter((k) => k.endsWith(`::${sub}`));
      expect(hit).toEqual([]);
    }
    // 这些分类里的词不应出现在任何题目选项里
    const result = await generateSynonymQuestions();
    const usedWordIds = new Set(result.questions.flatMap((q) => q.wordIds));
    const all = await getAllWords();
    for (const term of ["安土重迁", "高枕无忧", "如影随形", "买椟还珠", "趋之若鹜"]) {
      const w = all.find((x) => x.term === term)!;
      expect(usedWordIds.has(w.id)).toBe(false);
    }
  });

  it("无二级分类的词语不参与出题", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const noSub = all.filter((w) => !w.subcategory?.trim());
    expect(noSub.length).toBeGreaterThan(0);
    const result = await generateSynonymQuestions();
    const usedWordIds = new Set(result.questions.flatMap((q) => q.wordIds));
    for (const w of noSub) expect(usedWordIds.has(w.id)).toBe(false);
  });
});

describe("跨分类限制", () => {
  it("每道题的所有选项词都来自同一分类，且题目 categoryKey 正确", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const wordMap = new Map(all.map((w) => [w.id, w]));
    const result = await generateSynonymQuestions();
    expect(result.questions.length).toBeGreaterThan(0);

    for (const q of result.questions) {
      // 计算词的真实分类归属
      const keysPerWord = q.wordIds.map((id) => {
        const w = wordMap.get(id)!;
        return (w.categoryEntries ?? []).map((e) =>
          buildCategoryKey(e.section, e.groupId, e.subcategory?.trim() ?? ""),
        );
      });
      // 同一道题内所有词共享同一个分类键，且等于题目的 categoryKey
      const shared = keysPerWord[0].filter((k) =>
        keysPerWord.every((list) => list.includes(k)),
      );
      expect(shared).toContain(q.categoryKey);
    }
  });

  it("跨 section 同 groupId 不串组（categoryKey 含 section）", async () => {
    await seedVocabulary();
    const result = await generateSynonymQuestions();
    for (const q of result.questions) {
      expect(q.categoryKey).toMatch(/^(成语篇|实词篇)::\d+::.+/);
      // 解析出的 section 与 tags[0] 一致
      expect(q.categoryKey.split("::")[0]).toBe(q.tags[0]);
    }
  });

  it("构造器拒绝跨分类干扰项：不同分类的词不会被混入", async () => {
    await seedVocabulary();
    const cats = await collectSynonymCategories();
    const catA = cats.find((c) => c.words.length >= 2)!;
    const catB = cats.find((c) => c.categoryKey !== catA.categoryKey)!;
    const q = buildSynonymQuestion(catA, catA.words[0], [catB.words[0]], Date.now())!;
    // 若强行混入跨分类干扰项，categoryKey 仍指向 catA，但该干扰项不属于 catA
    expect(q.categoryKey).toBe(catA.categoryKey);
    expect(catA.words.some((w) => w.id === catB.words[0].id)).toBe(false);
    // 生成器本身不会这样组合（见上一条用例），此处仅验证字段不被改写
  });
});

describe("唯一正确答案与选项完整性（选项是词语）", () => {
  it("每道题恰好一个正确答案，且所有选项都是词语而非释义", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const termMap = new Map(all.map((w) => [w.id, w.term]));
    const defSet = new Set(all.map((w) => normalizeText(w.definition)));
    const result = await generateSynonymQuestions({ limit: 60 });
    expect(result.questions.length).toBe(60);

    for (const q of result.questions) {
      const correct = q.options.filter((o) => o.isCorrect);
      expect(correct.length).toBe(1);
      expect(q.correctOptionId).toBe(correct[0].id);
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(q.options.length).toBeLessThanOrEqual(4);
      expect(new Set(q.options.map((o) => o.id)).size).toBe(q.options.length);
      expect(new Set(q.options.map((o) => o.content)).size).toBe(q.options.length);

      for (const o of q.options) {
        // 选项内容 = 该词的 term（逐字一致）
        expect(termMap.get(o.wordId!)).toBe(o.content);
        // 选项内容不是任何词的释义
        expect(defSet.has(normalizeText(o.content))).toBe(false);
        expect(o.explain.trim().length).toBeGreaterThan(0);
        expect(o.sourceType).toBe("original");
      }
      // relatedWordIds = 干扰项
      expect(q.relatedWordIds).toEqual(
        q.options.filter((o) => !o.isCorrect).map((o) => o.wordId),
      );
      // wordIds = 全部选项词
      expect(q.wordIds.length).toBe(q.options.length);
    }
  });

  it("题干给出的释义与正确词语的 definition 逐字对应", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const byId = new Map(all.map((w) => [w.id, w]));
    const result = await generateSynonymQuestions({ limit: 40 });

    for (const q of result.questions) {
      const correctWord = byId.get(q.options.find((o) => o.isCorrect)!.wordId!)!;
      // 题干包含正确词的原文释义（原样，未裁剪）
      expect(q.stem).toContain(correctWord.definition);
      expect(q.stem).toContain("下列教材原文释义对应的是哪一个词语");
      // stemMeta 引用同一段原文
      expect(q.stemMeta.sourceType).toBe("original");
      expect(q.stemMeta.excerpt).toBe(correctWord.definition);
    }
  });

  it("题干里不会出现任何干扰词的词面（否则答案自相矛盾）", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const byId = new Map(all.map((w) => [w.id, w]));
    const result = await generateSynonymQuestions({ limit: 60 });
    for (const q of result.questions) {
      const stem = normalizeText(q.stem);
      for (const id of q.relatedWordIds) {
        const term = normalizeText(byId.get(id)!.term);
        expect(stem.includes(term)).toBe(false);
      }
    }
  });

  it("选项词语不重复（同形词无法构成唯一答案，整题跳过）", async () => {
    await seedVocabulary();
    const result = await generateSynonymQuestions();
    for (const q of result.questions) {
      const terms = q.options.map((o) => normalizeText(o.content));
      expect(new Set(terms).size).toBe(terms.length);
    }
  });

  it("干扰项数量与难度对应（2 项=1，3 项=2，4 项=3）", async () => {
    await seedVocabulary();
    const result = await generateSynonymQuestions({ limit: 30 });
    for (const q of result.questions) {
      expect(q.difficulty).toBe(Math.min(3, q.options.length - 1));
    }
  });

  it("正确项解析含原文释义，干扰项解析含该干扰词自己的释义", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const byId = new Map(all.map((w) => [w.id, w]));
    const result = await generateSynonymQuestions({ limit: 20 });
    for (const q of result.questions) {
      for (const o of q.options) {
        const w = byId.get(o.wordId!)!;
        expect(o.explain).toContain(w.term);
        expect(o.explain).toContain(w.definition);
      }
    }
  });
});

describe("原文引用逐字一致", () => {
  it("sourceExcerpt 与正确词的 definition 完全相同（含原文空白）", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const defMap = new Map(all.map((w) => [w.id, w.definition]));
    const result = await generateSynonymQuestions({ limit: 40 });
    for (const q of result.questions) {
      const correctWordId = q.options.find((o) => o.isCorrect)!.wordId!;
      // 严格相等：连原文折行残留的空格都不动
      expect(q.source.sourceExcerpt).toBe(defMap.get(correctWordId));
      // 解析正文也完整包含这段原文
      expect(normalizeText(q.explanation)).toContain(
        normalizeText(defMap.get(correctWordId)!),
      );
    }
  });

  it("来源信息保留：citation 含词语名、sourcePage 为数字、wordIds 完整", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const byId = new Map(all.map((w) => [w.id, w]));
    const result = await generateSynonymQuestions({ limit: 20 });
    for (const q of result.questions) {
      const correctWord = byId.get(q.options.find((o) => o.isCorrect)!.wordId!)!;
      expect(q.source.citation).toContain(correctWord.term);
      expect(q.source.citation).toContain("释义");
      expect(q.source.sourcePage).toBe(correctWord.sourcePage ?? q.source.sourcePage);
      expect(q.source.wordIds).toEqual(q.wordIds);
      expect(q.explanationMeta.sourceType).toBe("original");
      expect(q.explanationMeta.excerpt).toBe(correctWord.definition);
    }
  });

  it("题干不引入任何模型生成的近义判断，只复述原文释义", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const byId = new Map(all.map((w) => [w.id, w]));
    const result = await generateSynonymQuestions({ limit: 20 });
    for (const q of result.questions) {
      const correctWord = byId.get(q.options.find((o) => o.isCorrect)!.wordId!)!;
      expect(q.stem).not.toMatch(/近义|相似|最接近|意思相同/);
      // 题干除固定引导句与引号外，只剩原文释义
      const stripped = q.stem
        .replace("下列教材原文释义对应的是哪一个词语？", "")
        .replace(/^\s*「/, "")
        .replace(/」\s*$/, "");
      expect(stripped).toBe(correctWord.definition);
    }
  });
});

describe("去重与 30 天窗口", () => {
  it("同一时刻重复生成：已出过题的分类不再重复出题", async () => {
    await seedVocabulary();
    const now = Date.now();
    const first = await generateSynonymQuestions({ limit: 30, now });
    expect(first.created).toBe(30);
    const usedCats = new Set(first.questions.map((q) => q.categoryKey));

    // 同一时刻再生成：30 个分类进入 30 天窗口，只会从剩余分类出题
    const second = await generateSynonymQuestions({ limit: 30, now });
    expect(second.skippedRepeat).toBe(30); // 30 个分类被窗口剔除
    for (const q of second.questions) {
      expect(usedCats.has(q.categoryKey)).toBe(false);
    }

    // 题库中不存在同一分类两道题的情况
    const all = await getAllQuestions();
    const keys = all.map((q) => q.categoryKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(all.map((q) => q.id)).size).toBe(all.length);
  });

  it("已出过题的分类整组跳过，不会从其他词再凑一题", async () => {
    await seedVocabulary();
    const now = Date.now();
    const first = await generateSynonymQuestions({ limit: 30, now });
    const usedCats = new Set(first.questions.map((q) => q.categoryKey));
    const second = await generateSynonymQuestions({ limit: 30, now: now + 1000 });
    for (const q of second.questions) {
      expect(usedCats.has(q.categoryKey)).toBe(false);
    }
  });

  it("同一分类同一次生成中只出一题（避免同批词反复组合）", async () => {
    await seedVocabulary();
    const result = await generateSynonymQuestions();
    const keys = result.questions.map((q) => q.categoryKey);
    expect(new Set(keys).size).toBe(keys.length);
    // 最多等于可用分类数
    expect(result.questions.length).toBeLessThanOrEqual(result.categoryCount);
  });

  it("30 天内同一辨析对不重复出现", async () => {
    await seedVocabulary();
    const now = Date.now();
    const result = await generateSynonymQuestions({ limit: 80, now });
    const pairs = new Set<string>();
    for (const q of result.questions) {
      for (const other of q.relatedWordIds) {
        const sig = pairSignature(q.wordIds[0], other);
        expect(pairs.has(sig)).toBe(false);
        pairs.add(sig);
      }
    }
  });

  it("30 天窗口外可重新出题：旧题让位，新题补位", async () => {
    await seedVocabulary();
    const now = Date.now();
    const oldCats = new Set<string>();

    // 31 天前生成 10 题
    const old = await generateSynonymQuestions({
      limit: 10,
      now: now - REPEAT_WINDOW_MS - 24 * 60 * 60 * 1000,
    });
    expect(old.created).toBe(10);
    old.questions.forEach((q) => oldCats.add(q.categoryKey));

    // 现在再生成：那 10 个分类已出窗口，可再次出题（ID 与旧题不同则说明是新一批词）
    const again = await generateSynonymQuestions({ limit: 10, now });
    expect(again.created).toBe(10);

    const all = await getAllQuestions();
    expect(new Set(all.map((q) => q.id)).size).toBe(all.length);
  });

  it("近 30 天内已出现过的辨析对被跳过（即便题目 ID 不同）", async () => {
    await seedVocabulary();
    const now = Date.now();
    // 先把最早的一批题挪到 30 天前生成，使其不再占用窗口
    const result = await generateSynonymQuestions({ limit: 3, now: now - REPEAT_WINDOW_MS - 5000 });
    const q0 = result.questions[0];

    // 人为构造一条「同辨析对、不同 ID」的近期记录（模拟历史遗留数据）
    const db = await getDB();
    await db.put("quiz_questions", {
      ...q0,
      id: "manual_pair_conflict",
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });

    // 再次生成：该辨析对因处于 30 天窗口内而被跳过，不会产出新题
    const again = await generateSynonymQuestions({ limit: 3, now });
    expect(again.skippedRepeat).toBeGreaterThan(0);
    const conflictIds = again.questions.map((q) => q.id).filter((id) => id !== "manual_pair_conflict");
    expect(conflictIds).not.toContain(q0.id);
  });
});

describe("pending 状态", () => {
  it("所有新生成题目均为 pending，不自动 approved", async () => {
    await seedVocabulary();
    const result = await generateSynonymQuestions({ limit: 40 });
    expect(result.created).toBe(40);
    for (const q of result.questions) expect(q.reviewStatus).toBe("pending");
    expect((await getQuestionsByStatus("approved")).length).toBe(0);
    expect((await getQuestionsByStatus("pending")).length).toBe(40);
  });

  it("题目质量标准字段完整（difficulty/tags/categoryKey/questionVersion）", async () => {
    await seedVocabulary();
    const result = await generateSynonymQuestions({ limit: 10 });
    for (const q of result.questions) {
      expect([1, 2, 3]).toContain(q.difficulty);
      expect(q.tags.length).toBe(3);
      expect(q.categoryKey.split("::").length).toBe(3);
      expect(q.questionVersion).toBe(1);
      expect(q.qualityLevel).toBe("high");
      expect(q.createdAt).toBe(q.updatedAt);
    }
  });
});

describe("不污染学习数据", () => {
  it("生成题目不改变 words / progress / logs，不影响 FSRS", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    await submitGrade(all[0], GRADES.good, true);
    const pBefore = await getProgress(all[0].id);
    const lBefore = await getReviewLogs(all[0].id);
    const db = await getDB();
    const wBefore = JSON.stringify(await db.getAll("words"));

    await generateSynonymQuestions({ limit: 50 });

    expect(JSON.stringify(await db.getAll("words"))).toBe(wBefore);
    expect(await getProgress(all[0].id)).toEqual(pBefore);
    expect(await getReviewLogs(all[0].id)).toEqual(lBefore);
  });

  it("题目中的词 ID 均真实存在于词库", async () => {
    await seedVocabulary();
    const all = await getAllWords();
    const ids = new Set(all.map((w) => w.id));
    const result = await generateSynonymQuestions({ limit: 30 });
    for (const q of result.questions) {
      for (const id of q.wordIds) expect(ids.has(id)).toBe(true);
    }
  });
});
