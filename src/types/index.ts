/**
 * 领域类型定义
 * 数据模型已为后续 FSRS（ts-fsrs）接入预留字段
 */
import type { State, Grade } from "ts-fsrs";

/** 同一词语在某原始分类下的来源记录（重复词可能有多个） */
export interface CategoryEntry {
  /** 册别：上册/下册 */
  volume: string;
  /** 篇章：成语篇/实词篇 */
  section: string;
  /** 一级分类编号 */
  groupId: number;
  /** 一级分类名称 */
  groupTitle: string;
  /** PDF 原始二级分类（可能为空） */
  subcategory?: string;
  /** PDF 页码 */
  sourcePage?: number;
  /** 来源（如：上册第9页） */
  source?: string;
}

/** 词语 */
export interface Word {
  id: string;
  /** 词语本体 */
  term: string;
  /** 释义 */
  definition: string;
  /** 例句（旧字段，兼容保留；正式词库默认取 examples[0]） */
  example?: string;
  /** 来源（如：2023年国考真题） */
  source?: string;
  createdAt: number;

  /* —— 以下为正式词库扩展字段（均可选，旧数据不含也合法） —— */

  /** 册别：上册/下册 */
  volume?: string;
  /** 篇章：成语篇/实词篇 */
  section?: string;
  /** 一级分类编号 */
  groupId?: number;
  /** 一级分类名称 */
  groupTitle?: string;
  /** PDF 原始二级分类 */
  subcategory?: string;
  /** PDF 页码 */
  sourcePage?: number;
  /** 全部原文例句 */
  examples?: string[];
  /** AI 补充典型搭配（当前为空） */
  aiCollocations?: string[];
  /** 同一词语在 PDF 中的全部分类来源记录（重复词有多条） */
  categoryEntries?: CategoryEntry[];
}

/** 词语学习进度（对接 FSRS 卡片模型） */
export interface WordProgress {
  wordId: string;
  /** FSRS 卡片状态：0=新词 1=学习中 2=复习中 3=重学中 */
  state: State;
  /** 下次到期时间（时间戳，FSRS 计算结果） */
  due: number;
  stability: number;
  difficulty: number;
  /** FSRS 卡片的重复次数与遗忘次数 */
  reps: number;
  lapses: number;
  /** FSRS 学习步数（短步调度用） */
  learningSteps: number;
  updatedAt: number;
}

/** 学习/复习记录（历史流水） */
export interface ReviewLog {
  id?: number;
  wordId: string;
  /** 1=不会(Again) 2=模糊(Hard) 3=学会了(Good) */
  grade: Grade;
  reviewedAt: number;
  /** 本次评分时该词是否为新词（用于每日新词统计） */
  wasNew: boolean;
  /** 评分后的卡片状态与 FSRS 计算的调度间隔（天，0 表示当天） */
  stateAfter: State;
  scheduledDays: number;
}

/** 学习设置（保存在 localStorage，可后续迁移到云端） */
export interface StudySettings {
  /** 每日新词数（默认 20） */
  dailyNewCount: number;
  /** 目标记忆保持率（默认 0.9 = 90%） */
  requestRetention: number;
}
