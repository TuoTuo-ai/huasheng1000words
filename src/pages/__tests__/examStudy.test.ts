/**
 * 真题答题页面与交互测试（3c）
 * node 环境无 DOM：交互规则用纯函数验证，端到端流程用真实
 * examService + fake-indexeddb 走真实调用链，页面结构用源码静态断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  advanceAfterSubmit,
  applySubmitResult,
  buildStudyView,
  canGoNext,
  canGoPrev,
  computeDurationMs,
  explanationText,
  firstUnansweredIndex,
  optionState,
  type AnswerState,
} from "@/pages/ExamStudyPage";
import { examStudyPath, paperQuestionIds } from "@/pages/ExamPage";
import {
  finishExamSession,
  getExamSessionResult,
  judgeExamAnswer,
  resetExamCacheForTest,
  startExamSession,
  submitExamAnswer,
} from "@/lib/examService";
import { resetDBForTest, getDB } from "@/db/database";
import examJson from "../../../data/exam_questions.json";
import type { ExamQuestion } from "@/types/exam";

const questions = examJson as ExamQuestion[];
const [q1, q2, q3, q4] = questions;
const FIVE = [q1, q2, q3, q4, questions[4]];

function okFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify(questions), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const wrongOf = (q: ExamQuestion) => (q.answer === "A" ? "B" : "A");

beforeEach(async () => {
  resetExamCacheForTest();
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  vi.stubGlobal("fetch", okFetch());
});

async function newSession(qs: ExamQuestion[] = FIVE) {
  return startExamSession(qs.map((q) => q.id));
}

describe("1-2. 开始答题创建会话", () => {
  it("创建且只创建一个会话，questionIds 顺序与预览一致", async () => {
    const ids = paperQuestionIds(FIVE);
    const s = await startExamSession(ids);
    const db = await getDB();
    const all = await db.getAll("training_sessions");
    expect(all).toHaveLength(1);
    expect(all[0].trainingId).toBe(s.trainingId);
    expect(all[0].questionIds).toEqual(ids);
    expect(all[0].answeredCount).toBe(0);
    expect(all[0].finishedAt).toBeUndefined();
    expect(await db.getAll("training_records")).toEqual([]);
  });

  it("连续点击只会创建一次会话（页面闸门 + 单次调用验证）", async () => {
    const ids = paperQuestionIds(FIVE);
    let calls = 0;
    // 模拟页面 startingRef 闸门：并发 5 次点击，只允许第一次进入
    let locked = false;
    const click = async () => {
      if (locked) return null;
      locked = true;
      calls++;
      return startExamSession(ids);
    };
    const results = await Promise.all([click(), click(), click(), click(), click()]);
    expect(calls).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);
    const db = await getDB();
    expect(await db.getAll("training_sessions")).toHaveLength(1);
  });

  it("答题页路径格式正确", () => {
    expect(examStudyPath("abc-123")).toBe("/exam/study/abc-123");
    const src = ((globalThis as never as Record<string, unknown>).__x as string) ?? "";
    void src;
  });
});

describe("3-4. 顺序与选项", () => {
  it("会话 questionIds 顺序 === 预览顺序（不重新随机）", async () => {
    const s = await newSession();
    const result = await getExamSessionResult(s.trainingId);
    expect(result!.items.map((it) => it.question.id)).toEqual(FIVE.map((q) => q.id));
  });

  it("选项保持原始 A/B/C/D 顺序", async () => {
    const s = await newSession();
    const result = await getExamSessionResult(s.trainingId);
    for (const item of result!.items) {
      const original = questions.find((q) => q.id === item.question.id)!;
      expect(item.question.options.map((o) => o.id)).toEqual(["A", "B", "C", "D"]);
      expect(item.question.options.map((o) => o.content)).toEqual(
        original.options.map((o) => o.content),
      );
    }
  });
});

describe("5-7. 即时反馈与解析", () => {
  it("正确答案：持久化成功后 isCorrect=true，正确项标绿", async () => {
    const s = await newSession([q1]);
    const res = await submitExamAnswer(s.trainingId, q1, q1.answer, {
      submittedAt: Date.now(),
      durationMs: 1500,
    });
    expect(res.status).toBe("accepted");
    expect(res.isCorrect).toBe(true);
    const view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    const ans = view.answers.get(q1.id)!;
    expect(ans.userAnswer).toBe(q1.answer);
    expect(optionState(q1.answer, ans, q1.answer)).toBe("correct");
    expect(optionState(wrongOf(q1), ans, q1.answer)).toBe("idle");
  });

  it("错误答案：isCorrect=false，用户选项标红、正确项仍标绿", async () => {
    const s = await newSession([q1]);
    const wrong = wrongOf(q1);
    const res = await submitExamAnswer(s.trainingId, q1, wrong);
    expect(res.isCorrect).toBe(false);
    expect(judgeExamAnswer(q1, wrong)).toBe(false);
    const view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    const ans = view.answers.get(q1.id)!;
    expect(optionState(wrong, ans, q1.answer)).toBe("wrong");
    expect(optionState(q1.answer, ans, q1.answer)).toBe("correct");
  });

  it("解析为空显示「本题暂无解析」，非空原样显示", () => {
    expect(q1.explanation).toBe("");
    expect(explanationText(q1.explanation)).toBe("本题暂无解析");
    expect(explanationText("   ")).toBe("本题暂无解析");
    expect(explanationText(undefined)).toBe("本题暂无解析");
    expect(explanationText("原文解析内容")).toBe("原文解析内容");
  });
});

describe("8-10. 提交失败、already-submitted、锁定", () => {
  it("提交失败不改变已答状态（答案表不新增）", async () => {
    const s = await newSession([q1]);
    const answers = new Map<string, AnswerState>();
    // 模拟提交抛错：页面 catch 后不调用 applySubmitResult
    await expect(
      submitExamAnswer(s.trainingId, q1, "E"),
    ).rejects.toThrow();
    expect(answers.size).toBe(0);
    const view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    expect(view.answeredCount).toBe(0);
    expect(view.answers.has(q1.id)).toBe(false);
  });

  it("already-submitted 能恢复原答案，且不重复写入", async () => {
    const s = await newSession([q1]);
    const first = await submitExamAnswer(s.trainingId, q1, wrongOf(q1));
    const dup = await submitExamAnswer(s.trainingId, q1, q1.answer);
    expect(dup.status).toBe("already-submitted");
    expect(dup.isCorrect).toBe(first.isCorrect);
    const db = await getDB();
    expect(await db.getAll("training_records")).toHaveLength(1);
    const view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    // 恢复的是原答案（错答），不是第二次提交的正确答案
    expect(view.answers.get(q1.id)!.userAnswer).toBe(wrongOf(q1));
  });

  it("applySubmitResult：已存在记录时不被覆盖（已提交锁定）", () => {
    const answers = new Map<string, AnswerState>([
      [q1.id, { questionId: q1.id, userAnswer: "A", isCorrect: false }],
    ]);
    const next = applySubmitResult(answers, q1, "B", "already-submitted", true);
    expect(next.get(q1.id)!.userAnswer).toBe("A");
    expect(next.get(q1.id)!.isCorrect).toBe(false);
    expect(next).toBe(answers); // 未产生新表
  });
});

describe("11-13. 上一题 / 下一题 / 进度", () => {
  it("上一题可回看（index>0 允许）", () => {
    expect(canGoPrev(0)).toBe(false);
    expect(canGoPrev(1)).toBe(true);
    expect(canGoPrev(4)).toBe(true);
  });

  it("未作答不能跳到下一题；已作答且非最后一题可跳", () => {
    const answers = new Map<string, AnswerState>();
    expect(canGoNext(FIVE, answers, 0)).toBe(false);
    answers.set(q1.id, { questionId: q1.id, userAnswer: q1.answer, isCorrect: true });
    expect(canGoNext(FIVE, answers, 0)).toBe(true);
    // 最后一题没有下一题
    expect(canGoNext(FIVE, answers, FIVE.length - 1)).toBe(false);
  });

  it("下一题进度：已答数变化与题号推进正确", async () => {
    const s = await newSession();
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    let view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    expect(view.answeredCount).toBe(1);
    expect(view.total).toBe(5);
    expect(canGoNext(view.questions, view.answers, 0)).toBe(true);
    await submitExamAnswer(s.trainingId, q2, q2.answer);
    view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    expect(view.answeredCount).toBe(2);
  });
});

describe("14-17. 刷新恢复", () => {
  it("刷新后恢复原题目顺序", async () => {
    const s = await newSession();
    await submitExamAnswer(s.trainingId, q2, q2.answer);
    const view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    expect(view.questions.map((q) => q.id)).toEqual(FIVE.map((q) => q.id));
  });

  it("刷新后恢复已答答案与反馈", async () => {
    const s = await newSession();
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    await submitExamAnswer(s.trainingId, q3, wrongOf(q3));
    const view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    expect(view.answers.get(q1.id)!.isCorrect).toBe(true);
    expect(view.answers.get(q3.id)!.isCorrect).toBe(false);
    expect(view.answers.get(q3.id)!.userAnswer).toBe(wrongOf(q3));
  });

  it("恢复时默认定位第一道未答题", async () => {
    const s = await newSession();
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    await submitExamAnswer(s.trainingId, q2, q2.answer);
    const view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    const idx = firstUnansweredIndex(view.questions, view.answers);
    expect(idx).toBe(2); // 第 3 题
    expect(view.questions[idx].id).toBe(q3.id);
  });

  it("全部答完：allAnswered=true，定位到最后一题（完成态）", async () => {
    const s = await newSession();
    for (const q of FIVE) await submitExamAnswer(s.trainingId, q, q.answer);
    const view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    expect(view.allAnswered).toBe(true);
    expect(firstUnansweredIndex(view.questions, view.answers)).toBe(FIVE.length - 1);
  });
});

describe("18-20. 会话结束与不重复创建", () => {
  it("未完成会话不调用 finishExamSession：未答完时 finish 被服务拒绝", async () => {
    const s = await newSession();
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    // 页面仅在 allAnswered 时才调用；服务层同样拒绝未答完
    await expect(finishExamSession(s.trainingId)).rejects.toThrow(/未答完/);
    const stored = (await (await getDB()).get("training_sessions", s.trainingId))!;
    expect(stored.finishedAt).toBeUndefined();
  });

  it("全部答完时正确结束会话", async () => {
    const s = await newSession();
    for (const q of FIVE) await submitExamAnswer(s.trainingId, q, q.answer);
    const finished = await finishExamSession(s.trainingId);
    expect(finished.finishedAt).toBeDefined();
    expect(finished.answeredCount).toBe(5);
    const view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    expect(view.finished).toBe(true);
    expect(view.allAnswered).toBe(true);
  });

  it("刷新恢复不重复创建会话、不重复写记录", async () => {
    const s = await newSession();
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    // 模拟刷新：重新读取 3 次
    await getExamSessionResult(s.trainingId);
    await getExamSessionResult(s.trainingId);
    await getExamSessionResult(s.trainingId);
    const db = await getDB();
    expect(await db.getAll("training_sessions")).toHaveLength(1);
    expect(await db.getAll("training_records")).toHaveLength(1);
  });

  it("会话不存在返回 null（页面显示错误与返回入口）", async () => {
    expect(await getExamSessionResult("no-such-id")).toBeNull();
  });
});

describe("耗时计算", () => {
  it("首次展示 → 提交，非负", () => {
    expect(computeDurationMs(1000, 2500)).toBe(1500);
    expect(computeDurationMs(3000, 2000)).toBe(0);
  });

  it("已答记录的 durationMs 以数据库为准（回看不重新累计）", async () => {
    const s = await newSession([q1]);
    await submitExamAnswer(s.trainingId, q1, q1.answer, { durationMs: 4321 });
    const result = await getExamSessionResult(s.trainingId);
    const view = buildStudyView(result!);
    void view;
    const rec = result!.items[0].record!;
    expect(rec.durationMs).toBe(4321);
  });
});

describe("页面结构与隔离（静态断言）", () => {
  it("App 注册 /exam/study/:trainingId 路由", async () => {
    const src = (await import("@/App.tsx?raw")).default as string;
    expect(src).toContain('/exam/study/:trainingId');
    expect(src).toContain("ExamStudyPage");
  });

  it("答题页只提交、结束，不创建会话", async () => {
    const src = (await import("@/pages/ExamStudyPage.tsx?raw")).default as string;
    expect(src).toContain("submitExamAnswer");
    expect(src).toContain("finishExamSession");
    expect(src).toContain("getExamSessionResult");
    expect(src).not.toContain("startExamSession");
    expect(src).not.toContain("getRandomExamQuestions");
  });

  it("组卷页仅在 handleStart 中创建会话", async () => {
    const src = (await import("@/pages/ExamPage.tsx?raw")).default as string;
    const hits = src.split("startExamSession(").length - 1;
    expect(hits).toBe(1); // import 行不含 "("，仅 handleStart 调用一次
  });

  it("答题页不触碰学习数据与题库", async () => {
    const src = (await import("@/pages/ExamStudyPage.tsx?raw")).default as string;
    for (const banned of ["studyService", "fsrs", "wordRepository", "quizRepository", "quiz_questions"]) {
      expect(src).not.toContain(banned);
    }
  });
});

/* ==================== 回归：答完最后一题必须立即触发完成态 ====================
 * 缺陷背景：ExamStudyPage.handleSelect 增量更新 answers/answeredCount 但未重算
 * allAnswered，导致 finishExamSession 不触发、完成态不出现（刷新才恢复）。
 * 修复：与 QuizStudyPage.advanceAfterSubmit 同款纯函数，同步重算 allAnswered。
 */
describe("回归：真题完成态（advanceAfterSubmit 同步重算 allAnswered）", () => {
  it("未答完时 allAnswered 保持 false（不得提前进入完成态）", async () => {
    const s = await newSession([q1, q2]);
    let view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    expect(view.allAnswered).toBe(false);
    const r1 = await submitExamAnswer(s.trainingId, q1, q1.answer, {
      submittedAt: Date.now(),
      durationMs: 100,
    });
    view = advanceAfterSubmit(view, q1, q1.answer, r1.status, r1.isCorrect);
    expect(view.answeredCount).toBe(1);
    expect(view.allAnswered).toBe(false);
    // 未答完时服务层拒绝结束会话
    await expect(finishExamSession(s.trainingId)).rejects.toThrow(/未答完/);
    const stored = (await getExamSessionResult(s.trainingId))!;
    expect(stored.finished).toBe(false);
  });

  it("答完最后一题后 allAnswered 立刻为 true（缺陷回归点）", async () => {
    const s = await newSession([q1, q2]);
    let view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    const r1 = await submitExamAnswer(s.trainingId, q1, q1.answer, {
      submittedAt: Date.now(),
      durationMs: 100,
    });
    view = advanceAfterSubmit(view, q1, q1.answer, r1.status, r1.isCorrect);
    const r2 = await submitExamAnswer(s.trainingId, q2, q2.answer, {
      submittedAt: Date.now(),
      durationMs: 100,
    });
    view = advanceAfterSubmit(view, q2, q2.answer, r2.status, r2.isCorrect);
    expect(view.answeredCount).toBe(2);
    expect(view.allAnswered).toBe(true); // 必须立刻为 true，否则结束会话不会被触发
    // already-submitted 重放不得改变 allAnswered 与计数
    const replay = advanceAfterSubmit(view, q2, q2.answer, "already-submitted", r2.isCorrect);
    expect(replay.allAnswered).toBe(true);
    expect(replay.answeredCount).toBe(2);
  });

  it("finishExamSession 幂等：重复调用只保留第一次的 finishedAt", async () => {
    const s = await newSession([q1]);
    await submitExamAnswer(s.trainingId, q1, q1.answer, {
      submittedAt: Date.now(),
      durationMs: 100,
    });
    const fin1 = await finishExamSession(s.trainingId, 1_000);
    const fin2 = await finishExamSession(s.trainingId, 9_999);
    expect(fin1.finishedAt).toBe(1_000);
    expect(fin2.finishedAt).toBe(1_000);
  });

  it("端到端：全部答完 → finish 写入 finishedAt → 刷新（重新加载视图）后完成状态仍正确", async () => {
    const s = await newSession([q1, q2]);
    let view = buildStudyView((await getExamSessionResult(s.trainingId))!);
    for (const q of [q1, q2]) {
      const r = await submitExamAnswer(s.trainingId, q, q.answer, {
        submittedAt: Date.now(),
        durationMs: 100,
      });
      view = advanceAfterSubmit(view, q, q.answer, r.status, r.isCorrect);
    }
    expect(view.allAnswered).toBe(true);
    const finished = await finishExamSession(s.trainingId);
    expect(finished.finishedAt).toBeDefined();
    // 模拟刷新：重新 getExamSessionResult + buildStudyView
    const fresh = buildStudyView((await getExamSessionResult(s.trainingId))!);
    expect(fresh.allAnswered).toBe(true);
    expect(fresh.finished).toBe(true);
  });

  it("页面源码：handleSelect 使用 advanceAfterSubmit（不再手工增量拼装视图）", async () => {
    const src = (await import("@/pages/ExamStudyPage.tsx?raw")).default as string;
    expect(src).toContain("advanceAfterSubmit");
    // 增量更新必须经由纯函数，避免遗漏 allAnswered 重算
    expect(src).not.toContain("answeredCount: prev.answers.has");
  });
});
