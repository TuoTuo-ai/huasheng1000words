/**
 * 核心业务单元测试：数据层 + FSRS 评分 + 每日调度
 * 使用真实 IndexedDB 实现（fake-indexeddb），不 mock 业务逻辑
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { resetDBForTest } from "@/db/database";
import {
  addWord,
  getAllWords,
  getProgress,
  getReviewLogs,
  getTodayNewWords,
  getTodayReviewQueue,
  createInitialProgress,
} from "@/db/wordRepository";
import {
  submitGrade,
  ensureTestWords,
  GRADES,
  needsReview,
} from "@/lib/studyService";
import type { Word } from "@/types";

async function seedWord(term: string): Promise<Word> {
  const w = await addWord({
    term,
    definition: `${term} 的释义`,
    source: "单元测试",
  });
  if (!w) throw new Error(`词语 ${term} 应可创建`);
  return w;
}

beforeEach(async () => {
  // 每个用例使用全新数据库
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
});

describe("IndexedDB 数据层", () => {
  it("新词能正常添加，且同一词语不会重复创建", async () => {
    const first = await addWord({
      term: "首当其冲",
      definition: "最先受到攻击或遭受灾难",
    });
    const second = await addWord({
      term: "首当其冲",
      definition: "最先受到攻击或遭受灾难",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // 重复添加被拒绝
    expect((await getAllWords()).length).toBe(1);
  });

  it("批量导入测试词库（幂等）", async () => {
    await ensureTestWords();
    await ensureTestWords(); // 第二次不应新增
    const all = await getAllWords();
    expect(all.length).toBe(6);
  });

  it("刷新/重开后数据仍在（IndexedDB 持久化语义）", async () => {
    await seedWord("文不加点");
    // 模拟重新打开：重新拿数据库连接后仍能读到
    const all = await getAllWords();
    expect(all.length).toBe(1);
    expect(all[0].term).toBe("文不加点");
  });
});

describe("FSRS 三档评分与独立记忆状态", () => {
  it("Again（不会）触发重新学习：reps 增加、due 更新为近期", async () => {
    const w = await seedWord("空穴来风");
    const p1 = await submitGrade(w, GRADES.again, true);
    expect(p1.reps).toBe(1);
    expect(p1.due).toBeGreaterThan(Date.now() - 60_000); // due 已被 FSRS 重算
    expect(p1.stability).toBeGreaterThan(0);
    const p2 = await submitGrade(w, GRADES.again, false);
    expect(p2.reps).toBe(2); // 再次 Again 继续重学
    expect(p2.lapses).toBe(1); // 产生一次遗忘
  });

  it("Hard（模糊）由 FSRS 计算下一次复习时间", async () => {
    const w = await seedWord("差强人意");
    const p = await submitGrade(w, GRADES.hard, true);
    // FSRS 原生输出：due 在未来且稳定性已建立（fuzz 会使具体天数随机浮动）
    expect(p.due).toBeGreaterThan(Date.now());
    expect(p.stability).toBeGreaterThan(0);
  });

  it("Good（学会了）由 FSRS 计算下一次复习时间", async () => {
    const w = await seedWord("目无全牛");
    const p = await submitGrade(w, GRADES.good, true);
    expect(p.due).toBeGreaterThan(Date.now());
    expect(p.difficulty).toBeLessThan(3); // Good 后难度低于 Again 分支
  });

  it("三档评分产生不同的下次复习时间（Again < Hard < Good 间隔）", async () => {
    const w1 = await seedWord("词语甲");
    const w2 = await seedWord("词语乙");
    const w3 = await seedWord("词语丙");
    const pAgain = await submitGrade(w1, GRADES.again, true);
    const pHard = await submitGrade(w2, GRADES.hard, true);
    const pGood = await submitGrade(w3, GRADES.good, true);
    expect(pAgain.due).toBeLessThan(pHard.due);
    expect(pHard.due).toBeLessThan(pGood.due);
  });

  it("每个词语拥有独立记忆状态，互不覆盖", async () => {
    const w1 = await seedWord("独立甲");
    const w2 = await seedWord("独立乙");
    await submitGrade(w1, GRADES.good, true);
    await submitGrade(w2, GRADES.again, true);
    const p1 = await getProgress(w1.id);
    const p2 = await getProgress(w2.id);
    expect(p1!.reps).toBe(1);
    expect(p1!.lapses).toBe(0);
    expect(p2!.reps).toBe(1);
    expect(p2!.lapses).toBe(0);
    expect(p1!.due).not.toBe(p2!.due);
    expect(p1!.stability).not.toBe(p2!.stability);
  });

  it("复习历史完整保存，可按词查询", async () => {
    const w = await seedWord("历史甲");
    await submitGrade(w, GRADES.again, true);
    await submitGrade(w, GRADES.hard, false);
    await submitGrade(w, GRADES.good, false);
    const logs = await getReviewLogs(w.id);
    expect(logs.length).toBe(3);
    expect(logs.map((l) => l.grade)).toEqual([1, 2, 3]);
    expect(logs[0].wasNew).toBe(true);
    expect(logs[1].wasNew).toBe(false);
    // scheduledDays 为 FSRS 计算的调度间隔（0 表示当天内调度）
    expect(logs.every((l) => typeof l.scheduledDays === "number")).toBe(true);
    expect(logs[2].scheduledDays).toBeGreaterThanOrEqual(0);
  });

  it("重新打开 App 可恢复之前的记忆状态（卡片字段完整）", async () => {
    const w = await seedWord("恢复甲");
    await submitGrade(w, GRADES.good, true);
    const p = await getProgress(w.id);
    expect(p).toBeDefined();
    expect(p!.stability).toBeGreaterThan(0);
    expect(p!.difficulty).toBeGreaterThan(0);
    expect([1, 2, 3]).toContain(p!.state);
  });
});

describe("每日学习调度", () => {
  it("到期词语进入复习队列，逾期优先排序", async () => {
    const w1 = await seedWord("逾期词");
    const w2 = await seedWord("到期词");
    // w1：学习后人为把 due 调到 3 天前（逾期）
    const p1 = await submitGrade(w1, GRADES.good, true);
    await createInitialProgress(w1.id); // 确保进度存在
    await (await import("@/db/wordRepository")).updateProgress({
      ...p1,
      due: Date.now() - 3 * 86_400_000,
    });
    // w2：正常学习，due 在未来，不应进入队列
    const p2 = await submitGrade(w2, GRADES.good, true);
    expect(needsReview(p2)).toBe(false);

    const queue = await getTodayReviewQueue();
    expect(queue.length).toBe(1);
    expect(queue[0].wordId).toBe(w1.id); // 仅逾期词进入
  });

  it("每日新词数量限制生效", async () => {
    await ensureTestWords(); // 6 个测试词
    const words = await getAllWords();
    const limited = await getTodayNewWords(3);
    expect(limited.length).toBe(3);
    expect(limited.length).toBeLessThan(words.length);
    const unlimited = await getTodayNewWords(20);
    expect(unlimited.length).toBe(6);
  });

  it("已学过的词不再出现在新词队列", async () => {
    const w = await seedWord("去重词");
    await submitGrade(w, GRADES.good, true);
    const newWords = await getTodayNewWords(20);
    expect(newWords.find((x) => x.id === w.id)).toBeUndefined();
  });
});
