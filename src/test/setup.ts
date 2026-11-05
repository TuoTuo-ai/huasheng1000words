/**
 * Vitest 全局测试环境：
 * - fake-indexeddb 提供 IndexedDB 实现（浏览器外测试）
 * - stub localStorage（学习设置依赖）
 */
import "fake-indexeddb/auto";

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;
