/**
 * 真题数据服务 + 真题训练会话服务（3a）
 *
 * 数据职责：
 * - 从 /data/exam_questions.json 加载正式真题并做运行时校验（复用 types/exam.ts 校验函数）
 * - 内存缓存（按 fetchImpl 函数实例区分），提供按 ID / 条件筛选 / 随机抽题 / 判题
 *
 * 训练会话职责（3a 新增）：
 * - startExamSession / submitExamAnswer / finishExamSession / getExamSessionResult
 * - 会话写入 training_sessions，作答记录写入 training_records（mode="exam"，
 *   categoryKey="真题::成语/实词"），经 quizRepository 访问 IndexedDB v2 既有 store
 *
 * 隔离硬约束：本文件禁止 import 学习侧模块（studyService / fsrs / wordRepository）；
 * 不写 quiz_questions，不触碰 words / progress / logs，不修改 DB 版本与 FSRS。
 */
import type {
  ExamQuestion,
  ExamQuestionType,
  ExamSection,
} from "@/types/exam";
import type { TrainingRecord, TrainingSession } from "@/types/quiz";
import { validateExamDataset, validateExamQuestion } from "@/types/exam";
import {
  addTrainingRecordAndUpdateSession,
  getRecordsByTraining,
  getSession,
  putSession,
} from "@/db/quizRepository";

/** 运行时数据路径（public/data/exam_questions.json，PWA 已缓存 json） */
export const EXAM_DATA_URL = "/data/exam_questions.json";

/**
 * Promise 级缓存（P2 修复）：按 fetchImpl 函数实例区分缓存。
 * 默认运行时 fetch 是同一个全局函数实例，天然共享一份缓存；
 * 注入的不同 fetchImpl 各自独立，互不串用。
 */
let cacheMap = new WeakMap<typeof fetch, Promise<ExamQuestion[]>>();

/** 测试隔离：清空全部内存缓存（下一次加载重新 fetch） */
export function resetExamCacheForTest(): void {
  cacheMap = new WeakMap();
}

/** 校验异常（加载失败时抛出，绝不返回假数据） */
export class ExamDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExamDataError";
  }
}

/** 运行时数据校验：复用 types/exam.ts 的校验函数，不另起规则 */
function validateRuntimeData(questions: ExamQuestion[]): void {
  if (!Array.isArray(questions) || questions.length !== 204) {
    throw new ExamDataError(`真题总数应为 204，实际 ${questions?.length}`);
  }
  const errors = validateExamDataset(questions);
  if (errors.length) {
    throw new ExamDataError(`真题数据校验失败（前 5 条）：${errors.slice(0, 5).join("；")}`);
  }
}

/**
 * 加载全部真题（带内存缓存；失败抛 ExamDataError）
 * - 同一 fetchImpl 的并发/后续调用共享同一次 fetch（P1.1）
 * - 任何环节失败：清除该 fetchImpl 的失败缓存后原样抛出 ExamDataError，
 *   下次调用可重新发起请求（P1.2~P1.4）
 * - 并发安全：仅当缓存位仍是本次失败的 Promise 时才清除，不误删后来新建的缓存（P1.5）
 * @param fetchImpl 供测试注入的 fetch 实现
 */
export async function loadExamQuestions(
  fetchImpl: typeof fetch = fetch,
): Promise<ExamQuestion[]> {
  let cached = cacheMap.get(fetchImpl);
  if (!cached) {
    cached = (async () => {
      let res: Response;
      try {
        res = await fetchImpl(EXAM_DATA_URL);
      } catch (e) {
        throw new ExamDataError(`真题数据加载失败：${(e as Error).message}`);
      }
      if (!res.ok) {
        throw new ExamDataError(`真题数据加载失败：HTTP ${res.status}`);
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        throw new ExamDataError("真题数据不是合法 JSON");
      }
      validateRuntimeData(parsed as ExamQuestion[]);
      return parsed as ExamQuestion[];
    })();
    cacheMap.set(fetchImpl, cached);
    // 失败即清除：仅当缓存位仍是本次 Promise（并发场景下不误删新建缓存）
    cached.catch(() => {
      if (cacheMap.get(fetchImpl) === cached) cacheMap.delete(fetchImpl);
    });
  }
  return cached;
}

/** 按稳定 ID 获取单道题；不存在返回 null */
export async function getExamQuestionById(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExamQuestion | null> {
  const all = await loadExamQuestions(fetchImpl);
  return all.find((q) => q.id === id) ?? null;
}

/** 条件筛选（组合可用） */
export interface ExamFilters {
  /** 篇章 */
  section?: ExamSection;
  /** 年份 */
  year?: number;
  /** 题型 */
  questionType?: ExamQuestionType;
}

/** 按条件筛选（不传条件返回全部） */
export async function getExamQuestions(
  filters: ExamFilters = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ExamQuestion[]> {
  const all = await loadExamQuestions(fetchImpl);
  return all.filter(
    (q) =>
      (filters.section === undefined || q.section === filters.section) &&
      (filters.year === undefined || q.year === filters.year) &&
      (filters.questionType === undefined || q.questionType === filters.questionType),
  );
}

/** 随机抽题选项 */
export interface RandomExamOptions extends ExamFilters {
  /** 抽题数量；可用题不足时返回实际可用数量 */
  count: number;
  /** 随机数注入（测试用），默认 Math.random */
  random?: () => number;
  /** fetch 注入（测试用），默认全局 fetch；与 filters 一致的数据源缓存 */
  fetchImpl?: typeof fetch;
}

/** Fisher-Yates 洗牌（纯函数，便于测试） */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 随机抽题：不重复；数量不足返回实际可用数量，不报错 */
export async function getRandomExamQuestions(
  options: RandomExamOptions,
): Promise<ExamQuestion[]> {
  const { count, random, ...filters } = options;
  if (!Number.isInteger(count) || count <= 0) return [];
  const pool = await getExamQuestions(filters, options.fetchImpl);
  return shuffle(pool, random).slice(0, Math.min(count, pool.length));
}

/** 合法选项字母 */
const VALID_ANSWERS: readonly string[] = ["A", "B", "C", "D"];

/**
 * 判题：userAnswer 必须是 A/B/C/D 之一，与标准答案严格比较。
 * 多空题同样只判断一个选项字母（全对或全错），不拆分空格。
 * 非法答案抛 ExamDataError（不静默记为错误答案）。
 */
export function judgeExamAnswer(
  question: ExamQuestion,
  userAnswer: string,
): boolean {
  if (!VALID_ANSWERS.includes(userAnswer)) {
    throw new ExamDataError(`非法答案：${userAnswer}（只接受 A/B/C/D）`);
  }
  return userAnswer === question.answer;
}

/** 单题校验（供调试/测试使用） */
export function assertQuestionValid(question: ExamQuestion): void {
  const err = validateExamQuestion(question);
  if (err) throw new ExamDataError(err);
}

/* ========================================================================
 * 真题训练会话（3a）：会话持久化、作答记录、重复提交保护、结果恢复
 * ======================================================================== */

/** 真题训练 categoryKey 前缀（与辨析训练区分） */
export const EXAM_CATEGORY_PREFIX = "真题::";

/** 按 trainingId 串行化提交/结束操作（并发安全：同一会话的操作按序执行） */
const sessionQueues = new Map<string, Promise<unknown>>();

function enqueueForSession<T>(trainingId: string, task: () => Promise<T>): Promise<T> {
  const prev = sessionQueues.get(trainingId) ?? Promise.resolve();
  const next = prev.then(task, task);
  // 队列尾吞掉错误，避免未处理的 Promise rejection；调用方各自拿到 next 处理
  next.catch(() => undefined);
  sessionQueues.set(
    trainingId,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * 开始一次真题训练会话：立即持久化 TrainingSession（answeredCount=0、
 * correctCount=0、无 finishedAt）。返回的 trainingId 供后续提交与结果查询。
 */
export async function startExamSession(
  questionIds: string[],
  options: { startedAt?: number } = {},
): Promise<TrainingSession> {
  if (!Array.isArray(questionIds) || questionIds.length === 0) {
    throw new ExamDataError("开始训练会话至少需要 1 道题");
  }
  const session: TrainingSession = {
    trainingId: crypto.randomUUID(),
    mode: "exam",
    questionIds: [...questionIds],
    startedAt: options.startedAt ?? Date.now(),
    answeredCount: 0,
    correctCount: 0,
  };
  await putSession(session);
  return session;
}

export interface SubmitExamAnswerOptions {
  /** 提交时间戳（默认 Date.now()） */
  submittedAt?: number;
  /** 首次展示到提交的耗时（毫秒，默认 0） */
  durationMs?: number;
}

export type SubmitExamAnswerResult =
  | { status: "accepted"; isCorrect: boolean; recordId: number }
  | { status: "already-submitted"; isCorrect: boolean; recordId: number };

/**
 * 提交单题答案：
 * - 服务层查重：同 trainingId + questionId 已存在记录则不再写第二条、
 *   不重复计数，返回 already-submitted（含已有记录的正误）
 * - 重复提交保护通过按 trainingId 串行化实现（并发提交只接受一次）
 * - 完成态保护：会话已结束（有 finishedAt）拒绝提交，不写任何新记录
 * - 原子写入：记录与会话计数经 addTrainingRecordAndUpdateSession 在同一
 *   IndexedDB 事务中更新（一起成功或一起失败）
 * - 记录 mode="exam"，categoryKey="真题::<section>"，userAnswer 存原始字母
 */
export async function submitExamAnswer(
  trainingId: string,
  question: ExamQuestion,
  userAnswer: string,
  options: SubmitExamAnswerOptions = {},
): Promise<SubmitExamAnswerResult> {
  assertQuestionValid(question);
  return enqueueForSession(trainingId, async () => {
    const existing = (await getRecordsByTraining(trainingId)).find(
      (r) => r.questionId === question.id,
    );
    if (existing) {
      return { status: "already-submitted" as const, isCorrect: existing.isCorrect, recordId: existing.id ?? -1 };
    }
    const session = await getSession(trainingId);
    if (!session) {
      throw new ExamDataError(`训练会话不存在：${trainingId}`);
    }
    if (session.finishedAt !== undefined) {
      throw new ExamDataError(`会话已结束，不能继续提交：${trainingId}`);
    }
    const isCorrect = judgeExamAnswer(question, userAnswer);
    const record: Omit<TrainingRecord, "id"> = {
      trainingId,
      questionId: question.id,
      mode: "exam",
      userAnswer,
      isCorrect,
      answeredAt: options.submittedAt ?? Date.now(),
      durationMs: options.durationMs ?? 0,
      categoryKey: EXAM_CATEGORY_PREFIX + question.section,
    };
    const { recordId } = await addTrainingRecordAndUpdateSession(record, trainingId);
    return { status: "accepted" as const, isCorrect, recordId };
  });
}

/**
 * 结束训练会话：写入 finishedAt。
 * - 已结束的会话不覆盖原 finishedAt（幂等）
 * - 未答完（answeredCount < questionIds.length）拒绝完成
 */
export async function finishExamSession(
  trainingId: string,
  finishedAt: number = Date.now(),
): Promise<TrainingSession> {
  return enqueueForSession(trainingId, async () => {
    const session = await getSession(trainingId);
    if (!session) {
      throw new ExamDataError(`训练会话不存在：${trainingId}`);
    }
    if (session.finishedAt !== undefined) return session;
    if (session.answeredCount < session.questionIds.length) {
      throw new ExamDataError(
        `未答完不能结束会话：已答 ${session.answeredCount}/${session.questionIds.length}`,
      );
    }
    const finished: TrainingSession = { ...session, finishedAt };
    await putSession(finished);
    return finished;
  });
}

/** 真题训练结果中的单题条目 */
export interface ExamSessionResultItem {
  question: ExamQuestion;
  /** 已作答则给出记录；未作答为 null（不计错误） */
  record: TrainingRecord | null;
}

/** 真题训练结果（区分完成 / 未完成，恢复顺序按 session.questionIds） */
export interface ExamSessionResult {
  session: TrainingSession;
  /** 会话是否已结束（有 finishedAt） */
  finished: boolean;
  items: ExamSessionResultItem[];
  answeredCount: number;
  correctCount: number;
  wrongCount: number;
  unansweredCount: number;
}

/**
 * 读取真题训练结果：
 * - 按 session.questionIds 恢复题目顺序
 * - 未完成会话同样可恢复（中途退出场景），未答题不计错误
 * - 结果全部来自 IndexedDB（session + records），题目来自数据 JSON
 */
export async function getExamSessionResult(
  trainingId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExamSessionResult | null> {
  const session = await getSession(trainingId);
  if (!session) return null;
  const [records, allQuestions] = await Promise.all([
    getRecordsByTraining(trainingId),
    loadExamQuestions(fetchImpl),
  ]);
  const byId = new Map<string, ExamQuestion>(allQuestions.map((q) => [q.id, q]));
  const recordByQuestion = new Map<string, TrainingRecord>(
    records.map((r) => [r.questionId, r]),
  );
  const items: ExamSessionResultItem[] = [];
  for (const qid of session.questionIds) {
    const question = byId.get(qid);
    if (!question) {
      throw new ExamDataError(`真题数据中不存在题目：${qid}`);
    }
    items.push({ question, record: recordByQuestion.get(qid) ?? null });
  }
  const answered = items.filter((it) => it.record !== null);
  return {
    session,
    finished: session.finishedAt !== undefined,
    items,
    answeredCount: answered.length,
    correctCount: answered.filter((it) => it.record!.isCorrect).length,
    wrongCount: answered.filter((it) => !it.record!.isCorrect).length,
    unansweredCount: items.length - answered.length,
  };
}
