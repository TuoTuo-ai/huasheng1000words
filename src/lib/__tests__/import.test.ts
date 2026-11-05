/**
 * 正式词库导入测试（按产品验收口径修正）
 * 前置：空库先调用真实 ensureTestWords() 建立 6 个测试词，再导入正式词库
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import rawRecordsJson from "../../../data/vocabulary_final.json";
import { resetDBForTest } from "@/db/database";
import {
  getAllWords,
  getProgress,
  getReviewLogs,
} from "@/db/wordRepository";
import { submitGrade, ensureTestWords, GRADES } from "@/lib/studyService";
import {
  importVocabulary,
  dedupeRecords,
  type RawVocabRecord,
} from "@/lib/importService";

const rawRecords = rawRecordsJson as RawVocabRecord[];
/** 6 个与正式词库重叠的测试词 */
const OVERLAP_TERMS = [
  "不刊之论",
  "首当其冲",
  "差强人意",
  "文不加点",
  "空穴来风",
  "目无全牛",
];

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
});

describe("数据解析与去重", () => {
  it("993 条原始记录去重后为 990 个唯一词语", () => {
    const terms = rawRecords.map((r) => r.term);
    expect(terms.length).toBe(993);
    expect(new Set(terms).size).toBe(990);
  });

  it("重复词合并全部分类来源", () => {
    const merged = dedupeRecords(rawRecords);
    const dup = merged.find((m) => m.content.term === "不绝如缕");
    expect(dup!.entries.length).toBe(2);
    expect(dup!.entries.map((e) => e.volume)).toEqual(["上册", "下册"]);
  });
});

describe("完整导入（空库 + 6 测试词前置）", () => {
  let stats: Awaited<ReturnType<typeof importVocabulary>>;
  let before: {
    progress: unknown;
    logs: unknown;
    ids: Map<string, { id: string; createdAt: number }>;
  };

  beforeEach(async () => {
    // 真实初始化：完整 6 个测试词
    await ensureTestWords();
    const seeded = await getAllWords();
    expect(seeded.length).toBe(6);
    // 其中一个词产生真实学习记录
    const target = seeded.find((w) => w.term === "首当其冲")!;
    await submitGrade(target, GRADES.good, true);

    before = {
      progress: await getProgress(target.id),
      logs: await getReviewLogs(target.id),
      ids: new Map(
        (await getAllWords()).map((w) => [w.term, { id: w.id, createdAt: w.createdAt }]),
      ),
    };

    stats = await importVocabulary(rawRecords);
  });

  it("新增 984、更新 6、跳过 3、失败 0，最终 990 词", async () => {
    expect(stats.added).toBe(984);
    expect(stats.updated).toBe(6);
    expect(stats.skipped).toBe(3);
    expect(stats.failed).toBe(0);
    expect(stats.failures).toEqual([]);
    expect((await getAllWords()).length).toBe(990); // 6 测试词被吸收，不重复
  });

  it("6 个重叠词逐一验证：匹配成功、内容更新、id/createdAt 保留", async () => {
    const all = await getAllWords();
    for (const term of OVERLAP_TERMS) {
      const words = all.filter((w) => w.term === term);
      expect(words.length).toBe(1); // 不产生重复 Word
      const w = words[0];
      const orig = before.ids.get(term)!;
      expect(w.id).toBe(orig.id); // 原有 ID 保留
      expect(w.createdAt).toBe(orig.createdAt); // createdAt 保留
      // 正式词库字段已更新
      expect(w.section).toBe("成语篇");
      expect(w.groupId).toBeGreaterThan(0);
      expect(w.groupTitle).toBeTruthy();
      expect(w.examples!.length).toBeGreaterThan(0);
      expect(w.example).toBe(w.examples![0]);
      expect(w.categoryEntries!.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("6 个重叠词的正式释义为 PDF 原文", async () => {
    const all = await getAllWords();
    const w = all.find((x) => x.term === "首当其冲")!;
    expect(w.definition).toBe(
      "首：指头部或最前面。当：有承受之意。冲：指要冲或冲击的意思。比喻首先承受冲击、攻击或灾难， 常用于形容在某种事件或情况下最先受到影响的人或事物。",
    );
    // 已不是旧测试释义
    expect(w.definition).not.toBe("最先受到攻击或遭受灾难，并非「首先冲在前面」。");
  });

  it("原有学习记录逐字段保留（progress 与 logs）", async () => {
    const all = await getAllWords();
    const target = all.find((w) => w.term === "首当其冲")!;
    expect(await getProgress(target.id)).toEqual(before.progress);
    expect(await getReviewLogs(target.id)).toEqual(before.logs);
  });
});

describe("导入后的幂等与数据安全", () => {
  it("导入后再次调用 ensureTestWords：不再插入测试词", async () => {
    await ensureTestWords();
    const stats = await importVocabulary(rawRecords);
    const count1 = (await getAllWords()).length;
    await ensureTestWords();
    expect((await getAllWords()).length).toBe(count1); // 仍 990
    expect(stats.added).toBe(984);
  }, 60_000);

  it("再次导入正式词库：不产生重复词，全部走更新", async () => {
    await importVocabulary(rawRecords);
    const stats = await importVocabulary(rawRecords);
    expect(stats.added).toBe(0);
    expect(stats.updated).toBe(990);
    expect((await getAllWords()).length).toBe(990);
  }, 60_000);

  it("单条非法数据不影响其他合法数据导入", async () => {
    await ensureTestWords();
    const bad: RawVocabRecord[] = [
      { term: "", volume: "上册", section: "成语篇", group_id: 1, group_title: "x", definition: "x", examples: [], source: "x" } as RawVocabRecord,
      { ...rawRecords[0], examples: "不是数组" as unknown as string[] },
    ];
    const stats = await importVocabulary(bad);
    expect(stats.failed).toBe(2);
    expect(stats.failures.length).toBe(2);
    // 非法记录未写入，合法部分不受影响（仅 6 个测试词存在）
    const all = await getAllWords();
    expect(all.length).toBe(6);
  });
});
