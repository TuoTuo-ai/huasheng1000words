/**
 * 统计模块单元测试：使用真实 IndexedDB + 明确构造的测试数据
 * 覆盖：空数据、去重、复习计数、今日学习、7 天趋势、跨午夜本地日期、
 * 连续天数、状态分布、总数守恒、缺 progress 容错
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { resetDBForTest } from "@/db/database";
import {
  addWord,
  saveReviewLog,
  updateProgress,
  createInitialProgress,
  getAllWords,
} from "@/db/wordRepository";
import {
  getStudyStatistics,
  getTrend7Days,
  getStateDistribution,
  calcStreak,
  localDateKey,
  startOfLocalDay,
} from "@/lib/statsService";
import type { WordProgress } from "@/types";

/** 直接写入一条日志（绕过 submitGrade，便于精确构造时间） */
async function log(
  wordId: string,
  wasNew: boolean,
  reviewedAt: number,
): Promise<void> {
  await saveReviewLog({
    wordId,
    grade: 3,
    reviewedAt,
    wasNew,
    stateAfter: 2,
    scheduledDays: 2,
  });
}

/** 构造进度 */
async function progress(
  wordId: string,
  state: 0 | 1 | 2 | 3,
  dueOffsetMs = 86_400_000,
): Promise<void> {
  const p: WordProgress = {
    wordId,
    state,
    due: Date.now() + dueOffsetMs,
    stability: 2,
    difficulty: 5,
    reps: 3,
    lapses: 0,
    learningSteps: 0,
    updatedAt: Date.now(),
  };
  await updateProgress(p);
}

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
});

describe("统计模块", () => {
  it("空数据：所有指标为 0，不报错", async () => {
    const s = await getStudyStatistics();
    expect(s).toEqual({
      totalLearnedWords: 0,
      totalReviewCount: 0,
      masteredWords: 0,
      totalWords: 0,
      todayLearnedWords: 0,
      streakDays: 0,
    });
    const dist = await getStateDistribution();
    expect(dist).toEqual({ newCount: 0, learning: 0, reviewing: 0, relearning: 0 });
    const trend = await getTrend7Days();
    expect(trend.length).toBe(7);
    expect(trend.every((d) => d.newCount === 0 && d.reviewCount === 0)).toBe(true);
  });

  it("累计学习词数按 wordId 去重，复习次数不含首次学习", async () => {
    const w = await addWord({ term: "去重词", definition: "x" });
    if (!w) throw new Error("创建失败");
    const now = Date.now();
    // 同一词学习 1 次 + 复习 4 次
    await log(w.id, true, now - 86_400_000);
    await log(w.id, false, now - 43_200_000);
    await log(w.id, false, now - 10_800_000);
    await log(w.id, false, now - 3_600_000);
    await log(w.id, false, now);
    const s = await getStudyStatistics();
    expect(s.totalLearnedWords).toBe(1); // 去重
    expect(s.totalReviewCount).toBe(4); // 不含首次
  });

  it("今日学习数量：只统计今天，且按词去重", async () => {
    const w1 = await addWord({ term: "今词一", definition: "x" });
    const w2 = await addWord({ term: "今词二", definition: "x" });
    const w3 = await addWord({ term: "昨词", definition: "x" });
    if (!w1 || !w2 || !w3) throw new Error("创建失败");
    const now = Date.now();
    await log(w1.id, true, now - 1_000);
    await log(w1.id, false, now); // 同一词今天复习，不重复计数
    await log(w2.id, true, now - 2_000);
    await log(w3.id, true, now - 86_400_000 - 3_600_000); // 昨天
    const s = await getStudyStatistics();
    expect(s.todayLearnedWords).toBe(2);
  });

  it("最近 7 天趋势：含今天共 7 天，无记录的天为 0，归类正确", async () => {
    const w = await addWord({ term: "趋势词", definition: "x" });
    if (!w) throw new Error("创建失败");
    const now = Date.now();
    await log(w.id, true, now); // 今天：新学 1
    await log(w.id, false, now); // 今天：复习 1
    await log(w.id, true, now - 7 * 86_400_000); // 7 天前（不在窗口内）
    const trend = await getTrend7Days();
    expect(trend.length).toBe(7);
    expect(trend[6].label).toBe("今天");
    expect(trend[6].newCount).toBe(1);
    expect(trend[6].reviewCount).toBe(1);
    expect(trend[0].newCount).toBe(0); // 7 天前的记录不在窗口
  });

  it("本地日期边界：昨晚 23 点与今晨 0 点分属两天", async () => {
    const w = await addWord({ term: "边界词", definition: "x" });
    if (!w) throw new Error("创建失败");
    const todayStart = startOfLocalDay();
    await log(w.id, true, todayStart - 60 * 60 * 1000); // 昨晚 23 点
    await log(w.id, true, todayStart + 60 * 1000); // 今天 0 点 01 分
    const s = await getStudyStatistics();
    expect(s.todayLearnedWords).toBe(1); // 今天只有 1 条
    const trend = await getTrend7Days();
    expect(trend[5].newCount).toBe(1); // 昨天 1
    expect(trend[6].newCount).toBe(1); // 今天 1
  });

  it("连续学习天数：连续 3 天且今天已学 → 3", () => {
    const d = new Date();
    const set = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const t = new Date(d);
      t.setDate(t.getDate() - i);
      set.add(localDateKey(t));
    }
    expect(calcStreak(set)).toBe(3);
  });

  it("连续学习天数：今天未学但从昨天连续 → 不断签", () => {
    const d = new Date();
    const set = new Set<string>();
    for (let i = 1; i <= 4; i++) {
      const t = new Date(d);
      t.setDate(t.getDate() - i);
      set.add(localDateKey(t));
    }
    expect(calcStreak(set)).toBe(4);
  });

  it("连续学习天数：中断即归零，从今天开始计", () => {
    const d = new Date();
    const set = new Set<string>();
    set.add(localDateKey(d)); // 今天有
    const t = new Date(d);
    t.setDate(t.getDate() - 2); // 前天有，昨天断
    set.add(localDateKey(t));
    expect(calcStreak(set)).toBe(1);
  });

  it("四种记忆状态分布正确，且总和等于词库总数", async () => {
    // 4 词：新词(无progress)、学习中、复习中、重学中
    const w1 = await addWord({ term: "状态新词", definition: "x" });
    const w2 = await addWord({ term: "状态学习", definition: "x" });
    const w3 = await addWord({ term: "状态复习", definition: "x" });
    const w4 = await addWord({ term: "状态重学", definition: "x" });
    if (!w1 || !w2 || !w3 || !w4) throw new Error("创建失败");
    await progress(w2.id, 1);
    await progress(w3.id, 2);
    await progress(w4.id, 3);
    const dist = await getStateDistribution();
    expect(dist).toEqual({ newCount: 1, learning: 1, reviewing: 1, relearning: 1 });
    const words = await getAllWords();
    expect(dist.newCount + dist.learning + dist.reviewing + dist.relearning).toBe(
      words.length,
    );
  });

  it("缺少 progress 的词归入新词，不崩溃；所有 state=2 的词均计入已掌握", async () => {
    const w1 = await addWord({ term: "无进度词", definition: "x" });
    const w2 = await addWord({ term: "掌握词", definition: "x" });
    const w3 = await addWord({ term: "到期词", definition: "x" });
    if (!w1 || !w2 || !w3) throw new Error("创建失败");
    await progress(w2.id, 2, 86_400_000); // 复习中，明天到期 → 已掌握
    await progress(w3.id, 2, -3_600_000); // 复习中，已逾期 → 仍计入已掌握
    const s = await getStudyStatistics();
    expect(s.masteredWords).toBe(2); // 到期与否不改变卡片状态
    const dist = await getStateDistribution();
    expect(dist.reviewing).toBe(2);
    expect(dist.newCount).toBe(1); // w1 无进度，安全归类
    const words = await getAllWords();
    expect(dist.newCount + dist.learning + dist.reviewing + dist.relearning).toBe(
      words.length,
    );
  });

  it("累计学习词数只统计 wasNew=true 的词（异常数据容错）", async () => {
    const w1 = await addWord({ term: "正常首学", definition: "x" });
    const w2 = await addWord({ term: "仅有复习", definition: "x" });
    if (!w1 || !w2) throw new Error("创建失败");
    const now = Date.now();
    await log(w1.id, true, now);
    // 构造异常数据：w2 只有复习日志、从未有首次学习记录
    await log(w2.id, false, now);
    const s = await getStudyStatistics();
    expect(s.totalLearnedWords).toBe(1); // 仅 w1 计入
    expect(s.totalReviewCount).toBe(1); // 复习次数只统计 wasNew=false
  });

  it("真实学习流 + 初始进度混合场景统计守恒", async () => {
    const w1 = await addWord({ term: "混合一", definition: "x" });
    const w2 = await addWord({ term: "混合二", definition: "x" });
    if (!w1 || !w2) throw new Error("创建失败");
    await createInitialProgress(w2.id); // 有初始进度但从未评分 → 仍算新词
    await log(w1.id, true, Date.now());
    const dist = await getStateDistribution();
    const words = await getAllWords();
    expect(dist.newCount + dist.learning + dist.reviewing + dist.relearning).toBe(
      words.length,
    );
    expect(dist.newCount).toBe(2);
  });
});
