/**
 * 真题组卷设置页面测试（3b）
 * node 环境无 DOM：路由/入口用源码静态断言（与 examService 隔离测试同模式），
 * 组卷逻辑用 ExamPage 导出的纯函数 + 注入 fetchImpl 走真实调用链。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PAPER_OPTIONS,
  extractYears,
  generatePaper,
  sameOptions,
  toExamFilters,
  type PaperOptions,
} from "@/pages/ExamPage";
import { resetExamCacheForTest } from "@/lib/examService";
import { resetDBForTest, getDB, DB_VERSION } from "@/db/database";
import { IDBFactory } from "fake-indexeddb";
import examJson from "../../../data/exam_questions.json";
import type { ExamQuestion } from "@/types/exam";

const questions = examJson as ExamQuestion[];

function okFetch(data: unknown = questions) {
  return vi.fn(async () =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

beforeEach(async () => {
  resetExamCacheForTest();
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("路由与首页入口（静态断言）", () => {
  it("/exam 路由已注册且引入 ExamPage", async () => {
    const appSrc = (await import("@/App.tsx?raw")).default as string;
    expect(appSrc).toContain('path="/exam"');
    expect(appSrc).toContain("ExamPage");
  });

  it("首页包含真题训练入口且不影响原有学习流程", async () => {
    const homeSrc = (await import("@/pages/HomePage.tsx?raw")).default as string;
    expect(homeSrc).toContain('to="/exam"');
    // 原有功能仍在：学习入口与幂等词库初始化
    expect(homeSrc).toContain('to="/study"');
    expect(homeSrc).toContain("ensureTestWords()");
  });

  it("底部导航未被修改（仍为五个入口，不含 exam）", async () => {
    const navSrc = (await import("@/components/BottomNav.tsx?raw")).default as string;
    expect(navSrc).not.toContain("/exam");
  });

  it("ExamPage 只在开始答题时创建会话，不提交/不结束/不写库（3c 更新）", async () => {
    const pageSrc = (await import("@/pages/ExamPage.tsx?raw")).default as string;
    // 3c：允许通过 startExamSession 创建会话，且全文件仅调用 1 次（handleStart）
    expect(pageSrc.split("startExamSession(").length - 1).toBe(1);
    // 组卷页仍不得提交答案、结束会话或直接操作数据层
    for (const banned of [
      "submitExamAnswer",
      "finishExamSession",
      "addTrainingRecord",
      "putSession",
      "quizRepository",
    ]) {
      expect(pageSrc).not.toContain(banned);
    }
    // 会话创建只发生在 handleStart，不得出现在 handleGenerate 中
    const genBody = pageSrc.slice(
      pageSrc.indexOf("async function handleGenerate"),
      pageSrc.indexOf("async function handleStart"),
    );
    expect(genBody).not.toContain("startExamSession");
  });
});

describe("筛选参数映射 toExamFilters", () => {
  it("默认设置为全部（不传任何筛选条件）", () => {
    expect(toExamFilters(DEFAULT_PAPER_OPTIONS)).toEqual({});
  });

  it("篇章筛选参数透传", () => {
    expect(toExamFilters({ ...DEFAULT_PAPER_OPTIONS, section: "成语" })).toEqual({
      section: "成语",
    });
    expect(toExamFilters({ ...DEFAULT_PAPER_OPTIONS, section: "实词" })).toEqual({
      section: "实词",
    });
  });

  it("年份筛选参数透传（number）", () => {
    expect(toExamFilters({ ...DEFAULT_PAPER_OPTIONS, year: 2023 })).toEqual({
      year: 2023,
    });
  });

  it("题型筛选参数透传", () => {
    expect(toExamFilters({ ...DEFAULT_PAPER_OPTIONS, questionType: "单空" })).toEqual({
      questionType: "单空",
    });
    expect(toExamFilters({ ...DEFAULT_PAPER_OPTIONS, questionType: "多空" })).toEqual({
      questionType: "多空",
    });
  });

  it("多条件组合筛选正确", () => {
    const options: PaperOptions = {
      section: "成语",
      year: 2023,
      questionType: "多空",
      count: 10,
    };
    expect(toExamFilters(options)).toEqual({
      section: "成语",
      year: 2023,
      questionType: "多空",
    });
  });
});

describe("年份动态提取 extractYears", () => {
  it("从正式 204 题提取并去重、降序，与数据推导一致", () => {
    const years = extractYears(questions);
    const expected = [...new Set(questions.map((q) => q.year))].sort(
      (a, b) => b - a,
    );
    expect(years).toEqual(expected);
    expect(years.length).toBeGreaterThan(1);
    for (let i = 1; i < years.length; i++) {
      expect(years[i - 1]).toBeGreaterThan(years[i]); // 严格降序
    }
    expect(years.every((y) => Number.isInteger(y))).toBe(true);
    // 覆盖全部题目年份
    expect(new Set(questions.map((q) => q.year))).toEqual(new Set(years));
  });
});

describe("组卷 generatePaper（走 getRandomExamQuestions 真实链路）", () => {
  it("题量与筛选参数透传：实词 20 → 最多 27，全部为实词", async () => {
    const paper = await generatePaper(
      { ...DEFAULT_PAPER_OPTIONS, section: "实词", count: 20 },
      okFetch(),
    );
    expect(paper.length).toBe(20);
    expect(paper.every((q) => q.section === "实词")).toBe(true);
  });

  it("实际题量不足时返回实际数量（实词全量 27）", async () => {
    const paper = await generatePaper(
      { ...DEFAULT_PAPER_OPTIONS, section: "实词", count: 50 },
      okFetch(),
    );
    expect(paper).toHaveLength(27);
  });

  it("多条件组合组卷", async () => {
    const paper = await generatePaper(
      { section: "成语", year: 2023, questionType: "多空", count: 10 },
      okFetch(),
    );
    expect(paper.length).toBeGreaterThan(0);
    expect(paper.length).toBeLessThanOrEqual(10);
    for (const q of paper) {
      expect(q.section).toBe("成语");
      expect(q.year).toBe(2023);
      expect(q.questionType).toBe("多空");
    }
  });

  it("不重复抽题（全部题库抽 50）", async () => {
    const paper = await generatePaper(
      { ...DEFAULT_PAPER_OPTIONS, count: 50 },
      okFetch(),
    );
    expect(paper).toHaveLength(50);
    expect(new Set(paper.map((q) => q.id)).size).toBe(50);
  });

  it("保持原始 A/B/C/D 选项顺序与题干不变", async () => {
    const paper = await generatePaper(
      { ...DEFAULT_PAPER_OPTIONS, count: 50 },
      okFetch(),
    );
    for (const q of paper) {
      const original = questions.find((o) => o.id === q.id)!;
      expect(q.options.map((o) => o.id)).toEqual(original.options.map((o) => o.id));
      expect(q.options.map((o) => o.content)).toEqual(
        original.options.map((o) => o.content),
      );
      expect(q.questionText).toBe(original.questionText);
      expect(q.answer).toBe(original.answer);
    }
  });

  it("筛选结果为空返回空数组（不伪造题目）", async () => {
    const paper = await generatePaper(
      { section: "实词", year: 2009, questionType: "单空", count: 10 },
      okFetch(),
    );
    expect(paper).toEqual([]);
  });
});

describe("数据隔离：组卷预览不创建会话、不写记录", () => {
  it("生成试卷后 training_sessions / training_records 均为空", async () => {
    const paper = await generatePaper(
      { ...DEFAULT_PAPER_OPTIONS, count: 20 },
      okFetch(),
    );
    expect(paper).toHaveLength(20);
    const db = await getDB();
    expect(await db.getAll("training_sessions")).toEqual([]);
    expect(await db.getAll("training_records")).toEqual([]);
  });

  it("组卷不写入 quiz_questions，且 DB_VERSION 仍为 2", async () => {
    await generatePaper({ ...DEFAULT_PAPER_OPTIONS }, okFetch());
    const db = await getDB();
    expect(await db.getAll("quiz_questions")).toEqual([]);
    expect(DB_VERSION).toBe(2);
  });
});

describe("sameOptions（条件变更提示）", () => {
  it("相同条件为 true，任一条件变更后为 false", () => {
    const a: PaperOptions = { section: "全部", year: "全部", questionType: "全部", count: 20 };
    expect(sameOptions(a, { ...a })).toBe(true);
    expect(sameOptions(a, { ...a, count: 50 })).toBe(false);
    expect(sameOptions(a, { ...a, section: "成语" })).toBe(false);
    expect(sameOptions(a, { ...a, year: 2023 })).toBe(false);
    expect(sameOptions(a, { ...a, questionType: "单空" })).toBe(false);
  });
});
