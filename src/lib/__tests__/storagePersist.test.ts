/**
 * 存储持久化（navigator.storage.persist）测试
 * 覆盖：API 存在且成功 / 明确拒绝 / API 不存在 / 调用抛异常 /
 *       结果记录与复用 / 不阻塞启动 / 提示文案不夸大保证
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePersistentStorage,
  isStoragePersisted,
  persistNotice,
  PERSIST_RECORD_KEY,
  readPersistRecord,
  requestPersistentStorage,
  resetPersistRecordForTest,
} from "@/lib/storagePersist";

/** 用一个可控的 navigator.storage 替换全局对象 */
function stubStorage(storage: unknown): void {
  vi.stubGlobal("navigator", { storage } as unknown as Navigator);
}

beforeEach(() => {
  localStorage.clear();
  resetPersistRecordForTest();
  vi.unstubAllGlobals();
});

describe("持久化存储 · 申请结果", () => {
  it("API 存在且浏览器同意：记录 granted 并查询 persisted", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(true);
    stubStorage({ persist, persisted });

    const record = await requestPersistentStorage();
    expect(record.outcome).toBe("granted");
    expect(record.persisted).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(readPersistRecord()).toEqual(record);
  });

  it("API 存在但浏览器拒绝：记录 denied，不抛异常", async () => {
    stubStorage({
      persist: vi.fn().mockResolvedValue(false),
      persisted: vi.fn().mockResolvedValue(false),
    });

    const record = await requestPersistentStorage();
    expect(record.outcome).toBe("denied");
    expect(record.persisted).toBe(false);
    expect(readPersistRecord()?.outcome).toBe("denied");
  });

  it("浏览器不支持该 API：记录 unsupported，不影响启动", async () => {
    stubStorage({});
    const record = await requestPersistentStorage();
    expect(record.outcome).toBe("unsupported");
    expect(record.persisted).toBeNull();

    // navigator 完全不存在（SSR / 极旧环境）同样安全
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", undefined);
    const record2 = await requestPersistentStorage();
    expect(record2.outcome).toBe("unsupported");
  });

  it("persist() 抛异常：记录 error，绝不向上抛", async () => {
    stubStorage({
      persist: vi.fn().mockRejectedValue(new Error("SecurityError")),
      persisted: vi.fn().mockResolvedValue(false),
    });
    await expect(requestPersistentStorage()).resolves.toMatchObject({
      outcome: "error",
    });
  });

  it("persist() 同步抛出也被兜住", async () => {
    stubStorage({
      persist: () => {
        throw new Error("boom");
      },
    });
    await expect(requestPersistentStorage()).resolves.toMatchObject({
      outcome: "error",
    });
  });

  it("persisted() 查询失败时退化用 persist 的返回值", async () => {
    stubStorage({
      persist: vi.fn().mockResolvedValue(true),
      persisted: vi.fn().mockRejectedValue(new Error("nope")),
    });
    const record = await requestPersistentStorage();
    expect(record.outcome).toBe("granted");
    expect(record.persisted).toBe(true);
  });
});

describe("持久化存储 · 启动复用与提示", () => {
  it("已记录成功结果时不再重复申请", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    stubStorage({ persist, persisted: vi.fn().mockResolvedValue(true) });

    const first = await ensurePersistentStorage();
    expect(first?.outcome).toBe("granted");
    expect(persist).toHaveBeenCalledTimes(1);

    const second = await ensurePersistentStorage();
    expect(second?.outcome).toBe("granted");
    // 复用已有记录，不产生第二次调用（不打扰用户）
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("上次被拒绝时会重新尝试一次（可能因用户交互恢复权限）", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    stubStorage({ persist, persisted: vi.fn().mockResolvedValue(true) });

    await ensurePersistentStorage();
    const second = await ensurePersistentStorage();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(second?.outcome).toBe("granted");
  });

  it("localStorage 不可用（写入抛错）时仍能返回结果", async () => {
    const original = globalThis.localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    stubStorage({ persist: vi.fn().mockResolvedValue(true) });

    await expect(requestPersistentStorage()).resolves.toMatchObject({
      outcome: "granted",
    });
    // 读取失败返回 null 而不是抛错
    expect(readPersistRecord()).toBeNull();
    vi.stubGlobal("localStorage", original);
  });

  it("记录损坏时读取返回 null，不抛异常", () => {
    localStorage.setItem(PERSIST_RECORD_KEY, "{not json");
    expect(readPersistRecord()).toBeNull();
    localStorage.setItem(PERSIST_RECORD_KEY, JSON.stringify({ foo: 1 }));
    expect(readPersistRecord()).toBeNull();
  });

  it("提示文案：成功不承诺「绝对不会丢」，拒绝时引导备份", () => {
    const granted = persistNotice({
      outcome: "granted",
      at: "",
      persisted: true,
    })!;
    expect(granted).toContain("仍建议定期导出备份");
    expect(granted).not.toContain("绝对不会丢");
    expect(granted).not.toContain("绝不会丢失");

    const denied = persistNotice({
      outcome: "denied",
      at: "",
      persisted: false,
    })!;
    expect(denied).toContain("导出备份");

    // 不支持 / 无记录时不打扰
    expect(persistNotice({ outcome: "unsupported", at: "", persisted: null })).toBeNull();
    expect(persistNotice(null)).toBeNull();
  });

  it("isStoragePersisted 在不支持时返回 null", async () => {
    stubStorage({});
    await expect(isStoragePersisted()).resolves.toBeNull();
  });
});
