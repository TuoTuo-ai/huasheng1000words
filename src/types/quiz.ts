/**
 * 分类辨析训练 · 数据类型定义
 * 与 FSRS 学习数据（Word / WordProgress / ReviewLog）完全独立
 */

/** 训练模式：近义词辨析 / 易错辨析 / 例句判断 / 真题训练 */
export type TrainingMode = "synonym" | "pitfall" | "sentence" | "exam";

/** 审核状态：草稿 → 待审核 → 通过 / 驳回（仅 approved 进入正式题库） */
export type ReviewStatus = "draft" | "pending" | "approved" | "rejected";

/** 内容来源类型：教材原文 / AI 补充 */
export type SourceType = "original" | "ai";

/** 内容质量等级 */
export type QualityLevel = "high" | "medium" | "low";

/** 题目内容来源溯源信息 */
export interface QuestionSource {
  /** 原文或 AI 生成 */
  type: SourceType;
  /** 引用的词语 ID */
  wordIds: string[];
  /** 引用位置描述，如「上册第9页 · 源远流长 · 释义」 */
  citation: string;
  /** 页码（来自原文） */
  sourcePage?: number;
  /** 引用字段：definition / examples / subcategory 等 */
  sourceField?: "definition" | "example" | "subcategory" | "groupTitle";
  /** 原文摘录（用于逐字校验，必须能在源字段中找到） */
  sourceExcerpt?: string;
  /** 例句序号（引用 examples 时使用） */
  exampleIndex?: number;
}

/** 选项 */
export interface QuizOption {
  /** 选项标识，如 "A"/"B"/"C"/"D" */
  id: string;
  /** 选项文本（词语或句子） */
  content: string;
  /** 选项对应词语（选项为词语时） */
  wordId?: string;
  /** 是否为正确答案（有且仅有一个为 true） */
  isCorrect: boolean;
  /** 该选项正确/错误的原因（必填） */
  explain: string;
  /** 选项内容来源类型 */
  sourceType: SourceType;
}

/** 题干 / 解析的来源标记 */
export interface ContentMeta {
  sourceType: SourceType;
  /** 原文摘录（sourceType=original 时必填且可逐字校验） */
  excerpt?: string;
}

/** 题目 */
export interface QuizQuestion {
  /** 稳定题目 ID：hash(mode + 词 + 模板) */
  id: string;
  mode: TrainingMode;
  /** 涉及词语（主词 + 干扰项） */
  wordIds: string[];
  /** 题干 */
  stem: string;
  /** 题干来源 */
  stemMeta: ContentMeta;
  /** 选项（2~6 个，恰好一个正确） */
  options: QuizOption[];
  /** 正确选项 ID */
  correctOptionId: string;
  /** 总解析（须说明错误选项为何错误） */
  explanation: string;
  /** 解析来源 */
  explanationMeta: ContentMeta;
  /** 关联辨析词 */
  relatedWordIds: string[];
  /** 来源溯源 */
  source: QuestionSource;
  /** 是否含 AI 生成内容（任一部分为 ai 即 true） */
  aiGenerated: boolean;
  /** 难度 1~3 */
  difficulty: 1 | 2 | 3;
  /** 标签：一级分类 / 二级分类 / 易错类型等 */
  tags: string[];
  /** 分类键 section::groupId::subcategory */
  categoryKey: string;
  /** 审核状态 */
  reviewStatus: ReviewStatus;
  /** 质量等级 */
  qualityLevel: QualityLevel;
  /** 题目版本号（内容修订时递增） */
  questionVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** 训练记录（每次作答一条，独立存储） */
export interface TrainingRecord {
  id?: number;
  /** 训练会话 ID */
  trainingId: string;
  questionId: string;
  mode: TrainingMode;
  /** 用户答案（选项 ID 或 true/false） */
  userAnswer: string;
  isCorrect: boolean;
  /** 答题时间（时间戳） */
  answeredAt: number;
  /** 答题耗时（毫秒） */
  durationMs: number;
  /** 冗余分类键，便于薄弱项统计 */
  categoryKey: string;
}

/** 训练会话 */
export interface TrainingSession {
  trainingId: string;
  mode: TrainingMode;
  /** 本次题目 ID 列表 */
  questionIds: string[];
  startedAt: number;
  finishedAt?: number;
  /** 答题数 / 正确数 */
  answeredCount: number;
  correctCount: number;
}
