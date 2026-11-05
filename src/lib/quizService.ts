/**
 * 分类辨析训练 · 用户端服务（V1.0，只支持 synonym 近义词辨析）
 *
 * 职责：
 * - 只读取 reviewStatus = "approved" 的近义词题（pending / rejected 绝不进入训练）
 * - 按分类聚合、按分类筛选、随机抽题（不重复）、题量不足按实际可用量处理
 * - 创建 / 恢复 synonym 训练会话（training_sessions，mode = "synonym"）
 * - 提交单题答案：复用 quizRepository.addTrainingRecordAndUpdateSession 原子写入
 * - 结束会话、读取结果（未完成会话同样可恢复）
 *
 * 边界（硬约束）：
 * - 不写 quiz_questions（题目只由管理端生成与审核）
 * - 不 import 学习侧模块（studyService / fsrs / wordRepository），不触碰 words / progress / logs
 * - 不修改 DB_VERSION、不新增 Store、不改动真题模块与备份恢复模块
 * - 解析一律取题目自身已有字段（explanation / option.explain），不编造
 */
import type { QuizQuestion, TrainingRecord, TrainingSession } from "@/types/quiz";
import {
  addTrainingRecordAndUpdateSession,
  getQuestion,
  getQuestionsByStatus,
  getRecordsByTraining,
  getSession,
  putSession,
} from "@/db/quizRepository";

/* ------------------------------------------------------------------ */
/* 常量与错误                                                          */
/* ------------------------------------------------------------------ */

/** 本阶段唯一支持的训练模式 */
export const QUIZ_MODE = "synonym" as const;

/** 训练记录 categoryKey 前缀（与真题「真题::」区分） */
export const QUIZ_CATEGORY_PREFIX = "辨析::";

/** 解析缺失时的占位文案（不编造解析） */
export const NO_EXPLANATION_TEXT = "暂无解析";

/** 选项字母（选项本身带 id，展示时按原顺序渲染） */
const OPTION_PREFIX = "ABCDEF";

/** 服务层错误（页面据此给出中文提示，不吞错） */
export class QuizServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuizServiceError";
  }
}

/* ------------------------------------------------------------------ */
/* 分类（筛选维度）                                                    */
/* ------------------------------------------------------------------ */

/** 分类展示信息（由 categoryKey 拆解，不依赖词库） */
export interface QuizCategory {
  /** section::groupId::subcategory */
  categoryKey: string;
  /** 一级分类（如「成语」「实词」） */
  section: string;
  groupId: string;
  groupTitle: string;
  subcategory: string;
  /** 该分类下已审核通过的题目数 */
  count: number;
}

/** 拆解 categoryKey → { section, groupId, subcategory }（格式异常时不抛错，原样回填） */
export function parseCategoryKey(categoryKey: string): {
  section: string;
  groupId: string;
  subcategory: string;
} {
  const parts = categoryKey.split("::");
  return {
    section: parts[0] ?? categoryKey,
    groupId: parts[1] ?? "",
    subcategory: parts.slice(2).join("::"),
  };
}

/** 分类的完整展示名：section · subcategory */
export function categoryLabel(c: QuizCategory): string {
  return `${c.section} · ${c.subcategory}`;
}

/**
 * 从题目列表聚合出分类列表（只统计传入的题目，调用方负责先过滤 approved）。
 * 排序：section → groupId → subcategory，保证界面顺序稳定可复现。
 */
export function buildCategories(questions: readonly QuizQuestion[]): QuizCategory[] {
  const map = new Map<string, QuizCategory>();
  for (const q of questions) {
    const key = q.categoryKey ?? "";
    if (!key) continue;
    const hit = map.get(key);
    if (hit) {
      hit.count += 1;
      continue;
    }
    const parsed = parseCategoryKey(key);
    map.set(key, {
      categoryKey: key,
      section: parsed.section,
      groupId: parsed.groupId,
      subcategory: parsed.subcategory,
      groupTitle: q.tags?.[1] ?? parsed.groupId,
      count: 1,
    });
  }
  return [...map.values()].sort((a, b) =>
    a.section === b.section
      ? a.groupId === b.groupId
        ? a.subcategory < b.subcategory
          ? -1
          : a.subcategory > b.subcategory
            ? 1
            : 0
        : a.groupId < b.groupId
          ? -1
          : 1
      : a.section < b.section
        ? -1
        : 1,
  );
}

/* ------------------------------------------------------------------ */
/* 题目读取与抽题                                                      */
/* ------------------------------------------------------------------ */

/**
 * 读取可用于训练的题目：只取 approved，且只取 synonym 模式。
 * 这是训练侧唯一允许的题目入口——其它状态一律不进入训练。
 */
export async function getApprovedQuestions(): Promise<QuizQuestion[]> {
  const approved = await getQuestionsByStatus("approved");
  return approved
    .filter((q) => q.mode === QUIZ_MODE)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 可用分类（带可用题数） */
export async function loadQuizCategories(): Promise<QuizCategory[]> {
  return buildCategories(await getApprovedQuestions());
}

/** Fisher-Yates 洗牌（非变异，可注入随机数） */
export function shuffleItems<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 抽题结果：题目 + 是否因题量不足做了缩减 */
export interface PickResult {
  questions: QuizQuestion[];
  /** 用户要求的题量 */
  requested: number;
  /** 该分类实际可用题量 */
  available: number;
  /** 是否因可用题量不足而缩减 */
  insufficient: boolean;
}

/**
 * 按分类抽题：
 * - categoryKey 为 null 表示「全部分类」，池子 = 全部可用题
 * - 洗牌后截断，**不会重复抽到同一道题**（池内题目 ID 唯一，切片天然不重复）
 * - 题量不足时返回实际可用数量，并用 insufficient 标记，绝不报错、绝不补凑
 * - count 非法（非正整数）→ 返回空结果（不做隐式纠正）
 */
export async function pickQuestions(
  options: {
    categoryKey?: string | null;
    count: number;
    random?: () => number;
    questions?: readonly QuizQuestion[];
  },
): Promise<PickResult> {
  const { count, categoryKey = null } = options;
  const pool = options.questions ?? (await getApprovedQuestions());
  const scoped = categoryKey === null ? pool : pool.filter((q) => q.categoryKey === categoryKey);
  const available = scoped.length;
  if (!Number.isInteger(count) || count <= 0) {
    return { questions: [], requested: count, available, insufficient: available > 0 };
  }
  const picked = shuffleItems(scoped, options.random).slice(0, Math.min(count, available));
  return {
    questions: picked,
    requested: count,
    available,
    insufficient: available < count,
  };
}

/** 题量不足时的提示文案（available = 0 返回 null，由页面走「无题」分支） */
export function insufficientHint(result: PickResult): string | null {
  if (!result.insufficient || result.available === 0) return null;
  return `该分类当前可用题目仅 ${result.available} 道，少于所选 ${result.requested} 道，本次按 ${result.available} 道进行。`;
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

/** 路径工具（页面与测试共用，避免字符串硬编码散落） */
export function quizStudyPath(trainingId: string): string {
  return `/quiz/study/${trainingId}`;
}

export function quizResultPath(trainingId: string): string {
  return `/quiz/result/${trainingId}`;
}

/**
 * 创建一次辨析训练会话：立即持久化（answeredCount=0、correctCount=0、无 finishedAt）。
 * @throws QuizServiceError 题量为空
 */
export async function startQuizSession(
  questionIds: readonly string[],
  options: { startedAt?: number } = {},
): Promise<TrainingSession> {
  if (!Array.isArray(questionIds) || questionIds.length === 0) {
    throw new QuizServiceError("至少需要 1 道题目才能开始训练");
  }
  // 题号去重：同一题绝不在一场训练中出现两次
  const unique = [...new Set(questionIds)];
  const session: TrainingSession = {
    trainingId: crypto.randomUUID(),
    mode: QUIZ_MODE,
    questionIds: unique,
    startedAt: options.startedAt ?? Date.now(),
    answeredCount: 0,
    correctCount: 0,
  };
  await putSession(session);
  return session;
}

/** 按 trainingId 串行化同一会话的写操作（并发提交按序执行，不互相覆盖计数） */
const sessionQueues = new Map<string, Promise<unknown>>();

function enqueueForSession<T>(trainingId: string, task: () => Promise<T>): Promise<T> {
  const prev = sessionQueues.get(trainingId) ?? Promise.resolve();
  const next = prev.then(task, task);
  // 队尾吞掉错误，避免 unhandled rejection；调用方各自拿到 next 处理
  next.catch(() => undefined);
  sessionQueues.set(
    trainingId,
    next.catch(() => undefined),
  );
  return next;
}

/** 训练记录分类键：辨析::section::subcategory */
export function recordCategoryKey(categoryKey: string): string {
  const { section, subcategory } = parseCategoryKey(categoryKey);
  return `${QUIZ_CATEGORY_PREFIX}${section}::${subcategory}`;
}

/** 判题：选项 ID 与正确选项 ID 严格相等；非法选项 ID 抛错（不静默记错） */
export function judgeQuizAnswer(question: QuizQuestion, optionId: string): boolean {
  const exists = question.options.some((o) => o.id === optionId);
  if (!exists) {
    throw new QuizServiceError(`非法选项：${optionId}（该题不存在此选项）`);
  }
  return optionId === question.correctOptionId;
}

export interface SubmitQuizAnswerOptions {
  submittedAt?: number;
  durationMs?: number;
}

export type SubmitQuizAnswerResult =
  | { status: "accepted"; isCorrect: boolean; recordId: number }
  | { status: "already-submitted"; isCorrect: boolean; recordId: number };

/**
 * 提交单题答案。
 *
 * - **只接受本会话包含的题目**：不在 session.questionIds 内的题目一律拒绝，
 *   避免把别的题写进本场训练
 * - **已完成会话拒绝提交**（finishedAt 存在），不改动任何数据
 * - 重复提交：同 trainingId + questionId 已有记录 → 返回 already-submitted，
 *   不写第二条、不重复计数（先查重，再经串行队列，并发提交也只接受一次）
 * - 原子写入：记录与会话计数在同一事务中更新
 */
export async function submitQuizAnswer(
  trainingId: string,
  question: QuizQuestion,
  optionId: string,
  options: SubmitQuizAnswerOptions = {},
): Promise<SubmitQuizAnswerResult> {
  return enqueueForSession(trainingId, async () => {
    const session = await getSession(trainingId);
    if (!session) {
      throw new QuizServiceError(`训练会话不存在：${trainingId}`);
    }
    if (!session.questionIds.includes(question.id)) {
      throw new QuizServiceError(`题目不属于本次训练：${question.id}`);
    }
    if (session.finishedAt !== undefined) {
      throw new QuizServiceError("本次训练已结束，不能继续作答");
    }
    const existing = (await getRecordsByTraining(trainingId)).find(
      (r) => r.questionId === question.id,
    );
    if (existing) {
      return {
        status: "already-submitted" as const,
        isCorrect: existing.isCorrect,
        recordId: existing.id ?? -1,
      };
    }
    const isCorrect = judgeQuizAnswer(question, optionId);
    const record: Omit<TrainingRecord, "id"> = {
      trainingId,
      questionId: question.id,
      mode: QUIZ_MODE,
      userAnswer: optionId,
      isCorrect,
      answeredAt: options.submittedAt ?? Date.now(),
      durationMs: Math.max(0, options.durationMs ?? 0),
      categoryKey: recordCategoryKey(question.categoryKey),
    };
    const { recordId } = await addTrainingRecordAndUpdateSession(record, trainingId);
    return { status: "accepted" as const, isCorrect, recordId };
  });
}

/**
 * 结束会话：写入 finishedAt。
 * - 已结束 → 原样返回（幂等，不覆盖原 finishedAt）
 * - 未答完 → 抛错（未答完不得结束）
 */
export async function finishQuizSession(
  trainingId: string,
  finishedAt: number = Date.now(),
): Promise<TrainingSession> {
  return enqueueForSession(trainingId, async () => {
    const session = await getSession(trainingId);
    if (!session) {
      throw new QuizServiceError(`训练会话不存在：${trainingId}`);
    }
    if (session.finishedAt !== undefined) return session;
    if (session.answeredCount < session.questionIds.length) {
      throw new QuizServiceError(
        `尚未答完全部题目（已答 ${session.answeredCount}/${session.questionIds.length}）`,
      );
    }
    const finished: TrainingSession = { ...session, finishedAt };
    await putSession(finished);
    return finished;
  });
}

/* ------------------------------------------------------------------ */
/* 结果                                                                */
/* ------------------------------------------------------------------ */

export interface QuizSessionItem {
  question: QuizQuestion;
  /** 未作答为 null（不计错误） */
  record: TrainingRecord | null;
}

export interface QuizSessionResult {
  session: TrainingSession;
  finished: boolean;
  /** 严格按 session.questionIds 顺序 */
  items: QuizSessionItem[];
  total: number;
  answeredCount: number;
  correctCount: number;
  wrongCount: number;
  unansweredCount: number;
  /** 正确率（整数百分比，四舍五入；已答为 0 时返回 0） */
  accuracy: number;
  /** 各题用时合计（毫秒，仅统计已答题） */
  totalDurationMs: number;
  /** 整套训练耗时（finishedAt - startedAt；未结束为 null，不用当前时间估算） */
  sessionDurationMs: number | null;
}

/** 正确率：整数百分比，四舍五入；分母只用已答题数 */
export function computeAccuracy(correct: number, answered: number): number {
  if (answered <= 0) return 0;
  return Math.round((correct / answered) * 100);
}

/** 毫秒 → 展示文本（秒级；不足 1 秒按 1 秒内显示，避免出现 0 秒误导） */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const safe = Math.max(0, Math.round(ms));
  const totalSec = Math.round(safe / 1000);
  if (totalSec <= 0) return "1 秒内";
  if (totalSec < 60) return `${totalSec} 秒`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min} 分` : `${min} 分 ${sec} 秒`;
}

/**
 * 读取训练结果。
 * - 会话不存在 → null
 * - 题目按 session.questionIds 顺序恢复；**题目已从题库删除**时抛错并指明题号，
 *   绝不用空壳替身糊弄结果
 * - 未完成会话照常返回（finished = false），未答题不计入错误与正确率分母
 */
export async function getQuizSessionResult(
  trainingId: string,
): Promise<QuizSessionResult | null> {
  const session = await getSession(trainingId);
  if (!session) return null;
  const records = await getRecordsByTraining(trainingId);
  const recordByQuestion = new Map<string, TrainingRecord>(
    records.map((r) => [r.questionId, r]),
  );
  const items: QuizSessionItem[] = [];
  for (const qid of session.questionIds) {
    const question = await getQuestion(qid);
    if (!question) {
      throw new QuizServiceError(`题目已不存在，无法恢复结果：${qid}`);
    }
    items.push({ question, record: recordByQuestion.get(qid) ?? null });
  }
  const answered = items.filter((it) => it.record !== null);
  const correctCount = answered.filter((it) => it.record!.isCorrect).length;
  const totalDurationMs = answered.reduce((sum, it) => sum + Math.max(0, it.record!.durationMs), 0);
  return {
    session,
    finished: session.finishedAt !== undefined,
    items,
    total: items.length,
    answeredCount: answered.length,
    correctCount,
    wrongCount: answered.length - correctCount,
    unansweredCount: items.length - answered.length,
    accuracy: computeAccuracy(correctCount, answered.length),
    totalDurationMs,
    sessionDurationMs:
      session.finishedAt !== undefined
        ? Math.max(0, session.finishedAt - session.startedAt)
        : null,
  };
}

/* ------------------------------------------------------------------ */
/* 展示辅助（纯函数，供页面与测试复用）                                */
/* ------------------------------------------------------------------ */

/** 题干展示文本：直接使用题目自带的 stem，不改写、不拼接 */
export function stemText(question: QuizQuestion): string {
  return (question.stem ?? "").trim();
}

/** 选项展示：按题目原始顺序，补上字母标签 */
export function optionLines(question: QuizQuestion): { id: string; label: string; content: string }[] {
  return question.options.map((o, i) => ({
    id: o.id,
    label: o.id || OPTION_PREFIX[i] || "",
    content: o.content,
  }));
}

/** 正确答案的展示文本（选项内容，取不到时回退选项 ID） */
export function correctOptionText(question: QuizQuestion): string {
  const opt = question.options.find((o) => o.id === question.correctOptionId);
  return opt?.content ?? question.correctOptionId;
}

/** 解析文本：题目自带 explanation 为空则返回「暂无解析」，绝不编造 */
export function explanationText(question: QuizQuestion): string {
  const text = (question.explanation ?? "").trim();
  return text.length > 0 ? text : NO_EXPLANATION_TEXT;
}

/** 选项解释（已有字段 option.explain；为空返回 null，页面不展示该段） */
export function optionExplainText(optionId: string, question: QuizQuestion): string | null {
  const opt = question.options.find((o) => o.id === optionId);
  const text = (opt?.explain ?? "").trim();
  return text.length > 0 ? text : null;
}

/** 是否含 AI 生成内容（页面据此标注，不隐藏来源） */
export function hasAiContent(question: QuizQuestion): boolean {
  return question.aiGenerated === true;
}
