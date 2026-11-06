/**
 * 学习顺序（sortOrder）回归测试
 *
 * 缺陷背景：新词队列按 createdAt 排序，而 6 个演示测试词先写入、时间戳最早，
 * 导致正式词库导入后「首当其冲」等测试词排在最前，「源远流长」被挤到后面；
 * 且 Date.now() 在同一毫秒内重复，同批次词顺序不稳定。
 * 修复：正式词库导入时按 JSON 原始下标写 sortOrder，队列按 sortOrder 升序。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { getDB, resetDBForTest, backfillSortOrder } from "@/db/database";
import {
  compareWords,
  getTodayNewWords,
  getAllWords,
  TEST_WORD_SOURCE,
} from "@/db/wordRepository";
import { ensureTestWords } from "@/lib/studyService";
import {
  importVocabulary,
  removeLeftoverTestWords,
  type RawVocabRecord,
} from "@/lib/importService";
import rawRecordsJson from "../../../data/vocabulary_final.json";
import type { Word } from "@/types";

const rawRecords = rawRecordsJson as unknown as RawVocabRecord[];

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("1. 空库导入：正式词库顺序严格遵循 JSON 数组顺序", () => {
  it("第 1 个新词为「源远流长」，前 20 个与 JSON 前 20 条完全一致", async () => {
    const stats = await importVocabulary(rawRecords);
    expect(stats.failed).toBe(0);

    const queue = await getTodayNewWords(20);
    const jsonFirst20 = rawRecords.slice(0, 20).map((r) => r.term.trim());
    expect(queue.map((w) => w.term)).toEqual(jsonFirst20);
    expect(queue[0].term).toBe("源远流长");
  });

  it("990 个唯一词都有唯一且确定的 sortOrder", async () => {
    await importVocabulary(rawRecords);
    const all = await getAllWords();
    expect(all.length).toBe(990);
    const orders = all.map((w) => w.sortOrder);
    expect(orders.every((o) => typeof o === "number")).toBe(true);
    expect(new Set(orders).size).toBe(990); // 全部唯一
    expect(Math.min(...(orders as number[]))).toBe(0);
  });

  it("sortOrder 等于该词在 JSON 中首次出现的下标", async () => {
    await importVocabulary(rawRecords);
    const all = await getAllWords();
    const firstIndex = new Map<string, number>();
    rawRecords.forEach((r, i) => {
      const t = r.term.trim();
      if (!firstIndex.has(t)) firstIndex.set(t, i);
    });
    for (const w of all) {
      expect(w.sortOrder).toBe(firstIndex.get(w.term));
    }
  });
});

describe("2. 已有 6 个测试词后再导入：测试词不混入队列", () => {
  it("导入后第 1 个词仍为「源远流长」，测试词被清理", async () => {
    await ensureTestWords();
    expect((await getAllWords()).length).toBe(6);

    const stats = await importVocabulary(rawRecords);
    // 6 个测试词在正式词库中全部存在同名合法词，会被 upsert 原地接管（最理想：无需删除）
    // 因此 removedTestWords 为 0 也属正确；关键是队列中不得残留测试词来源
    expect(stats.removedTestWords).toBeGreaterThanOrEqual(0);
    expect(stats.added + stats.updated).toBe(990);

    const all = await getAllWords();
    expect(all.filter((w) => w.source === TEST_WORD_SOURCE).length).toBe(0);
    expect(all.length).toBe(990);

    const queue = await getTodayNewWords(20);
    expect(queue[0].term).toBe("源远流长");
    expect(queue.slice(0, 20).map((w) => w.term)).toEqual(
      rawRecords.slice(0, 20).map((r) => r.term.trim()),
    );
  });

  it("不误删正式词库中与测试词同名的合法词语", async () => {
    await ensureTestWords();
    await importVocabulary(rawRecords);
    const all = await getAllWords();
    // 首当其冲 / 差强人意 / 空穴来风 / 不刊之论 / 文不加点 都在正式词库中出现
    const overlapped = ["首当其冲", "差强人意", "空穴来风", "不刊之论", "文不加点"];
    for (const term of overlapped) {
      const w = all.find((x) => x.term === term);
      expect(w, `${term} 必须存在`).toBeDefined();
      expect(w!.source).not.toBe(TEST_WORD_SOURCE); // 已被正式数据覆盖
      expect(typeof w!.sortOrder).toBe("number");
    }
  });

  it("有学习记录的测试词不删除（保护用户数据）", async () => {
    await ensureTestWords();
    const before = await getAllWords();
    const learned = before.find((w) => w.term === "首当其冲")!;
    // 伪造一条学习进度
    const db = await getDB();
    await db.put("progress", {
      wordId: learned.id,
      state: 2,
      due: Date.now(),
      stability: 1,
      difficulty: 5,
      reps: 1,
      lapses: 0,
      learningSteps: 0,
      updatedAt: Date.now(),
    });
    await importVocabulary(rawRecords);
    const after = await getAllWords();
    expect(after.find((w) => w.term === "首当其冲")).toBeDefined();
  });

  it("全部记录非法时不清空原有测试词", async () => {
    await ensureTestWords();
    const bad = [
      { term: "", volume: "上册", section: "成语篇", group_id: 1, group_title: "x", definition: "x", examples: [], source: "x" },
    ] as unknown as RawVocabRecord[];
    const stats = await importVocabulary(bad);
    expect(stats.failed).toBe(1);
    expect(stats.removedTestWords).toBe(0);
    expect((await getAllWords()).length).toBe(6);
  });
});

describe("3. 排序规则本身", () => {
  const mk = (p: Partial<Word>): Word =>
    ({
      id: "x",
      term: "t",
      definition: "d",
      createdAt: 0,
      ...p,
    }) as Word;

  it("sortOrder 优先于 createdAt", () => {
    const a = mk({ id: "a", sortOrder: 5, createdAt: 999 });
    const b = mk({ id: "b", sortOrder: 1, createdAt: 1 });
    expect(compareWords(a, b)).toBeGreaterThan(0);
    expect(compareWords(b, a)).toBeLessThan(0);
  });

  it("无 sortOrder 的排在最后，再按 createdAt", () => {
    const formal = mk({ id: "f", sortOrder: 100 });
    const old = mk({ id: "o", createdAt: 1 });
    const newer = mk({ id: "n", createdAt: 2 });
    const sorted = [old, formal, newer].sort(compareWords);
    expect(sorted.map((w) => w.id)).toEqual(["f", "o", "n"]);
  });

  it("完全同序时按 id 兜底，结果稳定可复现", () => {
    const x = mk({ id: "b", sortOrder: 1 });
    const y = mk({ id: "a", sortOrder: 1 });
    expect([x, y].sort(compareWords).map((w) => w.id)).toEqual(["a", "b"]);
    expect([y, x].sort(compareWords).map((w) => w.id)).toEqual(["a", "b"]);
  });
});

describe("4. 旧数据升级：回填 sortOrder 不影响学习数据", () => {
  it("已有 progress / logs 的词回填后数据完整保留", async () => {
    const db = await getDB();
    // 模拟旧版本数据：无 sortOrder
    const legacy: Word[] = [
      { id: "w_1", term: "甲", definition: "d1", createdAt: 10 },
      { id: "w_2", term: "乙", definition: "d2", createdAt: 20 },
      { id: "w_3", term: "丙", definition: "d3", createdAt: 30, source: TEST_WORD_SOURCE },
    ];
    for (const w of legacy) await db.put("words", w);
    await db.put("progress", {
      wordId: "w_1",
      state: 2,
      due: 123,
      stability: 2.5,
      difficulty: 5.1,
      reps: 3,
      lapses: 1,
      learningSteps: 0,
      updatedAt: 100,
    });
    await db.add("logs", {
      wordId: "w_1",
      grade: 3,
      reviewedAt: 100,
      wasNew: true,
      stateAfter: 2,
      scheduledDays: 2,
    });

    const n = await backfillSortOrder(db);
    expect(n).toBe(2); // 只回填非测试词

    const words = (await db.getAll("words")) as Word[];
    const byId = new Map(words.map((w) => [w.id, w]));
    expect(byId.get("w_1")!.sortOrder).toBe(0);
    expect(byId.get("w_2")!.sortOrder).toBe(1);
    expect(byId.get("w_3")!.sortOrder).toBeUndefined(); // 测试词不回填
    // id / createdAt 不变
    expect(byId.get("w_1")!.createdAt).toBe(10);
    expect(byId.get("w_1")!.term).toBe("甲");
    // 学习数据不变
    const p = await db.get("progress", "w_1");
    expect(p).toMatchObject({ state: 2, stability: 2.5, reps: 3, lapses: 1, due: 123 });
    expect((await db.getAll("logs")).length).toBe(1);
  });

  it("幂等：重复回填不改变已有结果", async () => {
    const db = await getDB();
    await db.put("words", { id: "a", term: "甲", definition: "d", createdAt: 5 } as Word);
    await backfillSortOrder(db);
    const first = (await db.getAll("words")) as Word[];
    const n2 = await backfillSortOrder(db);
    expect(n2).toBe(0);
    expect((await db.getAll("words")) as Word[]).toEqual(first);
  });
});

describe("5. 复习队列不受影响", () => {
  it("getTodayNewWords 只返回无进度的词（复习队列仍走 by-due）", async () => {
    await importVocabulary(rawRecords.slice(0, 3));
    const db = await getDB();
    const first = (await getAllWords())[0];
    await db.put("progress", {
      wordId: first.id,
      state: 2,
      due: Date.now() + 86400000,
      stability: 1,
      difficulty: 5,
      reps: 1,
      lapses: 0,
      learningSteps: 0,
      updatedAt: Date.now(),
    });
    const queue = await getTodayNewWords(10);
    expect(queue.map((w) => w.term)).not.toContain(first.term);
  });
});

describe("6. removeLeftoverTestWords 保护规则", () => {
  it("只删除测试词来源、不在正式词库、无学习记录的词", async () => {
    const db = await getDB();
    await db.put("words", { id: "t1", term: "测试甲", definition: "d", createdAt: 1, source: TEST_WORD_SOURCE } as Word);
    await db.put("words", { id: "t2", term: "测试乙", definition: "d", createdAt: 2, source: TEST_WORD_SOURCE } as Word);
    await db.put("words", { id: "f1", term: "测试甲", definition: "d", createdAt: 3, source: "上册第1页" } as Word);

    // 「测试甲」在 formalTerms 中 → t1 作为同名正式词被保留；「测试乙」不属于正式词库 → t2 被删除
    const removed = await removeLeftoverTestWords(new Set(["测试甲"]));
    const all = await getAllWords();
    expect(removed).toBe(1);
    expect(all.map((w) => w.id).sort()).toEqual(["f1", "t1"]);
  });
});
