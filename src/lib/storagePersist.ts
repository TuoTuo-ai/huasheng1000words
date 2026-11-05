/**
 * 浏览器存储持久化（navigator.storage.persist）
 *
 * 目的：向浏览器申请「持久化存储」权限，降低存储空间紧张时
 * IndexedDB 被浏览器自动清理的概率。
 *
 * 三条原则：
 *   1. 任何失败（API 不存在 / 被拒绝 / 抛异常）都不得阻止 App 启动
 *   2. 申请结果只记录一次，不重复打扰用户
 *   3. 申请成功 ≠ 数据绝对不会丢：持久化只表示浏览器「不会在空间紧张时自动清理」，
 *      用户手动清除网站数据、系统清理、卸载 PWA 仍会丢失数据
 */

/** 本地记录申请结果的 key（避免每次启动都重复申请与提示） */
export const PERSIST_RECORD_KEY = "yanyu-1000:storage-persist";

/** 申请结果类型 */
export type PersistOutcome =
  | "granted" // 浏览器同意持久化
  | "denied" // 浏览器明确拒绝
  | "unsupported" // 当前浏览器不支持该 API
  | "error"; // 调用过程抛异常

export interface PersistRecord {
  outcome: PersistOutcome;
  /** 申请时间（ISO 8601） */
  at: string;
  /** 申请后查询到的 persisted 状态（不支持查询时为 null） */
  persisted: boolean | null;
}

/** 读取上一次的申请记录（无记录 / 解析失败返回 null） */
export function readPersistRecord(): PersistRecord | null {
  try {
    const raw = localStorage.getItem(PERSIST_RECORD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistRecord>;
    if (typeof parsed?.outcome !== "string") return null;
    return {
      outcome: parsed.outcome as PersistOutcome,
      at: typeof parsed.at === "string" ? parsed.at : "",
      persisted: typeof parsed.persisted === "boolean" ? parsed.persisted : null,
    };
  } catch {
    return null;
  }
}

function writePersistRecord(record: PersistRecord): void {
  try {
    localStorage.setItem(PERSIST_RECORD_KEY, JSON.stringify(record));
  } catch {
    /* localStorage 不可用（隐私模式等）时静默忽略，不影响启动 */
  }
}

/** navigator.storage 的最小类型（避免依赖 lib.dom 是否包含该 API） */
interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

function getStorageManager(): StorageManagerLike | null {
  try {
    if (typeof navigator === "undefined") return null;
    const sm = (navigator as Navigator & { storage?: StorageManagerLike }).storage;
    return sm ?? null;
  } catch {
    return null;
  }
}

/** 当前是否已处于持久化状态（不支持 / 查询失败返回 null） */
export async function isStoragePersisted(): Promise<boolean | null> {
  const sm = getStorageManager();
  if (!sm || typeof sm.persisted !== "function") return null;
  try {
    return await sm.persisted();
  } catch {
    return null;
  }
}

/**
 * 申请持久化存储（纯 function，不直接改界面）
 * - API 不存在 → unsupported
 * - 抛异常 → error
 * - 返回布尔 → granted / denied
 * 无论哪种结果都不会 throw，调用方可安全 fire-and-forget。
 */
export async function requestPersistentStorage(): Promise<PersistRecord> {
  const sm = getStorageManager();
  if (!sm || typeof sm.persist !== "function") {
    const record: PersistRecord = {
      outcome: "unsupported",
      at: new Date().toISOString(),
      persisted: null,
    };
    writePersistRecord(record);
    return record;
  }

  try {
    const granted = await sm.persist();
    // 只以「本次申请是否被批准」为准；persisted() 仅用于附加说明，
    // 查询失败也不能改写 granted 的真实含义（否则会把 denied 记成已持久化）
    const persisted = await isStoragePersisted();
    const record: PersistRecord = {
      outcome: granted ? "granted" : "denied",
      at: new Date().toISOString(),
      persisted: granted ? (persisted ?? true) : false,
    };
    writePersistRecord(record);
    return record;
  } catch {
    const record: PersistRecord = {
      outcome: "error",
      at: new Date().toISOString(),
      persisted: null,
    };
    writePersistRecord(record);
    return record;
  }
}

/**
 * App 启动时调用：安全申请持久化存储。
 * - 已确认持久化成功（且本次启动已核对）→ 直接复用，不再重复申请
 * - 上次被拒绝 / 出错 → 本次启动重新尝试一次（浏览器可能在用户交互后放行）
 * - 任何异常都被吞掉，绝不阻断启动
 */
export async function ensurePersistentStorage(): Promise<PersistRecord | null> {
  const previous = readPersistRecord();
  if (previous?.persisted === true) {
    // 记录说已持久化，再与浏览器实际状态核对一次；实际为 false 则重新申请
    const actual = await isStoragePersisted();
    if (actual === null || actual) return previous;
  }
  try {
    return await requestPersistentStorage();
  } catch {
    return null;
  }
}

/**
 * 面向用户的提示文案。
 * 只在「申请被拒绝 / 出错」时给出建议；成功/不支持时返回 null，不打扰用户。
 * 注意：成功文案明确说明「并非绝对不会丢」，避免误导。
 */
export function persistNotice(record: PersistRecord | null): string | null {
  if (!record) return null;
  if (record.outcome === "granted") {
    return "已启用持久化存储，浏览器不会在空间紧张时自动清理数据。仍建议定期导出备份（清除网站数据或卸载应用仍会丢失）。";
  }
  if (record.outcome === "denied" || record.outcome === "error") {
    return "浏览器未授予持久化存储权限，空间紧张时本地数据可能被系统清理。建议定期在设置页导出备份。";
  }
  return null;
}

/** 仅测试用：清除申请记录 */
export function resetPersistRecordForTest(): void {
  try {
    localStorage.removeItem(PERSIST_RECORD_KEY);
  } catch {
    /* ignore */
  }
}
