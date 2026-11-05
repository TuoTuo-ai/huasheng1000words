/**
 * 真题结果页测试（3d-b 骨架 + 3d-c 逐题列表与内联详情）
 *
 * 覆盖：
 * - 逐题列表（R7~R10）：行内容与顺序、三态徽标、答案显示、展开/收起、未作答详情、只读
 * - D 组（方案 9.2）：D1~D5 逐题状态、选项原始顺序、空解析、详情选项三态
 * - 加载状态机（loading / error / missing / empty / ready）
 * - 总览 / 篇章卡片映射（口径全部来自 @/lib/examStats，页面不重复实现）
 * - 未完成会话提示文案与「继续答题」路径
 * - 只读与隔离：源码静态断言（无写库 / 无 finish / 无题型统计 / 无错题重练 / 无详情子路由）
 * - 路由接线：/exam/result/:trainingId
 * - 刷新恢复：同一 trainingId 多次读取不改变库内数据
 *
 * 说明：项目无 DOM 环境（vitest environment=node，无 testing-library），
 * 因此页面行为以「可导出纯函数真实断言 + 真实 IndexedDB 端到端 + 源码静态断言」验证。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  BLANK_PLACEHOLDER,
  EMPTY_SECTION_HINT,
  UNFINISHED_DURATION_HINT,
  STATUS_LABEL,
  STATUS_STYLE,
  buildResultDetail,
  buildResultRows,
  examContinuePath,
  examResultPath,
  optionClass,
  overviewCards,
  resolveLoadState,
  sectionCards,
  unfinishedHint,
} from "@/pages/ExamResultPage";
import {
  computeDurationStats,
  computeOverview,
  computeSectionStats,
  durationOf,
  explanationText,
  formatDuration,
  optionState,
} from "@/lib/examStats";
import {
  ExamDataError,
  getExamSessionResult,
  resetExamCacheForTest,
  startExamSession,
  submitExamAnswer,
} from "@/lib/examService";
import { resetDBForTest, getDB } from "@/db/database";
import examJson from "../../../data/exam_questions.json";
/** vite ?raw 动态导入源码文本（静态 import 无法在 node 环境解析 .tsx?raw） */
async function readSource(path: string): Promise<string> {
  const mod = (await import(/* @vite-ignore */ path)) as { default: string };
  return mod.default;
}

/**
 * 去掉注释后再做「禁用词」断言：文件头注释会说明「不调用 finishExamSession」「不迁移 optionState」
 * 等约束，直接包含匹配会误报（3b/3c 静态测试同类坑）。
 * 只剔除块注释与行注释，保留代码本体。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
import type { ExamQuestion } from "@/types/exam";
import type { ExamSessionResult } from "@/lib/examService";

const questions = examJson as ExamQuestion[];

/** 取指定篇章的前 n 题 */
function pick(section: "成语" | "实词", n: number): ExamQuestion[] {
  return questions.filter((q) => q.section === section).slice(0, n);
}

const wrongOf = (q: ExamQuestion) => (q.answer === "A" ? "B" : "A");

beforeEach(async () => {
  resetExamCacheForTest();
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
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

/** 真实建会话并作答：answerPlan[i] = "correct" | "wrong" | "skip" */
async function buildSession(
  picked: ExamQuestion[],
  answerPlan: ("correct" | "wrong" | "skip")[],
  startedAt = 1_700_000_000_000,
): Promise<string> {
  const session = await startExamSession(
    picked.map((q) => q.id),
    { startedAt },
  );
  for (let i = 0; i < picked.length; i += 1) {
    const plan = answerPlan[i];
    if (plan === "skip") continue;
    const q = picked[i];
    await submitExamAnswer(session.trainingId, q, plan === "correct" ? q.answer : wrongOf(q), {
      submittedAt: startedAt + 1_000 * (i + 1),
      durationMs: 5_000,
    });
  }
  return session.trainingId;
}

/* ============================== 状态机 ============================== */

describe("R1 加载状态机", () => {
  it("loading 优先：加载中即使无数据也显示加载态", () => {
    expect(resolveLoadState(null, null, true)).toBe("loading");
    expect(resolveLoadState(null, "err", true)).toBe("loading");
  });

  it("error：有错误信息时进入错误态", () => {
    expect(resolveLoadState(null, "成绩加载失败", false)).toBe("error");
  });

  it("missing：无错误且结果为 null → 会话不存在", () => {
    expect(resolveLoadState(null, null, false)).toBe("missing");
  });

  it("empty：会话存在但 items 为空 → 空数据态", () => {
    const empty = { items: [], finished: false } as unknown as ExamSessionResult;
    expect(resolveLoadState(empty, null, false)).toBe("empty");
  });

  it("ready：有题目数据 → 正常态", () => {
    const ready = {
      items: [{ question: questions[0], record: null }],
      finished: false,
    } as unknown as ExamSessionResult;
    expect(resolveLoadState(ready, null, false)).toBe("ready");
  });
});

/* ============================== 总览卡片 ============================== */

describe("R2 成绩总览卡片", () => {
  it("六项指标顺序固定，正确率带 % 且高亮", () => {
    const overview = computeOverview(
      pick("成语", 4).map((q, i) => ({
        question: q,
        record:
          i < 3
            ? {
                trainingId: "t",
                questionId: q.id,
                mode: "exam" as const,
                userAnswer: q.answer,
                isCorrect: true,
                answeredAt: 0,
                durationMs: 1_000,
                categoryKey: "真题::成语",
              }
            : null,
      })),
    );
    const cards = overviewCards(overview);
    expect(cards.map((c) => c.key)).toEqual([
      "total",
      "answered",
      "correct",
      "wrong",
      "unanswered",
      "accuracy",
    ]);
    expect(cards.map((c) => c.label)).toEqual([
      "总题数",
      "已答",
      "正确",
      "错误",
      "未答",
      "正确率",
    ]);
    expect(cards[0].value).toBe("4");
    expect(cards[1].value).toBe("3");
    expect(cards[2].value).toBe("3");
    expect(cards[3].value).toBe("0");
    expect(cards[4].value).toBe("1");
    expect(cards[5].value).toBe("100%");
    expect(cards[5].emphasize).toBe(true);
  });

  it("10 对 5 错 5 未答：正确率展示为 67%，不是 66.67%", () => {
    const overview = {
      total: 20,
      answered: 15,
      correct: 10,
      wrong: 5,
      unanswered: 5,
      accuracy: 67,
    };
    const cards = overviewCards(overview);
    expect(cards[5].value).toBe("67%");
    expect(cards[5].value).not.toContain(".");
  });

  it("卡片数值与 examStats 口径一致（真实会话）", async () => {
    const picked = pick("成语", 5);
    const id = await buildSession(picked, ["correct", "correct", "wrong", "skip", "skip"]);
    const result = await getExamSessionResult(id);
    const overview = computeOverview(result!.items);
    const cards = overviewCards(overview);
    expect(cards[0].value).toBe("5");
    expect(cards[1].value).toBe("3");
    expect(cards[2].value).toBe("2");
    expect(cards[3].value).toBe("1");
    expect(cards[4].value).toBe("2");
    expect(cards[5].value).toBe("67%"); // 2/3 = 66.67 → 67
  });
});

/* ============================== 篇章统计 ============================== */

describe("R3 篇章统计卡片", () => {
  it("固定两条：成语、实词，顺序不变", () => {
    const cards = sectionCards(computeSectionStats([]));
    expect(cards.map((c) => c.section)).toEqual(["成语", "实词"]);
  });

  it("空篇章：isEmpty 为 true，仍显示 0% 与提示文案", () => {
    const items = pick("成语", 2).map((q) => ({ question: q, record: null }));
    const cards = sectionCards(computeSectionStats(items));
    const shici = cards.find((c) => c.section === "实词")!;
    expect(shici.isEmpty).toBe(true);
    expect(shici.total).toBe(0);
    expect(shici.accuracyText).toBe("0%");
    expect(EMPTY_SECTION_HINT).toBe("本次试卷未包含该篇题目");
  });

  it("两篇混合：各自指标独立正确（真实会话）", async () => {
    const picked = [...pick("成语", 3), ...pick("实词", 2)];
    const id = await buildSession(picked, ["correct", "wrong", "skip", "correct", "correct"]);
    const result = await getExamSessionResult(id);
    const cards = sectionCards(computeSectionStats(result!.items));
    const cz = cards.find((c) => c.section === "成语")!;
    const sc = cards.find((c) => c.section === "实词")!;
    expect(cz).toMatchObject({
      isEmpty: false,
      total: 3,
      answered: 2,
      correct: 1,
      wrong: 1,
      unanswered: 1,
      accuracyText: "50%",
    });
    expect(sc).toMatchObject({
      isEmpty: false,
      total: 2,
      answered: 2,
      correct: 2,
      wrong: 0,
      unanswered: 0,
      accuracyText: "100%",
    });
  });

  it("篇章合计等于总览（页面两块数字同源）", async () => {
    const picked = [...pick("成语", 3), ...pick("实词", 2)];
    const id = await buildSession(picked, ["correct", "wrong", "skip", "correct", "correct"]);
    const result = await getExamSessionResult(id);
    const cards = sectionCards(computeSectionStats(result!.items));
    const overview = computeOverview(result!.items);
    const sum = (k: "total" | "answered" | "correct" | "wrong" | "unanswered") =>
      cards.reduce((acc, c) => acc + c[k], 0);
    expect(sum("total")).toBe(overview.total);
    expect(sum("answered")).toBe(overview.answered);
    expect(sum("correct")).toBe(overview.correct);
    expect(sum("wrong")).toBe(overview.wrong);
    expect(sum("unanswered")).toBe(overview.unanswered);
  });
});

/* ============================== 未完成会话 ============================== */

describe("R4 未完成会话处理", () => {
  it("提示文案包含已答/总题数", () => {
    const text = unfinishedHint({
      total: 20,
      answered: 7,
      correct: 5,
      wrong: 2,
      unanswered: 13,
      accuracy: 71,
    });
    expect(text).toContain("未完成");
    expect(text).toContain("7/20");
  });

  it("继续答题路径指向答题页，不新增路由", () => {
    expect(examContinuePath("abc")).toBe("/exam/study/abc");
    expect(examResultPath("abc")).toBe("/exam/result/abc");
  });

  it("未完成会话可读取完整 items（不阻断展示、不自动 finish）", async () => {
    const picked = pick("成语", 4);
    const id = await buildSession(picked, ["correct", "skip", "skip", "skip"]);
    const result = await getExamSessionResult(id);
    expect(result!.finished).toBe(false);
    expect(result!.items).toHaveLength(4);
    const overview = computeOverview(result!.items);
    expect(overview.answered).toBe(1);
    expect(overview.unanswered).toBe(3);
    // 会话未被结束：finishedAt 仍为空
    const db = await getDB();
    const session = (await db.get("training_sessions", id))!;
    expect(session.finishedAt).toBeUndefined();
  });
});

/* ============================== 只读与隔离（静态） ============================== */

describe("R5 只读与隔离声明", () => {
  it("页面不引入任何写入 / 结束接口", async () => {
    const resultPageSource = stripComments(
      await readSource("@/pages/ExamResultPage.tsx?raw"),
    );
    for (const banned of [
      "startExamSession",
      "submitExamAnswer",
      "finishExamSession",
      "quizRepository",
      "putSession",
      "putRecord",
      "addTrainingRecord",
    ]) {
      expect(resultPageSource).not.toContain(banned);
    }
  });

  it("页面不触碰 FSRS / 词汇统计 / 辨析训练", async () => {
    const resultPageSource = stripComments(
      await readSource("@/pages/ExamResultPage.tsx?raw"),
    );
    for (const banned of ["@/lib/fsrs", "studyService", "wordRepository", "statsService", "quizAdminService"]) {
      expect(resultPageSource).not.toContain(banned);
    }
  });

  it("统计来自 @/lib/examStats，页面不自行实现公式", async () => {
    const resultPageSource = await readSource("@/pages/ExamResultPage.tsx?raw");
    expect(resultPageSource).toContain('from "@/lib/examStats"');
    expect(resultPageSource).toContain("computeOverview");
    expect(resultPageSource).toContain("computeSectionStats");
    // 不重复实现：页面源码中不出现 Math.round 形式的正确率公式
    expect(resultPageSource).not.toContain("Math.round");
    expect(resultPageSource).not.toContain("/ answered");
  });

  it("不迁移 3c 纯函数：不从 ExamStudyPage import，optionState/explanationText 取自 examStats", async () => {
    const resultPageSource = stripComments(
      await readSource("@/pages/ExamResultPage.tsx?raw"),
    );
    expect(resultPageSource).not.toContain("@/pages/ExamStudyPage");
    // 3d-c 起详情需要选项三态与解析占位：一律来自 examStats，不自行实现、不复用 3c 页面
    expect(resultPageSource).not.toContain("judgeExamAnswer");
    expect(resultPageSource).toContain('from "@/lib/examStats"');
  });

  it("无题型统计块、无错题重练入口", async () => {
    const resultPageSource = stripComments(
      await readSource("@/pages/ExamResultPage.tsx?raw"),
    );
    expect(resultPageSource).not.toContain("单空 · 多空");
    expect(resultPageSource).not.toContain("单空/多空");
    expect(resultPageSource).not.toContain("错题重练");
  });

  it("详情为内联展开：不新增子路由", async () => {
    const appSource = await readSource("@/App.tsx?raw");
    expect(appSource).not.toContain("/exam/result/:trainingId/:questionId");
    // 真题模块路由固定（3d-c 不新增路由）；总数 18 = 真题 15 条 + 辨析训练 3 条（/quiz、/quiz/study、/quiz/result）
    const routeCount = (appSource.match(/<Route\b/g) ?? []).length;
    expect(routeCount).toBe(18);
  });

  it("未完成时才显示继续答题入口", async () => {
    const resultPageSource = await readSource("@/pages/ExamResultPage.tsx?raw");
    expect(resultPageSource).toContain("!finished");
    expect(resultPageSource).toContain("继续答题");
    expect(resultPageSource).toContain("examContinuePath(trainingId)");
  });
});

/* ============================== 路由与刷新 ============================== */

describe("R6 路由与刷新恢复", () => {
  it("App 注册 /exam/result/:trainingId 且指向 ExamResultPage", async () => {
    const appSource = await readSource("@/App.tsx?raw");
    expect(appSource).toContain('path="/exam/result/:trainingId"');
    expect(appSource).toContain("ExamResultPage");
  });

  it("不覆盖既有答题页路由", async () => {
    const appSource = await readSource("@/App.tsx?raw");
    expect(appSource).toContain('path="/exam/study/:trainingId"');
  });

  it("同一 trainingId 读取三次：数据不变、不产生新记录（刷新等价）", async () => {
    const picked = pick("成语", 3);
    const id = await buildSession(picked, ["correct", "wrong", "skip"]);
    const before = await getExamSessionResult(id);
    const db = await getDB();
    const recordsBefore = (await db.getAllFromIndex("training_records", "by-trainingId", id)).length;

    const second = await getExamSessionResult(id);
    const third = await getExamSessionResult(id);

    const key = (r: ExamSessionResult) =>
      JSON.stringify({
        finished: r.finished,
        answered: r.answeredCount,
        correct: r.correctCount,
        items: r.items.map((it) => [it.question.id, it.record?.userAnswer ?? null]),
      });
    expect(key(second!)).toBe(key(before!));
    expect(key(third!)).toBe(key(before!));

    const recordsAfter = (await db.getAllFromIndex("training_records", "by-trainingId", id)).length;
    expect(recordsAfter).toBe(recordsBefore);
    const sessions = await db.getAll("training_sessions");
    expect(sessions.filter((s) => s.trainingId === id)).toHaveLength(1);
  });

  it("不存在的 trainingId 返回 null（页面显示会话不存在）", async () => {
    const result = await getExamSessionResult("not-a-real-id");
    expect(result).toBeNull();
    expect(resolveLoadState(result, null, false)).toBe("missing");
  });
});

/* ============================== 3d-c：逐题列表 ============================== */

describe("R7 逐题列表：内容与顺序", () => {
  it("行数等于 items 数，序号为试卷内 1 起，顺序严格等于 items", async () => {
    const picked = pick("成语", 4);
    const id = await buildSession(picked, ["correct", "wrong", "skip", "correct"]);
    const result = await getExamSessionResult(id);
    const durations = computeDurationStats(result!.session, result!.items);
    const rows = buildResultRows(result!.items, (qid) => durationOf(durations, qid));

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.questionId)).toEqual(picked.map((q) => q.id));
    // 序号是试卷内序号，不是 questionNumber（用第 4 题验证）
    expect(rows[3].index).toBe(4);
  });

  it("每行包含考试来源、题型、篇章", async () => {
    const picked = pick("实词", 1);
    const id = await buildSession(picked, ["correct"]);
    const result = await getExamSessionResult(id);
    const rows = buildResultRows(result!.items, () => null);
    expect(rows[0].examSource).toBe(picked[0].examSource);
    expect(rows[0].questionType).toBe(picked[0].questionType);
    expect(rows[0].section).toBe("实词");
  });

  it("已答行显示用户答案与正确答案；未答行用户答案为「—」但正确答案照常显示", async () => {
    const picked = pick("成语", 3);
    const id = await buildSession(picked, ["wrong", "skip", "correct"]);
    const result = await getExamSessionResult(id);
    const rows = buildResultRows(result!.items, () => 5_000);

    // 第 1 题答错：用户答案为所选错误项
    expect(rows[0].userAnswerText).not.toBe(picked[0].answer);
    expect(rows[0].correctAnswer).toBe(picked[0].answer);
    // 第 2 题未答
    expect(rows[1].userAnswerText).toBe(BLANK_PLACEHOLDER);
    expect(rows[1].correctAnswer).toBe(picked[1].answer);
    // 第 3 题答对：用户答案 === 正确答案
    expect(rows[2].userAnswerText).toBe(picked[2].answer);
    expect(rows[2].correctAnswer).toBe(picked[2].answer);
  });

  it("用时列：已答显示秒数，未答显示「—」且不显示 0 秒", async () => {
    const picked = pick("成语", 2);
    const id = await buildSession(picked, ["correct", "skip"]);
    const result = await getExamSessionResult(id);
    const durations = computeDurationStats(result!.session, result!.items);
    const rows = buildResultRows(result!.items, (qid) => durationOf(durations, qid));
    expect(rows[0].durationText).toBe("5 秒");
    expect(rows[1].durationText).toBe(BLANK_PLACEHOLDER);
    expect(rows[1].durationText).not.toBe("0 秒");
  });
});

describe("R8 三态徽标：答对 / 答错 / 未作答严格区分", () => {
  it("D1 3 题 1 对 1 错 1 未答：状态分别为 correct / wrong / unanswered", async () => {
    const picked = pick("成语", 3);
    const id = await buildSession(picked, ["correct", "wrong", "skip"]);
    const result = await getExamSessionResult(id);
    const rows = buildResultRows(result!.items, () => null);
    expect(rows.map((r) => r.status)).toEqual(["correct", "wrong", "unanswered"]);
    expect(rows.map((r) => r.statusLabel)).toEqual(["正确", "错误", "未作答"]);
    // 未答 record 必为 null
    expect(result!.items[2].record).toBeNull();
  });

  it("D2 未答与答错严格区分：未答 record===null；答错 record!==null 且 !isCorrect", async () => {
    const picked = pick("成语", 2);
    const id = await buildSession(picked, ["wrong", "skip"]);
    const result = await getExamSessionResult(id);
    const [wrongItem, skipItem] = result!.items;
    expect(skipItem.record).toBeNull();
    expect(wrongItem.record).not.toBeNull();
    expect(wrongItem.record!.isCorrect).toBe(false);
    // 空答案绝不被判为答错：未答状态来自 record 为空，而非 userAnswer 为空串
    const rows = buildResultRows(result!.items, () => null);
    expect(rows[1].status).toBe("unanswered");
    expect(rows[1].status).not.toBe("wrong");
  });

  it("三态文案与样式互不相同", () => {
    expect(STATUS_LABEL).toEqual({ correct: "正确", wrong: "错误", unanswered: "未作答" });
    const styles = [STATUS_STYLE.correct, STATUS_STYLE.wrong, STATUS_STYLE.unanswered];
    expect(new Set(styles).size).toBe(3);
    expect(STATUS_STYLE.correct).toContain("success");
    expect(STATUS_STYLE.wrong).toContain("danger");
    expect(STATUS_STYLE.unanswered).toContain("slate");
  });

  it("全部未答时没有任何行被标为 wrong", async () => {
    const picked = pick("成语", 3);
    const id = await buildSession(picked, ["skip", "skip", "skip"]);
    const result = await getExamSessionResult(id);
    const rows = buildResultRows(result!.items, () => null);
    expect(rows.every((r) => r.status === "unanswered")).toBe(true);
    expect(rows.some((r) => r.status === "wrong")).toBe(false);
  });
});

/* ============================== 3d-c：详情展开 ============================== */

describe("R9 详情内容", () => {
  it("D3 选项保持原始 A/B/C/D 顺序，内容与 JSON 逐字一致", async () => {
    const picked = pick("成语", 1);
    const id = await buildSession(picked, ["wrong"]);
    const result = await getExamSessionResult(id);
    const detail = buildResultDetail(result!.items[0]);
    expect(detail.options.map((o) => o.id)).toEqual(["A", "B", "C", "D"]);
    expect(detail.options.map((o) => o.content)).toEqual(
      picked[0].options.map((o) => o.content),
    );
  });

  it("题干原样保留（不截断、不改写）", async () => {
    const picked = pick("实词", 1);
    const id = await buildSession(picked, ["correct"]);
    const result = await getExamSessionResult(id);
    const detail = buildResultDetail(result!.items[0]);
    expect(detail.questionText).toBe(picked[0].questionText);
    expect(detail.meta).toBe(`${picked[0].section}篇 · ${picked[0].examSource} · ${picked[0].questionType}`);
  });

  it("D4 空解析显示「本题暂无解析」", () => {
    expect(explanationText("")).toBe("本题暂无解析");
    expect(explanationText("   ")).toBe("本题暂无解析");
    expect(explanationText(undefined)).toBe("本题暂无解析");
  });

  it("解析非空时原样展示", async () => {
    const picked = pick("成语", 1);
    const id = await buildSession(picked, ["correct"]);
    const result = await getExamSessionResult(id);
    const detail = buildResultDetail(result!.items[0]);
    // 正式数据解析当前均为空串；非空场景直接验证纯函数
    expect(detail.explanation).toBe(explanationText(picked[0].explanation));
    expect(explanationText("正确项 C，因……")).toBe("正确项 C，因……");
  });

  it("D5 选项三态：正确项 correct、用户错选项 wrong、其余 idle", async () => {
    const picked = pick("成语", 1);
    const q = picked[0];
    const id = await buildSession([q], ["wrong"]);
    const result = await getExamSessionResult(id);
    const detail = buildResultDetail(result!.items[0]);
    const byId = Object.fromEntries(detail.options.map((o) => [o.id, o.state]));
    expect(byId[q.answer]).toBe("correct");
    const userChoice = result!.items[0].record!.userAnswer;
    expect(userChoice).not.toBe(q.answer);
    expect(byId[userChoice]).toBe("wrong");
    const rest = detail.options.filter((o) => o.id !== q.answer && o.id !== userChoice);
    expect(rest.length).toBe(2);
    for (const opt of rest) expect(opt.state).toBe("idle");
  });

  it("判定文案与状态一致：答对 / 答错 / 未作答", async () => {
    const picked = pick("成语", 3);
    const id = await buildSession(picked, ["correct", "wrong", "skip"]);
    const result = await getExamSessionResult(id);
    const details = result!.items.map((it) => buildResultDetail(it));
    expect(details.map((d) => d.verdict)).toEqual(["答对", "答错", "未作答"]);
    expect(details.map((d) => d.status)).toEqual(["correct", "wrong", "unanswered"]);
  });

  it("未作答题目也能展开：详情完整，选项全部 idle，判定为未作答", async () => {
    const picked = pick("成语", 1);
    const id = await buildSession(picked, ["skip"]);
    const result = await getExamSessionResult(id);
    const detail = buildResultDetail(result!.items[0]);
    expect(detail.status).toBe("unanswered");
    expect(detail.verdict).toBe("未作答");
    expect(detail.userAnswerText).toBe(BLANK_PLACEHOLDER);
    expect(detail.correctAnswer).toBe(picked[0].answer);
    expect(detail.questionText).toBe(picked[0].questionText);
    expect(detail.options).toHaveLength(4);
    expect(detail.options.every((o) => o.state === "idle")).toBe(true);
  });

  it("optionState 纯函数边界：未作答全 idle；答对时只有正确项为 correct", () => {
    const answer = { questionId: "x", userAnswer: "A", isCorrect: false };
    expect(optionState("A", null, "C")).toBe("idle");
    expect(optionState("A", answer, "C")).toBe("wrong");
    expect(optionState("C", answer, "C")).toBe("correct");
    expect(optionState("B", answer, "C")).toBe("idle");
    const right = { questionId: "x", userAnswer: "C", isCorrect: true };
    expect(optionState("C", right, "C")).toBe("correct");
    expect(optionState("A", right, "C")).toBe("idle");
  });

  it("选项样式：正确绿、错选红、已答其余灰、未答白", () => {
    expect(optionClass("correct", true)).toContain("success");
    expect(optionClass("wrong", true)).toContain("danger");
    expect(optionClass("idle", true)).toContain("slate-50");
    expect(optionClass("idle", false)).toContain("bg-white");
    expect(optionClass("idle", true)).not.toBe(optionClass("idle", false));
  });
});

/* ============================== 3d-c：展开只读 ============================== */

describe("R10 展开/收起只读，不改变记录", () => {
  it("多次构造详情（等价于多次展开收起）不写库", async () => {
    const picked = pick("成语", 2);
    const id = await buildSession(picked, ["wrong", "skip"]);
    const db = await getDB();
    const before = {
      records: (await db.getAllFromIndex("training_records", "by-trainingId", id)).length,
      sessions: (await db.getAll("training_sessions")).length,
    };
    const result = await getExamSessionResult(id);
    // 模拟反复展开/收起：详情为纯函数，多次调用
    for (let i = 0; i < 5; i += 1) {
      for (const item of result!.items) buildResultDetail(item);
    }
    const after = {
      records: (await db.getAllFromIndex("training_records", "by-trainingId", id)).length,
      sessions: (await db.getAll("training_sessions")).length,
    };
    expect(after).toEqual(before);
    // 会话内容未变
    const stored = (await db.get("training_sessions", id))!;
    expect(stored.finishedAt).toBeUndefined();
    expect(stored.answeredCount).toBe(1);
  });

  it("页面源码展开态用 expandedId state 控制，一次只展开一题", async () => {
    const src = stripComments(await readSource("@/pages/ExamResultPage.tsx?raw"));
    expect(src).toContain("expandedId");
    expect(src).toContain("useState<string | null>(null)");
    // 切换逻辑：已展开则收起，否则展开该题
    expect(src).toContain("expanded ? null : row.questionId");
  });

  it("详情渲染不重新判题：不使用 judgeExamAnswer，判定取 record.isCorrect", async () => {
    const src = stripComments(await readSource("@/pages/ExamResultPage.tsx?raw"));
    expect(src).not.toContain("judgeExamAnswer");
    expect(src).toContain("questionStatus");
  });

  it("不新增详情子路由（仍只有 /exam/result/:trainingId）", async () => {
    const appSource = await readSource("@/App.tsx?raw");
    expect(appSource).toContain('path="/exam/result/:trainingId"');
    expect(appSource).not.toContain("/exam/result/:trainingId/");
  });
});

/* ============================== 3d-d：耗时卡 ============================== */

describe("R11 耗时卡（双口径并列）", () => {
  it("已完成会话：总耗时 = finishedAt - startedAt，与有效答题用时并列且可不同", async () => {
    const picked = pick("成语", 3);
    const startedAt = 1_700_000_000_000;
    const session = await startExamSession(picked.map((q) => q.id), { startedAt });
    for (let i = 0; i < picked.length; i += 1) {
      await submitExamAnswer(session.trainingId, picked[i], picked[i].answer, {
        submittedAt: startedAt + 10_000 * (i + 1),
        durationMs: 8_000,
      });
    }
    const { finishExamSession } = await import("@/lib/examService");
    await finishExamSession(session.trainingId, startedAt + 120_000);

    const result = await getExamSessionResult(session.trainingId);
    const durations = computeDurationStats(result!.session, result!.items);
    expect(durations.totalMs).toBe(120_000);
    expect(formatDuration(durations.totalMs)).toBe("2 分 0 秒");
    expect(durations.activeMs).toBe(24_000); // 3 × 8 秒
    expect(formatDuration(durations.activeMs)).toBe("24 秒");
    // 两口径并列且不等：差值即翻页/停留间隙
    expect(durations.totalMs).not.toBe(durations.activeMs);
  });

  it("未完成会话：总耗时为 null，页面显示占位文案；有效答题用时照常展示", async () => {
    const picked = pick("成语", 2);
    const id = await buildSession(picked, ["correct", "skip"]);
    const result = await getExamSessionResult(id);
    const durations = computeDurationStats(result!.session, result!.items);
    expect(durations.totalMs).toBeNull();
    expect(UNFINISHED_DURATION_HINT).toBe("训练未完成，无总耗时");
    // 未完成会话也正常展示当前已答的有效耗时
    expect(durations.activeMs).toBe(5_000);
    expect(formatDuration(durations.activeMs)).toBe("5 秒");
  });

  it("未答题不计入有效耗时合计", async () => {
    const picked = pick("成语", 4);
    const id = await buildSession(picked, ["correct", "correct", "skip", "skip"]);
    const result = await getExamSessionResult(id);
    const durations = computeDurationStats(result!.session, result!.items);
    expect(durations.activeMs).toBe(10_000); // 仅 2 题 × 5 秒
  });

  it("页面源码：耗时卡使用 durations.totalMs / activeMs，未完成不走 Date.now 估算", async () => {
    const src = stripComments(await readSource("@/pages/ExamResultPage.tsx?raw"));
    expect(src).toContain("durations.totalMs");
    expect(src).toContain("durations.activeMs");
    expect(src).toContain("UNFINISHED_DURATION_HINT");
    expect(src).toContain("整套训练耗时");
    expect(src).toContain("有效答题用时合计");
    expect(src).not.toContain("Date.now()");
  });
});

/* ============================== 3d-d：E2 / E5 / F1 / F2 ============================== */

/** 六个 Store 的完整快照（深比较，不只比数量） */
const SIX_STORES = [
  "words",
  "progress",
  "logs",
  "quiz_questions",
  "training_records",
  "training_sessions",
] as const;

async function snapshotSixStores() {
  const db = await getDB();
  const out: Record<string, unknown[]> = {};
  for (const name of SIX_STORES) {
    out[name] = await db.getAll(name);
  }
  return out;
}

describe("R12 E2 结果页读取前后六 Store 快照完全一致", () => {
  it("含词汇与题目数据的全库快照在读取前后深度相等", async () => {
    // 先写入非空数据：words / progress / logs 各 1 条，quiz_questions 1 条
    const db = await getDB();
    await db.put("words", {
      id: "w-test-1",
      word: "南辕北辙",
      definition: "心里想往南去，却驾车往北走",
      section: "成语",
      group: "测试组",
      groupId: "g-test",
      subcategory: "测试",
      createdAt: 1_700_000_000_000,
    } as never);
    await db.put("progress", {
      wordId: "w-test-1",
      stability: 1,
      difficulty: 5,
      elapsedDays: 0,
      scheduledDays: 1,
      reps: 1,
      lapses: 0,
      state: 1,
      due: 1_700_086_400_000,
      lastReview: 1_700_000_000_000,
    } as never);
    await db.put("logs", {
      wordId: "w-test-1",
      rating: 3,
      wasNew: true,
      reviewedAt: 1_700_000_000_000,
    } as never);
    await db.put("quiz_questions", {
      id: "q-test-1",
      mode: "synonym",
      categoryKey: "测试::测试",
      stem: "测试题干",
      options: ["A", "B", "C", "D"],
      answer: 0,
      reviewStatus: "pending",
      createdAt: 1_700_000_000_000,
    } as never);

    const picked = pick("成语", 3);
    const id = await buildSession(picked, ["correct", "wrong", "skip"]);

    const before = await snapshotSixStores();
    // 六库均非空（证明比较的是真实数据，不是空数组相等）
    for (const name of SIX_STORES) {
      expect(before[name].length).toBeGreaterThan(0);
    }

    // 结果页等价的读取行为：多次 getExamSessionResult
    const r1 = await getExamSessionResult(id);
    const r2 = await getExamSessionResult(id);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    const after = await snapshotSixStores();
    for (const name of SIX_STORES) {
      expect(after[name]).toEqual(before[name]);
    }
    // 整体深比较（防止漏项）
    expect(after).toEqual(before);
  });

  it("全未答会话的读取同样不改动任何 Store", async () => {
    const picked = pick("实词", 2);
    const id = await buildSession(picked, ["skip", "skip"]);
    const before = await snapshotSixStores();
    await getExamSessionResult(id);
    const after = await snapshotSixStores();
    for (const name of SIX_STORES) {
      expect(after[name]).toEqual(before[name]);
    }
  });
});

describe("R13 E5 题目数据缺失时抛 ExamDataError", () => {
  it("会话引用了题库中不存在的 questionId → getExamSessionResult 抛 ExamDataError", async () => {
    const db = await getDB();
    const trainingId = "t-missing-question";
    await db.put("training_sessions", {
      trainingId,
      mode: "exam",
      questionIds: ["ex_不存在的题目"],
      startedAt: 1_700_000_000_000,
      answeredCount: 0,
      correctCount: 0,
    } as never);

    await expect(getExamSessionResult(trainingId)).rejects.toBeInstanceOf(ExamDataError);
    await expect(getExamSessionResult(trainingId)).rejects.toThrow(/真题数据中不存在题目/);
  });
});

describe("R14 F1 重新组卷入口指向 /exam", () => {
  it("页面源码含「重新组卷」且 Link 指向 /exam", async () => {
    const src = stripComments(await readSource("@/pages/ExamResultPage.tsx?raw"));
    expect(src).toContain("重新组卷");
    expect(src).toContain('<Link to="/exam"');
    // 不通过 navigate 或 startExamSession 组卷
    expect(src).not.toContain("startExamSession");
  });
});

describe("R15 F2 答题页完成态「查看成绩」入口", () => {
  it("完成态含「查看成绩」且指向 /exam/result/${trainingId}", async () => {
    const src = stripComments(await readSource("@/pages/ExamStudyPage.tsx?raw"));
    expect(src).toContain("查看成绩");
    expect(src).toContain("/exam/result/${trainingId}");
    // 旧占位文案已移除
    expect(src).not.toContain("成绩统计与错题回顾将在后续版本提供");
    // 仍保留回看第 1 题与返回组卷设置
    expect(src).toContain("回看第 1 题");
    expect(src).toContain('to="/exam"');
  });

  it("完成态改造未引入写库或重新判题", async () => {
    const src = stripComments(await readSource("@/pages/ExamStudyPage.tsx?raw"));
    // 完成态区块只做跳转与本地回看，不新增会话、不改判定
    expect(src).not.toContain("judgeExamAnswer(");
  });
});
