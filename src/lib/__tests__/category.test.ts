/**
 * 分类学习测试：分类归属、数量、25 个无二级分类词、学习队列与 FSRS 复用
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import rawRecordsJson from "../../../data/vocabulary_final.json";
import { resetDBForTest } from "@/db/database";
import { ensureTestWords } from "@/lib/studyService";
import { importVocabulary, type RawVocabRecord } from "@/lib/importService";
import {
  getCategoryTree,
  NO_SUBCATEGORY,
  groupKey,
  groupLabel,
  parseGroupKey,
} from "@/lib/categoryService";
import {
  getCategoryStudyQueue,
  gradeInCategory,
} from "@/lib/categoryStudyService";
import { getProgress, getReviewLogs } from "@/db/wordRepository";

const raw = rawRecordsJson as RawVocabRecord[];

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  await ensureTestWords();
  await importVocabulary(raw);
});

describe("分类树", () => {
  it("一级分类数量与原始词库一致（67 组），词数合计 990", async () => {
    const tree = await getCategoryTree();
    const rawGroups = new Set(raw.map((r) => `${r.section}::${r.group_id}`));
    expect(tree.length).toBe(rawGroups.size);
    // 分类树按「分类来源」计数：重复词会出现在多个分类下，合计 = 993 条来源
    expect(tree.reduce((s, g) => s + g.total, 0)).toBe(993);
    // 去重后的唯一词语仍是 990
    const unique = new Set(
      tree.flatMap((g) => g.subs).flatMap((s) => s.entries.map((e) => e.word.id)),
    );
    expect(unique.size).toBe(990);
  });

  it("二级分类归属正确，且 26 个无二级分类词全部归入「未设置二级分类」", async () => {
    const tree = await getCategoryTree();
    const noSubWords = raw.filter((r) => !r.subcategory?.trim());
    const uniqueNoSub = new Set(noSubWords.map((r) => r.term));
    expect(uniqueNoSub.size).toBe(26);
    const inTree = tree
      .flatMap((g) => g.subs)
      .filter((s) => s.name === NO_SUBCATEGORY)
      .flatMap((s) => s.entries.map((e) => e.word.term));
    expect(new Set(inTree).size).toBe(26);
    for (const t of uniqueNoSub) expect(inTree).toContain(t);
    // 全部词语来源都被分类覆盖（993 条来源 = 990 词 + 3 个重复词的第二来源）
    const covered = tree.flatMap((g) => g.subs).reduce((s, x) => s + x.entries.length, 0);
    expect(covered).toBe(993);
  });

  it("二级分类名称与原始数据一致（不新增、不改写）", async () => {
    const tree = await getCategoryTree();
    const treeSubs = new Set(
      tree.flatMap((g) => g.subs.map((s) => s.name)).filter((n) => n !== NO_SUBCATEGORY),
    );
    const rawSubs = new Set(
      raw.map((r) => r.subcategory).filter((s): s is string => !!s?.trim()),
    );
    expect(treeSubs.size).toBe(rawSubs.size);
    for (const s of rawSubs) expect(treeSubs.has(s)).toBe(true);
  });

  it("未设置二级分类入口排在同组末尾，groupKey 唯一可复原", async () => {
    const tree = await getCategoryTree();
    for (const g of tree) {
      const idx = g.subs.findIndex((s) => s.name === NO_SUBCATEGORY);
      if (idx >= 0) expect(idx).toBe(g.subs.length - 1);
    }
    // section + groupId 作为唯一键：两篇同号不相等
    expect(groupKey(1, "成语篇")).not.toBe(groupKey(1, "实词篇"));
    // 可完整复原
    expect(parseGroupKey(groupKey(1, "实词篇"))).toEqual({
      section: "实词篇",
      groupId: 1,
    });
    expect(parseGroupKey(groupKey(67, "成语篇"))).toEqual({
      section: "成语篇",
      groupId: 67,
    });
  });

  it("成语篇与实词篇同 groupId 不串组", async () => {
    const tree = await getCategoryTree();
    const idioms = tree.filter((g) => g.section === "成语篇");
    const reals = tree.filter((g) => g.section === "实词篇");
    expect(idioms.length).toBe(67);
    expect(reals.length).toBe(14);
    // groupId=1 在两篇中标题不同、词不同
    const a = idioms.find((g) => g.groupId === 1)!;
    const b = reals.find((g) => g.groupId === 1)!;
    expect(a.groupTitle).toBe("中华文明传统文化");
    expect(b.groupTitle).toBe("“雕刻”和“绘画”");
    expect(a.total).not.toBe(b.total);
    const aTerms = new Set(a.subs.flatMap((s) => s.entries.map((e) => e.word.term)));
    const bTerms = new Set(b.subs.flatMap((s) => s.entries.map((e) => e.word.term)));
    for (const t of bTerms) expect(aTerms.has(t)).toBe(false);
  });

  it("两个章节均完整存在，合计 81 组", async () => {
    const tree = await getCategoryTree();
    const sections = new Map<string, number>();
    for (const g of tree) sections.set(g.section, (sections.get(g.section) ?? 0) + 1);
    expect(sections.get("成语篇")).toBe(67);
    expect(sections.get("实词篇")).toBe(14);
    expect(tree.length).toBe(81);
  });

  it("同名分类可通过组号区分（成语篇 16 组 / 20 组「错误做法」）", async () => {
    const tree = await getCategoryTree();
    const same = tree.filter(
      (g) => g.section === "成语篇" && g.groupTitle === "错误做法",
    );
    expect(same.map((g) => g.groupId)).toEqual([16, 20]);
    const labels = same.map((g) => groupLabel(g));
    expect(labels).toEqual(["16组 · 错误做法", "20组 · 错误做法"]);
    expect(new Set(labels).size).toBe(2); // 展示层可区分
  });

  it("登堂入室同时归属两个来源分类", async () => {
    const tree = await getCategoryTree();
    const hits = tree.flatMap((g) =>
      g.subs
        .filter((s) => s.entries.some((e) => e.word.term === "登堂入室"))
        .map((s) => `${g.section}·${g.groupId}·${g.groupTitle}·${s.name}`),
    );
    expect(hits.length).toBe(2);
    expect(hits.some((h) => h.includes("55") && h.includes("技艺十分精湛"))).toBe(true);
    expect(hits.some((h) => h.includes("67") && h.includes(NO_SUBCATEGORY))).toBe(true);
  });

  it("993 条来源记录完整覆盖且无重复计入同一分类", async () => {
    const tree = await getCategoryTree();
    const total = tree.flatMap((g) => g.subs).reduce((s, x) => s + x.entries.length, 0);
    expect(total).toBe(993);
    // 同一分类内不存在重复词
    for (const g of tree) {
      for (const s of g.subs) {
        const ids = s.entries.map((e) => e.word.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });
});

describe("分类学习", () => {
  it("队列：未学词在前，评分后写入 FSRS 进度与历史", async () => {
    const tree = await getCategoryTree();
    const g = tree.find((x) => x.total > 2)!;
    const sub = g.subs[0];
    const queue = await getCategoryStudyQueue(
      g.groupId,
      g.section,
      sub.name,
      NO_SUBCATEGORY,
    );
    expect(queue.length).toBe(sub.entries.length);
    expect(queue.every((i) => !i.learned)).toBe(true);

    const first = queue[0];
    const r = await gradeInCategory(first.word, 3, true);
    expect(r.state).toBeGreaterThan(0);
    expect(r.due).toBeGreaterThan(Date.now());
    const p = await getProgress(first.word.id);
    expect(p!.reps).toBe(1);
    const logs = await getReviewLogs(first.word.id);
    expect(logs.length).toBe(1);
    expect(logs[0].wasNew).toBe(true);
  }, 30_000);

  it("已学词再次评分：不重复建档，累积为复习记录", async () => {
    const tree = await getCategoryTree();
    const g = tree.find((x) => x.total > 2)!;
    const sub = g.subs[0];
    const queue = await getCategoryStudyQueue(
      g.groupId,
      g.section,
      sub.name,
      NO_SUBCATEGORY,
    );
    const w = queue[0].word;
    await gradeInCategory(w, 3, true);
    await gradeInCategory(w, 2, false);
    const logs = await getReviewLogs(w.id);
    expect(logs.length).toBe(2);
    expect(logs.map((l) => l.wasNew)).toEqual([true, false]);
    // 队列中该词被标记为已学
    const after = await getCategoryStudyQueue(
      g.groupId,
      g.section,
      sub.name,
      NO_SUBCATEGORY,
    );
    expect(after.find((i) => i.word.id === w.id)!.learned).toBe(true);
  }, 30_000);

  it("分类学习不影响每日新词队列与原有学习流程", async () => {
    const { getTodayNewWords } = await import("@/db/wordRepository");
    const before = await getTodayNewWords(1000);
    const tree = await getCategoryTree();
    const g = tree[0];
    const queue = await getCategoryStudyQueue(
      g.groupId,
      g.section,
      g.subs[0].name,
      NO_SUBCATEGORY,
    );
    await gradeInCategory(queue[0].word, 3, true);
    const after = await getTodayNewWords(1000);
    expect(after.length).toBe(before.length - 1); // 仅少掉刚学的那个词
  }, 30_000);
});
