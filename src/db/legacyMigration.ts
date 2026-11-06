/**
 * 数据迁移与自愈修复
 *
 * —— 为什么必须用原生请求回调 ——
 * 升级（versionchange）事务的生命周期规则：只有在某个请求的 onsuccess 回调里
 * **同步**发起下一个请求，事务才会保持活动并继续走下去；一旦回调返回、没有
 * 排队的请求，事务立即自动提交。因此 `await` 任何 Promise（包括 idb 封装的
 * getAll / put）都会让回调先返回，事务随即提交 —— 后续写入全部丢失。
 * 这正是此前把回填挪到升级事务外、再用内存标记兜底的根本原因。
 *
 * 本模块的所有写入都通过 `store.openCursor()` / `cursor.update()` 链式回调完成，
 * 保证「回填完成」与「版本升级」是同一次原子提交。
 *
 * —— 一致性规则 ——
 * 编号规则收敛在 `assignSortOrders()` 一处：按 createdAt 升序（同值按 id）赋 0..n-1。
 * 迁移回填与导入时的下标语义一致；同一份数据重复执行结果完全相同（幂等）。
 *
 * 依赖：只依赖类型与常量，不依赖 idb、不依赖 database.ts，可独立测试。
 */
import type { Word } from "@/types";
import { TEST_WORD_SOURCE } from "@/db/constants";

/** 是否需要为这条词回填 sortOrder（测试词不参与学习顺序） */
export function needsSortOrder(word: Word): boolean {
  return word.source !== TEST_WORD_SOURCE && word.sortOrder === undefined;
}

/** 稳定排序：createdAt 升序 → id 升序 */
function compareByCreation(a: Word, b: Word): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 计算待回填词的 sortOrder（纯函数，便于单测）：
 * 输入全量词条，返回 `id → sortOrder` 的映射，只包含需要回填的词。
 * 编号从 0 开始，只在这些词之间连续递增 —— 与导入时的「JSON 原始下标」语义一致。
 */
export function assignSortOrders(words: Word[]): Map<string, number> {
  const targets = words.filter(needsSortOrder).sort(compareByCreation);
  const result = new Map<string, number>();
  targets.forEach((w, i) => result.set(w.id, i));
  return result;
}

/**
 * 在给定 store 上用游标逐条回填 sortOrder。
 *
 * 调用方必须位于一个活跃事务中（升级事务或独立 readwrite 事务均可）。
 * 所有请求都在上一个请求的 onsuccess 里同步发起，因此事务不会提前提交；
 * 全部写完后才调用 onDone。
 *
 * - 只写 sortOrder 一个字段，其余字段沿用库里当前值（cursor.value）
 * - 待写项按 id 排序后逐条处理，与完成先后无关，结果与执行顺序无关
 * - 不需要回填的词不会产生写请求
 */
export function backfillSortOrderInStore(
  store: IDBObjectStore,
  onDone: () => void,
  onError: (err: unknown) => void,
): void {
  const getAllReq = store.getAll();
  getAllReq.onerror = () => onError(getAllReq.error);
  getAllReq.onsuccess = () => {
    const all = (getAllReq.result ?? []) as Word[];
    const plan = assignSortOrders(all);
    if (plan.size === 0) {
      onDone();
      return;
    }
    // 固定处理顺序，便于排查；结果由 plan 决定，不受处理顺序影响
    const ids = Array.from(plan.keys()).sort();
    let i = 0;
    const next = (): void => {
      if (i >= ids.length) {
        onDone();
        return;
      }
      const id = ids[i++];
      const cursorReq = store.openCursor(id);
      cursorReq.onerror = () => onError(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          // 记录已被删除：跳过，继续下一条
          next();
          return;
        }
        const current = cursor.value as Word;
        const updateReq = cursor.update({
          ...current,
          sortOrder: plan.get(id) as number,
        });
        updateReq.onerror = () => onError(updateReq.error);
        updateReq.onsuccess = next;
      };
    };
    next();
  };
}
