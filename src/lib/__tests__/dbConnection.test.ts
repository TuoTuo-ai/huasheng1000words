/**
 * 多标签页数据库连接管理测试
 * 覆盖：versionchange 关闭旧连接、blocked 事件与超时不挂死、
 *       DB_VERSION 与六个 Store / 索引不变、Repository 使用方式不变
 */
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import {
  DB_NAME,
  DB_STORE_NAMES,
  DB_VERSION,
  getDB,
  invalidateDBConnection,
  onDBConnectionEvent,
  resetDBForTest,
} from "@/db/database";

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

describe("多标签页 · 版本变化处理", () => {
  it("其他标签页请求升级时，本页连接被主动关闭（versionchange）", async () => {
    const db = await getDB();
    const events: string[] = [];
    const off = onDBConnectionEvent((e) => events.push(e.type));

    // 模拟另一个标签页用更高版本打开（触发本页 versionchange）
    const other = await openDB(DB_NAME, DB_VERSION + 1);
    other.close();
    // versionchange 处理器是同步执行的，事件应已派发
    await Promise.resolve();

    // 本页已让路：订阅者收到 closed 通知
    expect(events).toContain("closed");

    // 连接确实被关闭：fake-indexeddb 不派发 close 事件，用「关闭后再读会抛错」验证
    let threw = false;
    try {
      await db.count("words");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // 库已被别的标签页升到 v3，本页再打开 v2 会得到版本错误
    // —— 这是「旧标签页应提示用户刷新」的真实场景，不应静默成功
    await expect(getDB()).rejects.toBeTruthy();
    off();
  }, 20_000);

  it("connection 事件可被订阅，关闭后通知订阅者", async () => {
    await getDB();
    const events: string[] = [];
    const off = onDBConnectionEvent((e) => events.push(e.type));

    invalidateDBConnection("versionchange");
    expect(events).toContain("closed");

    off();
    invalidateDBConnection("manual");
    // 取消订阅后不再收到事件
    expect(events.filter((e) => e === "closed").length).toBe(1);
  });

  it("本页升级被别的连接挡住时发出 blocked 事件", async () => {
    globalThis.indexedDB = new IDBFactory();
    // 先用原始 API 打开一个低版本连接（不带 versionchange 监听，模拟旧版页面）
    const legacy = await new Promise<IDBDatabase>((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("words")) {
          const w = d.createObjectStore("words", { keyPath: "id" });
          w.createIndex("by-createdAt", "createdAt");
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });

    const seen: string[] = [];
    const off = onDBConnectionEvent((e) => seen.push(e.type));

    // 本页打开 v2：被 legacy 连接挡住 → 触发 blocked，并在超时后抛错而不是无限等待
    const pending = getDB();
    await expect(pending).rejects.toThrow(/超时/);
    expect(seen).toContain("blocked");

    off();
    legacy.close();
  }, 30_000);

  it("DB_VERSION 仍为 2，六个 Store 与索引定义未变", async () => {
    expect(DB_VERSION).toBe(2);
    expect([...DB_STORE_NAMES]).toEqual([
      "words",
      "progress",
      "logs",
      "quiz_questions",
      "training_records",
      "training_sessions",
    ]);

    const db = await getDB();
    expect(db.version).toBe(2);
    for (const name of DB_STORE_NAMES) {
      expect(db.objectStoreNames.contains(name)).toBe(true);
    }
    const expected: Record<string, string[]> = {
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
    for (const [store, indexes] of Object.entries(expected)) {
      const tx = db.transaction(store as never, "readonly");
      const os = tx.objectStore(store as never);
      expect([...os.indexNames].sort()).toEqual([...indexes].sort());
      await tx.done;
    }
  });

  it("Repository 使用方式不变：getDB() 仍返回可直接读写的连接", async () => {
    const db = await getDB();
    await db.put("words", {
      id: "w_1",
      term: "测试",
      definition: "释义",
      createdAt: 1,
    });
    expect(await db.get("words", "w_1")).toMatchObject({ id: "w_1" });

    // 连接失效后自动重建（Repository 无需感知）
    invalidateDBConnection("manual");
    const db2 = await getDB();
    expect(await db2.count("words")).toBe(1);
  });

  it("resetDBForTest 后可以重建全新数据库", async () => {
    const db = await getDB();
    await db.put("words", { id: "w_1", term: "a", definition: "b", createdAt: 1 });

    await resetDBForTest();
    globalThis.indexedDB = new IDBFactory();
    const fresh = await getDB();
    expect(await fresh.count("words")).toBe(0);
  });

  it("DBOpenTimeoutError 是独立错误类型（区别于数据损坏）", async () => {
    const mod = await import("@/db/database");
    const err = new mod.DBOpenTimeoutError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DBOpenTimeoutError");
  });
});
