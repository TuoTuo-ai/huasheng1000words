import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { loadSettings, saveSettings } from "@/lib/settings";
import { resetScheduler } from "@/lib/fsrs";
import { getAllWords, getProgress } from "@/db/wordRepository";
import { importVocabulary, type ImportStats } from "@/lib/importService";
import {
  downloadBackup,
  validateBackupFile,
  restoreBackup,
  summarizeBackup,
  safetyBackupFileName,
  serializeBackup,
  type BackupFile,
  type BackupSummary,
} from "@/lib/backupService";
import { Link } from "react-router-dom";
import { countStats } from "@/lib/quizAdminService";
import { getAllQuestions } from "@/db/quizRepository";
import type { Word, StudySettings } from "@/types";

/** 目标记忆保持率选项 */
const retentionOptions = [
  { value: 0.8, label: "80%", desc: "复习更频繁，记得更牢" },
  { value: 0.85, label: "85%", desc: "均衡模式" },
  { value: 0.9, label: "90%", desc: "遗忘率更低（推荐）" },
];

/** 判断是否已导入正式词库：任一词语带 section 字段即视为已导入 */
function isOfficialImported(words: Word[]): boolean {
  return words.some((w) => typeof w.section === "string" && w.section);
}

/** 加载正式词库数据包（点击导入时才请求，不在页面挂载时自动导入） */
async function loadVocabFile(): Promise<unknown[]> {
  const res = await fetch("/data/vocabulary_final.json");
  if (!res.ok) throw new Error(`数据文件读取失败（${res.status}）`);
  const data = (await res.json()) as unknown[];
  if (!Array.isArray(data) || data.length === 0)
    throw new Error("数据文件格式不正确");
  return data;
}

/** 备份导出时间显示：2026-03-01 08:00 */
function formatExportedAt(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "时间未知";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

/** 设置页：学习偏好与词库信息 */
export default function SettingsPage() {
  const [settings, setSettings] = useState<StudySettings | null>(null);
  const [stats, setStats] = useState({ total: 0, learned: 0, unlearned: 0 });
  const [saved, setSaved] = useState<string | null>(null);
  const [official, setOfficial] = useState(false);
  /* 导入流程状态：idle → confirm（二次确认）→ importing → done */
  const [confirming, setConfirming] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportStats | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [backupDone, setBackupDone] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [quiz, setQuiz] = useState({ total: 0, pending: 0 });

  /* —— 恢复流程状态：idle → picked（已校验）→ confirming → restoring → done —— */
  const [restoreFileName, setRestoreFileName] = useState<string | null>(null);
  const [restoreSummary, setRestoreSummary] = useState<BackupSummary | null>(null);
  const [restoreBackupData, setRestoreBackupData] = useState<BackupFile | null>(null);
  const [restoreErrors, setRestoreErrors] = useState<string[] | null>(null);
  const [restoreIssueCount, setRestoreIssueCount] = useState(0);
  const [restoreConfirming, setRestoreConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreDone, setRestoreDone] = useState<string | null>(null);
  const [restoreFailed, setRestoreFailed] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshWordStats = async () => {
    const words = await getAllWords();
    setOfficial(isOfficialImported(words));
    let learned = 0;
    for (const w of words) {
      const p = await getProgress(w.id);
      if (p && p.reps > 0) learned++;
    }
    setStats({ total: words.length, learned, unlearned: words.length - learned });
  };

  useEffect(() => {
    let cancelled = false;
    setSettings(loadSettings());
    refreshWordStats();
    (async () => {
      const s = countStats(await getAllQuestions());
      if (cancelled) return;
      setQuiz({ total: s.total, pending: s.pending });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 用户确认后执行导入（仅此入口触发，一次性调用） */
  const doImport = async () => {
    if (importing) return; // 防止连续点击
    setConfirming(false);
    setImporting(true);
    setImportError(null);
    setResult(null);
    try {
      const records = await loadVocabFile();
      const stats = await importVocabulary(records as never[]);
      setResult(stats);
      await refreshWordStats(); // 刷新本页词库统计（其他页面进入时自动读取最新数据）
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "导入失败，请重试");
    } finally {
      setImporting(false);
    }
  };

  /** 保存设置并给出反馈 */
  const apply = (next: StudySettings, tip: string) => {
    setSettings(next);
    saveSettings(next);
    if (next.requestRetention !== settings?.requestRetention) {
      resetScheduler(); // 保持率变化后重建 FSRS 调度器
    }
    setSaved(tip);
    setTimeout(() => setSaved(null), 1500);
  };

  /** 清空恢复相关的临时状态（不触碰数据库） */
  const resetRestoreState = () => {
    setRestoreFileName(null);
    setRestoreSummary(null);
    setRestoreBackupData(null);
    setRestoreErrors(null);
    setRestoreIssueCount(0);
    setRestoreDone(null);
    setRestoreFailed(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  /** 第一步：选择文件 → 只读校验（绝不写库，也不做任何变更） */
  const pickBackupFile = async (file: File) => {
    setRestoreDone(null);
    setRestoreFailed(null);
    setRestoreConfirming(false);
    setRestoreBackupData(null);
    setRestoreSummary(null);
    setRestoreFileName(file.name);

    const result = await validateBackupFile(file);
    if (!result.ok || !result.backup || !result.counts) {
      setRestoreErrors(result.issues.map((i) => i.message));
      setRestoreIssueCount(result.issueCount);
      return;
    }
    setRestoreErrors(null);
    setRestoreIssueCount(0);
    setRestoreBackupData(result.backup);
    setRestoreSummary(summarizeBackup(result.backup, result.counts));
  };

  /** 第二步：二次确认后执行完整替换恢复 */
  const doRestore = async () => {
    if (restoring || !restoreBackupData) return;
    setRestoreConfirming(false);
    setRestoring(true);
    setRestoreFailed(null);
    try {
      const { safetyBackup, counts } = await restoreBackup(restoreBackupData);

      // 恢复前存档：立即再导出一份下载，避免用户误覆盖后无法回退
      try {
        const blob = new Blob([serializeBackup(safetyBackup)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = safetyBackupFileName();
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch {
        /* 存档下载失败不影响恢复结果，下方提示中仍会说明 */
      }

      // 恢复成功后刷新页面数据（设置、词库统计、题量统计全部重读）
      setSettings(loadSettings());
      resetScheduler();
      await refreshWordStats();
      const s = countStats(await getAllQuestions());
      setQuiz({ total: s.total, pending: s.pending });

      setRestoreDone(
        `已恢复：${counts.words} 个词语、${counts.progress} 条进度、${counts.logs} 条复习记录、` +
          `${counts.quiz_questions} 道辨析题、${counts.training_records} 条训练记录、${counts.training_sessions} 个训练会话`,
      );
      setRestoreBackupData(null);
      setRestoreSummary(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setRestoreFailed(err instanceof Error ? err.message : "恢复失败，请重试");
    } finally {
      setRestoring(false);
    }
  };

  if (!settings) {
    return (
      <div className="page-container">
        <PageHeader title="设置" subtitle="学习偏好与词库信息" />
        <p className="text-center text-slate-400">正在加载…</p>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader title="设置" subtitle="学习偏好与词库信息" />

      {/* 每日新词数量 */}
      <section className="card mb-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-medium">每日新词数量</h2>
          <span className="text-2xl font-semibold text-brand-600">
            {settings.dailyNewCount}
          </span>
        </div>
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={settings.dailyNewCount}
          onChange={(e) =>
            apply(
              { ...settings, dailyNewCount: Number(e.target.value) },
              "每日新词数量已保存",
            )
          }
          className="mt-4 w-full accent-brand-600"
          aria-label="每日新词数量"
        />
        <div className="mt-1 flex justify-between text-xs text-slate-400">
          <span>10</span>
          <span>100</span>
        </div>
      </section>

      {/* 目标记忆保持率 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">目标记忆保持率</h2>
        <p className="mt-1 text-xs text-slate-400">
          数值越高，复习越频繁，遗忘越少。仅影响之后的新安排，已有记录不受影响。
        </p>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {retentionOptions.map((opt) => {
            const active = settings.requestRetention === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() =>
                  apply(
                    { ...settings, requestRetention: opt.value },
                    `目标保持率已设为 ${opt.label}`,
                  )
                }
                className={`rounded-2xl px-2 py-3 text-center transition-colors ${
                  active
                    ? "bg-brand-600 text-white"
                    : "bg-brand-50 text-brand-700"
                }`}
              >
                <span className="block text-base font-medium">{opt.label}</span>
                <span
                  className={`mt-0.5 block text-[10px] leading-tight ${
                    active ? "text-white/80" : "text-slate-400"
                  }`}
                >
                  {opt.desc}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 词库信息 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">词库信息</h2>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-2xl font-semibold">{stats.total}</p>
            <p className="mt-1 text-xs text-slate-500">总词数</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-success-500">
              {stats.learned}
            </p>
            <p className="mt-1 text-xs text-slate-500">已学习</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-slate-400">
              {stats.unlearned}
            </p>
            <p className="mt-1 text-xs text-slate-500">未学习</p>
          </div>
        </div>
      </section>

      {/* 数据备份 */}
      <section className="card mb-4">
        <h2 className="text-base font-medium">数据备份</h2>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          导出包含全部词语、学习进度、复习历史和设置的完整备份文件（JSON）。导出为只读操作，不影响任何现有数据。
        </p>
        <button
          className="btn-secondary mt-4 w-full"
          disabled={backingUp}
          onClick={async () => {
            if (backingUp) return;
            setBackingUp(true);
            setBackupDone(null);
            setBackupError(null);
            try {
              setBackupDone(await downloadBackup());
            } catch (err) {
              setBackupError(err instanceof Error ? err.message : "导出失败，请重试");
            } finally {
              setBackingUp(false);
            }
          }}
        >
          {backingUp ? "正在导出…" : "导出备份文件"}
        </button>
        {backupDone && (
          <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
            ✓ 备份已生成：{backupDone}（如未自动保存，请在 Safari 下载列表或分享面板中选择存储位置）
          </p>
        )}
        {backupError && (
          <p className="mt-3 rounded-xl bg-danger-500/10 p-3 text-xs text-danger-500">
            导出失败：{backupError}
          </p>
        )}

        {/* —— 导入并恢复 —— */}
        <div className="mt-5 border-t border-slate-100 pt-5">
          <h3 className="text-sm font-medium">导入并恢复备份</h3>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            从备份文件恢复数据。恢复会
            <span className="font-medium text-danger-500">完整替换</span>
            当前设备上的全部本地数据（词语、学习进度、复习记录、辨析题、训练记录与设置），
            不会与现有数据合并。恢复前会自动导出当前数据作为存档。
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="restore-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void pickBackupFile(file);
            }}
          />
          <button
            className="btn-secondary mt-3 w-full"
            disabled={restoring}
            onClick={() => {
              resetRestoreState();
              fileInputRef.current?.click();
            }}
          >
            选择备份文件…
          </button>

          {/* 备份信息 + 校验结果 */}
          {restoreFileName && (
            <div className="mt-3 rounded-2xl bg-slate-50 p-4 text-xs">
              <p className="truncate font-medium text-slate-700">
                已选择：{restoreFileName}
              </p>
              {restoreErrors ? (
                <div className="mt-2">
                  <p className="text-danger-500">
                    校验未通过（{restoreIssueCount} 项问题），不会写入任何数据：
                  </p>
                  <ul className="mt-1.5 space-y-1 text-slate-500">
                    {restoreErrors.slice(0, 5).map((msg, i) => (
                      <li key={i}>· {msg}</li>
                    ))}
                  </ul>
                  {restoreIssueCount > 5 && (
                    <p className="mt-1 text-slate-400">
                      另有 {restoreIssueCount - 5} 项问题未显示，请检查备份文件是否完整。
                    </p>
                  )}
                </div>
              ) : restoreSummary ? (
                <div className="mt-2 space-y-1.5">
                  <p className="text-success-500">✓ 校验通过，可以恢复</p>
                  <div className="grid grid-cols-2 gap-y-1 text-slate-500">
                    <span>导出时间</span>
                    <span className="text-right">
                      {formatExportedAt(restoreSummary.exportedAt)}
                    </span>
                    <span>词语</span>
                    <span className="text-right">{restoreSummary.counts.words}</span>
                    <span>学习进度</span>
                    <span className="text-right">{restoreSummary.counts.progress}</span>
                    <span>复习记录</span>
                    <span className="text-right">{restoreSummary.counts.logs}</span>
                    <span>辨析题</span>
                    <span className="text-right">
                      {restoreSummary.counts.quiz_questions}
                    </span>
                    <span>训练记录</span>
                    <span className="text-right">
                      {restoreSummary.counts.training_records}
                    </span>
                    <span>训练会话</span>
                    <span className="text-right">
                      {restoreSummary.counts.training_sessions}
                    </span>
                    <span>每日新词 / 保持率</span>
                    <span className="text-right">
                      {restoreSummary.settings.dailyNewCount} /{" "}
                      {Math.round(restoreSummary.settings.requestRetention * 100)}%
                    </span>
                  </div>
                  <button
                    className="btn-primary mt-2 w-full"
                    disabled={restoring}
                    onClick={() => setRestoreConfirming(true)}
                  >
                    恢复此备份
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-slate-400">正在校验…</p>
              )}
            </div>
          )}

          {restoreDone && (
            <p className="mt-3 rounded-xl bg-success-500/10 p-3 text-xs leading-relaxed text-success-500">
              ✓ 恢复完成。{restoreDone}
            </p>
          )}
          {restoreFailed && (
            <p className="mt-3 rounded-xl bg-danger-500/10 p-3 text-xs leading-relaxed text-danger-500">
              恢复失败：{restoreFailed}
            </p>
          )}
        </div>
      </section>

      {/* 正式词库管理 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">正式词库管理</h2>
          <span
            className={`rounded-full px-2.5 py-1 text-xs ${
              official ? "bg-success-500/10 text-success-500" : "bg-slate-100 text-slate-500"
            }`}
          >
            {official ? "已导入正式词库" : "尚未导入"}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          当前词库 {stats.total} 个词。导入将新增约 984
          个高频词，并更新 6 个重叠词的释义内容；所有学习记录与复习计划保持不变。
        </p>

        <button
          className="btn-primary mt-4 w-full"
          disabled={importing}
          onClick={() => setConfirming(true)}
        >
          {importing ? "正在导入…" : official ? "重新导入正式词库" : "导入正式词库"}
        </button>

        {/* 导入结果 */}
        {result && (
          <div className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm">
            <p className="font-medium text-slate-700">导入完成</p>
            <div className="mt-2 grid grid-cols-2 gap-y-1 text-xs text-slate-500">
              <span>新增词语：{result.added} 个</span>
              <span>更新词语：{result.updated} 个</span>
              <span>重复跳过：{result.skipped} 个</span>
              <span>失败：{result.failed} 个</span>
            </div>
          </div>
        )}
        {importError && (
          <p className="mt-3 rounded-xl bg-danger-500/10 p-3 text-xs leading-relaxed text-danger-500">
            导入失败：{importError}
          </p>
        )}
      </section>

      {/* 题目管理 · 人工审核入口 */}
      <section className="card mb-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">辨析题管理</h2>
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs text-brand-700">
            待审核 {quiz.pending}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          批量生成近义词辨析题并逐题人工审核。新生成题目默认为待审核状态，
          通过后才会进入正式题库。
        </p>
        <Link to="/quiz-admin" className="btn-secondary mt-4 w-full">
          进入题目管理（共 {quiz.total} 题）
        </Link>
      </section>

      {/* 二次确认弹窗 */}
      {confirming && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-slate-900/40 p-5 md:items-center"
          onClick={() => !importing && setConfirming(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-6 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-medium">确认导入正式词库？</h3>
            <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-slate-500">
              <li>· 将导入 990 个正式高频词（成语篇 / 实词篇）</li>
              <li>· 6 个重叠测试词的释义将更新为正式内容</li>
              <li>· 您的学习记录、复习计划与进度全部保留</li>
              <li>· 导入过程请勿关闭页面</li>
            </ul>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                className="btn-secondary"
                disabled={importing}
                onClick={() => setConfirming(false)}
              >
                取消
              </button>
              <button
                className="btn-primary"
                disabled={importing}
                onClick={doImport}
              >
                {importing ? "正在导入…" : "确认导入"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 恢复二次确认弹窗（不允许误触直接覆盖） */}
      {restoreConfirming && restoreSummary && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-slate-900/40 p-5 md:items-center"
          onClick={() => !restoring && setRestoreConfirming(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-6 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-medium">确认恢复此备份？</h3>
            <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-slate-500">
              <li className="text-danger-500">
                · 当前设备上的全部本地数据将被
                <strong className="font-semibold">完整替换</strong>，不会合并
              </li>
              <li>· 将写入 {restoreSummary.counts.words} 个词语、{restoreSummary.counts.logs} 条复习记录、
                {restoreSummary.counts.quiz_questions} 道辨析题、{restoreSummary.counts.training_records} 条训练记录</li>
              <li>· 每日新词数量与目标保持率也会改成备份中的设置</li>
              <li>· 恢复前会自动下载一份当前数据存档，可随时回退</li>
              <li>· 恢复过程请勿关闭页面</li>
            </ul>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                className="btn-secondary"
                disabled={restoring}
                onClick={() => setRestoreConfirming(false)}
              >
                取消
              </button>
              <button
                className="btn-primary"
                disabled={restoring}
                onClick={doRestore}
              >
                {restoring ? "正在恢复…" : "确认恢复"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 保存反馈 */}
      {saved && (
        <p
          role="status"
          className="fixed inset-x-0 bottom-24 z-20 mx-auto w-fit rounded-full bg-slate-900/85 px-4 py-2 text-sm text-white"
        >
          ✓ {saved}
        </p>
      )}
    </div>
  );
}
