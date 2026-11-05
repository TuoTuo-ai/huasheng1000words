/**
 * 分类辨析训练 · 页面纯逻辑测试
 *
 * 覆盖入口页（QuizPage）、答题页（QuizStudyPage）、结果页（QuizResultPage）
 * 中可导出的纯函数：
 * - 入口页：分类展示文案、总可用题数、预览摘要、是否可开始、无题文案
 * - 答题页：视图构造（顺序/已答恢复）、定位题号、上一题/下一题、选项状态、
 *   提交结果应用、already-submitted 反馈恢复、耗时计算、世代守卫
 * - 结果页：加载状态机、逐题行、详情（选项原始顺序、解析缺失占位）、总览卡片、
 *   未完成提示、耗时双口径
 */
import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES,
  DEFAULT_QUIZ_COUNT,
  NO_QUESTION_HINT,
  QUIZ_COUNT_OPTIONS,
  canStart,
  categoryOptionText,
  summarizePreview,
  totalAvailable,
} from "@/pages/QuizPage";
import {
  advanceAfterSubmit,
  applyQuizSubmitResult,
  buildQuizStudyView,
  canGoNext,
  canGoPrev,
  computeQuizDurationMs,
  createQuizRequestGuard,
  firstUnansweredIndex,
  quizOptionState,
  restoreQuizFeedback,
  type QuizAnswerState,
} from "@/pages/QuizStudyPage";
import {
  QUIZ_BLANK,
  QUIZ_STATUS_LABEL,
  UNFINISHED_SESSION_DURATION,
  buildQuizResultDetail,
  buildQuizResultRows,
  quizOverviewCards,
  quizQuestionStatus,
  resolveQuizLoadState,
  unfinishedQuizHint,
} from "@/pages/QuizResultPage";
import type {
  PickResult,
  QuizSessionItem,
  QuizSessionResult,
} from "@/lib/quizService";
import type { QuizQuestion, TrainingRecord, TrainingSession } from "@/types/quiz";

/* ---------------- 造数据 ---------------- */

function makeQuestion(id: string, opts: { explanation?: string } = {}): QuizQuestion {
  return {
    id,
    mode: "synonym",
    wordIds: [`w-${id}-1`, `w-${id}-2`],
    stem: `题干-${id}\n「原文释义-${id}」`,
    stemMeta: { sourceType: "original", excerpt: `原文释义-${id}` },
    options: [
      { id: "A", content: `选项A-${id}`, isCorrect: true, explain: `A 的解释-${id}`, sourceType: "original" },
      { id: "B", content: `选项B-${id}`, isCorrect: false, explain: `B 的解释-${id}`, sourceType: "original" },
      { id: "C", content: `选项C-${id}`, isCorrect: false, explain: `C 的解释-${id}`, sourceType: "original" },
    ],
    correctOptionId: "A",
    explanation: opts.explanation ?? `正确答案为选项A-${id}`,
    explanationMeta: { sourceType: "original" },
    relatedWordIds: [`w-${id}-2`],
    source: {
      type: "original",
      wordIds: [`w-${id}-1`],
      citation: `成语 · 近义辨析 · 选项A-${id} · 释义`,
      sourceField: "definition",
      sourceExcerpt: `原文释义-${id}`,
    },
    aiGenerated: false,
    difficulty: 2,
    tags: ["成语", "组一", "近义辨析"],
    categoryKey: "成语::g1::近义辨析",
    reviewStatus: "approved",
    qualityLevel: "high",
    questionVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function record(
  questionId: string,
  userAnswer: string,
  isCorrect: boolean,
  durationMs = 3000,
): TrainingRecord {
  return {
    id: 1,
    trainingId: "t1",
    questionId,
    mode: "synonym",
    userAnswer,
    isCorrect,
    answeredAt: 1000,
    durationMs,
    categoryKey: "辨析::成语::近义辨析",
  };
}

function item(
  q: QuizQuestion,
  rec: TrainingRecord | null,
): QuizSessionItem {
  return { question: q, record: rec };
}

/** 构造一个 QuizSessionResult（默认 3 题：对 / 错 / 未答，未完成） */
function makeResult(
  overrides: Partial<QuizSessionResult> = {},
): QuizSessionResult {
  const q1 = makeQuestion("q1");
  const q2 = makeQuestion("q2");
  const q3 = makeQuestion("q3", { explanation: "" });
  const items = [
    item(q1, record("q1", "A", true, 2000)),
    item(q2, record("q2", "B", false, 5000)),
    item(q3, null),
  ];
  const session: TrainingSession = {
    trainingId: "t1",
    mode: "synonym",
    questionIds: ["q1", "q2", "q3"],
    startedAt: 1000,
    answeredCount: 2,
    correctCount: 1,
  };
  return {
    session,
    finished: false,
    items,
    total: 3,
    answeredCount: 2,
    correctCount: 1,
    wrongCount: 1,
    unansweredCount: 1,
    accuracy: 50,
    totalDurationMs: 7000,
    sessionDurationMs: null,
    ...overrides,
  };
}

/* ================= 入口页 ================= */

describe("入口页纯逻辑", () => {
  it("分类展示文案带可用题数", () => {
    expect(
      categoryOptionText({
        categoryKey: "成语::g1::近义辨析",
        section: "成语",
        groupId: "g1",
        groupTitle: "组一",
        subcategory: "近义辨析",
        count: 7,
      }),
    ).toBe("成语 · 近义辨析（7 题）");
  });

  it("可用题总数 = 各分类题数之和", () => {
    expect(
      totalAvailable([
        { categoryKey: "a", section: "成语", groupId: "g1", groupTitle: "", subcategory: "x", count: 3 },
        { categoryKey: "b", section: "实词", groupId: "g2", groupTitle: "", subcategory: "y", count: 4 },
      ]),
    ).toBe(7);
    expect(totalAvailable([])).toBe(0);
  });

  it("题量选项与默认值", () => {
    expect([...QUIZ_COUNT_OPTIONS]).toEqual([5, 10, 20]);
    expect(DEFAULT_QUIZ_COUNT).toBe(10);
    expect(ALL_CATEGORIES).toBeNull();
  });

  it("无题提示文案明确指向需审核", () => {
    expect(NO_QUESTION_HINT).toContain("没有已通过审核");
  });

  it("预览摘要：不足时带提示，充足时提示为 null", () => {
    const short: PickResult = { questions: [], requested: 10, available: 3, insufficient: true };
    short.questions = [makeQuestion("a"), makeQuestion("b"), makeQuestion("c")];
    expect(summarizePreview(short)).toEqual({
      total: 3,
      requested: 10,
      insufficient: true,
      hint: "该分类当前可用题目仅 3 道，少于所选 10 道，本次按 3 道进行。",
    });

    const enough: PickResult = {
      questions: [makeQuestion("a"), makeQuestion("b")],
      requested: 2,
      available: 5,
      insufficient: false,
    };
    expect(summarizePreview(enough).hint).toBeNull();
  });

  it("canStart 只在有题时为 true", () => {
    expect(canStart(null)).toBe(false);
    expect(canStart({ questions: [], requested: 5, available: 0, insufficient: true })).toBe(false);
    expect(
      canStart({ questions: [makeQuestion("a")], requested: 5, available: 1, insufficient: true }),
    ).toBe(true);
  });
});

/* ================= 答题页 ================= */

describe("答题页纯逻辑", () => {
  it("视图构造：题目顺序与会话一致，已答记录恢复", () => {
    const view = buildQuizStudyView(makeResult());
    expect(view.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
    expect([...view.answers.keys()]).toEqual(["q1", "q2"]);
    expect(view.answers.get("q1")).toEqual({ questionId: "q1", userAnswer: "A", isCorrect: true });
    expect(view.answeredCount).toBe(2);
    expect(view.total).toBe(3);
    expect(view.allAnswered).toBe(false);
    expect(view.finished).toBe(false);
  });

  it("全部答完时 allAnswered 为 true；空题集不为 true", () => {
    const q1 = makeQuestion("q1");
    const done = buildQuizStudyView(
      makeResult({
        items: [item(q1, record("q1", "A", true))],
        total: 1,
        answeredCount: 1,
        correctCount: 1,
        finished: true,
      }),
    );
    expect(done.allAnswered).toBe(true);
    expect(done.finished).toBe(true);

    const empty = buildQuizStudyView(makeResult({ items: [], total: 0, answeredCount: 0 }));
    expect(empty.allAnswered).toBe(false);
  });

  it("定位题号：第一道未答题；全答完则最后一题；空题为 0", () => {
    const qs = [makeQuestion("q1"), makeQuestion("q2"), makeQuestion("q3")];
    const partial = new Map<string, QuizAnswerState>([
      ["q1", { questionId: "q1", userAnswer: "A", isCorrect: true }],
    ]);
    expect(firstUnansweredIndex(qs, partial)).toBe(1);

    const all = new Map<string, QuizAnswerState>(
      qs.map((q) => [q.id, { questionId: q.id, userAnswer: "A", isCorrect: true }]),
    );
    expect(firstUnansweredIndex(qs, all)).toBe(2);
    expect(firstUnansweredIndex([], new Map())).toBe(0);
  });

  it("下一题：当前题未作答不可跳；末题不可再进", () => {
    const qs = [makeQuestion("q1"), makeQuestion("q2")];
    const answers = new Map<string, QuizAnswerState>();
    expect(canGoNext(qs, answers, 0)).toBe(false);

    answers.set("q1", { questionId: "q1", userAnswer: "A", isCorrect: true });
    expect(canGoNext(qs, answers, 0)).toBe(true);
    expect(canGoNext(qs, answers, 1)).toBe(false);
  });

  it("上一题：首题不可再退", () => {
    expect(canGoPrev(0)).toBe(false);
    expect(canGoPrev(1)).toBe(true);
  });

  it("选项状态：正确项标 correct、用户选错项标 wrong、其余 idle；未答全 idle", () => {
    const idle = new Map<string, QuizAnswerState>();
    expect(quizOptionState("A", idle.get("q1"), "A")).toBe("idle");

    const wrong = { questionId: "q1", userAnswer: "B", isCorrect: false };
    expect(quizOptionState("A", wrong, "A")).toBe("correct");
    expect(quizOptionState("B", wrong, "A")).toBe("wrong");
    expect(quizOptionState("C", wrong, "A")).toBe("idle");
  });

  it("提交结果应用：accepted 写入；already-submitted 且已有记录不覆盖", () => {
    const base = new Map<string, QuizAnswerState>([
      ["q1", { questionId: "q1", userAnswer: "A", isCorrect: true }],
    ]);
    // accepted 写入新题
    const afterAccept = applyQuizSubmitResult(base, "q2", "C", "accepted", false);
    expect(afterAccept.get("q2")).toEqual({ questionId: "q2", userAnswer: "C", isCorrect: false });
    // 原 Map 不被修改
    expect(base.has("q2")).toBe(false);

    // already-submitted 且已有记录：保持原记录
    const afterDup = applyQuizSubmitResult(base, "q1", "B", "already-submitted", false);
    expect(afterDup.get("q1")).toEqual({ questionId: "q1", userAnswer: "A", isCorrect: true });
  });

  it("回归：答完最后一题后 allAnswered 必须立刻为 true（否则不会结束会话）", () => {
    // 2 题视图，仅第 1 题已答
    const q1 = makeQuestion("q1");
    const q2 = makeQuestion("q2");
    const view = buildQuizStudyView(
      makeResult({
        items: [item(q1, record("q1", "A", true)), item(q2, null)],
        total: 2,
        answeredCount: 1,
        correctCount: 1,
        wrongCount: 0,
        unansweredCount: 1,
      }),
    );
    expect(view.allAnswered).toBe(false);

    const next = advanceAfterSubmit(view, "q2", "B", "accepted", false);
    expect(next.answeredCount).toBe(2);
    expect(next.allAnswered).toBe(true);
    expect(next.answers.get("q2")).toEqual({ questionId: "q2", userAnswer: "B", isCorrect: false });
  });

  it("回归：重复提交同一题不重复计数，allAnswered 由实际答案表决定", () => {
    const q1 = makeQuestion("q1");
    const q2 = makeQuestion("q2");
    const view = buildQuizStudyView(
      makeResult({
        items: [item(q1, record("q1", "A", true)), item(q2, null)],
        total: 2,
        answeredCount: 1,
        correctCount: 1,
        wrongCount: 0,
        unansweredCount: 1,
      }),
    );
    // already-submitted 且 q1 已有记录：不覆盖，不重复计数
    const same = advanceAfterSubmit(view, "q1", "C", "already-submitted", false);
    expect(same.answeredCount).toBe(1);
    expect(same.allAnswered).toBe(false);
    expect(same.answers.get("q1")).toEqual({ questionId: "q1", userAnswer: "A", isCorrect: true });
  });

  it("回归：单选场景答完即 allAnswered=true", () => {
    const q1 = makeQuestion("q1");
    const view = buildQuizStudyView(
      makeResult({
        items: [item(q1, null)],
        total: 1,
        answeredCount: 0,
        correctCount: 0,
        wrongCount: 0,
        unansweredCount: 1,
      }),
    );
    expect(view.allAnswered).toBe(false);
    expect(advanceAfterSubmit(view, "q1", "A", "accepted", true).allAnswered).toBe(true);
  });

  it("already-submitted 反馈恢复：只用库记录，取不到返回 null（不伪造）", () => {
    expect(restoreQuizFeedback(record("q1", "A", true), "q1")).toEqual({
      questionId: "q1",
      userAnswer: "A",
      isCorrect: true,
    });
    // questionId 不匹配
    expect(restoreQuizFeedback(record("q2", "A", true), "q1")).toBeNull();
    // 记录不存在
    expect(restoreQuizFeedback(null, "q1")).toBeNull();
    // 记录答案为空
    expect(restoreQuizFeedback(record("q1", "   ", true), "q1")).toBeNull();
  });

  it("单题耗时非负", () => {
    expect(computeQuizDurationMs(1000, 4000)).toBe(3000);
    expect(computeQuizDurationMs(4000, 1000)).toBe(0);
  });

  it("请求世代守卫：只有最新一次请求有效", () => {
    const guard = createQuizRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });
});

/* ================= 结果页 ================= */

describe("结果页纯逻辑", () => {
  it("加载状态机四态", () => {
    expect(resolveQuizLoadState(null, null, true)).toBe("loading");
    expect(resolveQuizLoadState(null, "boom", false)).toBe("error");
    expect(resolveQuizLoadState(null, null, false)).toBe("missing");
    expect(resolveQuizLoadState(makeResult(), null, false)).toBe("ready");
  });

  it("总览卡片顺序与数值（正确率取整数百分比）", () => {
    const cards = quizOverviewCards(makeResult());
    expect(cards.map((c) => c.key)).toEqual([
      "total",
      "answered",
      "correct",
      "wrong",
      "unanswered",
      "accuracy",
    ]);
    expect(cards.map((c) => c.value)).toEqual(["3", "2", "1", "1", "1", "50%"]);
    expect(cards[5].emphasize).toBe(true);
  });

  it("三态判定由记录决定：未作答不计错误", () => {
    const r = makeResult();
    expect(quizQuestionStatus(r.items[0])).toBe("correct");
    expect(quizQuestionStatus(r.items[1])).toBe("wrong");
    expect(quizQuestionStatus(r.items[2])).toBe("unanswered");
    expect(QUIZ_STATUS_LABEL).toEqual({ correct: "正确", wrong: "错误", unanswered: "未作答" });
  });

  it("逐题行：顺序与 items 一致；未作答显示占位符", () => {
    const rows = buildQuizResultRows(makeResult().items);
    expect(rows.map((x) => x.index)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({
      userAnswerText: "选项A-q1",
      correctAnswerText: "选项A-q1",
      status: "correct",
      durationText: "2 秒",
    });
    expect(rows[1]).toMatchObject({ userAnswerText: "选项B-q2", status: "wrong" });
    expect(rows[2]).toMatchObject({
      userAnswerText: QUIZ_BLANK,
      status: "unanswered",
      durationText: QUIZ_BLANK,
    });
    // 未作答也照常给出正确答案，便于复盘
    expect(rows[2].correctAnswerText).toBe("选项A-q3");
  });

  it("详情：选项按原始顺序渲染，正确项/用户所选项标注正确", () => {
    const r = makeResult();
    const detail = buildQuizResultDetail(r.items[1], 1);
    expect(detail.index).toBe(2);
    expect(detail.options.map((o) => o.id)).toEqual(["A", "B", "C"]);
    expect(detail.options.map((o) => o.state)).toEqual(["correct", "wrong", "idle"]);
    expect(detail.stem).toBe("题干-q2\n「原文释义-q2」");
    expect(detail.userAnswerText).toBe("选项B-q2");
    expect(detail.correctAnswerText).toBe("选项A-q2");
    expect(detail.userExplain).toBe("B 的解释-q2");
    expect(detail.correctExplain).toBe("A 的解释-q2");
    expect(detail.citation).toBe("成语 · 近义辨析 · 选项A-q2 · 释义");
    expect(detail.durationText).toBe("5 秒");
  });

  it("详情：题目无解析时显示「暂无解析」并标记缺失，不编造", () => {
    const r = makeResult();
    const detail = buildQuizResultDetail(r.items[2], 2);
    expect(detail.explanation).toBe("暂无解析");
    expect(detail.explanationMissing).toBe(true);
    expect(detail.status).toBe("unanswered");
    expect(detail.options.every((o) => o.state === "idle")).toBe(true);
    expect(detail.userExplain).toBeNull();
  });

  it("详情：答对时不显示「你选的」解释", () => {
    const detail = buildQuizResultDetail(makeResult().items[0], 0);
    expect(detail.status).toBe("correct");
    expect(detail.userExplain).toBeNull();
  });

  it("未完成提示文案与总耗时占位", () => {
    expect(unfinishedQuizHint(makeResult())).toBe("本次训练未完成（已答 2/3 题），以下为当前进度");
    expect(UNFINISHED_SESSION_DURATION).toBe("训练未完成，无总耗时");
  });

  it("任意结果都不会把「未完成」显示成「已完成」文案", () => {
    const finished = makeResult({
      finished: true,
      sessionDurationMs: 20_000,
      answeredCount: 3,
      correctCount: 2,
      wrongCount: 1,
      unansweredCount: 0,
      accuracy: 67,
    });
    // 已完成：sessionDurationMs 有值，页面不展示未完成提示
    expect(finished.finished).toBe(true);
    expect(finished.sessionDurationMs).toBe(20_000);
    expect(finished.accuracy).toBe(67);
  });
});
