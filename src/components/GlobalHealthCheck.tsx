/**
 * 启动健康检查（应用级）
 *
 * 在 App 挂载时做两件互不阻塞的事：
 *   1. 安全申请持久化存储（失败不影响启动）
 *   2. 只读自检六个 Store，异常时在页面顶部给出明确提示
 *
 * 提示策略（避免频繁打扰）：
 *   - 正常 / 空库：不展示任何提示
 *   - 持久化被拒绝：只在「首次记录该结果」时提示一次
 *   - 数据库异常：需要用户处理，每次都提示（可关闭本次提示）
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ensurePersistentStorage,
  persistNotice,
  readPersistRecord,
  type PersistRecord,
} from "@/lib/storagePersist";
import { runSelfCheck, type SelfCheckResult } from "@/lib/dbSelfCheck";
import { onDBConnectionEvent } from "@/db/database";

/** 本次会话内是否已经提示过持久化结果（模块级，避免组件重挂载重复提示） */
let persistNoticeShown = false;

export function GlobalHealthCheck() {
  const [selfCheck, setSelfCheck] = useState<SelfCheckResult | null>(null);
  const [persist, setPersist] = useState<PersistRecord | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [extraWarning, setExtraWarning] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    // 1. 持久化：已有成功记录则直接复用，不重复申请
    const previous = readPersistRecord();
    (async () => {
      const record = await ensurePersistentStorage();
      if (!alive) return;
      // 只在「结果与服务端记录不同」或「首次」时提示，避免反复打扰
      if (!persistNoticeShown) {
        persistNoticeShown = true;
        setPersist(record ?? previous);
      }
    })();

    // 2. 数据自检（只读）
    (async () => {
      const res = await runSelfCheck();
      if (!alive) return;
      setSelfCheck(res);
    })();

    // 3. 多标签页事件：其他标签页升级/占用时给出一次性提示
    const off = onDBConnectionEvent((e) => {
      if (e.type === "blocked") {
        setExtraWarning(
          "检测到其他标签页正在使用本地数据库。为避免数据冲突，请关闭其他「言语1000词」页面。",
        );
      }
      if (e.type === "closed" && e.reason === "versionchange") {
        setExtraWarning(
          "应用已在其他标签页更新，本页面已释放本地数据库连接。建议重新加载本页面。",
        );
      }
    });

    return () => {
      alive = false;
      off();
    };
  }, []);

  if (dismissed) return null;

  // 需要用户处理的数据异常优先展示
  const abnormal =
    selfCheck &&
    selfCheck.status !== "ok" &&
    selfCheck.status !== "empty" &&
    selfCheck.status !== "absent";

  const persistText = persistNotice(persist);
  const showPersist = persist?.outcome === "denied" || persist?.outcome === "error";

  if (!abnormal && !extraWarning && !showPersist) return null;

  return (
    <div className="mx-auto w-full max-w-md px-5 pt-4 md:max-w-2xl lg:max-w-4xl">
      {abnormal && selfCheck && (
        <div
          role="alert"
          className="rounded-2xl border border-danger-500/30 bg-danger-500/5 p-4 text-sm"
        >
          <p className="font-medium text-danger-500">本地数据需要检查</p>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            {selfCheck.message}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {selfCheck.suggestBackup && (
              <Link to="/settings" className="btn-secondary px-4 py-2 text-sm">
                前往设置页备份 / 恢复
              </Link>
            )}
            {selfCheck.suggestCloseTabs && (
              <button
                className="btn-secondary px-4 py-2 text-sm"
                onClick={() => window.location.reload()}
              >
                我已关闭其他页面，重试
              </button>
            )}
            <button
              className="rounded-2xl px-4 py-2 text-sm text-slate-400"
              onClick={() => setDismissed(true)}
            >
              暂时忽略
            </button>
          </div>
        </div>
      )}

      {extraWarning && (
        <div className="mt-3 rounded-2xl bg-accent-500/10 p-4 text-xs leading-relaxed text-slate-600">
          {extraWarning}
        </div>
      )}

      {showPersist && persistText && (
        <div className="mt-3 rounded-2xl bg-slate-100 p-4 text-xs leading-relaxed text-slate-600">
          {persistText}
        </div>
      )}
    </div>
  );
}
