/**
 * 词库功能测试：列表、搜索、分类筛选、详情
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { resetDBForTest } from "@/db/database";
import { addWord } from "@/db/wordRepository";
import {
  getWordbook,
  filterEntries,
  getWordDetail,
  categoryOf,
} from "@/lib/wordbookService";
import { submitGrade, GRADES } from "@/lib/studyService";
import { updateProgress } from "@/db/wordRepository";
import type { WordProgress } from "@/types";

async function progress(
  wordId: string,
  state: 1 | 2 | 3,
): Promise<void> {
  const p: WordProgress = {
    wordId,
    state,
    due: Date.now() + 86_400_000,
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

/** 构造固定词库 */
async function seed(): Promise<void> {
  await addWord({ term: "首当其冲", definition: "最先受到攻击或遭受灾难" });
  await addWord({ term: "差强人意", definition: "大体上还能使人满意" });
  await addWord({ term: "不刊之论", definition: "不可改动的精确言论" });
  await addWord({ term: "文不加点", definition: "写文章一气呵成" });
}

describe("词库数据读取", () => {
  it("读取真实词库与统计", async () => {
    await seed();
    const { entries, stats } = await getWordbook();
    expect(entries.length).toBe(4);
    expect(stats).toEqual({ total: 4, learned: 0, unlearned: 4 });
  });

  it("学习后统计变化（已学/未学正确）", async () => {
    await seed();
    const { entries, stats: before } = await getWordbook();
    expect(before.learned).toBe(0);
    const w = entries.find((e) => e.word.term === "首当其冲")!.word;
    await submitGrade(w, GRADES.good, true);
    const { stats } = await getWordbook();
    expect(stats.learned).toBe(1);
    expect(stats.unlearned).toBe(3);
  });
});

describe("搜索", () => {
  it("按词语名称搜索", async () => {
    await seed();
    const { entries } = await getWordbook();
    const hit = filterEntries(entries, "首当其冲", "all");
    expect(hit.length).toBe(1);
    expect(hit[0].word.term).toBe("首当其冲");
  });

  it("按释义关键词搜索", async () => {
    await seed();
    const { entries } = await getWordbook();
    const hit = filterEntries(entries, "满意", "all");
    expect(hit.length).toBe(1);
    expect(hit[0].word.term).toBe("差强人意");
  });

  it("搜索无结果返回空数组", async () => {
    await seed();
    const { entries } = await getWordbook();
    expect(filterEntries(entries, "不存在的词汇", "all").length).toBe(0);
  });

  it("清空搜索（空串）返回全部", async () => {
    await seed();
    const { entries } = await getWordbook();
    expect(filterEntries(entries, "", "all").length).toBe(4);
    expect(filterEntries(entries, "   ", "all").length).toBe(4);
  });
});

describe("分类筛选", () => {
  it("全部/新词/学习中/复习中/重学中 五种筛选正确", async () => {
    await seed();
    let { entries } = await getWordbook();
    const byTerm = (t: string) => entries.find((e) => e.word.term === t)!.word;
    // 按名称设置三种状态：学习中、复习中、重学中；「文不加点」保持新词
    await progress(byTerm("首当其冲").id, 1);
    await progress(byTerm("差强人意").id, 2);
    await progress(byTerm("不刊之论").id, 3);
    // 重新读取最新进度后再筛选
    ({ entries } = await getWordbook());

    expect(filterEntries(entries, "", "all").length).toBe(4);
    const news = filterEntries(entries, "", "new");
    expect(news.length).toBe(1);
    expect(news[0].word.term).toBe("文不加点"); // 无 progress → 新词
    expect(filterEntries(entries, "", "learning").length).toBe(1);
    expect(filterEntries(entries, "", "reviewing").length).toBe(1);
    expect(filterEntries(entries, "", "relearning").length).toBe(1);
  });

  it("每个词只归入一个分类（含缺 progress 容错）", () => {
    expect(categoryOf(undefined)).toBe("new");
    expect(categoryOf({ state: 0 } as never)).toBe("new");
    expect(categoryOf({ state: 1 } as never)).toBe("learning");
    expect(categoryOf({ state: 2 } as never)).toBe("reviewing");
    expect(categoryOf({ state: 3 } as never)).toBe("relearning");
  });
});

describe("词语详情", () => {
  it("正确读取对应词语与学习/复习统计", async () => {
    await seed();
    const { entries } = await getWordbook();
    const w = entries.find((e) => e.word.term === "不刊之论")!.word;
    await submitGrade(w, GRADES.good, true); // 首次学习
    await submitGrade(w, GRADES.again, false); // 复习
    await submitGrade(w, GRADES.good, false); // 复习

    const d = await getWordDetail(w.id);
    expect(d).not.toBeNull();
    expect(d!.word.term).toBe("不刊之论");
    expect(d!.totalGrades).toBe(3);
    expect(d!.learnCount).toBe(1); // 学习次数来自 wasNew=true 日志
    expect(d!.reviewCount).toBe(2); // 复习次数来自 wasNew=false 日志，不含首次学习
    expect(d!.lastReviewedAt).toBeDefined();
    expect(d!.logs.length).toBe(3);
  });

  it("未学习词语：详情正常返回，无记录显示空状态", async () => {
    await seed();
    const { entries } = await getWordbook();
    const w = entries.find((e) => e.word.term === "文不加点")!.word;
    const d = await getWordDetail(w.id);
    expect(d).not.toBeNull();
    expect(d!.progress).toBeUndefined();
    expect(d!.logs.length).toBe(0);
    expect(d!.lastReviewedAt).toBeUndefined();
  });

  it("不存在的词语详情返回 null", async () => {
    expect(await getWordDetail("不存在的id")).toBeNull();
  });
});
