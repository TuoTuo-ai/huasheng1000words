/**
 * 数据备份服务：将 IndexedDB 六个 Store 的全量数据 + 用户设置导出为 JSON，
 * 并支持「完整替换恢复」——先从备份文件校验通过，再整体回滚式写入。
 *
 * 覆盖范围（v2）：
 *   words / progress / logs                               —— FSRS 学习数据
 *   quiz_questions / training_records / training_sessions —— 分类辨析训练数据
 *
 * 两条铁律：
 *   1. 导出是纯只读操作，不修改、清空、覆盖任何原有数据
 *   2. 恢复前必须通过 validateBackup 全量校验；校验失败绝不写库
 *   3. 恢复写入在单个 readwrite 事务内完成（六表 + 设置同一事务），失败整体回滚
 */
import type { Word, WordProgress, ReviewLog } from "@/types";
import type {
  QuizQuestion,
  TrainingRecord,
  TrainingSession,
} from "@/types/quiz";
import { getDB, DB_VERSION } from "@/db/database";
import { loadSettings, saveSettings } from "@/lib/settings";

/**
 * 备份文件结构版本（独立于数据库版本管理）
 * 1 = 仅 words / progress / logs
 * 2 = 增加 quiz_questions / training_records / training_sessions
 */
export const BACKUP_SCHEMA_VERSION = 2;

export interface BackupFile {
  /** 备份结构版本 */
  schemaVersion: number;
  /** 导出时 IndexedDB 的数据库版本（取自 DB_VERSION） */
  dbVersion: number;
  /** 导出时间（ISO 8601） */
  exportedAt: string;
  /** 用户设置（localStorage，不在 IndexedDB 内） */
  settings: {
    dailyNewCount: number;
    requestRetention: number;
  };
  /** 六个 Store 的全量数据 */
  data: {
    words: Word[];
    progress: WordProgress[];
    logs: ReviewLog[];
    quiz_questions: QuizQuestion[];
    training_records: TrainingRecord[];
    training_sessions: TrainingSession[];
  };
}

/** 生成完整备份对象（纯读取） */
export async function createBackup(): Promise<BackupFile> {
  const db = await getDB();
  const [
    words,
    progress,
    logs,
    quizQuestions,
    trainingRecords,
    trainingSessions,
  ] = await Promise.all([
    db.getAll("words"),
    db.getAll("progress"),
    db.getAll("logs"),
    db.getAll("quiz_questions"),
    db.getAll("training_records"),
    db.getAll("training_sessions"),
  ]);

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    // 数据库版本统一取自 DB_VERSION 常量，不硬编码
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    settings: loadSettings(),
    data: {
      words,
      progress,
      logs,
      quiz_questions: quizQuestions,
      training_records: trainingRecords,
      training_sessions: trainingSessions,
    },
  };
}

/** 备份文件名：言语1000词备份_20261105-1204.json */
export function backupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `言语1000词备份_${now.getFullYear()}${p(now.getMonth() + 1)}${p(
    now.getDate(),
  )}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/** 触发浏览器下载备份 JSON（iPhone Safari 弹出分享/存储面板） */
export async function downloadBackup(): Promise<string> {
  const backup = await createBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backupFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 释放临时 URL（下载已启动，不影响 Safari 分享面板）
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return backupFileName();
}

/* ========================================================================
 * 一、备份文件校验（纯函数，不访问数据库）
 * ======================================================================== */

/** 六个 Store 名称（顺序固定，与备份结构一致） */
export const BACKUP_STORES = [
  "words",
  "progress",
  "logs",
  "quiz_questions",
  "training_records",
  "training_sessions",
] as const;

export type BackupStoreName = (typeof BACKUP_STORES)[number];

/** 校验错误码：便于测试与界面分类展示 */export type BackupErrorCode =
  | "empty_file" // 文件为空 / 内容为空白
  | "invalid_json" // 不是合法 JSON
  | "not_object" // 顶层不是对象
  | "missing_field" // 顶层缺字段
  | "schema_version_invalid" // schemaVersion 缺失/非正整数
  | "schema_version_incompatible" // schemaVersion 高于当前支持版本
  | "db_version_invalid" // dbVersion 缺失/非正整数
  | "db_version_incompatible" // dbVersion 高于当前数据库版本
  | "exported_at_invalid" // exportedAt 非法
  | "settings_invalid" // settings 结构或数值非法
  | "store_missing" // 缺少某个 Store 数组
  | "store_not_array" // 某个 Store 不是数组
  | "store_not_object" // 某条记录不是对象
  | "field_missing" // 必要字段缺失
  | "field_invalid" // 字段类型/取值非法
  | "duplicate_key" // 同一 Store 内主键重复
  | "unknown_store"; // 出现未知 Store

export interface BackupIssue {
  code: BackupErrorCode;
  /** 精确定位，如 data.logs[3].grade */
  path: string;
  /** 面向用户的中文说明 */
  message: string;
}

/** 六个 Store 的记录条数（校验通过 / 预览时展示） */
export type BackupCounts = Record<BackupStoreName, number>;

export interface ValidationResult {
  ok: boolean;
  /** 全部问题清单（最多保留 MAX_ISSUES 条，避免超大文件刷屏） */
  issues: BackupIssue[];
  /** 问题总数（可能大于 issues.length） */
  issueCount: number;
  /** 校验通过时的强类型备份对象；失败为 null */
  backup: BackupFile | null;
  /** 校验通过时的各表条数 */
  counts: BackupCounts | null;
}

/** 单个文件最多收集的问题条数 */
const MAX_ISSUES = 50;

/** 收集器：统一收敛错误，超过上限后只计数不记录（限流防止超大文件刷屏） */
class IssueCollector {
  readonly list: BackupIssue[] = [];
  total = 0;
  private readonly max: number;
  constructor(max: number = MAX_ISSUES) {
    this.max = max;
  }
  add(code: BackupErrorCode, path: string, message: string): void {
    this.total += 1;
    if (this.list.length < this.max) this.list.push({ code, path, message });
  }
  get ok(): boolean {
    return this.total === 0;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/** 同一 Store 内主键查重器 */
const KEY_FIELD: Record<BackupStoreName, string> = {
  words: "id",
  progress: "wordId",
  logs: "id",
  quiz_questions: "id",
  training_records: "id",
  training_sessions: "trainingId",
};

const STORE_LABEL: Record<BackupStoreName, string> = {
  words: "词语",
  progress: "学习进度",
  logs: "复习记录",
  quiz_questions: "辨析题",
  training_records: "训练记录",
  training_sessions: "训练会话",
};

/** FSRS 卡片状态合法取值：0 新词 / 1 学习中 / 2 复习中 / 3 重学中 */
const VALID_STATES = new Set([0, 1, 2, 3]);
/** 评分合法取值：1 不会 / 2 模糊 / 3 学会了（Grade 枚举，无 0） */
const VALID_GRADES = new Set([1, 2, 3]);
const TRAINING_MODES = new Set(["synonym", "pitfall", "sentence", "exam"]);
const REVIEW_STATUSES = new Set(["draft", "pending", "approved", "rejected"]);
const SOURCE_TYPES = new Set(["original", "ai"]);
const QUALITY_LEVELS = new Set(["high", "medium", "low"]);

/** 字段说明：required = 必须存在，type = 期望类型（用于报错文案） */
interface FieldRule {
  key: string;
  required: boolean;
  type: "string" | "number" | "boolean" | "array" | "object";
}

const WORD_RULES: FieldRule[] = [
  { key: "id", required: true, type: "string" },
  { key: "term", required: true, type: "string" },
  { key: "definition", required: true, type: "string" },
  { key: "createdAt", required: true, type: "number" },
  /* —— 以下为正式词库扩展字段，旧数据不含也合法；存在即校验类型 —— */
  { key: "example", required: false, type: "string" },
  { key: "source", required: false, type: "string" },
  { key: "volume", required: false, type: "string" },
  { key: "section", required: false, type: "string" },
  { key: "groupId", required: false, type: "number" },
  { key: "groupTitle", required: false, type: "string" },
  { key: "subcategory", required: false, type: "string" },
  { key: "sourcePage", required: false, type: "number" },
  { key: "examples", required: false, type: "array" },
  { key: "aiCollocations", required: false, type: "array" },
  { key: "categoryEntries", required: false, type: "array" },
  /* 学习顺序（v3 新增）：旧备份不含此字段，恢复后按 createdAt 兜底，不报错 */
  { key: "sortOrder", required: false, type: "number" },
];

const PROGRESS_RULES: FieldRule[] = [
  { key: "wordId", required: true, type: "string" },
  { key: "state", required: true, type: "number" },
  { key: "due", required: true, type: "number" },
  { key: "stability", required: true, type: "number" },
  { key: "difficulty", required: true, type: "number" },
  { key: "reps", required: true, type: "number" },
  { key: "lapses", required: true, type: "number" },
  { key: "learningSteps", required: true, type: "number" },
  { key: "updatedAt", required: true, type: "number" },
];

const LOG_RULES: FieldRule[] = [
  { key: "wordId", required: true, type: "string" },
  { key: "grade", required: true, type: "number" },
  { key: "reviewedAt", required: true, type: "number" },
  { key: "wasNew", required: true, type: "boolean" },
  { key: "stateAfter", required: true, type: "number" },
  { key: "scheduledDays", required: true, type: "number" },
];

const QUESTION_RULES: FieldRule[] = [
  { key: "id", required: true, type: "string" },
  { key: "mode", required: true, type: "string" },
  { key: "wordIds", required: true, type: "array" },
  { key: "stem", required: true, type: "string" },
  { key: "stemMeta", required: true, type: "object" },
  { key: "options", required: true, type: "array" },
  { key: "correctOptionId", required: true, type: "string" },
  { key: "explanation", required: true, type: "string" },
  { key: "explanationMeta", required: true, type: "object" },
  { key: "relatedWordIds", required: true, type: "array" },
  { key: "source", required: true, type: "object" },
  { key: "aiGenerated", required: true, type: "boolean" },
  { key: "difficulty", required: true, type: "number" },
  { key: "tags", required: true, type: "array" },
  { key: "categoryKey", required: true, type: "string" },
  { key: "reviewStatus", required: true, type: "string" },
  { key: "qualityLevel", required: true, type: "string" },
  { key: "questionVersion", required: true, type: "number" },
  { key: "createdAt", required: true, type: "number" },
  { key: "updatedAt", required: true, type: "number" },
];

const RECORD_RULES: FieldRule[] = [
  { key: "trainingId", required: true, type: "string" },
  { key: "questionId", required: true, type: "string" },
  { key: "mode", required: true, type: "string" },
  { key: "userAnswer", required: true, type: "string" },
  { key: "isCorrect", required: true, type: "boolean" },
  { key: "answeredAt", required: true, type: "number" },
  { key: "durationMs", required: true, type: "number" },
  { key: "categoryKey", required: true, type: "string" },
];

const SESSION_RULES: FieldRule[] = [
  { key: "trainingId", required: true, type: "string" },
  { key: "mode", required: true, type: "string" },
  { key: "questionIds", required: true, type: "array" },
  { key: "startedAt", required: true, type: "number" },
  { key: "answeredCount", required: true, type: "number" },
  { key: "correctCount", required: true, type: "number" },
];

const RULES: Record<BackupStoreName, FieldRule[]> = {
  words: WORD_RULES,
  progress: PROGRESS_RULES,
  logs: LOG_RULES,
  quiz_questions: QUESTION_RULES,
  training_records: RECORD_RULES,
  training_sessions: SESSION_RULES,
};

const TYPE_LABEL: Record<FieldRule["type"], string> = {
  string: "字符串",
  number: "数字",
  boolean: "布尔值",
  array: "数组",
  object: "对象",
};

/** 实际值的中文类型名（用于错误说明） */
function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  switch (typeof v) {
    case "string":
      return "字符串";
    case "number":
      return "数字";
    case "boolean":
      return "布尔值";
    case "undefined":
      return "undefined";
    case "object":
      return "对象";
    default:
      return typeof v;
  }
}

function typeMatches(v: unknown, type: FieldRule["type"]): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return isPlainObject(v);
  }
}

/** 逐字段校验一条记录（必要字段 + 类型；可选字段存在即校验类型） */
function checkFields(
  rec: Record<string, unknown>,
  rules: FieldRule[],
  path: string,
  c: IssueCollector,
  storeLabel: string,
): void {
  for (const rule of rules) {
    const value = rec[rule.key];
    if (value === undefined) {
      // 可选字段缺失合法；必要字段缺失报错（logs / training_records 的 id 由自增补齐）
      if (rule.required) {
        // 显示名做转换：wordId → words 表的 id，便于用户理解
        c.add(
          "field_missing",
          `${path}.${rule.key}`,
          `${storeLabel}缺少必要字段 ${rule.key}`,
        );
      }
      continue;
    }
    if (!typeMatches(value, rule.type)) {
      // 可选字段为 null 视为「未填写」，不算类型错误（JSON 往返后可能丢失 undefined）
      if (!rule.required && value === null) continue;
      c.add(
        "field_invalid",
        `${path}.${rule.key}`,
        `${storeLabel}的 ${rule.key} 应为${TYPE_LABEL[rule.type]}，实际为 ${kindOf(value)}`,
      );
    }
  }
}

/** 键集合里出现 undefined 时补齐为 null，保证 JSON 序列化后键不丢失 */
function normalizeRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = v === undefined ? null : v;
  return out;
}

/**
 * 校验备份对象的完整结构（纯函数，不触碰数据库、不做任何写入）
 * 覆盖：JSON 顶层结构、schemaVersion、dbVersion、settings、
 *       六个 Store 是否齐全/是否数组、逐条必要字段与类型、主键重复、取值域
 */
export function validateBackup(raw: unknown): ValidationResult {
  const c = new IssueCollector();
  const emptyCounts = (): BackupCounts => ({
    words: 0,
    progress: 0,
    logs: 0,
    quiz_questions: 0,
    training_records: 0,
    training_sessions: 0,
  });

  if (!isPlainObject(raw)) {
    c.add("not_object", "$", "备份文件顶层必须是一个 JSON 对象");
    return { ok: false, issues: c.list, issueCount: c.total, backup: null, counts: null };
  }

  // —— 顶层必要字段 ——
  for (const key of ["schemaVersion", "dbVersion", "exportedAt", "data"]) {
    if (raw[key] === undefined) {
      c.add("missing_field", `$.${key}`, `备份文件缺少必要字段 ${key}`);
    }
  }

  // —— schemaVersion ——
  const sv = raw.schemaVersion;
  if (sv !== undefined) {
    if (!isPositiveInt(sv)) {
      c.add(
        "schema_version_invalid",
        "$.schemaVersion",
        `schemaVersion 必须是正整数，实际为 ${JSON.stringify(sv) ?? kindOf(sv)}`,
      );
    } else if (sv > BACKUP_SCHEMA_VERSION) {
      c.add(
        "schema_version_incompatible",
        "$.schemaVersion",
        `备份版本过新（schemaVersion=${sv}），当前 App 最高支持 ${BACKUP_SCHEMA_VERSION}，请先升级 App`,
      );
    } else if (sv < 1) {
      c.add("schema_version_invalid", "$.schemaVersion", "schemaVersion 必须大于 0");
    }
  }

  // —— dbVersion ——
  const dv = raw.dbVersion;
  if (dv !== undefined) {
    if (!isPositiveInt(dv)) {
      c.add(
        "db_version_invalid",
        "$.dbVersion",
        `dbVersion 必须是正整数，实际为 ${JSON.stringify(dv) ?? kindOf(dv)}`,
      );
    } else if (dv > DB_VERSION) {
      c.add(
        "db_version_incompatible",
        "$.dbVersion",
        `备份的数据库版本过新（dbVersion=${dv}），当前 App 为 v${DB_VERSION}，请先升级 App`,
      );
    }
  }

  // —— exportedAt（不阻塞恢复，仅校验格式）——
  const ea = raw.exportedAt;
  if (ea !== undefined && (typeof ea !== "string" || Number.isNaN(Date.parse(ea)))) {
    c.add(
      "exported_at_invalid",
      "$.exportedAt",
      "exportedAt 必须是合法的 ISO 8601 时间字符串",
    );
  }

  // —— settings（缺失时保留当前本地设置，文件损坏才报错）——
  let settings: BackupFile["settings"] | null = null;
  const st = raw.settings;
  if (st !== undefined) {
    if (!isPlainObject(st)) {
      c.add("settings_invalid", "$.settings", "settings 必须是一个对象");
    } else {
      const d = st.dailyNewCount;
      const r = st.requestRetention;
      let ok = true;
      if (!isPositiveInt(d)) {
        ok = false;
        c.add(
          "settings_invalid",
          "$.settings.dailyNewCount",
          `settings.dailyNewCount 必须是正整数，实际为 ${JSON.stringify(d) ?? kindOf(d)}`,
        );
      }
      if (typeof r !== "number" || !(r > 0.5) || !(r <= 1)) {
        ok = false;
        c.add(
          "settings_invalid",
          "$.settings.requestRetention",
          `settings.requestRetention 必须在 (0.5, 1] 区间内，实际为 ${JSON.stringify(r) ?? kindOf(r)}`,
        );
      }
      if (ok) settings = { dailyNewCount: d as number, requestRetention: r as number };
    }
  }

  // —— data 与六个 Store ——
  const data = raw.data;
  if (data !== undefined && !isPlainObject(data)) {
    c.add("store_missing", "$.data", "data 必须是一个对象，且包含六个数据表");
  }

  const counts = emptyCounts();
  const dataObj = isPlainObject(data) ? data : null;

  if (dataObj) {
    for (const key of Object.keys(dataObj)) {
      if (!(BACKUP_STORES as readonly string[]).includes(key)) {
        c.add("unknown_store", `$.data.${key}`, `备份中出现未知数据表 ${key}，已忽略该表`);
      }
    }
  }

  for (const store of BACKUP_STORES) {
    const label = STORE_LABEL[store];
    const arr = dataObj?.[store];
    if (arr === undefined) {
      c.add("store_missing", `$.data.${store}`, `备份文件缺少 ${store}（${label}）数据表`);
      continue;
    }
    if (!Array.isArray(arr)) {
      c.add(
        "store_not_array",
        `$.data.${store}`,
        `${store}（${label}）必须是数组，实际为 ${kindOf(arr)}`,
      );
      continue;
    }
    counts[store] = arr.length;
    const seen = new Set<string>();
    const keyField = KEY_FIELD[store];
    const selfIncrement = keyField === "id" && (store === "logs" || store === "training_records");

    arr.forEach((item: unknown, i: number) => {
      const path = `$.data.${store}[${i}]`;
      if (!isPlainObject(item)) {
        c.add("store_not_object", path, `${store} 第 ${i + 1} 条记录必须是对象`);
        return;
      }
      checkFields(item, RULES[store], path, c, `${label}（第 ${i + 1} 条）`);

      // 主键查重（自增表无 id 时跳过）
      const keyValue = item[keyField];
      if (selfIncrement && keyValue === undefined) return;
      if (keyValue === undefined) return;
      const key = String(keyValue);
      if (key === "" || key === "undefined" || key === "null") {
        c.add(
          "field_invalid",
          `${path}.${keyField}`,
          `${label}（第 ${i + 1} 条）主键 ${keyField} 不能为空`,
        );
        return;
      }
      if (seen.has(key)) {
        c.add(
          "duplicate_key",
          `${path}.${keyField}`,
          `${label}主键重复：${keyField}=${key}（第 ${i + 1} 条与前序记录冲突）`,
        );
        return;
      }
      seen.add(key);

      // —— 取值域与跨字段一致性 ——
      if (store === "progress") {
        if (!VALID_STATES.has(item.state as number)) {
          c.add(
            "field_invalid",
            `${path}.state`,
            `${label}（${key}）的 state 必须是 0~3，实际为 ${String(item.state)}`,
          );
        }
      }
      if (store === "logs") {
        if (!VALID_GRADES.has(item.grade as number)) {
          c.add(
            "field_invalid",
            `${path}.grade`,
            `${label}第 ${i + 1} 条的 grade 必须是 1~3，实际为 ${String(item.grade)}`,
          );
        }
        if (!VALID_STATES.has(item.stateAfter as number)) {
          c.add(
            "field_invalid",
            `${path}.stateAfter`,
            `${label}第 ${i + 1} 条的 stateAfter 必须是 0~3，实际为 ${String(item.stateAfter)}`,
          );
        }
      }
      if (store === "quiz_questions") {
        if (!TRAINING_MODES.has(item.mode as string)) {
          c.add(
            "field_invalid",
            `${path}.mode`,
            `${label}（${key}）的 mode 取值非法：${String(item.mode)}`,
          );
        }
        if (!REVIEW_STATUSES.has(item.reviewStatus as string)) {
          c.add(
            "field_invalid",
            `${path}.reviewStatus`,
            `${label}（${key}）的 reviewStatus 取值非法：${String(item.reviewStatus)}`,
          );
        }
        if (!QUALITY_LEVELS.has(item.qualityLevel as string)) {
          c.add(
            "field_invalid",
            `${path}.qualityLevel`,
            `${label}（${key}）的 qualityLevel 取值非法：${String(item.qualityLevel)}`,
          );
        }
        if (![1, 2, 3].includes(item.difficulty as number)) {
          c.add(
            "field_invalid",
            `${path}.difficulty`,
            `${label}（${key}）的 difficulty 必须是 1~3，实际为 ${String(item.difficulty)}`,
          );
        }
        const options = item.options;
        const correctId = item.correctOptionId;
        if (Array.isArray(options) && typeof correctId === "string") {
          const ids = new Set<string>();
          let dup = false;
          for (const [oi, o] of options.entries()) {
            if (!isPlainObject(o)) {
              c.add(
                "field_invalid",
                `${path}.options[${oi}]`,
                `${label}（${key}）第 ${oi + 1} 个选项必须是对象`,
              );
              continue;
            }
            if (typeof o.id !== "string" || typeof o.content !== "string") {
              c.add(
                "field_invalid",
                `${path}.options[${oi}]`,
                `${label}（${key}）第 ${oi + 1} 个选项缺少 id / content 字符串`,
              );
              continue;
            }
            if (typeof o.isCorrect !== "boolean" || typeof o.explain !== "string") {
              c.add(
                "field_invalid",
                `${path}.options[${oi}]`,
                `${label}（${key}）选项 ${o.id} 的 isCorrect / explain 类型错误`,
              );
            }
            if (typeof o.sourceType !== "string" || !SOURCE_TYPES.has(o.sourceType)) {
              c.add(
                "field_invalid",
                `${path}.options[${oi}].sourceType`,
                `${label}（${key}）选项 ${o.id} 的 sourceType 取值非法`,
              );
            }
            if (ids.has(o.id)) dup = true;
            ids.add(o.id);
          }
          if (dup) {
            c.add(
              "duplicate_key",
              `${path}.options`,
              `${label}（${key}）的选项 ID 存在重复`,
            );
          }
          if (!ids.has(correctId)) {
            c.add(
              "field_invalid",
              `${path}.correctOptionId`,
              `${label}（${key}）的 correctOptionId=${correctId} 不在选项列表中`,
            );
          }
        }
        for (const metaKey of ["stemMeta", "explanationMeta"] as const) {
          const meta = item[metaKey];
          if (
            isPlainObject(meta) &&
            (typeof meta.sourceType !== "string" || !SOURCE_TYPES.has(meta.sourceType))
          ) {
            c.add(
              "field_invalid",
              `${path}.${metaKey}.sourceType`,
              `${label}（${key}）的 ${metaKey}.sourceType 取值非法`,
            );
          }
        }
        const src = item.source;
        if (isPlainObject(src)) {
          if (typeof src.type !== "string" || !SOURCE_TYPES.has(src.type)) {
            c.add(
              "field_invalid",
              `${path}.source.type`,
              `${label}（${key}）的 source.type 取值非法`,
            );
          }
          if (!Array.isArray(src.wordIds)) {
            c.add(
              "field_invalid",
              `${path}.source.wordIds`,
              `${label}（${key}）的 source.wordIds 必须是数组`,
            );
          }
          if (typeof src.citation !== "string") {
            c.add(
              "field_invalid",
              `${path}.source.citation`,
              `${label}（${key}）的 source.citation 必须是字符串`,
            );
          }
        }
      }
      if (store === "training_records" || store === "training_sessions") {
        if (!TRAINING_MODES.has(item.mode as string)) {
          c.add(
            "field_invalid",
            `${path}.mode`,
            `${store} 第 ${i + 1} 条的 mode 取值非法：${String(item.mode)}`,
          );
        }
      }
      if (store === "training_sessions") {
        if (item.finishedAt !== undefined && typeof item.finishedAt !== "number") {
          c.add(
            "field_invalid",
            `${path}.finishedAt`,
            `训练会话（${key}）的 finishedAt 必须是数字`,
          );
        }
        const a = item.answeredCount;
        const k = item.correctCount;
        if (typeof a === "number" && typeof k === "number") {
          if (a < 0 || k < 0) {
            c.add("field_invalid", `${path}.answeredCount`, `训练会话（${key}）的计数不能为负数`);
          } else if (k > a) {
            c.add(
              "field_invalid",
              `${path}.correctCount`,
              `训练会话（${key}）的正确数（${k}）大于答题数（${a}）`,
            );
          }
        }
      }
    });
  }

  // 同一事务内写入，重复主键会直接触发 ConstraintError；这里提前查重，
  // 保证「重复主键」在写库前就被拦下。
  const ok = c.ok;
  if (!ok) {
    return { ok: false, issues: c.list, issueCount: c.total, backup: null, counts: null };
  }

  const file = raw as unknown as BackupFile;
  const normalized: BackupFile = {
    schemaVersion: file.schemaVersion,
    dbVersion: file.dbVersion,
    exportedAt:
      typeof file.exportedAt === "string" && file.exportedAt
        ? file.exportedAt
        : new Date(0).toISOString(),
    settings: settings ?? loadSettings(),
    data: {
      words: file.data.words as Word[],
      progress: file.data.progress as WordProgress[],
      logs: file.data.logs as ReviewLog[],
      quiz_questions: file.data.quiz_questions as QuizQuestion[],
      training_records: file.data.training_records as TrainingRecord[],
      training_sessions: file.data.training_sessions as TrainingSession[],
    },
  };

  return {
    ok: true,
    issues: [],
    issueCount: 0,
    backup: normalized,
    counts,
  };
}

/** 读取用户选择的文件文本 → 校验（不写库） */
export async function validateBackupFile(file: File): Promise<ValidationResult> {
  let text = "";
  try {
    text = await file.text();
  } catch {
    return {
      ok: false,
      issues: [{ code: "invalid_json", path: "$", message: "文件读取失败，请重新选择" }],
      issueCount: 1,
      backup: null,
      counts: null,
    };
  }
  return validateBackupText(text);
}

/** 校验备份文本（空文件 / 非法 JSON 在解析阶段拦截） */
export function validateBackupText(text: string): ValidationResult {
  if (!text || !text.trim()) {
    return {
      ok: false,
      issues: [{ code: "empty_file", path: "$", message: "文件内容为空，不是有效的备份文件" }],
      issueCount: 1,
      backup: null,
      counts: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_json",
          path: "$",
          message: `文件不是合法的 JSON：${err instanceof Error ? err.message : "解析失败"}`,
        },
      ],
      issueCount: 1,
      backup: null,
      counts: null,
    };
  }
  return validateBackup(parsed);
}

/* ========================================================================
 * 二、恢复：完整替换（单事务，失败整体回滚）
 * ======================================================================== */

export interface RestoreResult {
  /** 写入前自动导出的当前数据（可在失败后用于回退） */
  safetyBackup: BackupFile;
  /** 本次恢复写入的条数 */
  counts: BackupCounts;
  /** 恢复后生效的设置（备份含 settings 时为备份值，否则保留本地值） */
  settingsApplied: BackupFile["settings"];
}

/**
 * 完整替换恢复：清空六个 Store 后写入备份数据。
 *
 * 事务保证：
 *   - 六个 Store 的清空与写入在同一个 readwrite 事务内完成
 *   - 任一步抛错即 abort，IndexedDB 保证事务内全部改动回滚，
 *     不会出现「部分表已清空、部分表未写入」的中间态
 *   - 设置写入（localStorage）放在事务提交之后，避免事务失败却改了设置
 *
 * 自增主键（logs / training_records）：
 *   - 备份中带 id 则原样写回，保证与导出前逐字段一致
 *   - 不带 id 则交给 autoIncrement 重新分配
 *
 * 调用方必须先用 validateBackup 校验；本函数仍会再校验一次，绝不写脏数据。
 */
export async function restoreBackup(raw: unknown): Promise<RestoreResult> {
  const result = validateBackup(raw);
  if (!result.ok || !result.backup) {
    const first = result.issues[0];
    throw new Error(
      `备份文件校验未通过，未写入任何数据：${first ? first.message : "结构不合法"}`,
    );
  }
  const backup = result.backup;

  // 1. 恢复前自动导出当前完整数据（任何后续失败都可用它回退）
  const safetyBackup = await createBackup();

  // 2. 单事务完整替换
  const db = await getDB();
  const tx = db.transaction([...BACKUP_STORES], "readwrite");
  // 提前失败路径不会 await tx.done，附加 catch 避免 unhandled rejection
  tx.done.catch(() => undefined);

  try {
    for (const store of BACKUP_STORES) {
      await tx.objectStore(store).clear();
    }
    for (const store of BACKUP_STORES) {
      const os = tx.objectStore(store);
      for (const item of backup.data[store] as unknown[]) {
        // 保留原始主键（含 0，0 是合法自增 id），显式 put 覆盖 clear 后的空表
        const rec = item as Record<string, unknown>;
        await os.put(normalizeRecord(rec) as never);
      }
    }
    await tx.done;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      /* 事务可能已因错误自动中止 */
    }
    throw new Error(
      `恢复失败，事务已回滚，原有数据保持不变：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 3. 事务已提交，再落地设置（备份含 settings 才覆盖）
  const settingsApplied = backup.settings;
  saveSettings(settingsApplied);

  return {
    safetyBackup,
    counts: result.counts ?? {
      words: backup.data.words.length,
      progress: backup.data.progress.length,
      logs: backup.data.logs.length,
      quiz_questions: backup.data.quiz_questions.length,
      training_records: backup.data.training_records.length,
      training_sessions: backup.data.training_sessions.length,
    },
    settingsApplied,
  };
}

/** 备份摘要（导入前展示给用户的信息） */
export interface BackupSummary {
  exportedAt: string;
  schemaVersion: number;
  dbVersion: number;
  settings: BackupFile["settings"];
  counts: BackupCounts;
  total: number;
  /** 是否含正式词库（任一词语带 section） */
  officialVocabulary: boolean;
}

/** 由已校验的备份生成摘要 */
export function summarizeBackup(
  backup: BackupFile,
  counts: BackupCounts,
): BackupSummary {
  const total =
    counts.words +
    counts.progress +
    counts.logs +
    counts.quiz_questions +
    counts.training_records +
    counts.training_sessions;
  return {
    exportedAt: backup.exportedAt,
    schemaVersion: backup.schemaVersion,
    dbVersion: backup.dbVersion,
    settings: backup.settings,
    counts,
    total,
    officialVocabulary: backup.data.words.some(
      (w) => typeof w.section === "string" && w.section.length > 0,
    ),
  };
}

/** 把备份对象序列化为可下载的 JSON 文本（恢复前存档用） */
export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

/** 生成恢复前存档文件名：言语1000词_恢复前存档_20261105-1204.json */
export function safetyBackupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `言语1000词_恢复前存档_${now.getFullYear()}${p(now.getMonth() + 1)}${p(
    now.getDate(),
  )}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/**
 * 从文本恢复：先解析 + 校验，再走 restoreBackup。
 * 界面上的「导入并恢复」统一走这个入口，保证空文件 / 坏 JSON 不会进入写库流程。
 */
export async function restoreBackupText(text: string): Promise<RestoreResult> {
  const parsed = validateBackupText(text);
  if (!parsed.ok || !parsed.backup) {
    const first = parsed.issues[0];
    throw new Error(
      `备份文件校验未通过，未写入任何数据：${first ? first.message : "结构不合法"}`,
    );
  }
  return restoreBackup(parsed.backup);
}
