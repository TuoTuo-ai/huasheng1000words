/**
 * 1000 词规模性能与正确性测试
 * 验证：队列正确、逾期优先、新词限额、进度保留、导入去重、无明显性能问题
 */
import { describe, expect, it, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { resetDBForTest } from "@/db/database";
import {
  addWords,
  getAllWords,
  getProgress,
  getTodayNewWords,
  getTodayReviewQueue,
  updateProgress,
} from "@/db/wordRepository";
import { getStudyQueue, submitGrade, GRADES } from "@/lib/studyService";

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
});

/** 构造 1000 个不同词语 */
async function seed1000Words(): Promise<void> {
  const inputs = Array.from({ length: 1000 }, (_, i) => ({
    term: `测试词语${String(i).padStart(4, "0")}`,
    definition: `第 ${i} 个测试词语的释义`,
    source: "千词基准",
  }));
  await addWords(inputs);
}

describe("1000 词规模", () => {
  it("批量导入 1000 词无重复，重复导入全部跳过", async () => {
    await seed1000Words();
    expect((await getAllWords()).length).toBe(1000);
    // 重复导入同样 1000 个词
    const again = await addWords(
      Array.from({ length: 1000 }, (_, i) => ({
        term: `测试词语${String(i).padStart(4, "0")}`,
        definition: "重复版本",
      })),
    );
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1000);
    expect((await getAllWords()).length).toBe(1000);
  });

  it("1000 词规模下队列计算正确、逾期优先、限额生效", async () => {
    await seed1000Words();
    const words = await getAllWords();

    // 前 100 个词标记为已学：其中 0~49 设为逾期，50~99 设为未到期
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      const p = await submitGrade(words[i], GRADES.good, true);
      if (i < 50) {
        await updateProgress({
          ...p,
          due: now - (50 - i) * 3_600_000, // 逾期 50~1 小时不等
        });
      } else {
        await updateProgress({
          ...p,
          // 2~4 天后到期，确保不在「今日」队列范围内
          due: now + (2 * 86400 + (i - 50) * 3600) * 1000,
        });
      }
    }

    const { reviewWords, newWords } = await getStudyQueue();
    const queue = await getTodayReviewQueue();

    // 复习队列：仅 50 个逾期词（未来 due 的不在今日范围内）
    expect(queue.length).toBe(50);
    expect(reviewWords.length).toBe(50);
    // 逾期优先：队列按 due 升序（逾期最久的排最前）
    for (let i = 1; i < queue.length; i++) {
      expect(queue[i].due).toBeGreaterThanOrEqual(queue[i - 1].due);
    }
    expect(queue[0].wordId).toBe(words[0].id); // 逾期最久的是 0 号词

    // 新词限额：上述已用 submitGrade 学了 100 个新词（wasNew=true），
    // 每日限额 20 已耗尽，因此新词队列为空（限额逻辑生效的直接证据）
    expect(newWords.length).toBe(0);
    const learnedIds = new Set(words.slice(0, 100).map((w) => w.id));
    expect(newWords.every((w) => !learnedIds.has(w.id))).toBe(true);

    // 已有学习进度不丢失
    const p0 = await getProgress(words[0].id);
    expect(p0).toBeDefined();
    expect(p0!.reps).toBe(1);
    expect(p0!.lapses).toBe(0);
  }, 60_000);

  it("getTodayNewWords 限额在 1000 词下仍正确", async () => {
    await seed1000Words();
    expect((await getTodayNewWords(20)).length).toBe(20);
    expect((await getTodayNewWords(1001)).length).toBe(1000);
    expect((await getTodayNewWords(0)).length).toBe(0);
  });

  it("性能冒烟：1000 词下 getStudyQueue 应在 2 秒内完成", async () => {
    await seed1000Words();
    const words = await getAllWords();
    // 制造 200 个到期复习词
    for (let i = 0; i < 200; i++) {
      const p = await submitGrade(words[i], GRADES.good, true);
      await updateProgress({ ...p, due: Date.now() - 1_000 });
    }
    const t0 = performance.now();
    await getStudyQueue();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
  }, 60_000);
});
