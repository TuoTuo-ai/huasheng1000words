/**
 * 真题结果页统计纯函数（3d-a）
 *
 * 职责：只承载结果页所需的口径计算与格式化，全部为无副作用的纯函数。
 * - 不读写 IndexedDB、不发请求、不 import examService / quizRepository / fsrs / statsService
 * - 不从 `@/pages/ExamStudyPage` 反向 import：`optionState` / `explanationText` 为独立实现
 *   （3c 已验收冻结，不迁移、不共享，语义保持一致）
 * - 正确率取整在本函数内部完成（`Math.round` 整数百分比），展示层不再二次取整
 */
import type { ExamQuestion, ExamSection } from "@/types/exam";
import type { TrainingRecord, TrainingSession } from "@/types/quiz";
import type { ExamSessionResultItem } from "@/lib/examService";

/* ---------------- 正确率 ---------------- */

/**
 * 正确率 = 正确数 / 已答题数，结果已整数四舍五入（百分比整数）。
 * 已答为 0 → 返回 0（不是 NaN，不是 Infinity）。
 * 分母只用已答题数，未答题不入分母。
 */
export function accuracy(correct: number, answered: number): number {
  if (answered <= 0) return 0;
  return Math.round((correct / answered) * 100);
}

/* ---------------- 成绩总览 ---------------- */

/** 成绩总览指标（全部由 items 本地计算，不依赖服务层计数字段） */
export interface ResultOverview {
  /** 总题数 */
  total: number;
  /** 已答题数（record !== null） */
  answered: number;
  /** 正确数（record.isCorrect === true） */
  correct: number;
  /** 错误数（record !== null && !isCorrect） */
  wrong: number;
  /** 未作答数（record === null） */
  unanswered: number;
  /** 正确率（整数百分比） */
  accuracy: number;
}

/** 统计一组题目：已答 / 正确 / 错误 / 未答 严格互斥 */
export function computeOverview(items: readonly ExamSessionResultItem[]): ResultOverview {
  let answered = 0;
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  for (const item of items) {
    if (item.record === null) {
      unanswered += 1;
    } else {
      answered += 1;
      if (item.record.isCorrect) correct += 1;
      else wrong += 1;
    }
  }
  return {
    total: items.length,
    answered,
    correct,
    wrong,
    unanswered,
    accuracy: accuracy(correct, answered),
  };
}

/* ---------------- 篇章统计 ---------------- */

/** 固定输出顺序：成语篇、实词篇 */
export const SECTION_ORDER: readonly ExamSection[] = ["成语", "实词"];

/** 单篇章统计 */
export interface SectionStat extends ResultOverview {
  section: ExamSection;
}

/**
 * 按篇章分组统计，固定返回两个条目（成语、实词），本次试卷未包含的篇章全部为 0。
 * 合计口径与 computeOverview 完全一致（同一套代码，避免两处口径漂移）。
 */
export function computeSectionStats(items: readonly ExamSessionResultItem[]): SectionStat[] {
  return SECTION_ORDER.map((section) => {
    const subset = items.filter((item) => item.question.section === section);
    return { section, ...computeOverview(subset) };
  });
}

/* ---------------- 耗时 ---------------- */

/** 单题耗时条目（顺序与 items 一致） */
export interface QuestionDuration {
  questionId: string;
  /** 毫秒；未作答为 null（不计入任何合计，UI 显示占位） */
  ms: number | null;
}

/** 耗时统计（双口径并列，互不替代） */
export interface DurationStats {
  /**
   * 主口径：整套训练耗时 = finishedAt - startedAt。
   * 未完成（无 finishedAt）→ null，不用 Date.now() 估算；时钟回拨（负值）夹到 0。
   */
  totalMs: number | null;
  /** 辅口径：有效答题用时合计 = sum(已答 record.durationMs)，不含翻页与停留间隙 */
  activeMs: number;
  /** 每题耗时，顺序与 items 一致；未答为 null */
  perQuestion: QuestionDuration[];
}

/** 把畸形的 durationMs 归一为非负数（负数 / NaN / 非数字 → 0） */
export function safeDurationMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

/**
 * 计算耗时双口径：
 * - totalMs 来自会话 startedAt / finishedAt，未完成返回 null；
 * - activeMs 只累加已答题的 durationMs，未答题天然不计入；
 * - 二者独立计算，差值即间隙时间，不做归一化。
 */
export function computeDurationStats(
  session: Pick<TrainingSession, "startedAt" | "finishedAt">,
  items: readonly ExamSessionResultItem[],
): DurationStats {
  const finishedAt = session.finishedAt;
  const totalMs =
    finishedAt === undefined || finishedAt === null
      ? null
      : Math.max(0, finishedAt - session.startedAt);

  let activeMs = 0;
  const perQuestion: QuestionDuration[] = items.map((item) => {
    const record = item.record;
    if (!record) return { questionId: item.question.id, ms: null };
    const ms = safeDurationMs(record.durationMs);
    activeMs += ms;
    return { questionId: item.question.id, ms };
  });

  return { totalMs, activeMs, perQuestion };
}

/** 读取某题的耗时（找不到返回 null） */
export function durationOf(stats: DurationStats, questionId: string): number | null {
  const hit = stats.perQuestion.find((entry) => entry.questionId === questionId);
  return hit ? hit.ms : null;
}

/**
 * 毫秒 → 展示文本：< 1 分钟显示「X 秒」，< 1 小时显示「X 分 Y 秒」，否则「X 小时 Y 分」。
 * 负值按 0 处理；null 返回占位「—」（未作答不计入合计）。
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.floor(safeDurationMs(ms) / 1000);
  if (total < 60) return `${total} 秒`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${seconds} 秒`;
}

/* ---------------- 逐题状态与详情 ---------------- */

/** 逐题状态：正确 / 错误 / 未作答（严格互斥，由 record 判定） */
export type QuestionStatus = "correct" | "wrong" | "unanswered";

/** 判定单题状态：未答优先（record === null），其次看 isCorrect */
export function questionStatus(
  item: Pick<ExamSessionResultItem, "record">,
): QuestionStatus {
  if (item.record === null) return "unanswered";
  return item.record.isCorrect ? "correct" : "wrong";
}

/** 详情所需的用户答题信息（仅用于选项着色的输入，判定仍以 record.isCorrect 为准） */
export interface AnswerState {
  questionId: string;
  userAnswer: string;
  isCorrect: boolean;
}

/** 判定选项的视觉状态：正确项 / 用户选错项 / 普通 */
export type OptionState = "correct" | "wrong" | "idle";

/**
 * 计算某个选项在详情中的状态（结果页本地实现，语义同 3c，不引用 3c 页面）。
 * 未作答：全部 idle；已作答：正确项 → correct，用户所选且错误 → wrong，其余 idle。
 * 选项顺序不参与计算，仅依据原始字母。
 */
export function optionState(
  optionId: string,
  answer: AnswerState | null | undefined,
  correctAnswer: string,
): OptionState {
  if (!answer) return "idle";
  if (optionId === correctAnswer) return "correct";
  if (optionId === answer.userAnswer) return "wrong";
  return "idle";
}

/** 从 TrainingRecord 构造详情用 AnswerState（record 为 null 时返回 null） */
export function answerStateOf(
  question: Pick<ExamQuestion, "id">,
  record: TrainingRecord | null,
): AnswerState | null {
  if (!record || record.questionId !== question.id) return null;
  return {
    questionId: question.id,
    userAnswer: record.userAnswer,
    isCorrect: record.isCorrect,
  };
}

/** 解析展示文本：trim 后为空则显示占位提示（结果页本地实现） */
export function explanationText(explanation: string | undefined | null): string {
  const text = (explanation ?? "").trim();
  return text.length > 0 ? text : "本题暂无解析";
}
