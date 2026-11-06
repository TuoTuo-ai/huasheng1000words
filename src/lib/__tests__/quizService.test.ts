/**
 * 分类辨析训练用户端服务测试（V1.0 · synonym only）
 *
 * 覆盖：
 * - 只有 approved 可进入训练（pending / rejected / draft 全部排除）
 * - 只取 synonym 模式
 * - 分类聚合与排序、题数统计
 * - 抽题不重复、题量不足按实际可用量、count 非法
 * - 会话创建（题号去重）、提交、判题、重复提交、已完成会话拒绝提交
 * - 记录与会话计数一致、恢复未完成会话
 * - 已审核题目本身不被修改；不影响 words / progress / logs；不影响真题记录
 * - 解析取题目原文，缺失时「暂无解析」
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { resetDBForTest, getDB } from "@/db/database";
import {
  addTrainingRecordAndUpdateSession,
  getAllQuestions,
  getQuestion,
  getRecordsByTraining,
  getSession,
  putQuestion,
  putSession,
} from "@/db/quizRepository";
import {
  NO_EXPLANATION_TEXT,
  QuizServiceError,
  buildCategories,
  categoryLabel,
  computeAccuracy,
  correctOptionText,
  explanationText,
  finishQuizSession,
  formatDuration,
  getApprovedQuestions,
  getQuizSessionResult,
  insufficientHint,
  judgeQuizAnswer,
  loadQuizCategories,
  optionExplainText,
  optionLines,
  parseCategoryKey,
  pickQuestions,
  quizResultPath,
  quizStudyPath,
  recordCategoryKey,
  shuffleItems,
  startQuizSession,
  stemText,
  submitQuizAnswer,
} from "@/lib/quizService";
import type { QuizQuestion, TrainingSession } from "@/types/quiz";

const NOW = 1_780_000_000_000;

/** 造一道 synonym 题（默认 approved） */
function makeQuestion(
  id: string,
  opts: {
    categoryKey?: string;
    section?: string;
    subcategory?: string;
    reviewStatus?: QuizQuestion["reviewStatus"];
    mode?: QuizQuestion["mode"];
    explanation?: string;
    correctOptionId?: string;
    tags?: string[];
    aiGenerated?: boolean;
  } = {},
): QuizQuestion {
  const categoryKey = opts.categoryKey ?? "成语::g1::近义辨析";
  const section = opts.section ?? parseCategoryKey(categoryKey).section;
  const subcategory = opts.subcategory ?? parseCategoryKey(categoryKey).subcategory;
  return {
    id,
    mode: opts.mode ?? "synonym",
    wordIds: [`w-${id}-1`, `w-${id}-2`],
    stem: `下列教材原文释义对应的是哪一个词语？\n「第 ${id} 题的原文释义」`,
    stemMeta: { sourceType: "original", excerpt: `第 ${id} 题的原文释义` },
    options: [
      { id: "A", content: `词语A-${id}`, isCorrect: true, explain: `正确。词语A-${id}的释义`, sourceType: "original" },
      { id: "B", content: `词语B-${id}`, isCorrect: false, explain: `这是词语B-${id}`, sourceType: "original" },
      { id: "C", content: `词语C-${id}`, isCorrect: false, explain: `这是词语C-${id}`, sourceType: "original" },
    ],
    correctOptionId: opts.correctOptionId ?? "A",
    explanation: opts.explanation ?? `正确答案为「词语A-${id}」。教材原文释义：第 ${id} 题释义`,
    explanationMeta: { sourceType: "original" },
    relatedWordIds: [`w-${id}-2`],
    source: {
      type: "original",
      wordIds: [`w-${id}-1`, `w-${id}-2`],
      citation: `${section} · ${subcategory} · 词语A-${id} · 释义`,
      sourceField: "definition",
      sourceExcerpt: `第 ${id} 题的原文释义`,
    },
    aiGenerated: opts.aiGenerated ?? false,
    difficulty: 2,
    tags: opts.tags ?? [section, "组一", subcategory],
    categoryKey,
    reviewStatus: opts.reviewStatus ?? "approved",
    qualityLevel: "high",
    questionVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** 批量写库 */
async function seed(questions: QuizQuestion[]) {
  const db = await getDB();
  const tx = db.transaction("quiz_questions", "readwrite");
  for (const q of questions) tx.store.put(q);
  await tx.done;
}

/** 固定随机数序列，便于断言抽题顺序 */
function seqRandom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

/* ================= 1. 只有 approved 可进入训练 ================= */

describe("approved 过滤", () => {
  it("只返回 approved 题目，pending / rejected / draft 全部排除", async () => {
    await seed([
      makeQuestion("q-approved-1", { reviewStatus: "approved" }),
      makeQuestion("q-approved-2", { reviewStatus: "approved" }),
      makeQuestion("q-pending", { reviewStatus: "pending" }),
      makeQuestion("q-rejected", { reviewStatus: "rejected" }),
      makeQuestion("q-draft", { reviewStatus: "draft" }),
    ]);

    const got = await getApprovedQuestions();
    expect(got.map((q) => q.id)).toEqual(["q-approved-1", "q-approved-2"]);
    // 结果按 id 升序稳定
    expect(got.map((q) => q.reviewStatus)).toEqual(["approved", "approved"]);
  });

  it("approved 的真题（mode=exam）也排除：训练侧只取 synonym", async () => {
    await seed([
      makeQuestion("q-syn", { reviewStatus: "approved" }),
      makeQuestion("q-exam", { mode: "exam", reviewStatus: "approved" }),
      makeQuestion("q-pitfall", { mode: "pitfall", reviewStatus: "approved" }),
    ]);

    const got = await getApprovedQuestions();
    expect(got.map((q) => q.id)).toEqual(["q-syn"]);
    expect(got.every((q) => q.mode === "synonym")).toBe(true);
  });

  it("题库为空时返回空数组，不抛错", async () => {
    await expect(getApprovedQuestions()).resolves.toEqual([]);
    await expect(loadQuizCategories()).resolves.toEqual([]);
  });

  it("审核通过前后的可见性：pending 不可用，approve 后可用，reject 后再次不可用", async () => {
    const q = makeQuestion("q-flow", { reviewStatus: "pending" });
    await putQuestion(q);
    expect((await getApprovedQuestions()).length).toBe(0);

    await putQuestion({ ...q, reviewStatus: "approved" });
    expect((await getApprovedQuestions()).map((x) => x.id)).toEqual(["q-flow"]);

    await putQuestion({ ...q, reviewStatus: "rejected" });
    expect((await getApprovedQuestions()).length).toBe(0);
  });
});

/* ================= 2. 分类聚合 ================= */

describe("分类聚合", () => {
  it("按 categoryKey 聚合、统计题数，并按 section/groupId/subcategory 排序", async () => {
    await seed([
      makeQuestion("q1", { categoryKey: "实词::g2::易混" }),
      makeQuestion("q2", { categoryKey: "成语::g1::近义辨析" }),
      makeQuestion("q3", { categoryKey: "成语::g1::近义辨析" }),
      makeQuestion("q4", { categoryKey: "成语::g0::语义轻重" }),
    ]);

    // 排序按 Unicode 码点（稳定可复现）：「实」在「成」之前
    const categories = await loadQuizCategories();
    expect(categories.map((c) => c.categoryKey)).toEqual([
      "实词::g2::易混",
      "成语::g0::语义轻重",
      "成语::g1::近义辨析",
    ]);
    expect(categories.map((c) => c.count)).toEqual([1, 1, 2]);
    expect(categories[2]).toMatchObject({
      section: "成语",
      groupId: "g1",
      subcategory: "近义辨析",
      groupTitle: "组一",
    });
    expect(categoryLabel(categories[2])).toBe("成语 · 近义辨析");
  });

  it("未审核题不计入分类题数", async () => {
    await seed([
      makeQuestion("q-a", { categoryKey: "成语::g1::近义辨析", reviewStatus: "approved" }),
      makeQuestion("q-b", { categoryKey: "成语::g1::近义辨析", reviewStatus: "pending" }),
    ]);
    const categories = buildCategories(await getApprovedQuestions());
    expect(categories).toHaveLength(1);
    expect(categories[0].count).toBe(1);
  });

  it("categoryKey 解析健壮：缺段时原样回填，不抛错", () => {
    expect(parseCategoryKey("成语::g1::近义辨析")).toEqual({
      section: "成语",
      groupId: "g1",
      subcategory: "近义辨析",
    });
    expect(parseCategoryKey("成语")).toEqual({ section: "成语", groupId: "", subcategory: "" });
    // 含额外分隔符时后续片段合并回 subcategory
    expect(parseCategoryKey("成语::g1::A::B").subcategory).toBe("A::B");
    // 空字符串不抛错
    expect(() => parseCategoryKey("")).not.toThrow();
  });
});

/* ================= 3. 抽题 ================= */

describe("抽题", () => {
  it("按分类抽题只取该分类，且不重复", async () => {
    await seed([
      makeQuestion("a1", { categoryKey: "成语::g1::近义辨析" }),
      makeQuestion("a2", { categoryKey: "成语::g1::近义辨析" }),
      makeQuestion("a3", { categoryKey: "成语::g1::近义辨析" }),
      makeQuestion("b1", { categoryKey: "实词::g2::易混" }),
    ]);

    const result = await pickQuestions({ categoryKey: "成语::g1::近义辨析", count: 2, random: () => 0 });
    expect(result.questions).toHaveLength(2);
    expect(result.available).toBe(3);
    expect(result.insufficient).toBe(false);
    expect(new Set(result.questions.map((q) => q.id)).size).toBe(2);
    expect(result.questions.every((q) => q.categoryKey === "成语::g1::近义辨析")).toBe(true);
  });

  it("categoryKey 为 null 时跨分类抽题，同样不重复", async () => {
    const list = Array.from({ length: 6 }, (_, i) => makeQuestion(`x${i}`));
    await seed(list);

    const result = await pickQuestions({ count: 5, random: seqRandom([0.1, 0.9, 0.5]) });
    expect(result.questions).toHaveLength(5);
    expect(new Set(result.questions.map((q) => q.id)).size).toBe(5);
    expect(result.insufficient).toBe(false);
  });

  it("题量不足：返回实际可用量并标记 insufficient", async () => {
    await seed([makeQuestion("c1", { categoryKey: "成语::g1::近义辨析" })]);
    const result = await pickQuestions({ categoryKey: "成语::g1::近义辨析", count: 10, random: () => 0 });

    expect(result.questions).toHaveLength(1);
    expect(result.requested).toBe(10);
    expect(result.available).toBe(1);
    expect(result.insufficient).toBe(true);
    expect(insufficientHint(result)).toBe(
      "该分类当前可用题目仅 1 道，少于所选 10 道，本次按 1 道进行。",
    );
  });

  it("该分类无可用题：返回空数组，提示文案为 null（页面走无题分支）", async () => {
    await seed([makeQuestion("d1", { categoryKey: "实词::g2::易混" })]);
    const result = await pickQuestions({ categoryKey: "成语::g1::近义辨析", count: 10 });

    expect(result.questions).toEqual([]);
    expect(result.available).toBe(0);
    expect(result.insufficient).toBe(true);
    expect(insufficientHint(result)).toBeNull();
  });

  it("count 非法（0 / 负数 / 小数 / NaN）时不抽题，且不报错", async () => {
    await seed([makeQuestion("e1"), makeQuestion("e2")]);
    for (const count of [0, -3, 1.5, Number.NaN]) {
      const result = await pickQuestions({ count });
      expect(result.questions).toEqual([]);
      expect(result.requested).toBe(count);
    }
  });

  it("抽题不修改题库：题目总保持不变", async () => {
    await seed([makeQuestion("f1"), makeQuestion("f2")]);
    await pickQuestions({ count: 2 });
    expect((await getAllQuestions()).length).toBe(2);
    expect((await getQuestion("f1"))?.reviewStatus).toBe("approved");
  });

  it("shuffleItems 不改原数组，且元素守恒", () => {
    const src = [1, 2, 3, 4, 5];
    const out = shuffleItems(src, seqRandom([0.3, 0.7]));
    expect(src).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

/* ================= 4. 会话创建与提交 ================= */

describe("会话创建", () => {
  it("创建 synonym 会话并持久化，初始计数为 0", async () => {
    const session = await startQuizSession(["q1", "q2", "q3"], { startedAt: NOW });
    expect(session.mode).toBe("synonym");
    expect(session.questionIds).toEqual(["q1", "q2", "q3"]);
    expect(session.answeredCount).toBe(0);
    expect(session.correctCount).toBe(0);
    expect(session.finishedAt).toBeUndefined();
    expect(session.startedAt).toBe(NOW);

    const stored = await getSession(session.trainingId);
    expect(stored).toEqual(session);
  });

  it("题号重复时去重：同一题不会在一场训练中出现两次", async () => {
    const session = await startQuizSession(["q1", "q1", "q2"]);
    expect(session.questionIds).toEqual(["q1", "q2"]);
  });

  it("空题量拒绝创建会话（不写库）", async () => {
    await expect(startQuizSession([])).rejects.toBeInstanceOf(QuizServiceError);
    const db = await getDB();
    expect(await db.count("training_sessions")).toBe(0);
  });

  it("路径工具稳定", () => {
    expect(quizStudyPath("t1")).toBe("/quiz/study/t1");
    expect(quizResultPath("t1")).toBe("/quiz/result/t1");
  });
});

describe("提交答案", () => {
  it("答对：写入记录、会话计数同步 +1", async () => {
    const q = makeQuestion("s1");
    await seed([q]);
    const session = await startQuizSession([q.id], { startedAt: NOW });

    const res = await submitQuizAnswer(session.trainingId, q, "A", {
      submittedAt: NOW + 5000,
      durationMs: 5000,
    });
    expect(res.status).toBe("accepted");
    expect(res.isCorrect).toBe(true);

    const records = await getRecordsByTraining(session.trainingId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      trainingId: session.trainingId,
      questionId: q.id,
      mode: "synonym",
      userAnswer: "A",
      isCorrect: true,
      durationMs: 5000,
      categoryKey: "辨析::成语::近义辨析",
    });

    const stored = await getSession(session.trainingId);
    expect(stored).toMatchObject({ answeredCount: 1, correctCount: 1 });
  });

  it("答错：记录 isCorrect=false，会话正确数不增加", async () => {
    const q = makeQuestion("s2");
    await seed([q]);
    const session = await startQuizSession([q.id]);

    const res = await submitQuizAnswer(session.trainingId, q, "B");
    expect(res.isCorrect).toBe(false);
    const stored = await getSession(session.trainingId);
    expect(stored).toMatchObject({ answeredCount: 1, correctCount: 0 });
  });

  it("重复提交同一题：返回 already-submitted，不写第二条、不重复计数", async () => {
    const q = makeQuestion("s3");
    await seed([q]);
    const session = await startQuizSession([q.id]);

    const first = await submitQuizAnswer(session.trainingId, q, "A");
    const second = await submitQuizAnswer(session.trainingId, q, "B");

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("already-submitted");
    // 以首次记录为准，不被第二次的 B 覆盖
    expect(second.isCorrect).toBe(true);
    expect((await getRecordsByTraining(session.trainingId)).length).toBe(1);
    expect(await getSession(session.trainingId)).toMatchObject({
      answeredCount: 1,
      correctCount: 1,
    });
  });

  it("并发提交同一题：只接受一次，计数不重复累加", async () => {
    const q = makeQuestion("s4");
    await seed([q]);
    const session = await startQuizSession([q.id]);

    const results = await Promise.all([
      submitQuizAnswer(session.trainingId, q, "A"),
      submitQuizAnswer(session.trainingId, q, "B"),
      submitQuizAnswer(session.trainingId, q, "C"),
    ]);
    expect(results.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect((await getRecordsByTraining(session.trainingId)).length).toBe(1);
    expect(await getSession(session.trainingId)).toMatchObject({ answeredCount: 1 });
  });

  it("会话不存在时拒绝提交，且不产生记录", async () => {
    const q = makeQuestion("s5");
    await expect(submitQuizAnswer("not-exist", q, "A")).rejects.toBeInstanceOf(QuizServiceError);
    const db = await getDB();
    expect(await db.count("training_records")).toBe(0);
  });

  it("题目不属于本会话时拒绝提交（防止串题）", async () => {
    const inSession = makeQuestion("in");
    const outsider = makeQuestion("out");
    await seed([inSession, outsider]);
    const session = await startQuizSession([inSession.id]);

    await expect(
      submitQuizAnswer(session.trainingId, outsider, "A"),
    ).rejects.toBeInstanceOf(QuizServiceError);
    expect((await getRecordsByTraining(session.trainingId)).length).toBe(0);
  });

  it("非法选项 ID 拒绝提交（不静默记为错误答案）", async () => {
    const q = makeQuestion("s6");
    await seed([q]);
    const session = await startQuizSession([q.id]);
    await expect(submitQuizAnswer(session.trainingId, q, "Z")).rejects.toBeInstanceOf(
      QuizServiceError,
    );
    expect((await getRecordsByTraining(session.trainingId)).length).toBe(0);
    expect(await getSession(session.trainingId)).toMatchObject({ answeredCount: 0 });
  });

  it("已完成会话拒绝提交，数据不被篡改", async () => {
    const q1 = makeQuestion("f-1");
    const q2 = makeQuestion("f-2");
    await seed([q1, q2]);
    const session = await startQuizSession([q1.id, q2.id]);
    await submitQuizAnswer(session.trainingId, q1, "A");
    await submitQuizAnswer(session.trainingId, q2, "A");
    const finished = await finishQuizSession(session.trainingId, NOW + 60_000);

    // 已完成：同一题、新题都不得再提交
    await expect(submitQuizAnswer(session.trainingId, q1, "B")).rejects.toBeInstanceOf(
      QuizServiceError,
    );
    expect((await getRecordsByTraining(session.trainingId)).length).toBe(2);
    expect(await getSession(session.trainingId)).toEqual(finished);
  });

  it("judgeQuizAnswer 严格按选项 ID 判定", () => {
    const q = makeQuestion("j1", { correctOptionId: "C" });
    expect(judgeQuizAnswer(q, "C")).toBe(true);
    expect(judgeQuizAnswer(q, "A")).toBe(false);
    expect(() => judgeQuizAnswer(q, "D")).toThrow(QuizServiceError);
  });

  it("记录分类键：辨析::section::subcategory", () => {
    expect(recordCategoryKey("成语::g1::近义辨析")).toBe("辨析::成语::近义辨析");
    expect(recordCategoryKey("真题::g1::近义辨析")).toBe("辨析::真题::近义辨析");
  });
});

/* ================= 5. 结束会话与结果 ================= */

describe("结束会话", () => {
  it("未答完不得结束", async () => {
    const q1 = makeQuestion("u1");
    const q2 = makeQuestion("u2");
    await seed([q1, q2]);
    const session = await startQuizSession([q1.id, q2.id]);
    await submitQuizAnswer(session.trainingId, q1, "A");

    await expect(finishQuizSession(session.trainingId)).rejects.toBeInstanceOf(QuizServiceError);
    expect((await getSession(session.trainingId))?.finishedAt).toBeUndefined();
  });

  it("全部答完后结束，写入 finishedAt；重复结束幂等不覆盖", async () => {
    const q = makeQuestion("u3");
    await seed([q]);
    const session = await startQuizSession([q.id], { startedAt: NOW });
    await submitQuizAnswer(session.trainingId, q, "A");

    const finished = await finishQuizSession(session.trainingId, NOW + 30_000);
    expect(finished.finishedAt).toBe(NOW + 30_000);

    const again = await finishQuizSession(session.trainingId, NOW + 99_000);
    expect(again.finishedAt).toBe(NOW + 30_000);
  });

  it("会话不存在时结束抛错", async () => {
    await expect(finishQuizSession("nope")).rejects.toBeInstanceOf(QuizServiceError);
  });
});

describe("训练结果", () => {
  it("未完成会话可恢复：已答题计分，未答题计未答但不计错误", async () => {
    const q1 = makeQuestion("r1");
    const q2 = makeQuestion("r2");
    const q3 = makeQuestion("r3");
    await seed([q1, q2, q3]);
    const session = await startQuizSession([q1.id, q2.id, q3.id], { startedAt: NOW });
    await submitQuizAnswer(session.trainingId, q1, "A", { durationMs: 3000 });
    await submitQuizAnswer(session.trainingId, q2, "B", { durationMs: 5000 });

    const result = await getQuizSessionResult(session.trainingId);
    expect(result).not.toBeNull();
    expect(result!.finished).toBe(false);
    // 顺序严格等于 questionIds
    expect(result!.items.map((it) => it.question.id)).toEqual([q1.id, q2.id, q3.id]);
    expect(result!.total).toBe(3);
    expect(result!.answeredCount).toBe(2);
    expect(result!.correctCount).toBe(1);
    expect(result!.wrongCount).toBe(1);
    expect(result!.unansweredCount).toBe(1);
    // 正确率分母只用已答
    expect(result!.accuracy).toBe(50);
    expect(result!.totalDurationMs).toBe(8000);
    // 未结束无总耗时（不用当前时间估算）
    expect(result!.sessionDurationMs).toBeNull();
  });

  it("完成会话：正确率、总耗时按 finishedAt - startedAt", async () => {
    const q1 = makeQuestion("r4");
    const q2 = makeQuestion("r5");
    await seed([q1, q2]);
    const session = await startQuizSession([q1.id, q2.id], { startedAt: NOW });
    await submitQuizAnswer(session.trainingId, q1, "A", { durationMs: 4000 });
    await submitQuizAnswer(session.trainingId, q2, "A", { durationMs: 6000 });
    await finishQuizSession(session.trainingId, NOW + 20_000);

    const result = await getQuizSessionResult(session.trainingId);
    expect(result!.finished).toBe(true);
    expect(result!.accuracy).toBe(100);
    expect(result!.totalDurationMs).toBe(10_000);
    expect(result!.sessionDurationMs).toBe(20_000);
  });

  it("会话不存在返回 null", async () => {
    await expect(getQuizSessionResult("no-such-session")).resolves.toBeNull();
  });

  it("题目被删除时抛错并指明题号，不返回残缺结果", async () => {
    const q = makeQuestion("r6");
    await seed([q]);
    const session = await startQuizSession([q.id]);
    await submitQuizAnswer(session.trainingId, q, "A");

    const db = await getDB();
    await db.delete("quiz_questions", q.id);

    await expect(getQuizSessionResult(session.trainingId)).rejects.toBeInstanceOf(
      QuizServiceError,
    );
  });

  it("记录与会话计数一致：3 题全答后 answeredCount / correctCount 与记录一致", async () => {
    const qs = [makeQuestion("c-1"), makeQuestion("c-2"), makeQuestion("c-3")];
    await seed(qs);
    const session = await startQuizSession(qs.map((q) => q.id));
    await submitQuizAnswer(session.trainingId, qs[0], "A"); // 对
    await submitQuizAnswer(session.trainingId, qs[1], "B"); // 错
    await submitQuizAnswer(session.trainingId, qs[2], "A"); // 对

    const stored = await getSession(session.trainingId);
    const records = await getRecordsByTraining(session.trainingId);
    expect(stored!.answeredCount).toBe(records.length);
    expect(stored!.correctCount).toBe(records.filter((r) => r.isCorrect).length);
  });

  it("正确率与时长格式化口径", () => {
    expect(computeAccuracy(0, 0)).toBe(0);
    expect(computeAccuracy(1, 3)).toBe(33);
    expect(computeAccuracy(2, 3)).toBe(67);
    expect(computeAccuracy(3, 3)).toBe(100);
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("1 秒内");
    expect(formatDuration(400)).toBe("1 秒内");
    expect(formatDuration(45_000)).toBe("45 秒");
    expect(formatDuration(60_000)).toBe("1 分");
    expect(formatDuration(95_000)).toBe("1 分 35 秒");
  });
});

/* ================= 6. 数据隔离 ================= */

describe("数据隔离", () => {
  it("训练不改动题目本身（reviewStatus / 内容 / updatedAt 均不变）", async () => {
    const q = makeQuestion("iso-1");
    await seed([q]);
    const session = await startQuizSession([q.id]);
    await submitQuizAnswer(session.trainingId, q, "B");

    expect(await getQuestion(q.id)).toEqual(q);
  });

  it("训练不触碰 words / progress / logs", async () => {
    const q = makeQuestion("iso-2");
    await seed([q]);
    // 预置一条学习数据，确认训练前后不变
    const db = await getDB();
    await db.put("words", {
      id: "w-keep",
      term: "保持",
      definition: "保持原样",
      section: "实词",
      groupId: 1,
      groupTitle: "组",
      subcategory: "近义辨析",
      source: "测试",
      sourcePage: 1,
      createdAt: NOW,
    });
    await db.put("progress", {
      wordId: "w-keep",
      state: 2,
      due: NOW,
      stability: 1,
      difficulty: 5,
      reps: 0,
      lapses: 0,
      learningSteps: 0,
      updatedAt: NOW,
    });
    await db.put("logs", {
      wordId: "w-keep",
      grade: 3,
      reviewedAt: NOW,
      wasNew: false,
      stateAfter: 2,
      scheduledDays: 1,
    });

    const before = {
      words: await db.count("words"),
      progress: await db.count("progress"),
      logs: await db.count("logs"),
    };

    const session = await startQuizSession([q.id]);
    await submitQuizAnswer(session.trainingId, q, "A");
    await finishQuizSession(session.trainingId);

    expect(await db.count("words")).toBe(before.words);
    expect(await db.count("progress")).toBe(before.progress);
    expect(await db.count("logs")).toBe(before.logs);
    expect((await db.get("words", "w-keep"))?.term).toBe("保持");
    // 训练只写入 records 与 sessions
    expect(await db.count("training_records")).toBe(1);
    expect(await db.count("training_sessions")).toBe(1);
  });

  it("辨析训练与真题训练会话互不干扰（mode 与分类键各自独立）", async () => {
    const q = makeQuestion("iso-3");
    await seed([q]);
    // 造一个 exam 会话（模拟真题训练已产生的数据）
    const examSession: TrainingSession = {
      trainingId: "exam-session-1",
      mode: "exam",
      questionIds: ["eq-1"],
      startedAt: NOW,
      answeredCount: 0,
      correctCount: 0,
    };
    await putSession(examSession);
    await addTrainingRecordAndUpdateSession(
      {
        trainingId: "exam-session-1",
        questionId: "eq-1",
        mode: "exam",
        userAnswer: "A",
        isCorrect: false,
        answeredAt: NOW,
        durationMs: 1000,
        categoryKey: "真题::成语",
      },
      "exam-session-1",
    );

    const quizSession = await startQuizSession([q.id]);
    await submitQuizAnswer(quizSession.trainingId, q, "A");

    // 真题会话数据原样保留
    expect(await getSession("exam-session-1")).toMatchObject({
      answeredCount: 1,
      correctCount: 0,
    });
    const examRecords = await getRecordsByTraining("exam-session-1");
    expect(examRecords).toHaveLength(1);
    expect(examRecords[0].isCorrect).toBe(false);
    // 辨析会话独立计分
    expect(await getSession(quizSession.trainingId)).toMatchObject({
      answeredCount: 1,
      correctCount: 1,
    });
  });

  it("DB_VERSION 与六表结构未变", async () => {
    const db = await getDB();
    expect(db.version).toBe(3);
    expect([...db.objectStoreNames].sort()).toEqual(
      ["logs", "progress", "quiz_questions", "training_records", "training_sessions", "words"].sort(),
    );
  });
});

/* ================= 7. 展示辅助（不编造解析） ================= */

describe("展示辅助", () => {
  it("题干直接使用题目自带 stem，不改写", () => {
    const q = makeQuestion("d-1");
    expect(stemText(q)).toBe(q.stem);
  });

  it("选项按原顺序输出并带字母", () => {
    const q = makeQuestion("d-2");
    const lines = optionLines(q);
    expect(lines.map((l) => l.id)).toEqual(["A", "B", "C"]);
    expect(lines.map((l) => l.label)).toEqual(["A", "B", "C"]);
    expect(lines[0].content).toBe("词语A-d-2");
  });

  it("正确答案文本取选项内容", () => {
    expect(correctOptionText(makeQuestion("d-3", { correctOptionId: "B" }))).toBe("词语B-d-3");
  });

  it("解析取题目已有 explanation；为空时显示「暂无解析」且不编造", () => {
    expect(explanationText(makeQuestion("d-4"))).toBe("正确答案为「词语A-d-4」。教材原文释义：第 d-4 题释义");
    expect(explanationText(makeQuestion("d-5", { explanation: "" }))).toBe(NO_EXPLANATION_TEXT);
    expect(explanationText(makeQuestion("d-6", { explanation: "   " }))).toBe(NO_EXPLANATION_TEXT);
    expect(NO_EXPLANATION_TEXT).toBe("暂无解析");
  });

  it("选项解释取已有 option.explain，缺失返回 null", () => {
    const q = makeQuestion("d-7");
    expect(optionExplainText("A", q)).toBe("正确。词语A-d-7的释义");
    expect(optionExplainText("Z", q)).toBeNull();
    const bare: QuizQuestion = {
      ...q,
      options: q.options.map((o) => ({ ...o, explain: "  " })),
    };
    expect(optionExplainText("A", bare)).toBeNull();
  });
});
