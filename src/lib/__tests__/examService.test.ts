/**
 * 真题数据服务测试（第二阶段 · P1/P2/P3 修复回归版）
 * 通过注入 fetchImpl 走真实调用链：加载/缓存/失败重试/隔离/筛选/抽题/判题
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExamDataError,
  EXAM_DATA_URL,
  getExamQuestionById,
  getExamQuestions,
  getRandomExamQuestions,
  judgeExamAnswer,
  loadExamQuestions,
  resetExamCacheForTest,
  shuffle,
} from "@/lib/examService";
import examJson from "../../../data/exam_questions.json";
import type { ExamQuestion } from "@/types/exam";

const questions = examJson as ExamQuestion[];

/** 构造注入用 fetch（记录调用次数与 URL） */
function okFetch(data: unknown = examJson) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return Object.assign(fn, { calls }) as unknown as typeof fetch & {
    calls: string[];
  };
}

beforeEach(() => {
  resetExamCacheForTest();
});

describe("loadExamQuestions", () => {
  it("首次加载返回 204 题并请求正确 URL", async () => {
    const f = okFetch();
    const list = await loadExamQuestions(f);
    expect(list).toHaveLength(204);
    expect(f.calls).toEqual([EXAM_DATA_URL]);
  });

  it("缓存命中：后续调用不再发起 fetch", async () => {
    const f = okFetch();
    await loadExamQuestions(f);
    await loadExamQuestions(f);
    await loadExamQuestions(f);
    expect(f.calls).toHaveLength(1);
  });

  it("并发调用共享同一次 fetch（同一 fetchImpl）", async () => {
    const f = okFetch();
    await Promise.all([loadExamQuestions(f), loadExamQuestions(f)]);
    expect(f.calls).toHaveLength(1);
  });

  it("HTTP 失败抛 ExamDataError，不返回假数据", async () => {
    const f = vi.fn(async () => new Response("not found", { status: 404 }));
    await expect(loadExamQuestions(f as unknown as typeof fetch)).rejects.toThrow(
      ExamDataError,
    );
  });

  it("fetch 网络异常抛 ExamDataError", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(loadExamQuestions(f as unknown as typeof fetch)).rejects.toThrow(
      "network down",
    );
  });

  it("JSON 格式错误抛 ExamDataError", async () => {
    const f = vi.fn(async () => new Response("{oops", { status: 200 }));
    await expect(loadExamQuestions(f as unknown as typeof fetch)).rejects.toThrow(
      /合法 JSON/,
    );
  });

  it("数据校验失败（总数不对）抛 ExamDataError", async () => {
    const f = okFetch(questions.slice(0, 100));
    await expect(loadExamQuestions(f)).rejects.toThrow(/204/);
  });

  it("数据校验失败（字段非法）抛 ExamDataError", async () => {
    const bad = questions.map((q, i) =>
      i === 0 ? { ...q, answer: "E" as never } : q,
    );
    const f = okFetch(bad);
    await expect(loadExamQuestions(f)).rejects.toThrow(ExamDataError);
  });
});

describe("P1 修复回归：失败后清除缓存、可重新加载", () => {
  it("首次 HTTP 失败、第二次成功：重新 fetch 且次数为 2", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("server error", { status: 500 });
      return new Response(JSON.stringify(questions), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(loadExamQuestions(f)).rejects.toThrow(ExamDataError);
    const list = await loadExamQuestions(f);
    expect(list).toHaveLength(204);
    expect(calls).toBe(2);
  });

  it("JSON 解析失败后再次加载可重新请求并成功", async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("{oops", { status: 200 });
      return new Response(JSON.stringify(questions), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(loadExamQuestions(f)).rejects.toThrow(/合法 JSON/);
    const list = await loadExamQuestions(f);
    expect(list).toHaveLength(204);
    expect(calls).toBe(2);
  });

  it("并发安全：失败清除不误删后来新建的缓存", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        await gate; // 第一次请求挂起
        return new Response("err", { status: 500 });
      }
      return new Response(JSON.stringify(questions), { status: 200 });
    }) as unknown as typeof fetch;
    const first = loadExamQuestions(f); // 失败的 Promise（挂起中）
    resetExamCacheForTest(); // 模拟新缓存建立
    const second = loadExamQuestions(f); // 新 Promise，成功
    release();
    await expect(first).rejects.toThrow(ExamDataError);
    expect(await second).toHaveLength(204);
    // 新 Promise 的成功缓存仍在：第三次调用不再 fetch
    expect(await loadExamQuestions(f)).toHaveLength(204);
    expect(calls).toBe(2);
  });
});

describe("P2 修复回归：不同 fetchImpl 缓存隔离", () => {
  it("不同 fetchImpl 各自返回各自数据，不共享缓存", async () => {
    const dataB = JSON.parse(JSON.stringify(questions));
    const fA = okFetch(questions);
    const fB = okFetch(dataB);
    const a = await loadExamQuestions(fA);
    const b = await loadExamQuestions(fB);
    expect(a).toHaveLength(204);
    expect(b).toHaveLength(204);
    expect(fA.calls).toHaveLength(1);
    expect(fB.calls).toHaveLength(1);
    expect(a[0]).not.toBe(b[0]); // 不是同一份缓存对象
    expect(a[0]).toEqual(questions[0]);
    expect(b[0]).toEqual(dataB[0]);
  });

  it("同一 fetchImpl 连续调用只 fetch 一次", async () => {
    const f = okFetch();
    await loadExamQuestions(f);
    await loadExamQuestions(f);
    expect(f.calls).toHaveLength(1);
  });

  it("resetExamCacheForTest 后同一 fetchImpl 重新 fetch", async () => {
    const f = okFetch();
    await loadExamQuestions(f);
    expect(f.calls).toHaveLength(1);
    resetExamCacheForTest();
    await loadExamQuestions(f);
    expect(f.calls).toHaveLength(2);
  });
});

describe("getExamQuestionById", () => {
  it("按 ID 查询成功", async () => {
    const f = okFetch();
    const first = (await loadExamQuestions(f))[0];
    expect(await getExamQuestionById(first.id, f)).toEqual(first);
  });

  it("ID 不存在返回 null", async () => {
    const f = okFetch();
    await loadExamQuestions(f);
    expect(await getExamQuestionById("ex_notexist", f)).toBeNull();
  });
});

describe("getExamQuestions 筛选", () => {
  let f: ReturnType<typeof okFetch>;
  beforeEach(async () => {
    f = okFetch();
    await loadExamQuestions(f);
  });

  it("按篇章筛选：成语 177 / 实词 27", async () => {
    expect(await getExamQuestions({ section: "成语" }, f)).toHaveLength(177);
    expect(await getExamQuestions({ section: "实词" }, f)).toHaveLength(27);
  });

  it("按年份筛选", async () => {
    const list = await getExamQuestions({ year: 2023 }, f);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((q) => q.year === 2023)).toBe(true);
  });

  it("按题型筛选：单空 38 / 多空 166", async () => {
    expect(await getExamQuestions({ questionType: "单空" }, f)).toHaveLength(38);
    expect(await getExamQuestions({ questionType: "多空" }, f)).toHaveLength(166);
  });

  it("多条件组合筛选", async () => {
    const list = await getExamQuestions(
      { section: "成语", year: 2023, questionType: "多空" },
      f,
    );
    expect(list.length).toBeGreaterThan(0);
    for (const q of list) {
      expect(q.section).toBe("成语");
      expect(q.year).toBe(2023);
      expect(q.questionType).toBe("多空");
    }
  });

  it("无匹配条件返回空数组", async () => {
    expect(await getExamQuestions({ section: "实词", year: 2009 }, f)).toEqual([]);
  });
});

describe("getRandomExamQuestions", () => {
  let f: ReturnType<typeof okFetch>;
  beforeEach(async () => {
    f = okFetch();
    await loadExamQuestions(f);
  });

  it("随机抽题数量正确且不重复", async () => {
    const list = await getRandomExamQuestions({ count: 50, fetchImpl: f });
    expect(list).toHaveLength(50);
    expect(new Set(list.map((q) => q.id)).size).toBe(50);
  });

  it("按篇章随机抽题", async () => {
    const list = await getRandomExamQuestions({ count: 10, section: "实词", fetchImpl: f });
    expect(list).toHaveLength(10);
    expect(list.every((q) => q.section === "实词")).toBe(true);
  });

  it("数量不足时返回实际可用数量（实词仅 27 题）", async () => {
    const list = await getRandomExamQuestions({ count: 100, section: "实词", fetchImpl: f });
    expect(list).toHaveLength(27);
  });

  it("组合条件 + 数量不足", async () => {
    const list = await getRandomExamQuestions(
      { count: 999, section: "成语", year: 2009, questionType: "单空", fetchImpl: f },
    );
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThan(999);
  });

  it("count 非法返回空数组", async () => {
    expect(await getRandomExamQuestions({ count: 0, fetchImpl: f })).toEqual([]);
    expect(await getRandomExamQuestions({ count: -1, fetchImpl: f })).toEqual([]);
  });

  it("注入随机数时结果可复现", async () => {
    const a = await getRandomExamQuestions({ count: 5, random: () => 0.42, fetchImpl: f });
    const b = await getRandomExamQuestions({ count: 5, random: () => 0.42, fetchImpl: f });
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
  });

  it("shuffle 纯函数不修改原数组", () => {
    const src = [1, 2, 3, 4, 5];
    shuffle(src, () => 0.1);
    expect(src).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("judgeExamAnswer", () => {
  const q = questions[0]; // 成语1，多空，正确答案 C

  it("正确答案判定为 true", () => {
    expect(judgeExamAnswer(q, "C")).toBe(true);
  });

  it("错误答案判定为 false", () => {
    expect(judgeExamAnswer(q, "A")).toBe(false);
    expect(judgeExamAnswer(q, "B")).toBe(false);
    expect(judgeExamAnswer(q, "D")).toBe(false);
  });

  it("多空题同样只判断单个选项字母", () => {
    expect(q.questionType).toBe("多空");
    expect(q.blankCount).toBeGreaterThan(1);
    expect(judgeExamAnswer(q, q.answer)).toBe(true);
  });

  it("非法答案抛 ExamDataError", () => {
    expect(() => judgeExamAnswer(q, "E")).toThrow(ExamDataError);
    expect(() => judgeExamAnswer(q, "c")).toThrow(ExamDataError);
    expect(() => judgeExamAnswer(q, "")).toThrow(ExamDataError);
    expect(() => judgeExamAnswer(q, "AB")).toThrow(ExamDataError);
  });
});

describe("隔离约束（静态检查）", () => {
  it("examService 源码不 import 学习侧模块", async () => {
    // vite ?raw 导入源码文本（无需 node types）
    const src = (await import("@/lib/examService.ts?raw")).default as string;
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l) || /from\s+"/.test(l))
      .join("\n");
    // 3a 起允许 import quizRepository（训练记录写入），学习侧模块仍然禁止
    for (const banned of [
      "studyService",
      "fsrs",
      "wordRepository",
      "putQuestion",
      "putQuestionsBatch",
      "quiz_questions",
    ]) {
      expect(importLines).not.toContain(banned);
    }
  });
});
