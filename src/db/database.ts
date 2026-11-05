/**
 * IndexedDB 封装（基于 idb）
 *
 * v1：words / progress / logs（FSRS 学习数据）
 * v2：新增 quiz_questions / training_records / training_sessions（分类辨析训练数据）
 *     迁移只新增 store 与索引，不删除、不重建、不修改原有数据
 * 后续云端同步（Supabase）将以 updatedAt 做增量比对
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Word, WordProgress, ReviewLog } from "@/types";
import type {
  QuizQuestion,
  TrainingRecord,
  TrainingSession,
} from "@/types/quiz";

/** 数据库当前版本 */
export const DB_VERSION = 2;

interface YuYanDB extends DBSchema {
  words: {
    key: string;
    value: Word;
    indexes: { "by-createdAt": number };
  };
  progress: {
    key: string;
    value: WordProgress;
    indexes: { "by-due": number };
  };
  logs: {
    key: number;
    value: ReviewLog;
    indexes: { "by-wordId": string; "by-reviewedAt": number };
  };
  quiz_questions: {
    key: string;
    value: QuizQuestion;
    indexes: {
      "by-mode": string;
      "by-categoryKey": string;
      "by-reviewStatus": string;
    };
  };
  training_records: {
    key: number;
    value: TrainingRecord;
    indexes: {
      "by-questionId": string;
      "by-categoryKey": string;
      "by-answeredAt": number;
      "by-trainingId": string;
    };
  };
  training_sessions: {
    key: string;
    value: TrainingSession;
  };
}

export type YuYanDBType = IDBPDatabase<YuYanDB>;

/** 数据库名称（唯一入口，便于自检与多标签页逻辑复用） */
export const DB_NAME = "yanyu-1000";

/** 六个 Store 名称（顺序与建库顺序一致，只读自检用） */
export const DB_STORE_NAMES = [
  "words",
  "progress",
  "logs",
  "quiz_questions",
  "training_records",
  "training_sessions",
] as const;

/** 打开数据库的超时时间：被其他标签页 blocked 时不会无限等待 */
export const DB_OPEN_TIMEOUT_MS = 8000;

export type DBConnectionEvent =
  | { type: "blocked"; blockedVersion: number | null }
  | { type: "blocking"; blockedVersion: number | null }
  | { type: "closed"; reason: "versionchange" | "timeout" | "test" | "manual" };

/** 连接事件监听（界面可据此提示「请关闭其他标签页」） */
const connectionListeners = new Set<(e: DBConnectionEvent) => void>();

/** 订阅连接事件，返回取消订阅函数 */
export function onDBConnectionEvent(
  listener: (e: DBConnectionEvent) => void,
): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

function emitConnectionEvent(e: DBConnectionEvent): void {
  for (const l of connectionListeners) {
    try {
      l(e);
    } catch {
      /* 监听器自身异常不影响数据库流程 */
    }
  }
}

let dbPromise: Promise<IDBPDatabase<YuYanDB>> | null = null;

/**
 * 关闭当前连接并丢弃缓存，让下一次 getDB() 重新打开。
 * 用于：别的标签页升级/删除数据库（versionchange）、打开超时、测试重置。
 */
export function invalidateDBConnection(
  reason: "versionchange" | "timeout" | "test" | "manual" = "manual",
): void {
  const pending = dbPromise;
  dbPromise = null;
  if (pending) {
    pending
      .then((db) => db.close())
      .catch(() => {
        /* 打开本身就失败，无需关闭 */
      });
  }
  emitConnectionEvent({ type: "closed", reason });
}

export function getDB(): Promise<IDBPDatabase<YuYanDB>> {
  if (!dbPromise) {
    dbPromise = openDBWithGuards();
  }
  return dbPromise;
}

/**
 * 打开数据库（带多标签页保护）：
 * - blocking：本页持有旧连接、别的标签页正升级 → 立即关闭本页连接，避免把对方卡死
 * - blocked：本页要升级、但别的标签页还开着旧连接 → 发出事件提示用户关闭其他标签页，
 *            超过 DB_OPEN_TIMEOUT_MS 仍未打开则放弃等待并抛错（不会无限挂起）
 * - terminated：浏览器异常终止连接 → 丢弃缓存，下次重新打开
 * 不改变版本号、不改变任何 Store / 索引定义。
 */
function openDBWithGuards(): Promise<IDBPDatabase<YuYanDB>> {
  const attempt = openDB<YuYanDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
        // —— v1：学习数据（仅在全新安装时创建）——
        if (oldVersion < 1) {
          const words = db.createObjectStore("words", { keyPath: "id" });
          words.createIndex("by-createdAt", "createdAt");

          const progress = db.createObjectStore("progress", {
            keyPath: "wordId",
          });
          progress.createIndex("by-due", "due");

          const logs = db.createObjectStore("logs", {
            keyPath: "id",
            autoIncrement: true,
          });
          logs.createIndex("by-wordId", "wordId");
          logs.createIndex("by-reviewedAt", "reviewedAt");
        }

        // —— v2：分类辨析训练数据（增量迁移，只新增）——
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains("quiz_questions")) {
            const q = db.createObjectStore("quiz_questions", {
              keyPath: "id",
            });
            q.createIndex("by-mode", "mode");
            q.createIndex("by-categoryKey", "categoryKey");
            q.createIndex("by-reviewStatus", "reviewStatus");
          }
          if (!db.objectStoreNames.contains("training_records")) {
            const r = db.createObjectStore("training_records", {
              keyPath: "id",
              autoIncrement: true,
            });
            r.createIndex("by-questionId", "questionId");
            r.createIndex("by-categoryKey", "categoryKey");
            r.createIndex("by-answeredAt", "answeredAt");
            r.createIndex("by-trainingId", "trainingId");
          }
          if (!db.objectStoreNames.contains("training_sessions")) {
            db.createObjectStore("training_sessions", {
              keyPath: "trainingId",
            });
          }
        }
      },
    blocking(_currentVersion, blockedVersion) {
      // 本页持有旧连接，另一个标签页正在升级/删除数据库：
      // 必须立刻关闭本页连接，否则对方会一直停在 blocked。
      invalidateDBConnection("versionchange");
      emitConnectionEvent({ type: "blocking", blockedVersion });
    },
    blocked(_currentVersion, blockedVersion) {
      // 本页要升级，但还有其他标签页开着旧版本连接：提示用户关闭其他标签页。
      emitConnectionEvent({ type: "blocked", blockedVersion });
    },
    terminated() {
      // 浏览器异常断连（如存储被清理）：丢弃缓存，下次调用重新打开
      dbPromise = null;
      emitConnectionEvent({ type: "closed", reason: "manual" });
    },
  });

  // 超时保护：blocked 时 openDB 会一直挂起，这里给出上限，避免页面无限等待
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new DBOpenTimeoutError(
          `本地数据库打开超时（${DB_OPEN_TIMEOUT_MS}ms），可能有其他标签页仍打开着旧版本页面，请关闭其他标签页后重试`,
        ),
      );
    }, DB_OPEN_TIMEOUT_MS);
  });

  const guarded = Promise.race([attempt, timeout]).then(
    (db) => {
      // 打开成功：监听 versionchange，别的标签页升级时主动让路
      db.addEventListener("versionchange", () => {
        invalidateDBConnection("versionchange");
      });
      return db;
    },
    (err: unknown) => {
      // 打开失败/超时：丢弃缓存，下次调用可重新尝试
      dbPromise = null;
      if (err instanceof DBOpenTimeoutError) {
        emitConnectionEvent({ type: "closed", reason: "timeout" });
      }
      // 超时后若原连接最终打开成功，一并关闭，避免泄漏
      attempt.then((db) => db.close()).catch(() => undefined);
      throw err;
    },
  );

  return guarded;
}

/** 数据库打开超时（区别于「数据库损坏」） */
export class DBOpenTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DBOpenTimeoutError";
  }
}

/** 仅测试用：关闭连接并重置缓存，便于用例间重建数据库 */
export async function resetDBForTest(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  if (pending) {
    try {
      (await pending).close();
    } catch {
      /* ignore */
    }
  }
}
