/**
 * 真题训练会话服务测试（3a）
 * 覆盖：会话持久化、顺序恢复、正误记录、重复提交、并发重复、
 * 计数同步、finishedAt、中途退出、words/progress/logs 隔离、
 * statsService 不受影响、categoryKey 区分
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  finishExamSession,
  getExamSessionResult,
  startExamSession,
  submitExamAnswer,
} from "@/lib/examService";
import { resetDBForTest, getDB } from "@/db/database";
import { getAllQuestions } from "@/db/quizRepository";
import examJson from "../../../data/exam_questions.json";
import type { ExamQuestion } from "@/types/exam";
import type { TrainingRecord } from "@/types/quiz";

const questions = examJson as ExamQuestion[];
const q1 = questions[0]; // 成语，多空，答案 C
const q2 = questions[1];
const q3 = questions[2];

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  // getExamSessionResult 默认走全局 fetch 加载题目；Node 环境无法解析相对 URL，
  // stub 一个返回正式数据的 fetch（与第 2 阶段 okFetch 行为一致）
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(questions), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

describe("startExamSession", () => {
  it("开始会话立即持久化：answeredCount=0、correctCount=0、无 finishedAt", async () => {
    const s = await startExamSession([q1.id, q2.id]);
    const stored = (await (await getDB()).get("training_sessions", s.trainingId))!;
    expect(stored).toBeDefined();
    expect(stored.mode).toBe("exam");
    expect(stored.answeredCount).toBe(0);
    expect(stored.correctCount).toBe(0);
    expect(stored.finishedAt).toBeUndefined();
    expect(stored.questionIds).toEqual([q1.id, q2.id]);
  });

  it("空题目列表抛 ExamDataError", async () => {
    await expect(startExamSession([])).rejects.toThrow(/至少需要 1 道题/);
  });

  it("注入 startedAt 生效", async () => {
    const s = await startExamSession([q1.id], { startedAt: 1700000000000 });
    expect(s.startedAt).toBe(1700000000000);
  });
});

describe("submitExamAnswer", () => {
  it("按顺序记录作答：answeredAt 与 userAnswer 原始字母", async () => {
    const s = await startExamSession([q1.id, q2.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer, { submittedAt: 111, durationMs: 500 });
    await submitExamAnswer(s.trainingId, q2, q2.answer, { submittedAt: 222, durationMs: 700 });
    const result = await getExamSessionResult(s.trainingId);
    expect(result!.items[0].question.id).toBe(q1.id);
    expect(result!.items[1].question.id).toBe(q2.id); // 顺序与 questionIds 一致
    expect(result!.items[0].record!.userAnswer).toBe(q1.answer);
    expect(result!.items[0].record!.durationMs).toBe(500);
    expect(result!.items[0].record!.answeredAt).toBe(111);
  });

  it("正确/错误判定正确，正确答案 C 答成 A 记 false", async () => {
    const s = await startExamSession([q1.id, q2.id]);
    const r1 = await submitExamAnswer(s.trainingId, q1, q1.answer);
    const wrong = "A" === q2.answer ? "B" : "A";
    const r2 = await submitExamAnswer(s.trainingId, q2, wrong);
    expect(r1).toMatchObject({ status: "accepted", isCorrect: true });
    expect(r2.isCorrect).toBe(false);
  });

  it("重复提交：不写第二条、不重复计数、返回 already-submitted", async () => {
    const s = await startExamSession([q1.id]);
    const first = await submitExamAnswer(s.trainingId, q1, "A");
    const dup = await submitExamAnswer(s.trainingId, q1, q1.answer, { submittedAt: 999 });
    expect(first.status).toBe("accepted");
    expect(dup.status).toBe("already-submitted");
    expect(dup.isCorrect).toBe(first.isCorrect); // 返回已提交记录的正误
    const result = await getExamSessionResult(s.trainingId);
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].record!.answeredAt).not.toBe(999); // 仍是首次记录
    expect(result!.answeredCount).toBe(1);
    expect(result!.session.answeredCount).toBe(1);
  });

  it("并发重复提交：只接受一次（串行化保护）", async () => {
    const s = await startExamSession([q1.id]);
    const [a, b, c] = await Promise.all([
      submitExamAnswer(s.trainingId, q1, "A"),
      submitExamAnswer(s.trainingId, q1, q1.answer),
      submitExamAnswer(s.trainingId, q1, "B"),
    ]);
    const accepted = [a, b, c].filter((r) => r.status === "accepted");
    expect(accepted).toHaveLength(1);
    const result = await getExamSessionResult(s.trainingId);
    expect(result!.answeredCount).toBe(1);
    expect(result!.session.answeredCount).toBe(1);
  });

  it("计数同步：Session 的 answeredCount/correctCount 与记录一致", async () => {
    const s = await startExamSession([q1.id, q2.id, q3.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer); // 对
    await submitExamAnswer(s.trainingId, q2, "A" === q2.answer ? "B" : "A"); // 错
    await submitExamAnswer(s.trainingId, q3, q3.answer); // 对
    const result = await getExamSessionResult(s.trainingId);
    expect(result!.session.answeredCount).toBe(3);
    expect(result!.session.correctCount).toBe(2);
    expect(result!.correctCount).toBe(2);
    expect(result!.wrongCount).toBe(1);
    expect(result!.unansweredCount).toBe(0);
  });

  it("非法答案抛 ExamDataError 且不写任何记录", async () => {
    const s = await startExamSession([q1.id]);
    await expect(submitExamAnswer(s.trainingId, q1, "E")).rejects.toThrow();
    const result = await getExamSessionResult(s.trainingId);
    expect(result!.answeredCount).toBe(0);
    expect(result!.items[0].record).toBeNull();
  });

  it("categoryKey 为 真题::成语 / 真题::实词（与辨析训练区分）", async () => {
    const shici = questions.filter((q) => q.section === "实词")[0];
    const s = await startExamSession([q1.id, shici.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    await submitExamAnswer(s.trainingId, shici, shici.answer);
    const records = await (await getDB()).getAll("training_records");
    const keys = records.map((r) => r.categoryKey).sort();
    expect(keys).toEqual(["真题::成语", "真题::实词"].sort());
    expect(keys.every((k) => !k.includes("::辨析"))).toBe(true);
  });
});

describe("finishExamSession", () => {
  it("全部答完后写入 finishedAt，不重复创建会话", async () => {
    const s = await startExamSession([q1.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    const finished = await finishExamSession(s.trainingId, 1234567890);
    expect(finished.finishedAt).toBe(1234567890);
    // 幂等：再次结束不覆盖
    const again = await finishExamSession(s.trainingId, 9999999999);
    expect(again.finishedAt).toBe(1234567890);
  });

  it("未答完调用 finishExamSession 会失败，且不写 finishedAt（3a.1）", async () => {
    const s = await startExamSession([q1.id, q2.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer); // 1/2
    await expect(finishExamSession(s.trainingId, 1234567890)).rejects.toThrow(
      /未答完/,
    );
    const stored = (await (await getDB()).get("training_sessions", s.trainingId))!;
    expect(stored.finishedAt).toBeUndefined();
    // 0 答时同样拒绝
    const s2 = await startExamSession([q1.id]);
    await expect(finishExamSession(s2.trainingId)).rejects.toThrow(/未答完/);
  });

  it("已完成会话不能继续提交，不写任何新记录（3a.1）", async () => {
    const s = await startExamSession([q1.id, q2.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    await submitExamAnswer(s.trainingId, q2, q2.answer);
    await finishExamSession(s.trainingId);
    // 对未提交过的题（此处为构造的第 3 题）提交 → 拒绝
    await expect(
      submitExamAnswer(s.trainingId, q3, q3.answer),
    ).rejects.toThrow(/会话已结束/);
    // 已提交过的题重复提交仍返回 already-submitted（幂等读，不报错）
    const dup = await submitExamAnswer(s.trainingId, q1, q1.answer);
    expect(dup.status).toBe("already-submitted");
    const db = await getDB();
    expect(await db.getAll("training_records")).toHaveLength(2);
    const stored = (await db.get("training_sessions", s.trainingId))!;
    expect(stored.answeredCount).toBe(2);
  });

  it("会话不存在抛 ExamDataError", async () => {
    await expect(finishExamSession("no-such-id")).rejects.toThrow(/不存在/);
  });

  it("提交后立即结束：Session 已更新计数且仅有一次结束写入", async () => {
    const s = await startExamSession([q1.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    const finished = await finishExamSession(s.trainingId);
    expect(finished.answeredCount).toBe(1);
    expect(finished.correctCount).toBe(1);
    const all = await (await getDB()).getAll("training_sessions");
    expect(all).toHaveLength(1);
  });
});

describe("原子事务（3a.1）", () => {
  it("成功时记录与会话计数同事务同步更新", async () => {
    const { addTrainingRecordAndUpdateSession } = await import("@/db/quizRepository");
    const s = await startExamSession([q1.id, q2.id]);
    const { recordId, session } = await addTrainingRecordAndUpdateSession(
      {
        trainingId: s.trainingId, questionId: q1.id, mode: "exam",
        userAnswer: q1.answer, isCorrect: true,
        answeredAt: 111, durationMs: 0, categoryKey: "真题::成语",
      },
      s.trainingId,
    );
    expect(typeof recordId).toBe("number");
    expect(session.answeredCount).toBe(1);
    expect(session.correctCount).toBe(1);
    const db = await getDB();
    expect(await db.getAll("training_records")).toHaveLength(1);
  });

  it("失败时两者都不发生部分写入（事务回滚验证）", async () => {
    const { addTrainingRecordAndUpdateSession } = await import("@/db/quizRepository");
    const s = await startExamSession([q1.id]);
    const record = {
      trainingId: s.trainingId, questionId: q1.id, mode: "exam" as const,
      userAnswer: "A", isCorrect: false,
      answeredAt: 111, durationMs: 0, categoryKey: "真题::成语",
    };
    // 先用显式主键 999 占位，再原子写入同主键 → add 抛 ConstraintError → 事务 abort
    const db = await getDB();
    await db.put("training_records", { ...record, id: 999 });
    const withKey = { ...record, id: 999 } as unknown as Omit<TrainingRecord, "id">;
    await expect(
      addTrainingRecordAndUpdateSession(withKey, s.trainingId),
    ).rejects.toThrow();
    // 回滚验证：记录数不变（仍 1 条），会话计数未更新
    expect(await db.getAll("training_records")).toHaveLength(1);
    const stored = (await db.get("training_sessions", s.trainingId))!;
    expect(stored.answeredCount).toBe(0);
    expect(stored.correctCount).toBe(0);
  });

  it("会话不存在时原子函数拒绝且不写记录", async () => {
    const { addTrainingRecordAndUpdateSession } = await import("@/db/quizRepository");
    await expect(
      addTrainingRecordAndUpdateSession(
        {
          trainingId: "no-such", questionId: q1.id, mode: "exam",
          userAnswer: "A", isCorrect: true,
          answeredAt: 1, durationMs: 0, categoryKey: "真题::成语",
        },
        "no-such",
      ),
    ).rejects.toThrow(/不存在/);
    expect(await (await getDB()).getAll("training_records")).toHaveLength(0);
  });
});

describe("getExamSessionResult", () => {
  it("中途退出（无 finishedAt）：可恢复、未答题不计错误", async () => {
    const s = await startExamSession([q1.id, q2.id, q3.id]);
    await submitExamAnswer(s.trainingId, q1, "A" === q1.answer ? "B" : "A"); // 只答第 1 题，答错
    const result = await getExamSessionResult(s.trainingId);
    expect(result!.finished).toBe(false);
    expect(result!.answeredCount).toBe(1);
    expect(result!.wrongCount).toBe(1);
    expect(result!.unansweredCount).toBe(2);
    expect(result!.items[1].record).toBeNull();
    expect(result!.items[2].record).toBeNull();
    expect(result!.session.correctCount).toBe(0);
  });

  it("完成的会话 finished=true，结果来自 IndexedDB", async () => {
    const s = await startExamSession([q1.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    await finishExamSession(s.trainingId);
    const result = await getExamSessionResult(s.trainingId);
    expect(result!.finished).toBe(true);
    expect(result!.correctCount).toBe(1);
  });

  it("trainingId 不存在返回 null", async () => {
    expect(await getExamSessionResult("no-such-id")).toBeNull();
  });
});

describe("数据隔离（不触碰学习侧数据）", () => {
  it("真题训练不影响 words / progress / logs 三个 store", async () => {
    const db = await getDB();
    // 预置学习侧数据
    const word = {
      id: "w_test", word: "测试词", pinyin: "cè shì",
      definition: "测试释义", categoryKey: "成语::测试组",
      subcategory: "", examples: [], relatedWords: [], tags: [],
      createdAt: 1, updatedAt: 1,
    };
    await db.put("words", word as never);
    const before = {
      words: await db.getAll("words"),
      progress: await db.getAll("progress"),
      logs: await db.getAll("logs"),
    };
    const s = await startExamSession([q1.id, q2.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    await submitExamAnswer(s.trainingId, q2, "A");
    await finishExamSession(s.trainingId);
    expect(await db.getAll("words")).toEqual(before.words);
    expect(await db.getAll("progress")).toEqual(before.progress);
    expect(await db.getAll("logs")).toEqual(before.logs);
    expect(await db.getAll("quiz_questions")).toEqual([]);
  });

  it("真题题目不写入 quiz_questions store", async () => {
    const s = await startExamSession([q1.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    expect(await getAllQuestions()).toEqual([]);
  });

  it("真题训练后 statsService 统计结果不受影响（真题记录不进入学习统计）", async () => {
    const { getStudyStatistics, getTrend7Days, getStateDistribution } =
      await import("@/lib/statsService");
    const s = await startExamSession([q1.id, q2.id, q3.id]);
    await submitExamAnswer(s.trainingId, q1, q1.answer);
    await submitExamAnswer(s.trainingId, q2, "A");
    await submitExamAnswer(s.trainingId, q3, q3.answer);
    await finishExamSession(s.trainingId);
    const stats = await getStudyStatistics();
    const trend = await getTrend7Days();
    const dist = await getStateDistribution();
    // 无学习数据：统计应全为 0 / 空，真题的 3 条训练记录不得混入
    expect(stats.totalLearnedWords).toBe(0);
    expect(stats.totalReviewCount).toBe(0);
    expect(stats.masteredWords).toBe(0);
    expect(stats.todayLearnedWords).toBe(0);
    expect(stats.streakDays).toBe(0);
    expect(trend.every((d) => d.newCount === 0 && d.reviewCount === 0)).toBe(true);
    expect(
      dist.newCount === 0 && dist.learning === 0 && dist.reviewing === 0 && dist.relearning === 0,
    ).toBe(true);
  });
});
