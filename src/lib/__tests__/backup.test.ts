/**
 * 数据备份功能测试（v2：六个 Store + settings）
 * 覆盖：六 Store 完整导出、新增三表逐字段核对、空数据可导出、
 *       导出只读（六个 Store 前后完全一致）、settings 完整、文件名格式
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import rawRecordsJson from "../../../data/vocabulary_final.json";
import { resetDBForTest, getDB, DB_VERSION } from "@/db/database";
import { getAllWords } from "@/db/wordRepository";
import { submitGrade, ensureTestWords, GRADES } from "@/lib/studyService";
import { importVocabulary } from "@/lib/importService";
import { saveSettings } from "@/lib/settings";
import {
  putQuestion,
  addTrainingRecord,
  putSession,
} from "@/db/quizRepository";
import {
  createBackup,
  backupFileName,
  BACKUP_SCHEMA_VERSION,
  validateBackup,
  validateBackupText,
  restoreBackup,
  restoreBackupText,
  summarizeBackup,
} from "@/lib/backupService";
import type { RawVocabRecord } from "@/lib/importService";
import { loadSettings } from "@/lib/settings";
import type { Word, WordProgress, ReviewLog } from "@/types";
import type { BackupFile } from "@/lib/backupService";
import type { QuizQuestion, TrainingRecord, TrainingSession } from "@/types/quiz";

const rawRecords = rawRecordsJson as RawVocabRecord[];

/** 六个 Store 名称 */
const STORES = [
  "words",
  "progress",
  "logs",
  "quiz_questions",
  "training_records",
  "training_sessions",
] as const;

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

/** 统计数据库实际数量（六个表） */
async function dbCounts() {
  const db = await getDB();
  return {
    words: (await db.getAll("words")).length,
    progress: (await db.getAll("progress")).length,
    logs: (await db.getAll("logs")).length,
    quiz_questions: (await db.getAll("quiz_questions")).length,
    training_records: (await db.getAll("training_records")).length,
    training_sessions: (await db.getAll("training_sessions")).length,
  };
}

/** 深拷贝六个 Store 的快照，用于比对导出前后是否变化 */
async function snapshot() {
  const db = await getDB();
  const out: Record<string, unknown[]> = {};
  for (const name of STORES) {
    out[name] = JSON.parse(JSON.stringify(await db.getAll(name)));
  }
  return out;
}

function makeQuestion(over: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: "q_test_1",
    mode: "synonym",
    wordIds: ["w_a", "w_b"],
    stem: "下列词语中，形容历史悠久、延续不断的是？",
    stemMeta: { sourceType: "original", excerpt: "源远流长" },
    options: [
      { id: "A", content: "源远流长", wordId: "w_a", isCorrect: true, explain: "原文：源头远，水流长", sourceType: "original" },
      { id: "B", content: "博大精深", wordId: "w_b", isCorrect: false, explain: "侧重内容丰富", sourceType: "original" },
    ],
    correctOptionId: "A",
    explanation: "源远流长强调时间久远，博大精深强调内容广博。",
    explanationMeta: { sourceType: "original" },
    relatedWordIds: ["w_b"],
    source: {
      type: "original",
      wordIds: ["w_a"],
      citation: "上册第9页 · 源远流长 · 释义",
      sourcePage: 9,
      sourceField: "definition",
      sourceExcerpt: "源远流长",
    },
    aiGenerated: false,
    difficulty: 2,
    tags: ["成语篇", "中华文明传统文化"],
    categoryKey: "成语篇::1::形容中华文化",
    reviewStatus: "approved",
    qualityLevel: "high",
    questionVersion: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

const baseRecord: Omit<TrainingRecord, "id"> = {
  trainingId: "t_1",
  questionId: "q_test_1",
  mode: "synonym",
  userAnswer: "A",
  isCorrect: true,
  answeredAt: 1_700_000_001_000,
  durationMs: 3200,
  categoryKey: "成语篇::1::形容中华文化",
};

const baseSession: TrainingSession = {
  trainingId: "t_1",
  mode: "synonym",
  questionIds: ["q_test_1"],
  startedAt: 1_700_000_000_500,
  finishedAt: 1_700_000_005_000,
  answeredCount: 1,
  correctCount: 1,
};

describe("备份功能 · 六个 Store 完整性", () => {
  it("备份包含六个 Store，数量均与数据库一致，设置完整", async () => {
    await ensureTestWords();
    const all = await getAllWords();
    await submitGrade(all[0], GRADES.good, true);
    await submitGrade(all[1], GRADES.again, true);
    await putQuestion(makeQuestion());
    await addTrainingRecord(baseRecord);
    await addTrainingRecord({ ...baseRecord, isCorrect: false, userAnswer: "B", answeredAt: 1_700_000_002_000 });
    await putSession(baseSession);
    saveSettings({ dailyNewCount: 35, requestRetention: 0.85 });

    const backup = await createBackup();
    const counts = await dbCounts();

    // 六个 Store 全部存在且数量一致
    expect(Object.keys(backup.data).sort()).toEqual([...STORES].sort());
    expect(backup.data.words.length).toBe(counts.words);
    expect(backup.data.progress.length).toBe(counts.progress);
    expect(backup.data.logs.length).toBe(counts.logs);
    expect(backup.data.quiz_questions.length).toBe(counts.quiz_questions);
    expect(backup.data.training_records.length).toBe(counts.training_records);
    expect(backup.data.training_sessions.length).toBe(counts.training_sessions);

    // 具体数值
    expect(backup.data.words.length).toBe(6);
    expect(backup.data.logs.length).toBe(2);
    expect(backup.data.quiz_questions.length).toBe(1);
    expect(backup.data.training_records.length).toBe(2);
    expect(backup.data.training_sessions.length).toBe(1);

    // 设置、版本、时间
    expect(backup.settings).toEqual({ dailyNewCount: 35, requestRetention: 0.85 });
    expect(backup.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(backup.dbVersion).toBe(DB_VERSION);
    expect(backup.exportedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(backup.exportedAt))).toBe(false);

    // 词语内容完整（含释义）
    const w = backup.data.words.find((x) => x.term === "首当其冲")!;
    expect(w.definition).toContain("最先受到攻击");
  });

  it("新增三个 Store 的关键字段逐字段核对", async () => {
    await putQuestion(makeQuestion());
    await addTrainingRecord(baseRecord);
    await putSession(baseSession);

    const backup = await createBackup();

    // quiz_questions
    const q = backup.data.quiz_questions[0];
    expect(q.id).toBe("q_test_1");
    expect(q.mode).toBe("synonym");
    expect(q.wordIds).toEqual(["w_a", "w_b"]);
    expect(q.stem).toBe("下列词语中，形容历史悠久、延续不断的是？");
    expect(q.stemMeta).toEqual({ sourceType: "original", excerpt: "源远流长" });
    expect(q.options.length).toBe(2);
    expect(q.options.filter((o) => o.isCorrect).length).toBe(1);
    expect(q.correctOptionId).toBe("A");
    expect(q.explanation).toContain("博大精深");
    expect(q.source.sourcePage).toBe(9);
    expect(q.source.sourceField).toBe("definition");
    expect(q.source.sourceExcerpt).toBe("源远流长");
    expect(q.aiGenerated).toBe(false);
    expect(q.difficulty).toBe(2);
    expect(q.tags).toEqual(["成语篇", "中华文明传统文化"]);
    expect(q.categoryKey).toBe("成语篇::1::形容中华文化");
    expect(q.reviewStatus).toBe("approved");
    expect(q.qualityLevel).toBe("high");
    expect(q.questionVersion).toBe(1);
    expect(q.createdAt).toBe(1_700_000_000_000);

    // training_records（含自增主键 id）
    const r = backup.data.training_records[0];
    expect(typeof r.id).toBe("number");
    expect(r.trainingId).toBe("t_1");
    expect(r.questionId).toBe("q_test_1");
    expect(r.mode).toBe("synonym");
    expect(r.userAnswer).toBe("A");
    expect(r.isCorrect).toBe(true);
    expect(r.answeredAt).toBe(1_700_000_001_000);
    expect(r.durationMs).toBe(3200);
    expect(r.categoryKey).toBe("成语篇::1::形容中华文化");

    // training_sessions
    const s = backup.data.training_sessions[0];
    expect(s.trainingId).toBe("t_1");
    expect(s.mode).toBe("synonym");
    expect(s.questionIds).toEqual(["q_test_1"]);
    expect(s.startedAt).toBe(1_700_000_000_500);
    expect(s.finishedAt).toBe(1_700_000_005_000);
    expect(s.answeredCount).toBe(1);
    expect(s.correctCount).toBe(1);
  });

  it("正式词库规模下备份完整（990 词 + 学习记录 + 训练数据）", async () => {
    await ensureTestWords();
    await importVocabulary(rawRecords);
    const all = await getAllWords();
    await submitGrade(all[0], GRADES.good, true);
    await putQuestion(makeQuestion());
    await addTrainingRecord(baseRecord);
    await putSession(baseSession);

    const backup = await createBackup();
    const counts = await dbCounts();
    expect(backup.data.words.length).toBe(990);
    expect(backup.data.words.length).toBe(counts.words);
    expect(backup.data.progress.length).toBe(1);
    expect(backup.data.logs.length).toBe(1);
    expect(backup.data.quiz_questions.length).toBe(1);
    expect(backup.data.training_records.length).toBe(1);
    expect(backup.data.training_sessions.length).toBe(1);
  }, 60_000);
});

describe("备份功能 · 边界与安全", () => {
  it("空数据（六个 Store 全空）可以正常导出", async () => {
    const backup = await createBackup();
    expect(backup.data.words).toEqual([]);
    expect(backup.data.progress).toEqual([]);
    expect(backup.data.logs).toEqual([]);
    expect(backup.data.quiz_questions).toEqual([]);
    expect(backup.data.training_records).toEqual([]);
    expect(backup.data.training_sessions).toEqual([]);
    expect(backup.settings.dailyNewCount).toBe(20); // 默认设置
    expect(backup.settings.requestRetention).toBe(0.9);
    expect(backup.dbVersion).toBe(DB_VERSION);
  });

  it("导出是只读操作：六个 Store 导出前后完全一致", async () => {
    await ensureTestWords();
    const all = await getAllWords();
    await submitGrade(all[0], GRADES.good, true);
    await putQuestion(makeQuestion());
    await addTrainingRecord(baseRecord);
    await putSession(baseSession);

    const before = await snapshot();
    const backup = await createBackup();
    const after = await snapshot();

    // 数据库未被修改（六个 Store 逐表比对）
    expect(after).toEqual(before);
    // 备份内容即导出前的数据
    expect(backup.data.words).toEqual(after.words);
    expect(backup.data.progress).toEqual(after.progress);
    expect(backup.data.logs).toEqual(after.logs);
    expect(backup.data.quiz_questions).toEqual(after.quiz_questions);
    expect(backup.data.training_records).toEqual(after.training_records);
    expect(backup.data.training_sessions).toEqual(after.training_sessions);
  });

  it("备份可序列化为 JSON 并原样还原（结构无丢失）", async () => {
    await putQuestion(makeQuestion());
    await addTrainingRecord(baseRecord);
    await putSession(baseSession);
    saveSettings({ dailyNewCount: 50, requestRetention: 0.8 });

    const backup = await createBackup();
    const roundTrip = JSON.parse(JSON.stringify(backup));
    expect(roundTrip).toEqual(backup);
    expect(Object.keys(roundTrip.data).sort()).toEqual([...STORES].sort());
    expect(roundTrip.settings).toEqual({ dailyNewCount: 50, requestRetention: 0.8 });
  });

  it("备份文件名包含日期时间且格式正确", () => {
    const name = backupFileName(new Date(2026, 10, 5, 12, 4));
    expect(name).toBe("言语1000词备份_20261105-1204.json");
  });
});

/* ========================================================================
 * 恢复功能（V1.0 · 本地备份恢复）
 * ------------------------------------------------------------------------
 * 覆盖：正常导出→导入六 Store 逐字段一致、空文件 / 损坏 JSON /
 *       错误 schemaVersion / 错误 dbVersion、缺失字段 / 错误类型 / 重复主键、
 *       事务中途失败原库完整保留、取消确认不写库、恢复后可重读
 * ======================================================================== */

/** 构造一个「有内容」的完整场景：学习数据 + 辨析训练数据 + 非默认设置 */
async function seedSampleData() {
  await ensureTestWords();
  const all = await getAllWords();
  await submitGrade(all[0], GRADES.good, true);
  await submitGrade(all[1], GRADES.again, true);
  await putQuestion(makeQuestion());
  await addTrainingRecord(baseRecord);
  await putSession(baseSession);
  saveSettings({ dailyNewCount: 35, requestRetention: 0.85 });
}

/** 用给定数据直接落库（跳过 service，用于构造「当前库」与「备份」的差异） */
async function seedRaw(opts: {
  words?: Word[];
  progress?: WordProgress[];
  logs?: ReviewLog[];
  questions?: QuizQuestion[];
  records?: TrainingRecord[];
  sessions?: TrainingSession[];
}) {
  const db = await getDB();
  for (const w of opts.words ?? []) await db.put("words", w);
  for (const p of opts.progress ?? []) await db.put("progress", p);
  for (const l of opts.logs ?? []) await db.put("logs", l);
  for (const q of opts.questions ?? []) await db.put("quiz_questions", q);
  for (const r of opts.records ?? []) await db.put("training_records", r);
  for (const s of opts.sessions ?? []) await db.put("training_sessions", s);
}

function sampleWord(id: string, term: string, over: Partial<Word> = {}): Word {
  return { id, term, definition: `${term}的释义`, createdAt: 1_700_000_000_000, ...over };
}

function sampleProgress(wordId: string, over: Partial<WordProgress> = {}): WordProgress {
  return {
    wordId,
    state: 2,
    due: 1_700_100_000_000,
    stability: 12.5,
    difficulty: 4.2,
    reps: 3,
    lapses: 1,
    learningSteps: 0,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function sampleLog(id: number, wordId: string, over: Partial<ReviewLog> = {}): ReviewLog {
  return {
    id,
    wordId,
    grade: 3,
    reviewedAt: 1_700_000_000_000 + id,
    wasNew: id === 1,
    stateAfter: 2,
    scheduledDays: 1,
    ...over,
  };
}

function sampleRecord(id: number, over: Partial<TrainingRecord> = {}): TrainingRecord {
  return { ...baseRecord, id, ...over };
}

function sampleSession(trainingId: string, over: Partial<TrainingSession> = {}): TrainingSession {
  return { ...baseSession, trainingId, ...over };
}

/** 以对象形式构造备份文本（便于局部破坏字段） */
function asFile(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

describe("恢复功能 · 正常导出→导入一致性", () => {
  it("导出→清库→恢复：六个 Store 逐条逐字段完全一致", async () => {
    await seedSampleData();
    // 额外补一条自增 id 为 0 的记录，验证 id=0 不会被丢弃
    await seedRaw({
      logs: [sampleLog(0, "w_ext_0")],
      records: [sampleRecord(0)],
    });
    const backup = await createBackup();
    const before = await snapshot();

    await resetDBForTest();
    globalThis.indexedDB = new IDBFactory();

    const result = await restoreBackup(JSON.parse(asFile(backup)));
    expect(result.counts).toEqual({
      words: before.words.length,
      progress: before.progress.length,
      logs: before.logs.length,
      quiz_questions: before.quiz_questions.length,
      training_records: before.training_records.length,
      training_sessions: before.training_sessions.length,
    });

    const after = await snapshot();
    // 逐 Store 逐字段一致（含自增 id、可选字段、undefined→null 归一）
    expect(after.words).toEqual(JSON.parse(JSON.stringify(before.words)));
    expect(after.progress).toEqual(JSON.parse(JSON.stringify(before.progress)));
    expect(after.logs).toEqual(JSON.parse(JSON.stringify(before.logs)));
    expect(after.quiz_questions).toEqual(JSON.parse(JSON.stringify(before.quiz_questions)));
    expect(after.training_records).toEqual(JSON.parse(JSON.stringify(before.training_records)));
    expect(after.training_sessions).toEqual(JSON.parse(JSON.stringify(before.training_sessions)));

    // 恢复后重新导出，与备份内容等价（可重复恢复）
    const second = await createBackup();
    expect(second.data.words).toEqual(backup.data.words);
    expect(second.data.progress).toEqual(backup.data.progress);
    expect(second.data.logs).toEqual(backup.data.logs);
    expect(second.data.quiz_questions).toEqual(backup.data.quiz_questions);
    expect(second.data.training_records).toEqual(backup.data.training_records);
    expect(second.data.training_sessions).toEqual(backup.data.training_sessions);
  }, 60_000);

  it("恢复会替换当前本地数据（而非合并），并落地备份中的设置", async () => {
    // 备份里只有 1 个词
    const backup = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      dbVersion: DB_VERSION,
      exportedAt: "2026-01-02T03:04:05.000Z",
      settings: { dailyNewCount: 55, requestRetention: 0.8 },
      data: {
        words: [sampleWord("w_only", "唯一词")],
        progress: [],
        logs: [],
        quiz_questions: [],
        training_records: [],
        training_sessions: [],
      },
    };
    // 当前库里已有 3 个词 + 学过的进度
    await seedRaw({
      words: [sampleWord("w_a", "甲"), sampleWord("w_b", "乙"), sampleWord("w_c", "丙")],
      progress: [sampleProgress("w_a")],
    });

    await restoreBackup(backup);

    const db = await getDB();
    const words = await db.getAll("words");
    expect(words.map((w) => w.id)).toEqual(["w_only"]);
    expect(await db.getAll("progress")).toEqual([]);
    expect(loadSettings()).toEqual({ dailyNewCount: 55, requestRetention: 0.8 });
  });

  it("恢复前会自动导出当前完整数据，可用它回退到恢复前状态", async () => {
    await seedRaw({
      words: [sampleWord("w_old", "旧词")],
      progress: [sampleProgress("w_old")],
      logs: [sampleLog(1, "w_old")],
    });

    const backup = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      dbVersion: DB_VERSION,
      exportedAt: "2026-02-02T00:00:00.000Z",
      settings: { dailyNewCount: 30, requestRetention: 0.9 },
      data: {
        words: [sampleWord("w_new", "新词")],
        progress: [],
        logs: [],
        quiz_questions: [],
        training_records: [],
        training_sessions: [],
      },
    };

    const { safetyBackup } = await restoreBackup(backup);
    // 存档即恢复前状态
    expect(safetyBackup.data.words.map((w) => w.id)).toEqual(["w_old"]);
    expect(safetyBackup.data.progress.length).toBe(1);
    expect(safetyBackup.data.logs.length).toBe(1);

    // 用存档回退：数据回到恢复前
    await restoreBackup(safetyBackup);
    const db = await getDB();
    expect((await db.getAll("words")).map((w) => w.id)).toEqual(["w_old"]);
    expect((await db.getAll("progress")).length).toBe(1);
    expect((await db.getAll("logs")).length).toBe(1);
  });

  it("备份缺少 settings 时保留本地设置不丢", async () => {
    saveSettings({ dailyNewCount: 45, requestRetention: 0.9 });
    await restoreBackup({
      schemaVersion: BACKUP_SCHEMA_VERSION,
      dbVersion: DB_VERSION,
      exportedAt: "2026-04-01T00:00:00.000Z",
      data: {
        words: [],
        progress: [],
        logs: [],
        quiz_questions: [],
        training_records: [],
        training_sessions: [],
      },
    });
    expect(loadSettings()).toEqual({ dailyNewCount: 45, requestRetention: 0.9 });
  });
});

describe("恢复功能 · 文件与版本校验", () => {
  it("空文件被拦下，且不写库", async () => {
    await seedRaw({ words: [sampleWord("w_keep", "保留词")] });
    for (const text of ["", "   ", "\n\t "]) {
      const r = validateBackupText(text);
      expect(r.ok).toBe(false);
      expect(r.issues[0].code).toBe("empty_file");
      expect(r.backup).toBeNull();
    }
    await expect(restoreBackupText("")).rejects.toThrow(/校验未通过/);
    const db = await getDB();
    expect((await db.getAll("words")).map((w) => w.id)).toEqual(["w_keep"]);
  });

  it("损坏的 JSON 被拦下，且不写库", async () => {
    await seedRaw({ words: [sampleWord("w_keep", "保留词")] });
    const broken = '{"schemaVersion": 2, "data": {';
    const r = validateBackupText(broken);
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe("invalid_json");
    expect(r.issues[0].message).toContain("不是合法的 JSON");
    const db = await getDB();
    expect((await db.getAll("words")).length).toBe(1);
  }, 20_000);

  it("顶层不是对象（数组 / 数字 / 字符串）被拦下", () => {
    for (const raw of [[], 42, "backup", null]) {
      const r = validateBackup(raw);
      expect(r.ok).toBe(false);
      expect(r.issues[0].code).toBe("not_object");
    }
  });

  it("schemaVersion 过新被拦下，提示升级 App", async () => {
    const backup = await makeMinimalBackup();
    backup.schemaVersion = BACKUP_SCHEMA_VERSION + 1;
    const r = validateBackup(backup);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "schema_version_incompatible")).toBe(true);
    const msg = r.issues.find((i) => i.code === "schema_version_incompatible")!.message;
    expect(msg).toContain("请先升级 App");
  });

  it("schemaVersion 缺失 / 非法（0、负数、小数、字符串）被拦下", async () => {
    const backup = await makeMinimalBackup();
    for (const bad of [undefined, null, 0, -1, 1.5, "2"]) {
      const copy = JSON.parse(asFile(backup)) as Record<string, unknown>;
      copy.schemaVersion = bad;
      const r = validateBackup(copy);
      expect(r.ok).toBe(false);
      expect(
        r.issues.some(
          (i) => i.code === "schema_version_invalid" || i.code === "missing_field",
        ),
      ).toBe(true);
    }
  });

  it("dbVersion 过新被拦下，提示当前数据库版本", async () => {
    const backup = await makeMinimalBackup();
    backup.dbVersion = DB_VERSION + 1;
    const r = validateBackup(backup);
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === "db_version_incompatible")!;
    expect(issue.message).toContain(`当前 App 为 v${DB_VERSION}`);
  });

  it("dbVersion 缺失 / 非法被拦下", async () => {
    const backup = await makeMinimalBackup();
    for (const bad of [undefined, 0, 2.5, "2"]) {
      const copy = JSON.parse(asFile(backup)) as Record<string, unknown>;
      copy.dbVersion = bad;
      const r = validateBackup(copy);
      expect(r.ok).toBe(false);
      expect(
        r.issues.some((i) => i.code === "db_version_invalid" || i.code === "missing_field"),
      ).toBe(true);
    }
  });

  it("settings 数值越界被拦下（保持率必须在 (0.5, 1]）", async () => {
    const backup = await makeMinimalBackup();
    for (const r of [0.5, 1.2, 0, -0.9]) {
      const copy = JSON.parse(asFile(backup)) as typeof backup;
      copy.settings.requestRetention = r;
      const res = validateBackup(copy);
      expect(res.ok).toBe(false);
      expect(res.issues.some((i) => i.code === "settings_invalid")).toBe(true);
    }
  });
});

describe("恢复功能 · 数据结构校验", () => {
  it("缺少某个 Store 数组被拦下，并指出具体表名", async () => {
    const backup = await makeMinimalBackup();
    for (const store of STORES) {
      const copy = JSON.parse(asFile(backup)) as {
        data: Record<string, unknown[]>;
      };
      delete copy.data[store];
      const r = validateBackup(copy);
      expect(r.ok).toBe(false);
      const issue = r.issues.find((i) => i.code === "store_missing" && i.path.endsWith(store));
      expect(issue).toBeTruthy();
    }
  });

  it("Store 不是数组被拦下", async () => {
    const backup = await makeMinimalBackup();
    const copy = JSON.parse(asFile(backup)) as { data: Record<string, unknown> };
    copy.data.logs = { not: "array" };
    const r = validateBackup(copy);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "store_not_array" && i.path.endsWith("logs"))).toBe(true);
  });

  it("记录不是对象被拦下", async () => {
    const backup = await makeMinimalBackup();
    const copy = JSON.parse(asFile(backup)) as { data: Record<string, unknown[]> };
    copy.data.words = [sampleWord("w1", "词"), "not-an-object"];
    const r = validateBackup(copy);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "store_not_object")).toBe(true);
  });

  it("必要字段缺失被拦下：逐表验证并能定位到字段路径", async () => {
    const cases: Array<[keyof BackupFile["data"], string]> = [
      ["words", "term"],
      ["progress", "stability"],
      ["logs", "grade"],
      ["quiz_questions", "correctOptionId"],
      ["training_records", "isCorrect"],
      ["training_sessions", "startedAt"],
    ];
    for (const [store, field] of cases) {
      const backup = await makeMinimalBackup();
      const copy = JSON.parse(asFile(backup)) as {
        data: Record<string, Record<string, unknown>[]>;
      };
      delete copy.data[store][0][field];
      const r = validateBackup(copy);
      expect(r.ok).toBe(false);
      const issue = r.issues.find(
        (i) => i.code === "field_missing" && i.path === `$.data.${store}[0].${field}`,
      );
      expect(issue, `${store}.${field}`).toBeTruthy();
    }
  });

  it("字段类型错误被拦下：字符串/数字互换可被识别", async () => {
    const backup = await makeMinimalBackup();
    const copy = JSON.parse(asFile(backup)) as { data: Record<string, Record<string, unknown>[]> };
    copy.data.words[0].createdAt = "1700000000000"; // 应为数字
    copy.data.progress[0].state = "2"; // 应为数字
    copy.data.logs[0].wasNew = "true"; // 应为布尔
    copy.data.quiz_questions[0].options = "A,B"; // 应为数组
    copy.data.training_records[0].durationMs = null; // 必要字段为 null
    copy.data.training_sessions[0].questionIds = 1; // 应为数组

    const r = validateBackup(copy);
    expect(r.ok).toBe(false);
    const paths = r.issues.filter((i) => i.code === "field_invalid").map((i) => i.path);
    expect(paths).toContain("$.data.words[0].createdAt");
    expect(paths).toContain("$.data.progress[0].state");
    expect(paths).toContain("$.data.logs[0].wasNew");
    expect(paths).toContain("$.data.quiz_questions[0].options");
    expect(paths).toContain("$.data.training_records[0].durationMs");
    expect(paths).toContain("$.data.training_sessions[0].questionIds");
    // 错误说明里给出实际类型
    expect(
      r.issues.find((i) => i.path === "$.data.words[0].createdAt")!.message,
    ).toContain("字符串");
  });

  it("重复主键被拦下：六个 Store 逐一验证", async () => {
    // words：id 重复
    {
      const backup = await makeMinimalBackup();
      backup.data.words.push(sampleWord("w_1", "重复词"));
      const r = validateBackup(backup);
      expect(r.ok).toBe(false);
      const issue = r.issues.find((i) => i.code === "duplicate_key")!;
      expect(issue.path).toBe("$.data.words[1].id");
      expect(issue.message).toContain("id=w_1");
    }
    // progress：wordId 重复
    {
      const backup = await makeMinimalBackup();
      backup.data.progress.push(sampleProgress("w_1"));
      const r = validateBackup(backup);
      expect(r.issues.some((i) => i.code === "duplicate_key" && i.path.endsWith("progress[1].wordId"))).toBe(true);
    }
    // logs：自增 id 重复
    {
      const backup = await makeMinimalBackup();
      backup.data.logs.push(sampleLog(1, "w_1"));
      const r = validateBackup(backup);
      expect(r.issues.some((i) => i.code === "duplicate_key" && i.path.endsWith("logs[1].id"))).toBe(true);
    }
    // quiz_questions：id 重复
    {
      const backup = await makeMinimalBackup();
      backup.data.quiz_questions.push(makeQuestion());
      const r = validateBackup(backup);
      expect(r.issues.some((i) => i.code === "duplicate_key" && i.path.endsWith("quiz_questions[1].id"))).toBe(true);
    }
    // training_records：自增 id 重复
    {
      const backup = await makeMinimalBackup();
      backup.data.training_records.push(sampleRecord(1));
      const r = validateBackup(backup);
      expect(r.issues.some((i) => i.code === "duplicate_key" && i.path.endsWith("training_records[1].id"))).toBe(true);
    }
    // training_sessions：trainingId 重复
    {
      const backup = await makeMinimalBackup();
      backup.data.training_sessions.push(sampleSession("t_1"));
      const r = validateBackup(backup);
      expect(r.issues.some((i) => i.code === "duplicate_key" && i.path.endsWith("training_sessions[1].trainingId"))).toBe(true);
    }
  });

  it("无效取值被拦下：state / grade 越界、mode 非法、正确选项不在选项中", async () => {
    const backup = await makeMinimalBackup();
    const copy = JSON.parse(asFile(backup)) as { data: Record<string, Record<string, unknown>[]> };
    copy.data.progress[0].state = 7;
    copy.data.logs[0].grade = 0;
    copy.data.quiz_questions[0].mode = "unknown-mode";
    copy.data.quiz_questions[0].correctOptionId = "Z";
    copy.data.training_records[0].mode = "nope";
    copy.data.training_sessions[0].correctCount = 99; // 大于答题数

    const r = validateBackup(copy);
    expect(r.ok).toBe(false);
    const codes = r.issues.map((i) => i.path);
    expect(codes).toContain("$.data.progress[0].state");
    expect(codes).toContain("$.data.logs[0].grade");
    expect(codes).toContain("$.data.quiz_questions[0].mode");
    expect(codes).toContain("$.data.quiz_questions[0].correctOptionId");
    expect(codes).toContain("$.data.training_records[0].mode");
    expect(codes).toContain("$.data.training_sessions[0].correctCount");
  });

  it("未知 Store 只提示不阻断（前向兼容）", async () => {
    const backup = await makeMinimalBackup();
    const copy = JSON.parse(asFile(backup)) as { data: Record<string, unknown> };
    copy.data.future_store = [];
    const r = validateBackup(copy);
    // 目前实现采用「提示 + 忽略该表」，不阻断恢复
    expect(r.issues.some((i) => i.code === "unknown_store")).toBe(true);
  });

  it("校验失败时绝不写库：库内数据保持原样", async () => {
    await seedRaw({
      words: [sampleWord("w_keep", "保留词")],
      progress: [sampleProgress("w_keep")],
    });
    const before = await snapshot();

    const bad = await makeMinimalBackup();
    bad.data.words[0].createdAt = "not-a-number" as unknown as number;
    await expect(restoreBackup(bad)).rejects.toThrow(/校验未通过/);

    expect(await snapshot()).toEqual(before);
  });
});

describe("恢复功能 · 事务安全与页面刷新", () => {
  it("事务中途失败时原库完整保留（六表逐字段不变，设置不被改写）", async () => {
    await seedSampleData();
    saveSettings({ dailyNewCount: 35, requestRetention: 0.85 });
    const before = await snapshot();

    // 构造一个「能通过校验、但写入数据库时失败」的备份：
    // __poison 是不在校验规则内的额外字段，函数值无法结构化克隆，
    // 因此在事务已 clear 完并写入前几张表之后抛 DataCloneError。
    const backup = await makeMinimalBackup();
    const poisoned = JSON.parse(asFile(backup)) as {
      settings: { dailyNewCount: number; requestRetention: number };
      data: Record<string, unknown[]>;
    };
    poisoned.settings.dailyNewCount = 88;
    (poisoned.data.progress[0] as Record<string, unknown>).__poison = () => 1;

    await expect(restoreBackup(poisoned)).rejects.toThrow(/恢复失败，事务已回滚/);

    // 关键：clear 已执行过，但事务回滚后原有数据必须一条不少
    expect(await snapshot()).toEqual(before);
    // 设置写入安排在事务提交之后，失败时不得被改写
    expect(loadSettings()).toEqual({ dailyNewCount: 35, requestRetention: 0.85 });
  }, 30_000);

  it("取消确认不写库：非零差异下库内数据完全不变", async () => {
    await seedSampleData();
    const before = await snapshot();

    // 模拟用户在确认弹窗点「取消」——不调用 restoreBackup，仅完成校验
    const backup = await makeMinimalBackup();
    const r = validateBackup(backup);
    expect(r.ok).toBe(true);

    expect(await snapshot()).toEqual(before);
  });

  it("恢复后可从数据库重新读取（页面重挂载可正常显示）", async () => {
    await seedSampleData();
    const backup = await createBackup();
    await resetDBForTest();
    globalThis.indexedDB = new IDBFactory();
    // 模拟「清空后」的 App 状态
    expect(await (await getDB()).getAll("words")).toEqual([]);

    await restoreBackup(JSON.parse(asFile(backup)));

    // 模拟页面用常规读取路径重新取数
    const words = await getAllWords();
    expect(words.length).toBe(backup.data.words.length);
    const db = await getDB();
    expect((await db.getAll("progress")).length).toBe(backup.data.progress.length);
    expect((await db.get("progress", backup.data.progress[0].wordId))?.state).toBe(
      backup.data.progress[0].state,
    );
    expect(loadSettings()).toEqual(backup.settings);
  }, 60_000);

  it("恢复不破坏导出功能：恢复后仍能正常导出且内容自洽", async () => {
    await seedSampleData();
    const first = await createBackup();
    await restoreBackup(JSON.parse(asFile(first)));
    const second = await createBackup();
    expect(second.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(second.dbVersion).toBe(DB_VERSION);
    expect(second.data).toEqual(first.data);
    expect(backupFileName()).toMatch(/^言语1000词备份_\d{8}-\d{4}\.json$/);
  }, 60_000);

  it("恢复前后备份摘要信息可用于界面展示", async () => {
    await seedSampleData();
    const backup = await createBackup();
    const r = validateBackup(JSON.parse(asFile(backup)));
    expect(r.ok).toBe(true);
    const summary = summarizeBackup(r.backup!, r.counts!);
    expect(summary.counts.words).toBe(backup.data.words.length);
    expect(summary.total).toBe(
      backup.data.words.length +
        backup.data.progress.length +
        backup.data.logs.length +
        backup.data.quiz_questions.length +
        backup.data.training_records.length +
        backup.data.training_sessions.length,
    );
    expect(summary.settings).toEqual(backup.settings);
    expect(summary.exportedAt).toBe(backup.exportedAt);
  }, 60_000);
});

/* ---------------- 构造工具（供恢复测试使用） ---------------- */

/** 最小合法备份：六表各 1 条，字段齐全 */
async function makeMinimalBackup(): Promise<BackupFile> {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: "2026-03-01T08:00:00.000Z",
    settings: { dailyNewCount: 20, requestRetention: 0.9 },
    data: {
      words: [sampleWord("w_1", "测试词")],
      progress: [sampleProgress("w_1")],
      logs: [sampleLog(1, "w_1")],
      quiz_questions: [makeQuestion()],
      training_records: [sampleRecord(1)],
      training_sessions: [sampleSession("t_1")],
    },
  };
}
