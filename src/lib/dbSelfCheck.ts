/**
 * 启动数据自检（只读）
 *
 * 目的：在 App 启动后确认本地数据库处于可用状态，并在异常时给出准确分类，
 * 避免把「正常的空库」或「网络问题」误判为「数据损坏」。
 *
 * 硬性约束：
 *   - 只读：只做 open / count / getAll 的读操作，不清库、不重建、不覆盖
 *   - 不升级版本：打开时使用 DB_VERSION，不做任何 schema 变更
 *   - 不抛异常：所有结果通过 status 返回，调用方决定如何提示
 */
import {
  DB_NAME,
  DB_VERSION,
  DB_STORE_NAMES,
  DBOpenTimeoutError,
  getDB,
} from "@/db/database";

/** 自检状态分类 */
export type SelfCheckStatus =
  /** 六个 Store 全部可读（空库也算正常） */
  | "ok"
  /** 六个 Store 可读，但其中部分为空（提示未导入词库，不是错误） */
  | "empty"
  /** 数据库尚不存在（首次使用），已按正常流程创建 */
  | "absent"
  /** 打不开：可能是浏览器不支持 / 存储被禁用（私密模式等） */
  | "unavailable"
  /** 打开超时：多半是其他标签页占用旧连接 */
  | "blocked"
  /** 缺表 / 索引缺失：数据库结构异常，需要备份恢复或重建 */
  | "schema_mismatch"
  /** 能打开，但读取数据时出错：可能已损坏 */
  | "read_failed"
  /** 浏览器限制了本地存储（如 Safari 无痕模式） */
  | "quota_denied";

export interface StoreReport {
  name: string;
  /** 是否存在于数据库中 */
  present: boolean;
  /** 记录条数（读取失败为 null） */
  count: number | null;
  /** 读取失败时的错误说明 */
  error: string | null;
}

export interface SelfCheckResult {
  status: SelfCheckStatus;
  /** 数据库版本（无法打开时为 null） */
  version: number | null;
  /** 六个 Store 的逐表结果 */
  stores: StoreReport[];
  /** 缺失的表名 */
  missingStores: string[];
  /** 记录总数（全部读取成功时统计） */
  totalRecords: number;
  /** 面向用户的中文说明 */
  message: string;
  /** 是否建议用户去设置页导出/恢复备份 */
  suggestBackup: boolean;
  /** 是否建议用户关闭其他标签页后重试 */
  suggestCloseTabs: boolean;
  /** 原始错误（仅用于开发排查，界面不直接展示） */
  detail: string | null;
}

/** 索引定义（自检用；与 database.ts 保持一致，不参与建库） */
const EXPECTED_INDEXES: Record<string, string[]> = {
  words: ["by-createdAt"],
  progress: ["by-due"],
  logs: ["by-wordId", "by-reviewedAt"],
  quiz_questions: ["by-mode", "by-categoryKey", "by-reviewStatus"],
  training_records: [
    "by-questionId",
    "by-categoryKey",
    "by-answeredAt",
    "by-trainingId",
  ],
  training_sessions: [],
};

function emptyStores(): StoreReport[] {
  return DB_STORE_NAMES.map((name) => ({
    name,
    present: false,
    count: null,
    error: null,
  }));
}

function result(
  status: SelfCheckStatus,
  patch: Partial<SelfCheckResult> = {},
): SelfCheckResult {
  return {
    status,
    version: null,
    stores: emptyStores(),
    missingStores: [],
    totalRecords: 0,
    message: "",
    suggestBackup: false,
    suggestCloseTabs: false,
    detail: null,
    ...patch,
  };
}

/** 判断是否属于「浏览器不支持 / 存储被禁用」类错误（而非数据损坏） */
function isUnavailableError(err: unknown): boolean {
  if (!err) return false;
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return (
      err.name === "SecurityError" ||
      err.name === "InvalidStateError" ||
      err.name === "NotSupportedError"
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /SecurityError|denied|not supported|InvalidStateError/i.test(msg);
}

/**
 * 执行一次只读自检。
 * 注意：本函数不会创建或修改任何 Store —— 打开数据库时若库不存在，
 * IndexedDB 会按 upgrade 创建空库，这是浏览器打开行为，不是自检写入。
 */
export async function runSelfCheck(): Promise<SelfCheckResult> {
  // 1. 数据库是否已存在（不触发创建）
  let existed = true;
  try {
    if (typeof indexedDB.databases === "function") {
      const list = await indexedDB.databases();
      existed = list.some((d) => d.name === DB_NAME);
    }
  } catch {
    // 部分浏览器（Safari）不支持 databases()，按「已存在」继续探测
    existed = true;
  }

  // 2. 打开并检查结构
  let db;
  try {
    db = await getDB();
  } catch (err) {
    if (err instanceof DBOpenTimeoutError) {
      return result("blocked", {
        message:
          "本地数据库被其他标签页占用，暂时无法读取。请关闭其他已打开的「言语1000词」页面后重试。",
        suggestCloseTabs: true,
        detail: err.message,
      });
    }
    if (isUnavailableError(err)) {
      return result("unavailable", {
        message:
          "当前浏览器无法使用本地存储（可能处于无痕模式或已禁用网站数据）。请使用普通窗口打开，数据不会丢失。",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return result("read_failed", {
      message:
        "本地数据库无法打开，可能是浏览器存储异常。请勿重复刷新，建议先用备份文件恢复，或联系技术支持。",
      suggestBackup: true,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const version = db.version ?? null;

  // 3. 结构检查：六个 Store 与索引是否齐全
  const stores = emptyStores();
  const missingStores: string[] = [];
  const indexProblems: string[] = [];

  try {
    for (const report of stores) {
      const present = db.objectStoreNames.contains(
        report.name as (typeof DB_STORE_NAMES)[number],
      );
      report.present = present;
      if (!present) {
        missingStores.push(report.name);
        continue;
      }
      const tx = db.transaction(
        report.name as (typeof DB_STORE_NAMES)[number],
        "readonly",
      );
      const os = tx.objectStore(
        report.name as (typeof DB_STORE_NAMES)[number],
      );
      // idb 的 TypedDOMStringList 只接受已声明的索引名，
      // 自检需要探测运行时真实索引，这里退化为原生 DOMStringList 读取。
      const indexNames = os.indexNames as unknown as {
        contains(name: string): boolean;
      };
      for (const idx of EXPECTED_INDEXES[report.name] ?? []) {
        if (!indexNames.contains(idx)) {
          indexProblems.push(`${report.name} 缺少索引 ${idx}`);
        }
      }
      await tx.done;
    }
  } catch (err) {
    return result("schema_mismatch", {
      version,
      stores,
      missingStores,
      message: `本地数据库结构异常（${missingStores.length ? `缺少数据表：${missingStores.join("、")}` : "索引不完整"}）。请先导出备份，再用备份文件恢复；如仍失败请联系技术支持。`,
      suggestBackup: true,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (missingStores.length > 0 || indexProblems.length > 0) {
    return result("schema_mismatch", {
      version,
      stores,
      missingStores,
      message: missingStores.length
        ? `本地数据库结构异常，缺少数据表：${missingStores.join("、")}。请先导出备份，再用备份文件恢复；如仍失败请联系技术支持。`
        : `本地数据库结构异常（${indexProblems.join("；")}）。请先导出备份，再用备份文件恢复；如仍失败请联系技术支持。`,
      suggestBackup: true,
      detail: indexProblems.join("；") || null,
    });
  }

  // 4. 逐表只读计数（空表不算异常）
  let totalRecords = 0;
  try {
    for (const report of stores) {
      const n = await db.count(
        report.name as (typeof DB_STORE_NAMES)[number],
      );
      report.count = n;
      totalRecords += n;
    }
  } catch (err) {
    const failing = stores.filter((s) => s.count === null).map((s) => s.name);
    return result("read_failed", {
      version,
      stores,
      missingStores: [],
      totalRecords,
      message: `本地数据读取失败（${failing.join("、") || "未知数据表"}）。数据可能已损坏，请勿重复刷新，建议先用备份文件恢复，或联系技术支持。`,
      suggestBackup: true,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 5. 正常：区分「首次使用/空库」与「已有数据」
  if (totalRecords === 0) {
    const wordsEmpty = stores.find((s) => s.name === "words")?.count === 0;
    return result(existed && !wordsEmpty ? "ok" : "empty", {
      version,
      stores,
      totalRecords,
      message: existed
        ? "本地数据库正常，当前还没有任何数据。可以先去设置页导入正式词库。"
        : "首次使用：已创建本地数据库，可以开始导入词库。",
    });
  }

  return result("ok", {
    version,
    stores,
    totalRecords,
    message: "本地数据库正常。",
  });
}

/**
 * 不创建数据库的「环境探测」：仅用于区分「浏览器根本不支持 IndexedDB」。
 * 不打开、不写入任何数据。
 */
export function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

/** 数据库名与版本（供界面/日志显示） */
export const SELF_CHECK_META = { name: DB_NAME, version: DB_VERSION };
