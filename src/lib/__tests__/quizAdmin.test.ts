/**
 * 题目管理 / 人工审核测试
 * 覆盖：批量生成并持久化、篇章与分类筛选、状态筛选、审核通过、审核驳回、
 *       已审核不可再改、批量写入事务、相似题检测、审核要点、原学习数据不受影响
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import rawRecordsJson from "../../../data/vocabulary_final.json";
import { resetDBForTest, getDB } from "@/db/database";
import { ensureTestWords, submitGrade, GRADES } from "@/lib/studyService";
import { importVocabulary, type RawVocabRecord } from "@/lib/importService";
import { getAllWords, getProgress, getReviewLogs } from "@/db/wordRepository";
import {
  getAllQuestions,
  getQuestion,
  getQuestionsByStatus,
  reviewQuestion,
  resetQuestionReview,
  putQuestionsBatch,
} from "@/db/quizRepository";
import { generateSynonymQuestions, collectSynonymCategories } from "@/lib/quizGenerator";
import {
  countStats,
  filterQuestions,
  groupByCategory,
  parseCategoryKey,
  findSimilarQuestions,
  buildReviewChecks,
  loadQuizAdminData,
} from "@/lib/quizAdminService";

const raw = rawRecordsJson as RawVocabRecord[];

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

async function seed() {
  await ensureTestWords();
  await importVocabulary(raw);
}

describe("批量生成与数据库持久化", () => {
  it("生成结果全部写入 quiz_questions，统计与库中一致", async () => {
    await seed();
    const result = await generateSynonymQuestions({ limit: 20 });
    expect(result.created).toBe(20);

    const stored = await getAllQuestions();
    expect(stored.length).toBe(20);
    // 内存结果与库中数据 ID 完全一致
    expect(new Set(stored.map((q) => q.id))).toEqual(
      new Set(result.questions.map((q) => q.id)),
    );
    // 全部是 pending
    expect((await getQuestionsByStatus("pending")).length).toBe(20);
    expect((await getQuestionsByStatus("approved")).length).toBe(0);
  });

  it("按篇章生成：只产出指定篇章的题目", async () => {
    await seed();
    const cats = await collectSynonymCategories();
    const idiomCats = cats.filter((c) => c.section === "成语篇").length;
    const wordCats = cats.filter((c) => c.section === "实词篇").length;
    expect(idiomCats).toBeGreaterThan(0);
    expect(wordCats).toBeGreaterThan(0);

    const onlyIdiom = await generateSynonymQuestions({ section: "成语篇" });
    expect(onlyIdiom.created).toBe(idiomCats);
    for (const q of onlyIdiom.questions) {
      expect(parseCategoryKey(q.categoryKey).section).toBe("成语篇");
    }

    const onlyWord = await generateSynonymQuestions({ section: "实词篇" });
    expect(onlyWord.created).toBe(wordCats);
    for (const q of onlyWord.questions) {
      expect(parseCategoryKey(q.categoryKey).section).toBe("实词篇");
    }
  }, 60_000);

  it("putQuestionsBatch 单事务批量写入，空数组不报错", async () => {
    await seed();
    const base = await generateSynonymQuestions({ limit: 3 });

    // 空数组
    expect(await putQuestionsBatch([])).toBe(0);

    // 复制成新 ID 批量写入
    const copies = base.questions.map((q, i) => ({
      ...q,
      id: `batch_copy_${i}`,
      reviewStatus: "pending" as const,
    }));
    expect(await putQuestionsBatch(copies)).toBe(3);
    expect((await getAllQuestions()).length).toBe(6);
    for (const c of copies) {
      expect(await getQuestion(c.id)).toBeTruthy();
    }
  });

  it("重复生成不会让题库膨胀（分类级 30 天窗口 + ID 幂等）", async () => {
    await seed();
    const first = await generateSynonymQuestions({ limit: 10 });
    const total1 = (await getAllQuestions()).length;
    const second = await generateSynonymQuestions({ limit: 10 });
    const total2 = (await getAllQuestions()).length;
    expect(total2).toBe(total1 + second.created);
    for (const q of second.questions) {
      expect(first.questions.some((f) => f.categoryKey === q.categoryKey)).toBe(false);
    }
    // 题库内不存在重复 ID
    const ids = (await getAllQuestions()).map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("筛选", () => {
  it("按篇章筛选", async () => {
    await seed();
    await generateSynonymQuestions({ section: "成语篇", limit: 5 });
    await generateSynonymQuestions({ section: "实词篇", limit: 5 });
    const all = await getAllQuestions();

    const idiom = filterQuestions(all, { section: "成语篇" });
    const word = filterQuestions(all, { section: "实词篇" });
    expect(idiom.length).toBe(5);
    expect(word.length).toBe(5);
    expect(idiom.length + word.length).toBe(all.length);
    for (const q of idiom) {
      expect(parseCategoryKey(q.categoryKey).section).toBe("成语篇");
    }
  });

  it("按分类筛选", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 20 });
    const all = await getAllQuestions();
    const key = all[0].categoryKey;
    const inCat = filterQuestions(all, { categoryKey: key });
    expect(inCat.length).toBeGreaterThan(0);
    for (const q of inCat) expect(q.categoryKey).toBe(key);
  });

  it("按审核状态筛选", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 6 });
    const all = await getAllQuestions();
    await reviewQuestion(all[0].id, "approved");
    await reviewQuestion(all[1].id, "rejected");

    const fresh = await getAllQuestions();
    expect(filterQuestions(fresh, { status: "pending" }).length).toBe(4);
    expect(filterQuestions(fresh, { status: "approved" }).length).toBe(1);
    expect(filterQuestions(fresh, { status: "rejected" }).length).toBe(1);
    expect(filterQuestions(fresh, { status: "" }).length).toBe(6);
  });

  it("组合筛选：篇章 + 状态", async () => {
    await seed();
    await generateSynonymQuestions({ section: "成语篇", limit: 4 });
    await generateSynonymQuestions({ section: "实词篇", limit: 4 });
    const all = await getAllQuestions();
    const idiom = all.find((q) => parseCategoryKey(q.categoryKey).section === "成语篇")!;
    await reviewQuestion(idiom.id, "approved");

    const res = filterQuestions(await getAllQuestions(), {
      section: "成语篇",
      status: "pending",
    });
    expect(res.length).toBe(3);
    for (const q of res) {
      expect(parseCategoryKey(q.categoryKey).section).toBe("成语篇");
      expect(q.reviewStatus).toBe("pending");
    }
  });

  it("分类聚合按篇章分组，计数正确", async () => {
    await seed();
    await generateSynonymQuestions({ section: "实词篇", limit: 5 });
    const all = await getAllQuestions();
    const groups = groupByCategory(all);
    expect(groups.length).toBe(all.length); // 每分类一题
    expect(groups.every((g) => g.section === "实词篇")).toBe(true);
    expect(groups.reduce((s, g) => s + g.total, 0)).toBe(all.length);
    expect(groups.reduce((s, g) => s + g.pending, 0)).toBe(all.length);
  });
});

describe("人工审核", () => {
  it("通过：pending → approved，并更新 updatedAt", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 2 });
    const q = (await getAllQuestions())[0];
    expect(q.reviewStatus).toBe("pending");

    const next = await reviewQuestion(q.id, "approved");
    expect(next.reviewStatus).toBe("approved");
    expect(next.updatedAt).toBeGreaterThanOrEqual(q.updatedAt);
    // 持久化生效
    const stored = await getQuestion(q.id);
    expect(stored!.reviewStatus).toBe("approved");
    // 题目内容未被改动
    expect(stored!.stem).toBe(q.stem);
    expect(stored!.options).toEqual(q.options);
    expect(stored!.correctOptionId).toBe(q.correctOptionId);
  });

  it("驳回：pending → rejected", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 2 });
    const q = (await getAllQuestions())[0];
    const next = await reviewQuestion(q.id, "rejected");
    expect(next.reviewStatus).toBe("rejected");
    expect((await getQuestion(q.id))!.reviewStatus).toBe("rejected");
  });

  it("已审核题目不能再次审核（防止结论被覆盖）", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 1 });
    const q = (await getAllQuestions())[0];
    await reviewQuestion(q.id, "approved");
    await expect(reviewQuestion(q.id, "rejected")).rejects.toThrow(/已审核/);
    // 结论保持不变
    expect((await getQuestion(q.id))!.reviewStatus).toBe("approved");
  });

  it("审核不存在的题目报错", async () => {
    await seed();
    await expect(reviewQuestion("not_exist", "approved")).rejects.toThrow(/不存在/);
  });

  it("审核后计数正确", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 5 });
    const all = await getAllQuestions();
    await reviewQuestion(all[0].id, "approved");
    await reviewQuestion(all[1].id, "approved");
    await reviewQuestion(all[2].id, "rejected");
    const stats = countStats(await getAllQuestions());
    expect(stats).toEqual({ total: 5, pending: 2, approved: 2, rejected: 1 });
  });

  it("新生成题目永远不会自动变成 approved", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 3 });
    await reviewQuestion((await getAllQuestions())[0].id, "approved");
    // 再次生成新题
    const more = await generateSynonymQuestions({ section: "实词篇", limit: 3 });
    for (const q of more.questions) expect(q.reviewStatus).toBe("pending");
    expect((await getQuestionsByStatus("approved")).length).toBe(1);
  });
});

describe("审核辅助", () => {
  it("审核要点：唯一答案 / 题干释义 / 原文引用 / 同分类 全部通过", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 5 });
    const { questions, wordMap } = await loadQuizAdminData();
    for (const q of questions) {
      const checks = buildReviewChecks(q, wordMap);
      expect(checks.length).toBeGreaterThanOrEqual(6);
      for (const c of checks) {
        expect(c.ok).toBe(true);
      }
    }
  });

  it("相似题检测：同分类重复选项组合能被识别", async () => {
    await seed();
    const base = await generateSynonymQuestions({ limit: 2 });
    const q = base.questions[0];
    // 人为塞入一条同分类、同选项组合的题
    await putQuestionsBatch([
      { ...q, id: "dup_same_options", reviewStatus: "pending" },
    ]);
    const all = await getAllQuestions();
    const dup = findSimilarQuestions(all);
    expect(dup.has(q.categoryKey)).toBe(true);
  });

  it("相似题检测：正常题库无非预期重复", async () => {
    await seed();
    await generateSynonymQuestions({ section: "实词篇", limit: 10 });
    const all = await getAllQuestions();
    const dup = findSimilarQuestions(all);
    // 生成器保证每分类一题，因此不应出现重复
    expect(dup.size).toBe(0);
  });

  it("parseCategoryKey 正确解析 section / groupId / subcategory", () => {
    expect(parseCategoryKey("成语篇::12::形容学到一点就能推知更多")).toEqual({
      section: "成语篇",
      groupId: 12,
      subcategory: "形容学到一点就能推知更多",
    });
    expect(parseCategoryKey("实词篇::3::连接、中介")).toEqual({
      section: "实词篇",
      groupId: 3,
      subcategory: "连接、中介",
    });
  });
});

describe("不影响原有词库与学习数据", () => {
  it("批量生成 + 审核不改变 words / progress / logs 与 FSRS", async () => {
    await seed();
    const words = await getAllWords();
    await submitGrade(words[0], GRADES.good, true);
    await submitGrade(words[1], GRADES.again, true);

    const db = await getDB();
    const before = {
      words: JSON.stringify(await db.getAll("words")),
      progress: JSON.stringify(await db.getAll("progress")),
      logs: JSON.stringify(await db.getAll("logs")),
    };
    const pBefore = await getProgress(words[0].id);
    const lBefore = await getReviewLogs(words[0].id);

    await generateSynonymQuestions({ limit: 10 });
    const all = await getAllQuestions();
    await reviewQuestion(all[0].id, "approved");
    await reviewQuestion(all[1].id, "rejected");

    expect(JSON.stringify(await db.getAll("words"))).toBe(before.words);
    expect(JSON.stringify(await db.getAll("progress"))).toBe(before.progress);
    expect(JSON.stringify(await db.getAll("logs"))).toBe(before.logs);
    expect(await getProgress(words[0].id)).toEqual(pBefore);
    expect(await getReviewLogs(words[0].id)).toEqual(lBefore);
  });

  it("未生成任何题目时页面数据也能正常加载", async () => {
    await seed();
    const { questions, wordMap } = await loadQuizAdminData();
    expect(questions).toEqual([]);
    expect(wordMap.size).toBe(990);
    expect(countStats(questions)).toEqual({
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
    });
  });
});

describe("审核撤销", () => {
  it("已通过 → 重置为 pending，且重新出现在待审核列表", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 3 });
    const q = (await getAllQuestions())[0];

    await reviewQuestion(q.id, "approved");
    expect((await getQuestion(q.id))!.reviewStatus).toBe("approved");
    expect((await getQuestionsByStatus("pending")).length).toBe(2);

    const after = await resetQuestionReview(q.id);
    expect(after.reviewStatus).toBe("pending");
    expect((await getQuestion(q.id))!.reviewStatus).toBe("pending");
    expect((await getQuestionsByStatus("pending")).length).toBe(3);
    expect((await getQuestionsByStatus("approved")).length).toBe(0);
    expect(filterQuestions(await getAllQuestions(), { status: "pending" }).length).toBe(3);
  });

  it("已驳回 → 重置为 pending", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 2 });
    const q = (await getAllQuestions())[0];
    await reviewQuestion(q.id, "rejected");

    const after = await resetQuestionReview(q.id);
    expect(after.reviewStatus).toBe("pending");
    expect((await getQuestion(q.id))!.reviewStatus).toBe("pending");
    expect((await getQuestionsByStatus("rejected")).length).toBe(0);
  });

  it("撤销不改变题目内容、选项与来源信息", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 2 });
    const before = (await getAllQuestions())[0];
    await reviewQuestion(before.id, "approved");
    const after = await resetQuestionReview(before.id);

    // 除 reviewStatus 与 updatedAt 外完全一致
    const { reviewStatus: _a, updatedAt: _b, ...restAfter } = after;
    const { reviewStatus: _c, updatedAt: _d, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(after.stem).toBe(before.stem);
    expect(after.options).toEqual(before.options);
    expect(after.source).toEqual(before.source);
    expect(after.source.sourceExcerpt).toBe(before.source.sourceExcerpt);
    expect(after.correctOptionId).toBe(before.correctOptionId);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it("不允许 approved 直接改判为 rejected，必须先撤销", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 1 });
    const q = (await getAllQuestions())[0];
    await reviewQuestion(q.id, "approved");
    await expect(reviewQuestion(q.id, "rejected")).rejects.toThrow(/先撤销/);
    expect((await getQuestion(q.id))!.reviewStatus).toBe("approved");

    // 撤销后可以重新审核为 rejected
    await resetQuestionReview(q.id);
    const next = await reviewQuestion(q.id, "rejected");
    expect(next.reviewStatus).toBe("rejected");
  });

  it("不允许 rejected 直接改判为 approved，必须先撤销", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 1 });
    const q = (await getAllQuestions())[0];
    await reviewQuestion(q.id, "rejected");
    await expect(reviewQuestion(q.id, "approved")).rejects.toThrow(/先撤销/);
    expect((await getQuestion(q.id))!.reviewStatus).toBe("rejected");

    await resetQuestionReview(q.id);
    expect((await reviewQuestion(q.id, "approved")).reviewStatus).toBe("approved");
  });

  it("重置 pending 题目为幂等操作（不报错、不改内容）", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 1 });
    const q = (await getAllQuestions())[0];
    expect(q.reviewStatus).toBe("pending");
    const after = await resetQuestionReview(q.id);
    expect(after.reviewStatus).toBe("pending");
    expect(after.stem).toBe(q.stem);
    expect(after.updatedAt).toBe(q.updatedAt); // 未写入
  });

  it("撤销不存在的题目报错", async () => {
    await seed();
    await expect(resetQuestionReview("not_exist")).rejects.toThrow(/不存在/);
  });

  it("撤销后统计回到待审核", async () => {
    await seed();
    await generateSynonymQuestions({ limit: 5 });
    const all = await getAllQuestions();
    await reviewQuestion(all[0].id, "approved");
    await reviewQuestion(all[1].id, "rejected");
    expect(countStats(await getAllQuestions())).toEqual({
      total: 5, pending: 3, approved: 1, rejected: 1,
    });

    await resetQuestionReview(all[0].id);
    await resetQuestionReview(all[1].id);
    expect(countStats(await getAllQuestions())).toEqual({
      total: 5, pending: 5, approved: 0, rejected: 0,
    });
  });
});

describe("批量生成数量限制", () => {
  it("limit 控制本次新增数量，实际数不超过上限", async () => {
    await seed();
    const r = await generateSynonymQuestions({ limit: 10 });
    expect(r.created).toBe(10);
    expect(r.limit).toBe(10);
    expect((await getAllQuestions()).length).toBe(10);
  });

  it("可生成数量不足时按实际生成，不凑数", async () => {
    await seed();
    const cats = await collectSynonymCategories();
    const wordCats = cats.filter((c) => c.section === "实词篇").length;
    // 上限远大于实词篇可用分类数
    const r = await generateSynonymQuestions({ section: "实词篇", limit: 200 });
    expect(r.created).toBeLessThan(200);
    expect(r.created).toBeLessThanOrEqual(wordCats);
    // 实际入库数 = 返回的 created，不虚报
    expect((await getAllQuestions()).length).toBe(r.created);
  }, 60_000);

  it("按篇章 + 数量限制：只产出该篇章且不超上限", async () => {
    await seed();
    const r = await generateSynonymQuestions({ section: "成语篇", limit: 20 });
    expect(r.created).toBe(20);
    for (const q of r.questions) {
      expect(parseCategoryKey(q.categoryKey).section).toBe("成语篇");
    }
    const wordR = await generateSynonymQuestions({ section: "实词篇", limit: 20 });
    expect(wordR.created).toBe(20);
    for (const q of wordR.questions) {
      expect(parseCategoryKey(q.categoryKey).section).toBe("实词篇");
    }
    expect((await getAllQuestions()).length).toBe(40);
  });

  it("不同 limit 取值均可生效（默认值 50 语义）", async () => {
    await seed();
    const r = await generateSynonymQuestions({ limit: 50 });
    expect(r.created).toBe(50);
    const again = await generateSynonymQuestions({ limit: 50 });
    // 新一批分类补位，仍不超过 50
    expect(again.created).toBeLessThanOrEqual(50);
    expect((await getAllQuestions()).length).toBe(r.created + again.created);
  });

  it("数量限制不影响 30 天去重与同分类去重", async () => {
    await seed();
    const r1 = await generateSynonymQuestions({ limit: 30 });
    const cats1 = new Set(r1.questions.map((q) => q.categoryKey));
    const r2 = await generateSynonymQuestions({ limit: 30 });
    // 第二批不会复用第一批的分类
    for (const q of r2.questions) expect(cats1.has(q.categoryKey)).toBe(false);
    expect(r2.skippedRepeat).toBeGreaterThan(0);
    // 题库内无重复 ID、无重复分类
    const all = await getAllQuestions();
    expect(new Set(all.map((q) => q.id)).size).toBe(all.length);
    const keys = all.map((q) => q.categoryKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("limit=0 或未设置时按不限处理（仅校验不报错）", async () => {
    await seed();
    const r = await generateSynonymQuestions({ section: "实词篇" });
    expect(r.limit).toBeNull();
    expect(r.created).toBeGreaterThan(0);
  });
});
