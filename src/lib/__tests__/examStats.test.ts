/**
 * 真题结果页统计纯函数测试（3d-a）
 *
 * 覆盖方案 9.2 的 A / B / C 三组共 18 条：
 * - A 组（7 条）：正确率与总览口径
 * - B 组（4 条）：篇章统计（固定两篇、空篇补 0、合计等于总览）
 * - C 组（7 条）：耗时双口径与边界
 *
 * 全部为纯函数真实数值断言，不触碰 IndexedDB / 页面 / 服务层写接口。
 * 构造器只负责把「题目 + 作答情形」拼成 ExamSessionResultItem[]，其中
 * C1 / C3 另起一组真实 startExamSession → finishExamSession 端到端校验。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  accuracy,
  computeDurationStats,
  computeOverview,
  computeSectionStats,
  durationOf,
  formatDuration,
} from "@/lib/examStats";
import {
  getExamSessionResult,
  finishExamSession,
  startExamSession,
  submitExamAnswer,
  resetExamCacheForTest,
} from "@/lib/examService";
import { resetDBForTest } from "@/db/database";
import examJson from "../../../data/exam_questions.json";
import type { ExamQuestion, ExamSection } from "@/types/exam";
import type { TrainingRecord } from "@/types/quiz";
import type { ExamSessionResultItem } from "@/lib/examService";

const questions = examJson as ExamQuestion[];

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  resetExamCacheForTest();
  // getExamSessionResult 通过 fetch 加载题目；Node 环境无法解析相对 URL，stub 正式数据
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(questions), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

/** 按篇章取题（保持 JSON 原始顺序） */
function questionsOf(section: ExamSection, count: number): ExamQuestion[] {
  return questions.filter((q) => q.section === section).slice(0, count);
}

/** 造一条已答记录（durationMs 可指定） */
function recordOf(
  question: ExamQuestion,
  isCorrect: boolean,
  durationMs = 10_000,
): TrainingRecord {
  return {
    trainingId: "t-test",
    questionId: question.id,
    mode: "exam",
    userAnswer: isCorrect ? question.answer : "A",
    isCorrect,
    answeredAt: 1_700_000_000_000,
    durationMs,
    categoryKey: `真题::${question.section}`,
  };
}

/** 已答 / 未答 / 对错混合构造：correct / wrong / unanswered 三个数量 */
function buildItems(
  correct: number,
  wrong: number,
  unanswered: number,
  opts: { section?: ExamSection; durationMs?: number } = {},
): ExamSessionResultItem[] {
  const section = opts.section ?? "成语";
  const pool = questionsOf(section, correct + wrong + unanswered);
  expect(pool.length).toBe(correct + wrong + unanswered);
  const items: ExamSessionResultItem[] = [];
  let i = 0;
  for (let n = 0; n < correct; n += 1) {
    const q = pool[i++];
    items.push({ question: q, record: recordOf(q, true, opts.durationMs) });
  }
  for (let n = 0; n < wrong; n += 1) {
    const q = pool[i++];
    items.push({ question: q, record: recordOf(q, false, opts.durationMs) });
  }
  for (let n = 0; n < unanswered; n += 1) {
    items.push({ question: pool[i++], record: null });
  }
  return items;
}

/* ============================== A 组：统计口径 ============================== */

describe("A 组 · 正确率与总览（纯函数）", () => {
  it("A1 全部答对 20 题：total=20, answered=20, correct=20, wrong=0, unanswered=0, accuracy=100", () => {
    const overview = computeOverview(buildItems(20, 0, 0));
    expect(overview.total).toBe(20);
    expect(overview.answered).toBe(20);
    expect(overview.correct).toBe(20);
    expect(overview.wrong).toBe(0);
    expect(overview.unanswered).toBe(0);
    expect(overview.accuracy).toBe(100);
  });

  it("A2 10 对 5 错 5 未答：accuracy === 67（10/15=66.67，函数内四舍五入）", () => {
    const overview = computeOverview(buildItems(10, 5, 5));
    expect(overview.correct).toBe(10);
    expect(overview.wrong).toBe(5);
    expect(overview.unanswered).toBe(5);
    expect(overview.answered).toBe(15);
    expect(overview.accuracy).toBe(67);
    // 取整发生在纯函数内部：返回值本身即整数
    expect(Number.isInteger(overview.accuracy)).toBe(true);
  });

  it("A3 已答 0 题：accuracy === 0 且 Number.isFinite 为 true", () => {
    const value = accuracy(0, 0);
    expect(value).toBe(0);
    expect(Number.isFinite(value)).toBe(true);
    expect(Number.isNaN(value)).toBe(false);
  });

  it("A4 0 题会话（全部未答）：accuracy === 0 且不抛错", () => {
    expect(() => computeOverview([])).not.toThrow();
    const overview = computeOverview([]);
    expect(overview).toEqual({
      total: 0,
      answered: 0,
      correct: 0,
      wrong: 0,
      unanswered: 0,
      accuracy: 0,
    });
    // 全部未答（有题但一条记录都没有）
    const allUnanswered = computeOverview(buildItems(0, 0, 3));
    expect(allUnanswered.answered).toBe(0);
    expect(allUnanswered.accuracy).toBe(0);
  });

  it("A5 未答不计入分母：2 题中 1 对 1 未答 → accuracy === 100", () => {
    const overview = computeOverview(buildItems(1, 0, 1));
    expect(overview.total).toBe(2);
    expect(overview.answered).toBe(1);
    expect(overview.accuracy).toBe(100);
  });

  it("A6 未答不计入错误：wrong === 0、unanswered === 1", () => {
    const overview = computeOverview(buildItems(1, 0, 1));
    expect(overview.wrong).toBe(0);
    expect(overview.unanswered).toBe(1);
  });

  it("A7 与服务返回的 correctCount / answeredCount 一致", async () => {
    const picked = questionsOf("成语", 4);
    const session = await startExamSession(picked.map((q) => q.id), {
      startedAt: 1_700_000_000_000,
    });
    const result = await getExamSessionResult(session.trainingId);
    expect(result).not.toBeNull();
    const local = computeOverview(result!.items);
    expect(local.answered).toBe(result!.answeredCount);
    expect(local.correct).toBe(result!.correctCount);
    expect(local.wrong).toBe(result!.wrongCount);
    expect(local.unanswered).toBe(result!.unansweredCount);
    expect(local.total).toBe(result!.items.length);
  });
});

/* ============================== B 组：篇章统计 ============================== */

describe("B 组 · 篇章统计", () => {
  it("B1 成语 15 + 实词 5，混合对错未答：两篇各自指标独立正确", () => {
    const phrase = buildItems(5, 4, 6, { section: "成语" }); // 15 题：5 对 4 错 6 未答
    const content = buildItems(3, 1, 1, { section: "实词" }); // 5 题：3 对 1 错 1 未答
    const stats = computeSectionStats([...phrase, ...content]);

    expect(stats).toHaveLength(2);
    const [cz, sc] = stats;
    expect(cz.section).toBe("成语");
    expect(cz).toEqual({
      section: "成语",
      total: 15,
      answered: 9,
      correct: 5,
      wrong: 4,
      unanswered: 6,
      accuracy: 56, // 5/9 = 55.56 → 56
    });
    expect(sc.section).toBe("实词");
    expect(sc).toEqual({
      section: "实词",
      total: 5,
      answered: 4,
      correct: 3,
      wrong: 1,
      unanswered: 1,
      accuracy: 75, // 3/4 = 75
    });
    // 固定顺序：成语在前、实词在后
    expect(stats.map((s) => s.section)).toEqual(["成语", "实词"]);
  });

  it("B2 全为成语（实词 0 题）：实词条目存在且全 0，accuracy === 0，无 NaN/Infinity", () => {
    const stats = computeSectionStats(buildItems(4, 2, 2, { section: "成语" }));
    const content = stats.find((s) => s.section === "实词")!;
    expect(content).toBeDefined();
    expect(content).toEqual({
      section: "实词",
      total: 0,
      answered: 0,
      correct: 0,
      wrong: 0,
      unanswered: 0,
      accuracy: 0,
    });
    expect(Number.isNaN(content.accuracy)).toBe(false);
    expect(Number.isFinite(content.accuracy)).toBe(true);
    expect(content.accuracy).not.toBe(Number.POSITIVE_INFINITY);
  });

  it("B3 两篇都为 0（空会话）：两条均全 0，String(accuracy) === \"0\"", () => {
    const stats = computeSectionStats([]);
    expect(stats).toHaveLength(2);
    for (const stat of stats) {
      expect(stat.total).toBe(0);
      expect(stat.answered).toBe(0);
      expect(stat.correct).toBe(0);
      expect(stat.wrong).toBe(0);
      expect(stat.unanswered).toBe(0);
      expect(String(stat.accuracy)).toBe("0");
    }
    expect(stats.map((s) => s.section)).toEqual(["成语", "实词"]);
  });

  it("B4 篇章合计 === 总览：两篇各项相加等于总计", () => {
    const items = [...buildItems(5, 4, 6, { section: "成语" }), ...buildItems(3, 1, 1, { section: "实词" })];
    const stats = computeSectionStats(items);
    const total = computeOverview(items);
    const sum = (key: "total" | "answered" | "correct" | "wrong" | "unanswered") =>
      stats.reduce((acc, s) => acc + s[key], 0);
    expect(sum("total")).toBe(total.total);
    expect(sum("answered")).toBe(total.answered);
    expect(sum("correct")).toBe(total.correct);
    expect(sum("wrong")).toBe(total.wrong);
    expect(sum("unanswered")).toBe(total.unanswered);
    // 总计正确率独立计算，不等于两篇正确率之和（口径不同，属预期）
    expect(total.accuracy).toBe(62); // 8/13 = 61.54 → 62
  });
});

/* ============================== C 组：耗时 ============================== */

describe("C 组 · 耗时双口径", () => {
  it("C1 已完成：totalMs 精确等于 finishedAt - startedAt（真实会话端到端）", async () => {
    const picked = questionsOf("成语", 2);
    const startedAt = 1_700_000_000_000;
    const finishedAt = startedAt + 125_000;
    const session = await startExamSession(picked.map((q) => q.id), { startedAt });
    for (const q of picked) {
      await submitExamAnswer(
        session.trainingId,
        q,
        q.answer,
        { submittedAt: startedAt + 1_000, durationMs: 5_000 },
      );
    }
    await finishExamSession(session.trainingId, finishedAt);

    const result = await getExamSessionResult(session.trainingId);
    const stats = computeDurationStats(result!.session, result!.items);
    expect(stats.totalMs).toBe(125_000);
    expect(stats.totalMs).toBe(result!.session.finishedAt! - result!.session.startedAt);
  });

  it("C2 未完成（无 finishedAt）：totalMs === null，不用当前时间估算", () => {
    const items = buildItems(2, 0, 0);
    const stats = computeDurationStats({ startedAt: 1_700_000_000_000 }, items);
    expect(stats.totalMs).toBeNull();
    // 与 Date.now() 无关：多次调用结果恒为 null
    expect(computeDurationStats({ startedAt: 1 }, items).totalMs).toBeNull();
  });

  it("C3 finishedAt < startedAt（时钟回拨）：totalMs 夹到 0", () => {
    const items = buildItems(1, 0, 0);
    const stats = computeDurationStats(
      { startedAt: 1_700_000_010_000, finishedAt: 1_700_000_000_000 },
      items,
    );
    expect(stats.totalMs).toBe(0);
    expect(formatDuration(stats.totalMs)).toBe("0 秒");
  });

  it("C4 有效答题耗时合计只累加已答：未答题不计入", () => {
    const items = buildItems(2, 1, 3, { durationMs: 7_000 });
    const stats = computeDurationStats({ startedAt: 0, finishedAt: 100_000 }, items);
    expect(stats.activeMs).toBe(21_000); // 3 题已答 × 7 秒
    // 未答 3 题在 perQuestion 中为 null，且不影响 activeMs
    expect(stats.perQuestion.filter((p) => p.ms === null)).toHaveLength(3);
  });

  it("C5 每题耗时：未答为 null（UI 占位「—」）", () => {
    const items = buildItems(1, 0, 2, { durationMs: 5_000 });
    const stats = computeDurationStats({ startedAt: 0 }, items);
    const [first, second, third] = stats.perQuestion;
    expect(first.ms).toBe(5_000);
    expect(second.ms).toBeNull();
    expect(third.ms).toBeNull();
    expect(formatDuration(second.ms)).toBe("—");
    // 顺序与 items 一致
    expect(stats.perQuestion.map((p) => p.questionId)).toEqual(items.map((i) => i.question.id));
    expect(durationOf(stats, items[0].question.id)).toBe(5_000);
    expect(durationOf(stats, items[1].question.id)).toBeNull();
    expect(durationOf(stats, "not-exist")).toBeNull();
  });

  it("C6 durationMs 畸形（负数 / NaN / 非数字）：归 0，不抛错", () => {
    const pool = questionsOf("成语", 4);
    const badValues = [-5_000, Number.NaN, "oops", Number.POSITIVE_INFINITY];
    const items: ExamSessionResultItem[] = pool.map((q, i) => ({
      question: q,
      record: { ...recordOf(q, true), durationMs: badValues[i] as unknown as number },
    }));
    let stats!: ReturnType<typeof computeDurationStats>;
    expect(() => {
      stats = computeDurationStats({ startedAt: 0 }, items);
    }).not.toThrow();
    expect(stats.perQuestion.map((p) => p.ms)).toEqual([0, 0, 0, 0]);
    expect(stats.activeMs).toBe(0);
    expect(Number.isFinite(stats.activeMs)).toBe(true);
  });

  it("C7 两种口径并列且不等：totalMs 与 activeMs 独立计算、语义不同", () => {
    const items = buildItems(3, 0, 2, { durationMs: 10_000 });
    // 60 秒总耗时，已答合计 30 秒 → 差值 30 秒为间隙
    const stats = computeDurationStats(
      { startedAt: 1_700_000_000_000, finishedAt: 1_700_000_060_000 },
      items,
    );
    expect(stats.totalMs).toBe(60_000);
    expect(stats.activeMs).toBe(30_000);
    expect(stats.totalMs).not.toBe(stats.activeMs);
    // 二者同时存在，且 totalMs 不由 activeMs 推导
    const noRecords = computeDurationStats(
      { startedAt: 0, finishedAt: 60_000 },
      buildItems(0, 0, 3),
    );
    expect(noRecords.totalMs).toBe(60_000);
    expect(noRecords.activeMs).toBe(0);
  });
});
