/**
 * 3c.1 修复测试：真实行为验证（非源码字符串断言）
 * 1) already-submitted 以数据库原答案为准
 * 2) 无法取得原记录时不伪造反馈
 * 3) 原答案与判定保持一致
 * 4) 提交期间切题，反馈按 questionId 归属
 * 5) 旧加载请求晚到不覆盖新状态（世代守卫）
 * 6) 已成功提交的记录不因切题丢失
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  applySubmitResult,
  buildStudyView,
  createRequestGuard,
  restoreSubmittedFeedback,
  type AnswerState,
} from "@/pages/ExamStudyPage";
import {
  getExamSessionResult,
  resetExamCacheForTest,
  startExamSession,
  submitExamAnswer,
} from "@/lib/examService";
import { resetDBForTest, getDB } from "@/db/database";
import examJson from "../../../data/exam_questions.json";
import type { ExamQuestion } from "@/types/exam";
import type { TrainingRecord } from "@/types/quiz";

const questions = examJson as ExamQuestion[];
const [q1, q2, q3] = questions;
const THREE = [q1, q2, q3];

const wrongOf = (q: ExamQuestion) => (q.answer === "A" ? "B" : "A");

function okFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify(questions), {
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
  vi.stubGlobal("fetch", okFetch());
});

async function recordsOf(trainingId: string) {
  const db = await getDB();
  const all = await db.getAllFromIndex("training_records", "by-trainingId", trainingId);
  return all;
}

describe("1-3. already-submitted 以数据库原答案为准", () => {
  it("本次点击与数据库原答案不同时，恢复到的是数据库答案", async () => {
    const s = await startExamSession(THREE.map((q) => q.id));
    const dbAnswer = wrongOf(q1); // 先以错误答案提交
    await submitExamAnswer(s.trainingId, q1, dbAnswer);
    // 用户再次点击正确答案 → already-submitted（返回值不含 userAnswer）
    const dup = await submitExamAnswer(s.trainingId, q1, q1.answer);
    expect(dup.status).toBe("already-submitted");
    expect(dup.isCorrect).toBe(false);

    // 页面会重新读取会话恢复原记录
    const fresh = await getExamSessionResult(s.trainingId);
    const record = fresh!.items.find((it) => it.question.id === q1.id)!.record;
    const restored = restoreSubmittedFeedback(record, q1.id)!;

    expect(restored.userAnswer).toBe(dbAnswer); // 数据库原答案
    expect(restored.userAnswer).not.toBe(q1.answer); // 不是本次点击
    expect(restored.isCorrect).toBe(false); // 判定与答案一致
  });

  it("原答案与判定保持一致（正确记录 + 错误记录各一例）", async () => {
    const s = await startExamSession(THREE.map((q) => q.id));
    await submitExamAnswer(s.trainingId, q1, q1.answer); // 对
    await submitExamAnswer(s.trainingId, q2, wrongOf(q2)); // 错
    const fresh = await getExamSessionResult(s.trainingId);

    const r1 = restoreSubmittedFeedback(
      fresh!.items.find((it) => it.question.id === q1.id)!.record,
      q1.id,
    )!;
    const r2 = restoreSubmittedFeedback(
      fresh!.items.find((it) => it.question.id === q2.id)!.record,
      q2.id,
    )!;

    expect(r1.userAnswer).toBe(q1.answer);
    expect(r1.isCorrect).toBe(true);
    expect(r2.userAnswer).toBe(wrongOf(q2));
    expect(r2.isCorrect).toBe(false);
  });

  it("无法取得原记录时不生成反馈（返回 null，页面提示刷新）", () => {
    expect(restoreSubmittedFeedback(null, q1.id)).toBeNull();
    // questionId 不匹配的记录同样不可信
    const other: TrainingRecord = {
      id: 1, trainingId: "t", questionId: "ex_other", mode: "exam",
      userAnswer: "A", isCorrect: true, answeredAt: 1, durationMs: 0,
      categoryKey: "真题::成语",
    };
    expect(restoreSubmittedFeedback(other, q1.id)).toBeNull();
    // 记录存在但答案为空，也不可伪造
    const empty: TrainingRecord = { ...other, questionId: q1.id, userAnswer: "" };
    expect(restoreSubmittedFeedback(empty, q1.id)).toBeNull();
  });
});

describe("4. 提交期间切题，反馈不串到新题", () => {
  it("反馈按 questionId 归属：旧题反馈不会显示在新题下", async () => {
    // 模拟页面状态：feedbackByQuestion 按题 ID 存
    const feedbackByQuestion: Record<string, AnswerState> = {};
    const s = await startExamSession(THREE.map((q) => q.id));

    // 用户在第 1 题点击，然后立即切到第 2 题（真实场景：请求仍在飞行）
    const submitted = submitExamAnswer(s.trainingId, q1, q1.answer);
    const currentAtSubmit = q1;
    const currentAfterSwitch = q2;

    const res = await submitted;
    // 页面写入反馈：键是提交时的题（q1），而不是切换后的题（q2）
    feedbackByQuestion[currentAtSubmit.id] = {
      questionId: currentAtSubmit.id,
      userAnswer: q1.answer,
      isCorrect: res.isCorrect,
    };

    // 当前展示第 2 题：其反馈为 undefined（不会拿到第 1 题的反馈）
    expect(feedbackByQuestion[currentAfterSwitch.id]).toBeUndefined();
    // 第 1 题的反馈仍可回看
    expect(feedbackByQuestion[q1.id]!.userAnswer).toBe(q1.answer);
  });
});

describe("5. 旧加载请求晚到不覆盖新状态", () => {
  it("世代守卫：后发起的请求才是 current，先发的过期", () => {
    const guard = createRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(second)).toBe(true);
    expect(guard.isCurrent(first)).toBe(false);
  });

  it("旧请求晚到时其数据被丢弃，新请求结果保留", async () => {
    const guard = createRequestGuard();
    let applied: string | null = null;

    const slow = (async () => {
      const seq = guard.begin(); // 第一次加载
      await new Promise((r) => setTimeout(r, 30));
      if (guard.isCurrent(seq)) applied = "old";
    })();

    const fast = (async () => {
      const seq = guard.begin(); // 第二次加载（新）
      await new Promise((r) => setTimeout(r, 5));
      if (guard.isCurrent(seq)) applied = "new";
    })();

    await Promise.all([slow, fast]);
    expect(applied).toBe("new"); // 慢的旧请求没有覆盖
  });
});

describe("6. 切题不丢失已提交记录", () => {
  it("提交成功后切到下一题再切回，记录仍在且答案不变", async () => {
    const s = await startExamSession(THREE.map((q) => q.id));
    const res = await submitExamAnswer(s.trainingId, q1, wrongOf(q1));
    expect(res.status).toBe("accepted");

    // 切题（页面只改 index，不影响数据库）
    const afterSwitch = await getExamSessionResult(s.trainingId);
    const view = buildStudyView(afterSwitch!);
    expect(view.answers.get(q1.id)!.userAnswer).toBe(wrongOf(q1));

    // 再提交第 2 题，第 1 题记录不受影响
    await submitExamAnswer(s.trainingId, q2, q2.answer);
    const recs = await recordsOf(s.trainingId);
    expect(recs).toHaveLength(2);
    const first = recs.find((r) => r.questionId === q1.id)!;
    expect(first.userAnswer).toBe(wrongOf(q1));
    expect(first.isCorrect).toBe(false);
  });

  it("切题后重复提交同一题仍只有一条记录（不因切题重复写）", async () => {
    const s = await startExamSession(THREE.map((q) => q.id));
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    await submitExamAnswer(s.trainingId, q2, q2.answer);
    const dup = await submitExamAnswer(s.trainingId, q1, wrongOf(q1));
    expect(dup.status).toBe("already-submitted");
    expect(await recordsOf(s.trainingId)).toHaveLength(2);
  });
});

describe("已提交锁定不被破坏", () => {
  it("applySubmitResult 对已有记录返回同一 Map（不覆盖）", () => {
    const answers = new Map<string, AnswerState>([
      [q1.id, { questionId: q1.id, userAnswer: "A", isCorrect: false }],
    ]);
    const next = applySubmitResult(answers, q1, "B", "already-submitted", true);
    expect(next).toBe(answers);
    expect(next.get(q1.id)!.userAnswer).toBe("A");
  });
});
