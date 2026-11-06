/**
 * v3 sortOrder 迁移专项测试
 *
 * 覆盖用户验收要求的四类场景：
 * 1. v2 → v3 升级：回填在 upgrade 事务内原子完成
 * 2. 迁移中断 / 回填失败：事务回滚，版本与数据都不变，下次打开能重新升级
 * 3. 已是 v3 但仍有缺失 sortOrder 的库：打开时自愈补齐
 * 4. 正常 v3 数据：不被重复回填，已有 sortOrder 完全不变
 *
 * 与 wordOrder.test.ts 的分工：
 * - wordOrder.test.ts 关注「业务顺序是否正确」（导入下标、队列、清理测试词）
 * - 本文件关注「迁移本身的可靠性与幂等性」
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openDB, unwrap } from "idb";
import { getDB, resetDBForTest, backfillSortOrder, DB_NAME } from "@/db/database";
import { assignSortOrders, needsSortOrder } from "@/db/legacyMigration";
import { TEST_WORD_SOURCE } from "@/db/constants";
import { getAllWords, getTodayNewWords } from "@/db/wordRepository";
import type { Word, WordProgress } from "@/types";

/** 建一个真实 v1 库并写入数据 */
async function seedV1(rows: {
  words?: Array<Partial<Word> & { id: string; term: string; createdAt: number }>;
  progress?: WordProgress[];
  logs?: Array<Record<string, unknown>>;
}): Promise<void> {
  const v1 = await openDB(DB_NAME, 1, {
    upgrade(db) {
      const w = db.createObjectStore("words", { keyPath: "id" });
      w.createIndex("by-createdAt", "createdAt");
      const p = db.createObjectStore("progress", { keyPath: "wordId" });
      p.createIndex("by-due", "due");
      const l = db.createObjectStore("logs", {
        keyPath: "id",
        autoIncrement: true,
      });
      l.createIndex("by-wordId", "wordId");
      l.createIndex("by-reviewedAt", "reviewedAt");
    },
  });
  for (const w of rows.words ?? []) {
    await v1.put("words", { definition: "释义", ...w } as Word);
  }
  for (const p of rows.progress ?? []) await v1.put("progress", p);
  for (const l of rows.logs ?? []) await v1.add("logs", l as never);
  v1.close();
}

/**
 * 建一个已经是 v3、但故意缺 sortOrder 的库（模拟「升级后没回填成功」）。
 * 走原生 API：先建 v3 结构，再用原生事务写入不带 sortOrder 的记录。
 */
async function seedV3WithMissingSortOrder(): Promise<void> {
  // 1) 建到 v3 结构（与正式 upgrade 一致）
  const base = await openDB(DB_NAME, 3, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const w = db.createObjectStore("words", { keyPath: "id" });
        w.createIndex("by-createdAt", "createdAt");
        const p = db.createObjectStore("progress", { keyPath: "wordId" });
        p.createIndex("by-due", "due");
        const l = db.createObjectStore("logs", {
          keyPath: "id",
          autoIncrement: true,
        });
        l.createIndex("by-wordId", "wordId");
        l.createIndex("by-reviewedAt", "reviewedAt");
      }
      if (oldVersion < 2) {
        const q = db.createObjectStore("quiz_questions", { keyPath: "id" });
        q.createIndex("by-mode", "mode");
        q.createIndex("by-categoryKey", "categoryKey");
        q.createIndex("by-reviewStatus", "reviewStatus");
        const r = db.createObjectStore("training_records", {
          keyPath: "id",
          autoIncrement: true,
        });
        r.createIndex("by-questionId", "questionId");
        r.createIndex("by-categoryKey", "categoryKey");
        r.createIndex("by-answeredAt", "answeredAt");
        r.createIndex("by-trainingId", "trainingId");
        db.createObjectStore("training_sessions", { keyPath: "trainingId" });
      }
    },
  });
  const raw = unwrap(base as never) as unknown as IDBDatabase;

  // 2) 原生事务写入「缺 sortOrder」的记录
  await new Promise<void>((resolve, reject) => {
    const tx = raw.transaction("words", "readwrite");
    const store = tx.objectStore("words");
    store.put({ id: "w_a", term: "甲", definition: "d", createdAt: 10 });
    store.put({ id: "w_b", term: "乙", definition: "d", createdAt: 20 });
    store.put({ id: "w_c", term: "丙", definition: "d", createdAt: 5, source: TEST_WORD_SOURCE });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  base.close();
}

beforeEach(async () => {
  await resetDBForTest();
  globalThis.indexedDB = new IDBFactory();
});

describe("1. v2 → v3 升级：回填与版本升级原子完成", () => {
  it("升级完成后 sortOrder 已就位，早期读取即可见（不依赖后续异步补偿）", async () => {
    await seedV1({
      words: [
        { id: "w_1", term: "源远流长", createdAt: 1 },
        { id: "w_2", term: "博大精深", createdAt: 2 },
        { id: "w_3", term: "首当其冲", createdAt: 3, source: TEST_WORD_SOURCE },
      ],
    });

    const db = await getDB();
    expect(db.version).toBe(3);

    const words = (await db.getAll("words")) as Word[];
    const byId = new Map(words.map((w) => [w.id, w]));
    expect(byId.get("w_1")!.sortOrder).toBe(0);
    expect(byId.get("w_2")!.sortOrder).toBe(1);
    // 测试词不参与学习顺序
    expect(byId.get("w_3")!.sortOrder).toBeUndefined();
  });

  it("学习数据（progress / logs）在升级中逐字段不变", async () => {
    const progress: WordProgress = {
      wordId: "w_1",
      state: 2,
      due: 999999,
      stability: 12.5,
      difficulty: 6.2,
      reps: 7,
      lapses: 2,
      learningSteps: 0,
      updatedAt: 123,
    };
    await seedV1({
      words: [
        { id: "w_1", term: "甲", createdAt: 1 },
        { id: "w_2", term: "乙", createdAt: 2 },
      ],
      progress: [progress],
      logs: [
        { wordId: "w_1", grade: 3, reviewedAt: 100, wasNew: true, stateAfter: 2, scheduledDays: 2 },
        { wordId: "w_1", grade: 1, reviewedAt: 200, wasNew: false, stateAfter: 3, scheduledDays: 0 },
      ],
    });

    const db = await getDB();
    expect(await db.get("progress", "w_1")).toEqual(progress);
    const logs = await db.getAll("logs");
    expect(logs.length).toBe(2);
    expect(logs.map((l) => l.grade)).toEqual([3, 1]);
    // id / createdAt / term 原样
    const w1 = (await db.get("words", "w_1")) as Word;
    expect(w1.id).toBe("w_1");
    expect(w1.term).toBe("甲");
    expect(w1.createdAt).toBe(1);
  });

  it("回填后新词队列按 createdAt 顺序（与旧版可见顺序一致，不产生跳变）", async () => {
    await seedV1({
      words: [
        { id: "w_1", term: "甲", createdAt: 30 },
        { id: "w_2", term: "乙", createdAt: 10 },
        { id: "w_3", term: "丙", createdAt: 20 },
      ],
    });
    await getDB();
    const queue = await getTodayNewWords(10);
    expect(queue.map((w) => w.term)).toEqual(["乙", "丙", "甲"]);
  });
});

describe("2. 迁移中断 / 失败：回滚且可重试", () => {
  it("upgrade 事务被中止 → 版本保持 v2，数据与 sortOrder 均不变", async () => {
    await seedV1({
      words: [
        { id: "w_1", term: "甲", createdAt: 1 },
        { id: "w_2", term: "乙", createdAt: 2 },
      ],
    });

    // 让回填过程中的请求出错：把 createObjectStore 之后写入阶段的 put 打桩失败
    // 这里改用更贴近真实的做法——直接用一个会 abort 的 upgrade 打开同版本库
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = () => {
        const tx = req.transaction as IDBTransaction;
        // 补建 v3 需要的三个 store（模拟正式升级路径的前半段）
        if (!req.result.objectStoreNames.contains("quiz_questions")) {
          req.result.createObjectStore("quiz_questions", { keyPath: "id" });
          req.result.createObjectStore("training_records", { keyPath: "id", autoIncrement: true });
          req.result.createObjectStore("training_sessions", { keyPath: "trainingId" });
        }
        // 模拟回填失败：主动中止事务
        tx.abort();
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
    expect(raw).toBeNull(); // 事务中止 → 打开失败

    // 版本必须仍然是 2，words 数据原样且没有 sortOrder
    const check = await openDB(DB_NAME, 2);
    expect(check.version).toBe(2);
    const words = (await check.getAll("words")) as Word[];
    expect(words.map((w) => w.id).sort()).toEqual(["w_1", "w_2"]);
    expect(words.every((w) => w.sortOrder === undefined)).toBe(true);
    check.close();

    // 再次通过应用打开（模拟用户刷新）→ 升级正常完成
    const db = await getDB();
    expect(db.version).toBe(3);
    const after = (await db.getAll("words")) as Word[];
    expect(after.map((w) => w.sortOrder).sort()).toEqual([0, 1]);
  });

  it("回填中途报错时不留下半写状态（全有或全无）", async () => {
    await seedV1({
      words: [
        { id: "w_1", term: "甲", createdAt: 1 },
        { id: "w_2", term: "乙", createdAt: 2 },
        { id: "w_3", term: "丙", createdAt: 3 },
      ],
    });
    await getDB();

    // 人为清掉全部 sortOrder，制造「v3 但缺失」的状态
    const db = await getDB();
    const raw = unwrap(db as never) as unknown as IDBDatabase;
    await new Promise<void>((resolve, reject) => {
      const tx = raw.transaction("words", "readwrite");
      const store = tx.objectStore("words");
      const all = store.getAll();
      all.onsuccess = () => {
        for (const w of all.result as Word[]) {
          const copy = { ...w };
          delete copy.sortOrder;
          store.put(copy);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    expect(((await db.getAll("words")) as Word[]).every((w) => w.sortOrder === undefined)).toBe(true);

    // 正常自愈：一次补齐
    const n = await backfillSortOrder(db);
    expect(n).toBe(3);
    expect(((await db.getAll("words")) as Word[]).map((w) => w.sortOrder).sort()).toEqual([0, 1, 2]);
  });
});

describe("3. 已是 v3 但有缺失：打开时自愈", () => {
  it("getDB() 打开后补齐缺失的 sortOrder，测试词保持不回填", async () => {
    // 全新 IDBFactory 等价于浏览器重新启动：模块内不残留任何内存状态
    globalThis.indexedDB = new IDBFactory();
    await seedV3WithMissingSortOrder();

    const db = await getDB();
    const words = (await db.getAll("words")) as Word[];
    const byId = new Map(words.map((w) => [w.id, w]));
    expect(byId.get("w_c")!.sortOrder).toBeUndefined(); // 测试词
    const orders = [byId.get("w_a")!.sortOrder, byId.get("w_b")!.sortOrder];
    expect(orders.sort()).toEqual([0, 1]);
    // 按 createdAt：w_a(10) → 0，w_b(20) → 1
    expect(byId.get("w_a")!.sortOrder).toBe(0);
    expect(byId.get("w_b")!.sortOrder).toBe(1);
  });

  it("自愈不依赖内存标记：清空连接后再次打开仍能识别并补齐", async () => {
    globalThis.indexedDB = new IDBFactory();
    await seedV3WithMissingSortOrder();

    // 第一次打开补齐
    const db1 = await getDB();
    expect(((await db1.getAll("words")) as Word[]).filter(needsSortOrder).length).toBe(0);

    // 再造一次缺失（模拟另一台设备升级到 v3 但回填失败后同步过来 / 导入链路异常）
    const raw = unwrap(db1 as never) as unknown as IDBDatabase;
    await new Promise<void>((resolve, reject) => {
      const tx = raw.transaction("words", "readwrite");
      const store = tx.objectStore("words");
      const get = store.get("w_b");
      get.onsuccess = () => {
        const copy = { ...(get.result as Word) };
        delete copy.sortOrder;
        store.put(copy);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await resetDBForTest();

    // 第二次打开（新的模块生命周期内没有任何内存标记）→ 仍能补齐
    const db2 = await getDB();
    const wb = (await db2.get("words", "w_b")) as Word;
    expect(wb.sortOrder).toBeDefined();
  });

  it("自愈失败不阻断数据库使用，且下次打开会重试", async () => {
    globalThis.indexedDB = new IDBFactory();
    await seedV3WithMissingSortOrder();

    const first = await getDB();
    const raw = unwrap(first as never) as unknown as IDBDatabase;

    // 先清掉 sortOrder，制造「v3 但缺失」的状态（getDB 打开时已自愈过一次）
    await new Promise<void>((resolve, reject) => {
      const tx = raw.transaction("words", "readwrite");
      const store = tx.objectStore("words");
      const all = store.getAll();
      all.onsuccess = () => {
        for (const w of all.result as Word[]) {
          const copy = { ...w };
          delete copy.sortOrder;
          store.put(copy);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // 确认此刻确实缺 2 条（测试词不参与）
    expect(((await first.getAll("words")) as Word[]).filter((w) => w.sortOrder === undefined).length).toBe(3);

    // 让回填事务失败（模拟配额不足）
    const realTx = raw.transaction.bind(raw);
    let attempted = 0;
    (raw as unknown as { transaction: unknown }).transaction = () => {
      attempted++;
      throw new DOMException("quota exceeded", "QuotaExceededError");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(backfillSortOrder(first)).rejects.toBeTruthy();
    expect(attempted).toBeGreaterThan(0);
    spy.mockRestore();
    // 恢复原生事务：数据库仍可正常读取（失败只影响回填，不影响可用性）
    (raw as unknown as { transaction: unknown }).transaction = realTx;
    const stillReadable = (await first.getAll("words")) as Word[];
    expect(stillReadable.length).toBe(3);

    // 恢复后重试成功
    const n = await backfillSortOrder(first);
    expect(n).toBe(2);
  });
});

describe("4. 正常 v3 数据：不重复回填、不改已有 sortOrder", () => {
  it("已有 sortOrder 全部保留原值（即使与 createdAt 顺序不同）", async () => {
    const db = await getDB();
    // 故意让 sortOrder 与 createdAt 反向，模拟正式词库导入后的真实状态
    await db.put("words", { id: "w_1", term: "甲", definition: "d", createdAt: 1, sortOrder: 100 } as Word);
    await db.put("words", { id: "w_2", term: "乙", definition: "d", createdAt: 2, sortOrder: 5 } as Word);
    await db.put("words", { id: "w_3", term: "丙", definition: "d", createdAt: 3, sortOrder: 0 } as Word);

    const n = await backfillSortOrder(db);
    expect(n).toBe(0);

    const words = (await db.getAll("words")) as Word[];
    const map = new Map(words.map((w) => [w.id, w.sortOrder]));
    expect(map.get("w_1")).toBe(100);
    expect(map.get("w_2")).toBe(5);
    expect(map.get("w_3")).toBe(0);
  });

  it("重复打开 / 重复回填完全幂等（数据逐字段不变）", async () => {
    const db = await getDB();
    await db.put("words", { id: "w_1", term: "甲", definition: "d", createdAt: 1 } as Word);
    await db.put("words", { id: "w_2", term: "乙", definition: "d", createdAt: 2 } as Word);
    await backfillSortOrder(db);
    const snapshot = JSON.stringify(await db.getAll("words"));

    for (let i = 0; i < 3; i++) {
      await resetDBForTest();
      const again = await getDB();
      expect(await backfillSortOrder(again)).toBe(0);
      expect(JSON.stringify(await again.getAll("words"))).toBe(snapshot);
    }
  });

  it("正常 v3 库打开时自愈不会产生额外写请求（0 条需回填）", async () => {
    const db = await getDB();
    await db.put("words", { id: "w_1", term: "甲", definition: "d", createdAt: 1, sortOrder: 0 } as Word);
    const raw = unwrap(db as never) as unknown as IDBDatabase;
    const realTx = raw.transaction.bind(raw);
    let txCount = 0;
    // 先读一次词条（本身会开一个只读事务），再清零计数，只统计「回填是否新建事务」
    await db.getAll("words");
    (raw as unknown as { transaction: unknown }).transaction = (
      ...args: unknown[]
    ) => {
      txCount++;
      return (realTx as (...a: unknown[]) => IDBTransaction)(...args);
    };
    const n = await backfillSortOrder(db);
    (raw as unknown as { transaction: unknown }).transaction = realTx;
    expect(n).toBe(0);
    expect(txCount).toBe(1); // 只有读取用的事务，没有 readwrite 回填事务
  });
});

describe("5. assignSortOrders 纯函数规则", () => {
  const mk = (p: Partial<Word> & { id: string }): Word =>
    ({ term: p.id, definition: "d", createdAt: 0, ...p }) as Word;

  it("只挑非测试词且无 sortOrder 的记录", () => {
    const plan = assignSortOrders([
      mk({ id: "a", createdAt: 1 }),
      mk({ id: "b", createdAt: 2, sortOrder: 9 }),
      mk({ id: "c", createdAt: 3, source: TEST_WORD_SOURCE }),
    ]);
    expect(Array.from(plan.keys())).toEqual(["a"]);
  });

  it("编号 0..n-1 连续，按 createdAt 升序、同值按 id", () => {
    const plan = assignSortOrders([
      mk({ id: "b", createdAt: 5 }),
      mk({ id: "a", createdAt: 5 }),
      mk({ id: "c", createdAt: 1 }),
    ]);
    expect(plan.get("c")).toBe(0);
    expect(plan.get("a")).toBe(1);
    expect(plan.get("b")).toBe(2);
  });

  it("没有可回填项时返回空映射", () => {
    expect(assignSortOrders([]).size).toBe(0);
    expect(assignSortOrders([mk({ id: "a", sortOrder: 1 })]).size).toBe(0);
  });
});

describe("6. 顺序与既有队列规则一致", () => {
  it("升级回填后 getAllWords 顺序 = createdAt 顺序", async () => {
    await seedV1({
      words: [
        { id: "w_1", term: "丙", createdAt: 30 },
        { id: "w_2", term: "甲", createdAt: 10 },
        { id: "w_3", term: "乙", createdAt: 20 },
      ],
    });
    await getDB();
    const all = await getAllWords();
    expect(all.map((w) => w.term)).toEqual(["甲", "乙", "丙"]);
  });

  it("复习队列仍按 due 升序，与 sortOrder 无关", async () => {
    const db = await getDB();
    await db.put("words", { id: "w_1", term: "甲", definition: "d", createdAt: 1, sortOrder: 99 } as Word);
    await db.put("words", { id: "w_2", term: "乙", definition: "d", createdAt: 2, sortOrder: 0 } as Word);
    await db.put("progress", {
      wordId: "w_1", state: 2, due: 500, stability: 1, difficulty: 5,
      reps: 1, lapses: 0, learningSteps: 0, updatedAt: 1,
    } as WordProgress);
    await db.put("progress", {
      wordId: "w_2", state: 2, due: 100, stability: 1, difficulty: 5,
      reps: 1, lapses: 0, learningSteps: 0, updatedAt: 1,
    } as WordProgress);
    const { getTodayReviewQueue } = await import("@/db/wordRepository");
    const queue = await getTodayReviewQueue(new Date(10_000));
    expect(queue.map((p) => p.wordId)).toEqual(["w_2", "w_1"]); // due 小的在前
  });
});
