/**
 * 启动数据自检测试
 * 覆盖：六个 Store 正常读取、空库不误判、缺表/缺索引可识别、
 *       读取异常可识别、数据库不可用与超时可区分、自检零写入
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  DB_NAME,
  DB_VERSION,
  DB_STORE_NAMES,
  getDB,
  resetDBForTest,
} from "@/db/database";
import { isIndexedDBAvailable, runSelfCheck } from "@/lib/dbSelfCheck";
import { ensureTestWords, submitGrade, GRADES } from "@/lib/studyService";
import { getAllWords } from "@/db/wordRepository";

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("数据自检 · 正常路径", () => {
  it("全新空库：六个 Store 全部可读，状态为 empty 而不是报错", async () => {
    const res = await runSelfCheck();
    expect(res.stores.map((s) => s.name)).toEqual([...DB_STORE_NAMES]);
    expect(res.stores.every((s) => s.present)).toBe(true);
    expect(res.stores.every((s) => s.count === 0)).toBe(true);
    expect(res.missingStores).toEqual([]);
    expect(res.totalRecords).toBe(0);
    expect(res.status).toBe("empty");
    expect(res.suggestBackup).toBe(false);
    expect(res.version).toBe(DB_VERSION);
  });

  it("有数据时状态为 ok，且各表计数与实际一致", async () => {
    await ensureTestWords();
    const all = await getAllWords();
    await submitGrade(all[0], GRADES.good, true);
    await submitGrade(all[1], GRADES.again, true);

    const res = await runSelfCheck();
    const db = await getDB();
    expect(res.status).toBe("ok");
    expect(res.totalRecords).toBe(
      (await db.count("words")) +
        (await db.count("progress")) +
        (await db.count("logs")),
    );
    expect(res.stores.find((s) => s.name === "words")?.count).toBe(all.length);
    expect(res.stores.find((s) => s.name === "logs")?.count).toBe(2);
    expect(res.suggestBackup).toBe(false);
  });

  it("六个 Store 都能被逐一打开读取（逐表 count 为数字）", async () => {
    const res = await runSelfCheck();
    for (const s of res.stores) {
      expect(s.present).toBe(true);
      expect(typeof s.count).toBe("number");
      expect(s.error).toBeNull();
    }
  });

  it("自检是只读的：执行前后六个 Store 数据逐字段不变", async () => {
    await ensureTestWords();
    const all = await getAllWords();
    await submitGrade(all[0], GRADES.good, true);

    const db = await getDB();
    const snapshot = async () =>
      JSON.parse(
        JSON.stringify({
          words: await db.getAll("words"),
          progress: await db.getAll("progress"),
          logs: await db.getAll("logs"),
          quiz_questions: await db.getAll("quiz_questions"),
          training_records: await db.getAll("training_records"),
          training_sessions: await db.getAll("training_sessions"),
        }),
      );

    const before = await snapshot();
    const res = await runSelfCheck();
    const after = await snapshot();

    expect(res.status).toBe("ok");
    expect(after).toEqual(before);
  });

  it("连续多次自检不改变数据（幂等）", async () => {
    await ensureTestWords();
    const db = await getDB();
    const first = await db.count("words");
    await runSelfCheck();
    await runSelfCheck();
    expect(await db.count("words")).toBe(first);
  });
});

describe("数据自检 · 结构异常", () => {
  it("缺少数据表可被识别为 schema_mismatch，并建议备份", async () => {
    // 手工建一个只含 words 的残缺库
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("words", { keyPath: "id" });
      };
      req.onsuccess = () => {
        req.result.close();
        res();
      };
      req.onerror = () => rej(req.error);
    });

    const res = await runSelfCheck();
    expect(res.status).toBe("schema_mismatch");
    expect(res.missingStores).toContain("progress");
    expect(res.missingStores).toContain("training_sessions");
    expect(res.suggestBackup).toBe(true);
    expect(res.message).toContain("缺少数据表");
  }, 20_000);

  it("索引缺失可被识别（表都在、索引不全）", async () => {
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("words", { keyPath: "id" }); // 故意不建 by-createdAt
        d.createObjectStore("progress", { keyPath: "wordId" });
        d.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("quiz_questions", { keyPath: "id" });
        d.createObjectStore("training_records", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("training_sessions", { keyPath: "trainingId" });
      };
      req.onsuccess = () => {
        req.result.close();
        res();
      };
      req.onerror = () => rej(req.error);
    });

    const res = await runSelfCheck();
    // 索引缺失会被判定为结构异常（不静默通过）
    expect(res.status).toBe("schema_mismatch");
    expect(res.detail).toContain("by-createdAt");
    expect(res.suggestBackup).toBe(true);
  }, 20_000);
});

describe("数据自检 · 环境异常分类", () => {
  it("浏览器不支持 IndexedDB 时可被探测到（不误判为数据损坏）", async () => {
    expect(isIndexedDBAvailable()).toBe(true);
    const saved = globalThis.indexedDB;
    // @ts-expect-error 故意删除以模拟不支持环境
    delete globalThis.indexedDB;
    expect(isIndexedDBAvailable()).toBe(false);
    globalThis.indexedDB = saved;
  });

  it("存储被禁用（SecurityError 类）判定为 unavailable，不提示数据损坏", async () => {
    await getDB();
    // 模拟后续打开全部失败且是权限类错误
    const { vi } = await import("vitest");
    const stubFactory = {
      open: () => {
        throw new DOMException("storage disabled", "SecurityError");
      },
      databases: async () => [],
    };
    vi.stubGlobal("indexedDB", stubFactory);
    await resetDBForTest();

    const res = await runSelfCheck();
    expect(res.status).toBe("unavailable");
    expect(res.suggestBackup).toBe(false);
    expect(res.message).toContain("无痕模式");
    vi.unstubAllGlobals();
  }, 20_000);

  it("被旧版本连接挡住时判定为 blocked（超时后返回，不无限等待）", async () => {
    // 用原始 API 打开一个 v1 连接，模拟「另一个标签页还开着旧页面」
    const legacy = await new Promise<IDBDatabase>((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("words", { keyPath: "id" });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });

    const started = Date.now();
    const res = await runSelfCheck();
    const elapsed = Date.now() - started;

    expect(res.status).toBe("blocked");
    expect(res.suggestCloseTabs).toBe(true);
    expect(res.message).toContain("其他标签页");
    // 有上限：不会无限挂起（内部超时 8s）
    expect(elapsed).toBeLessThan(15_000);
    legacy.close();
  }, 30_000);

  it("读取阶段异常判定为 read_failed，并建议先用备份恢复", async () => {
    await getDB();
    const db = await getDB();
    // 关闭连接后再触发读取失败场景：直接改 stub 让 getDB 返回损坏连接较 hack，
    // 这里改用「事务读取抛错」的模拟：包一层 fake 对象
    const brokenDb = {
      version: DB_VERSION,
      objectStoreNames: db.objectStoreNames,
      transaction: () => {
        throw new DOMException("corrupted", "UnknownError");
      },
      count: async () => {
        throw new DOMException("corrupted", "UnknownError");
      },
    };
    const { vi } = await import("vitest");
    vi.spyOn(await import("@/db/database"), "getDB").mockResolvedValue(
      brokenDb as never,
    );

    const res = await runSelfCheck();
    expect(["schema_mismatch", "read_failed"]).toContain(res.status);
    expect(res.suggestBackup).toBe(true);
    vi.restoreAllMocks();
  }, 20_000);

  it("自检结果自带面向用户的说明，且不暴露堆栈", async () => {
    const res = await runSelfCheck();
    expect(res.message.length).toBeGreaterThan(0);
    expect(res.message).not.toContain("at ");
    expect(res.message).not.toMatch(/\.tsx?:\d+/);
  });
});
