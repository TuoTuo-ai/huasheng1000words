/**
 * v1 → v2 数据库迁移测试
 * 核心验证：原有三表数据完整保留；新增三表与索引可用；训练数据与 FSRS 完全隔离
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { getDB, resetDBForTest, DB_VERSION } from "@/db/database";
import { ensureTestWords, submitGrade, GRADES } from "@/lib/studyService";
import { getAllWords, getProgress, getReviewLogs } from "@/db/wordRepository";
import { createBackup } from "@/lib/backupService";
import {
  putQuestion,
  getQuestion,
  getQuestionsByMode,
  getQuestionsByCategory,
  getQuestionsByStatus,
  addTrainingRecord,
  getRecordsByTraining,
  getRecordsByCategory,
  getRecordsByAnsweredAtRange,
  putSession,
  getSession,
} from "@/db/quizRepository";
import type { QuizQuestion, TrainingRecord, TrainingSession } from "@/types/quiz";

/** 构造一条合法题目 */
function makeQuestion(over: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: "q_test_1",
    mode: "synonym",
    wordIds: ["w_a", "w_b"],
    stem: "下列词语中，形容历史悠久、延续不断的是？",
    stemMeta: { sourceType: "original", excerpt: "源远流长" },
    options: [
      { id: "A", content: "源远流长", isCorrect: true, explain: "原文：源头远，水流长", sourceType: "original" },
      { id: "B", content: "博大精深", isCorrect: false, explain: "侧重内容丰富", sourceType: "original" },
    ],
    correctOptionId: "A",
    explanation: "源远流长强调时间久远，博大精深强调内容广博。",
    explanationMeta: { sourceType: "original" },
    relatedWordIds: ["w_b"],
    source: { type: "original", wordIds: ["w_a"], citation: "上册第9页 · 源远流长", sourcePage: 9, sourceField: "definition" },
    aiGenerated: false,
    difficulty: 2,
    tags: ["成语篇", "中华文明传统文化"],
    categoryKey: "成语篇::1::形容中华文化",
    reviewStatus: "approved",
    qualityLevel: "high",
    questionVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  return resetDBForTest();
});

describe("v1 → v2 迁移", () => {
  it("全新安装直接创建 v2（6 个 store）", async () => {
    const db = await getDB();
    expect(db.version).toBe(DB_VERSION);
    const names = Array.from(db.objectStoreNames).sort();
    expect(names).toEqual([
      "logs",
      "progress",
      "quiz_questions",
      "training_records",
      "training_sessions",
      "words",
    ]);
  });

  it("已存在的 v1 数据升级到 v2：原有三表数据完整保留", async () => {
    await resetDBForTest();
    globalThis.indexedDB = new IDBFactory();

    // 1) 手工建一个 v1 库并写入真实数据
    const v1 = await openDB("yanyu-1000", 1, {
      upgrade(db) {
        const words = db.createObjectStore("words", { keyPath: "id" });
        words.createIndex("by-createdAt", "createdAt");
        const progress = db.createObjectStore("progress", { keyPath: "wordId" });
        progress.createIndex("by-due", "due");
        const logs = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
        logs.createIndex("by-wordId", "wordId");
        logs.createIndex("by-reviewedAt", "reviewedAt");
      },
    });
    const w1 = { id: "w_1", term: "源远流长", definition: "源头远，水流长。", createdAt: 1 };
    const w2 = { id: "w_2", term: "博大精深", definition: "内容广博精深。", createdAt: 2 };
    await v1.put("words", w1);
    await v1.put("words", w2);
    await v1.put("progress", {
      wordId: "w_1", state: 2, due: Date.now() + 86400000, stability: 2.5,
      difficulty: 5.1, reps: 3, lapses: 1, learningSteps: 0, updatedAt: 100,
    });
    await v1.add("logs", { wordId: "w_1", grade: 3, reviewedAt: 100, wasNew: true, stateAfter: 2, scheduledDays: 2 });
    await v1.add("logs", { wordId: "w_1", grade: 1, reviewedAt: 200, wasNew: false, stateAfter: 3, scheduledDays: 0 });
    v1.close();

    // 2) 通过应用代码打开（触发 upgrade 到 v2）
    const db = await getDB();
    expect(db.version).toBe(2);
    expect(Array.from(db.objectStoreNames)).toContain("quiz_questions");
    expect(Array.from(db.objectStoreNames)).toContain("training_records");
    expect(Array.from(db.objectStoreNames)).toContain("training_sessions");

    // 3) 原有数据逐条比对
    const words = await db.getAll("words");
    expect(words).toEqual([w1, w2]);
    const p = await db.get("progress", "w_1");
    expect(p!.stability).toBe(2.5);
    expect(p!.reps).toBe(3);
    expect(p!.lapses).toBe(1);
    const logs = await db.getAll("logs");
    expect(logs.length).toBe(2);
    expect(logs.map((l) => l.grade)).toEqual([3, 1]);
    // 原有索引仍可用
    expect((await db.getAllFromIndex("words", "by-createdAt")).length).toBe(2);
    expect((await db.getAllFromIndex("logs", "by-wordId", "w_1")).length).toBe(2);
  });

  it("迁移后再次打开不重复迁移、数据不丢失", async () => {
    await ensureTestWords();
    const before = await getAllWords();
    await resetDBForTest();
    const after = await getAllWords();
    expect(after.length).toBe(before.length);
    expect((await getDB()).version).toBe(2);
  });
});

describe("新增 store 读写与索引", () => {
  it("quiz_questions：主键读写与三个索引", async () => {
    const db = await getDB();
    const names = (db.transaction("quiz_questions").store.indexNames);
    expect(Array.from(names).sort()).toEqual([
      "by-categoryKey",
      "by-mode",
      "by-reviewStatus",
    ]);

    await putQuestion(makeQuestion());
    await putQuestion(makeQuestion({ id: "q_2", mode: "pitfall", reviewStatus: "pending" }));
    await putQuestion(makeQuestion({ id: "q_3", mode: "sentence", categoryKey: "实词篇::1::动作" }));

    expect((await getQuestion("q_test_1"))!.stem).toContain("历史悠久");
    expect((await getQuestionsByMode("pitfall")).length).toBe(1);
    expect((await getQuestionsByCategory("成语篇::1::形容中华文化")).length).toBe(2);
    expect((await getQuestionsByStatus("pending")).length).toBe(1);
  });

  it("training_records：自增主键 + 四个索引", async () => {
    const db = await getDB();
    expect(Array.from(db.transaction("training_records").store.indexNames).sort()).toEqual([
      "by-answeredAt",
      "by-categoryKey",
      "by-questionId",
      "by-trainingId",
    ]);

    const base: Omit<TrainingRecord, "id"> = {
      trainingId: "t1",
      questionId: "q_test_1",
      mode: "synonym",
      userAnswer: "A",
      isCorrect: true,
      answeredAt: 1000,
      durationMs: 3200,
      categoryKey: "成语篇::1::形容中华文化",
    };
    const id1 = await addTrainingRecord(base);
    const id2 = await addTrainingRecord({ ...base, trainingId: "t2", answeredAt: 5000, isCorrect: false });
    expect(typeof id1).toBe("number");
    expect(id2).toBe(id1! + 1); // 自增

    expect((await getRecordsByTraining("t1")).length).toBe(1);
    expect((await getRecordsByCategory("成语篇::1::形容中华文化")).length).toBe(2);
    expect((await getRecordsByAnsweredAtRange(0, 2000)).length).toBe(1);
  });

  it("training_sessions：主键读写", async () => {
    const s: TrainingSession = {
      trainingId: "t1",
      mode: "synonym",
      questionIds: ["q_test_1"],
      startedAt: 1000,
      answeredCount: 1,
      correctCount: 1,
    };
    await putSession(s);
    expect((await getSession("t1"))!.correctCount).toBe(1);
  });
});

describe("训练数据与 FSRS 完全隔离", () => {
  it("写入训练数据不改变 words / progress / logs / FSRS 字段", async () => {
    await ensureTestWords();
    const words = await getAllWords();
    await submitGrade(words[0], GRADES.good, true);
    const pBefore = await getProgress(words[0].id);
    const lBefore = await getReviewLogs(words[0].id);
    const backupBefore = await createBackup();

    await putQuestion(makeQuestion());
    await addTrainingRecord({
      trainingId: "t1", questionId: "q_test_1", mode: "synonym",
      userAnswer: "B", isCorrect: false, answeredAt: Date.now(),
      durationMs: 1500, categoryKey: "成语篇::1::形容中华文化",
    });
    await putSession({
      trainingId: "t1", mode: "synonym", questionIds: ["q_test_1"],
      startedAt: Date.now(), answeredCount: 1, correctCount: 0,
    });

    expect(await getProgress(words[0].id)).toEqual(pBefore);
    expect(await getReviewLogs(words[0].id)).toEqual(lBefore);
    const backupAfter = await createBackup();
    expect(backupAfter.data.words).toEqual(backupBefore.data.words);
    expect(backupAfter.data.progress).toEqual(backupBefore.data.progress);
    expect(backupAfter.data.logs).toEqual(backupBefore.data.logs);
    expect(backupAfter.settings).toEqual(backupBefore.settings);
  });

  it("原有学习流程（每日新词 / 复习队列）不受影响", async () => {
    const { getTodayNewWords, getTodayReviewQueue } = await import("@/db/wordRepository");
    await ensureTestWords();
    const newBefore = await getTodayNewWords(20);
    await putQuestion(makeQuestion());
    await addTrainingRecord({
      trainingId: "t1", questionId: "q_test_1", mode: "synonym",
      userAnswer: "A", isCorrect: true, answeredAt: Date.now(),
      durationMs: 800, categoryKey: "成语篇::1::形容中华文化",
    });
    expect((await getTodayNewWords(20)).length).toBe(newBefore.length);
    expect((await getTodayReviewQueue()).length).toBe(0);
  });
});
