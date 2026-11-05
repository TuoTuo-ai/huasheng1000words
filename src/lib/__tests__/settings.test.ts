/**
 * 设置页单元测试：每日新词数、目标保持率、持久化、FSRS 参数生效、数据安全
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { resetDBForTest } from "@/db/database";
import { loadSettings, saveSettings } from "@/lib/settings";
import { resetScheduler, newCard, reviewCard, GRADES } from "@/lib/fsrs";
import { addWord, getProgress, getReviewLogs } from "@/db/wordRepository";
import { submitGrade } from "@/lib/studyService";

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  resetScheduler(); // 恢复默认参数
});

describe("学习设置", () => {
  it("每日新词数量修改后立即保存并读取一致", () => {
    const s = loadSettings();
    expect(s.dailyNewCount).toBe(20); // 默认值
    saveSettings({ ...s, dailyNewCount: 35 });
    expect(loadSettings().dailyNewCount).toBe(35);
  });

  it("目标保持率 80%/85%/90% 三档切换", () => {
    for (const r of [0.8, 0.85, 0.9]) {
      saveSettings({ ...loadSettings(), requestRetention: r });
      expect(loadSettings().requestRetention).toBe(r);
    }
  });

  it("模拟刷新页面：设置从持久层重新加载仍然保留", () => {
    saveSettings({ dailyNewCount: 60, requestRetention: 0.85 });
    // 新的读取（等效刷新后重新 loadSettings）
    const s = loadSettings();
    expect(s.dailyNewCount).toBe(60);
    expect(s.requestRetention).toBe(0.85);
  });

  it("非法设置值被回退为默认值，不产生异常状态", () => {
    localStorage.setItem(
      "yanyu-1000:settings",
      JSON.stringify({ dailyNewCount: -5, requestRetention: 3 }),
    );
    const s = loadSettings();
    expect(s.dailyNewCount).toBe(20);
    expect(s.requestRetention).toBe(0.9);
  });

  it("修改保持率后 FSRS 使用新参数（90% 间隔 > 80% 间隔）", () => {
    // 90%（默认）下新卡 Good 的下次复习时间
    const cardA = newCard();
    const due90 = reviewCard(cardA, GRADES.good).card.due.getTime();

    // 切到 80% 并重建调度器
    saveSettings({ ...loadSettings(), requestRetention: 0.8 });
    resetScheduler();
    const due80 = reviewCard(newCard(), GRADES.good).card.due.getTime();

    // 保持率越低，容忍的遗忘越多，FSRS 给出的间隔越长（算法正确行为）
    expect(due80).toBeGreaterThan(due90);

    // 恢复 90%
    saveSettings({ ...loadSettings(), requestRetention: 0.9 });
    resetScheduler();
  });

  it("修改设置不影响历史学习记录与进度（数据安全）", async () => {
    const w = await addWord({
      term: "设置安全词",
      definition: "测试设置变更不影响记录",
    });
    if (!w) throw new Error("词语应创建成功");
    const before = await submitGrade(w, GRADES.good, true);
    const logsBefore = await getReviewLogs(w.id);

    saveSettings({ dailyNewCount: 100, requestRetention: 0.8 });
    resetScheduler();

    const after = await getProgress(w.id);
    const logsAfter = await getReviewLogs(w.id);
    expect(after).toEqual(before); // 进度逐字段一致
    expect(logsAfter).toEqual(logsBefore); // 历史记录不变
    expect(logsAfter.length).toBe(1);
  });
});
