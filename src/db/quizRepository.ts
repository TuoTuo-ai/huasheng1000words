/**
 * 分类辨析训练 · 数据访问层
 * 只读写 v2 新增的三个 store，绝不触碰 words / progress / logs
 */
import type { QuizQuestion, TrainingRecord, TrainingSession } from "@/types/quiz";
import { getDB } from "@/db/database";

/* ---------------- 题目 ---------------- */

export async function putQuestion(q: QuizQuestion): Promise<QuizQuestion> {
  const db = await getDB();
  await db.put("quiz_questions", q);
  return q;
}

export async function getQuestion(id: string) {
  const db = await getDB();
  return db.get("quiz_questions", id);
}

export async function getQuestionsByMode(mode: string) {
  const db = await getDB();
  return db.getAllFromIndex("quiz_questions", "by-mode", mode);
}

export async function getQuestionsByCategory(categoryKey: string) {
  const db = await getDB();
  return db.getAllFromIndex("quiz_questions", "by-categoryKey", categoryKey);
}

export async function getQuestionsByStatus(status: string) {
  const db = await getDB();
  return db.getAllFromIndex("quiz_questions", "by-reviewStatus", status);
}

/** 读取全部题目（生成器统计 / 去重用） */
export async function getAllQuestions() {
  const db = await getDB();
  return db.getAll("quiz_questions");
}

/** 批量写入题目（单事务，全部成功或全部回滚） */
export async function putQuestionsBatch(questions: QuizQuestion[]): Promise<number> {
  if (questions.length === 0) return 0;
  const db = await getDB();
  const tx = db.transaction("quiz_questions", "readwrite");
  for (const q of questions) tx.store.put(q);
  await tx.done;
  return questions.length;
}

/**
 * 人工审核：仅允许 pending → approved / rejected。
 * 已审核过的题目不可直接改判（必须先 resetQuestion 重置为 pending）。
 */
export async function reviewQuestion(
  id: string,
  status: "approved" | "rejected",
): Promise<QuizQuestion> {
  const db = await getDB();
  // 先只读校验，避免为一次失败的分支开启写事务
  const current = await db.get("quiz_questions", id);
  if (!current) throw new Error(`题目不存在：${id}`);
  if (current.reviewStatus !== "pending")
    throw new Error(`该题已审核（${current.reviewStatus}），需先撤销审核才能改判`);

  const next: QuizQuestion = {
    ...current,
    reviewStatus: status,
    updatedAt: Date.now(),
  };
  await db.put("quiz_questions", next);
  return next;
}

/**
 * 撤销审核：approved / rejected → pending。
 * 只改变 reviewStatus 与 updatedAt，题目内容、选项、来源信息一律原样保留。
 * 已是 pending 的题目无需撤销，直接返回（幂等）。
 */
export async function resetQuestionReview(id: string): Promise<QuizQuestion> {
  const db = await getDB();
  const current = await db.get("quiz_questions", id);
  if (!current) throw new Error(`题目不存在：${id}`);
  if (current.reviewStatus === "pending") return current;

  const next: QuizQuestion = {
    ...current,
    reviewStatus: "pending",
    updatedAt: Date.now(),
  };
  await db.put("quiz_questions", next);
  return next;
}

/* ---------------- 训练记录 ---------------- */

export async function addTrainingRecord(
  record: Omit<TrainingRecord, "id">,
): Promise<number> {
  const db = await getDB();
  return db.add("training_records", record as TrainingRecord) as Promise<number>;
}

/**
 * 原子写入：在同一个 readwrite 事务中完成
 *   1) 添加一条 TrainingRecord
 *   2) 更新对应 TrainingSession 的 answeredCount / correctCount
 * 两项一起成功或一起失败（事务 abort 时全部回滚），杜绝
 * 「记录已写入但会话计数未更新」的部分写入。
 * 不修改数据库版本、不新增 Store。
 */
export async function addTrainingRecordAndUpdateSession(
  record: Omit<TrainingRecord, "id">,
  trainingId: string,
): Promise<{ recordId: number; session: TrainingSession }> {
  const db = await getDB();
  const tx = db.transaction(["training_records", "training_sessions"], "readwrite");
  // 失败路径（提前抛错）不会 await tx.done，附加 catch 避免 unhandled rejection
  tx.done.catch(() => undefined);
  const recordsStore = tx.objectStore("training_records");
  const sessionsStore = tx.objectStore("training_sessions");

  const session = await sessionsStore.get(trainingId);
  if (!session) {
    // 只读阶段即可判定，主动 abort，不产生任何写入
    tx.abort();
    throw new Error(`训练会话不存在：${trainingId}`);
  }
  const recordId = (await recordsStore.add(record as TrainingRecord)) as number;
  const updated: TrainingSession = {
    ...session,
    answeredCount: session.answeredCount + 1,
    correctCount: session.correctCount + (record.isCorrect ? 1 : 0),
  };
  await sessionsStore.put(updated);
  await tx.done; // 任一步失败：整个事务回滚，记录与会话均不落库
  return { recordId, session: updated };
}

export async function getRecordsByTraining(trainingId: string) {
  const db = await getDB();
  return db.getAllFromIndex("training_records", "by-trainingId", trainingId);
}

export async function getRecordsByQuestion(questionId: string) {
  const db = await getDB();
  return db.getAllFromIndex("training_records", "by-questionId", questionId);
}

export async function getRecordsByCategory(categoryKey: string) {
  const db = await getDB();
  return db.getAllFromIndex("training_records", "by-categoryKey", categoryKey);
}

export async function getRecordsByAnsweredAtRange(from: number, to: number) {
  const db = await getDB();
  return db.getAllFromIndex(
    "training_records",
    "by-answeredAt",
    IDBKeyRange.bound(from, to),
  );
}

/* ---------------- 训练会话 ---------------- */

export async function putSession(session: TrainingSession) {
  const db = await getDB();
  await db.put("training_sessions", session);
  return session;
}

export async function getSession(trainingId: string) {
  const db = await getDB();
  return db.get("training_sessions", trainingId);
}
