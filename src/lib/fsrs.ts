/**
 * FSRS 接入层（封装 ts-fsrs 5.4.2，使用原生调度，不自造间隔）
 *
 * 已核对的 API（5.4.2）：
 * - Grade 为数字枚举：1=Again(不会) 2=Hard(模糊) 3=Good(学会了)
 * - fsrs(params).repeat(card, date)[grade] => { card, log }
 * - State: 0=New 1=Learning 2=Review 3=Relearning
 */
import {
  generatorParameters,
  createEmptyCard,
  fsrs,
  type FSRS,
  type State,
  type Grade,
  type Card,
  type RecordLogItem,
} from "ts-fsrs";
import type { WordProgress } from "@/types";
import { loadSettings } from "@/lib/settings";

/** 三档评分按钮语义映射 */
export const GRADES = {
  /** 不会 */
  again: 1,
  /** 模糊 */
  hard: 2,
  /** 学会了 */
  good: 3,
} as const satisfies Record<string, Grade>;

/** 根据设置创建调度器（保持率可在设置页调整） */
function createScheduler(): FSRS {
  const { requestRetention } = loadSettings();
  return fsrs(
    generatorParameters({
      request_retention: requestRetention,
      enable_fuzz: true,
      enable_short_term: false,
    }),
  );
}

let scheduler: FSRS = createScheduler();

/** 设置变更后重建调度器 */
export function resetScheduler(): void {
  scheduler = createScheduler();
}

/** 从本地进度记录恢复 FSRS 卡片（重新打开 App 时恢复记忆状态） */
export function cardFromProgress(progress: WordProgress): Card {
  return {
    due: new Date(progress.due),
    stability: progress.stability,
    difficulty: progress.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: progress.reps,
    lapses: progress.lapses,
    state: progress.state,
    learning_steps: progress.learningSteps ?? 0,
    last_review: undefined,
  };
}

/** 新卡片初始化（state=New） */
export function newCard(): Card {
  return createEmptyCard(new Date());
}

/** 用 FSRS 原生算法评分，返回 { card, log } */
export function reviewCard(card: Card, grade: Grade): RecordLogItem {
  return scheduler.repeat(card, new Date())[grade];
}

/** 进度是否已到期（需要复习） */
export function isDue(progress: { due: number }): boolean {
  return progress.due <= Date.now();
}

export type { State, Grade };
