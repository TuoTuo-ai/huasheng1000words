/**
 * 题目管理服务（近义词辨析题 · 人工审核辅助）
 *
 * 职责：
 * - 汇总题库统计（按篇章 / 审核状态）
 * - 按篇章、分类、审核状态筛选题目
 * - 为人工审核生成「审核要点」提示（只做客观比对，不代替人判断，不自动审核）
 *
 * 只读 quiz_questions 与 words；审核写入由 quizRepository.reviewQuestion 完成。
 */
import type { Word } from "@/types";
import type { QuizQuestion, ReviewStatus, TrainingMode } from "@/types/quiz";
import { getDB } from "@/db/database";
import { getAllQuestions } from "@/db/quizRepository";
import { normalizeText } from "@/lib/quizGenerator";

/** 题库统计 */
export interface QuizStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
}

/** 分类聚合（用于「按分类查看题目」） */
export interface QuizCategoryGroup {
  categoryKey: string;
  section: string;
  groupId: number;
  subcategory: string;
  groupTitle: string;
  total: number;
  pending: number;
}

/** 单题的审核要点（全部为可机器核对的客观事实） */
export interface ReviewCheck {
  /** 检查项名称 */
  label: string;
  /** 是否通过 */
  ok: boolean;
  /** 说明（例如实际值） */
  detail: string;
}

/** 从 categoryKey 解析分类身份：section::groupId::subcategory */
export function parseCategoryKey(key: string): {
  section: string;
  groupId: number;
  subcategory: string;
} {
  const first = key.indexOf("::");
  const last = key.lastIndexOf("::");
  return {
    section: key.slice(0, first),
    groupId: Number(key.slice(first + 2, last)),
    subcategory: key.slice(last + 2),
  };
}

/** 统计题库 */
export function countStats(questions: QuizQuestion[]): QuizStats {
  const stats: QuizStats = { total: questions.length, pending: 0, approved: 0, rejected: 0 };
  for (const q of questions) {
    if (q.reviewStatus === "pending") stats.pending++;
    else if (q.reviewStatus === "approved") stats.approved++;
    else if (q.reviewStatus === "rejected") stats.rejected++;
  }
  return stats;
}

/** 按分类聚合题目数量 */
export function groupByCategory(questions: QuizQuestion[]): QuizCategoryGroup[] {
  const map = new Map<string, QuizCategoryGroup>();
  for (const q of questions) {
    let g = map.get(q.categoryKey);
    if (!g) {
      const { section, groupId, subcategory } = parseCategoryKey(q.categoryKey);
      g = {
        categoryKey: q.categoryKey,
        section,
        groupId,
        subcategory,
        groupTitle: q.tags?.[1] ?? "",
        total: 0,
        pending: 0,
      };
      map.set(q.categoryKey, g);
    }
    g.total++;
    if (q.reviewStatus === "pending") g.pending++;
  }
  return Array.from(map.values()).sort(
    (a, b) =>
      a.section.localeCompare(b.section, "zh-CN") ||
      a.groupId - b.groupId ||
      a.subcategory.localeCompare(b.subcategory, "zh-CN"),
  );
}

/**
 * 筛选题目。
 * @param section 篇章（"成语篇" / "实词篇" / 空表示全部）
 * @param status  审核状态（空表示全部）
 * @param categoryKey 分类键（空表示全部）
 */
export function filterQuestions(
  questions: QuizQuestion[],
  opts: { section?: string; status?: ReviewStatus | ""; categoryKey?: string } = {},
): QuizQuestion[] {
  return questions.filter((q) => {
    if (opts.section && parseCategoryKey(q.categoryKey).section !== opts.section)
      return false;
    if (opts.status && q.reviewStatus !== opts.status) return false;
    if (opts.categoryKey && q.categoryKey !== opts.categoryKey) return false;
    return true;
  });
}

/**
 * 检测「同分类高度相似题」：同一分类内多道题共用同一组选项词。
 * 返回 categoryKey → 重复出现的选项词集合签名。
 * 仅用于审核提示，不删除题目。
 */
export function findSimilarQuestions(
  questions: QuizQuestion[],
): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  const dup = new Map<string, Set<string>>();
  for (const q of questions) {
    const sig = [...q.wordIds].sort().join(",");
    const bucket = seen.get(q.categoryKey) ?? new Set<string>();
    if (bucket.has(sig)) {
      const d = dup.get(q.categoryKey) ?? new Set<string>();
      d.add(sig);
      dup.set(q.categoryKey, d);
    }
    bucket.add(sig);
    seen.set(q.categoryKey, bucket);
  }
  return dup;
}

/**
 * 生成单题的审核要点（客观核对，不做通过/驳回决定）。
 * 人工审核时据此快速判断释义、答案、干扰项、原文引用是否正确。
 */
export function buildReviewChecks(
  q: QuizQuestion,
  wordMap: Map<string, Word>,
): ReviewCheck[] {
  const checks: ReviewCheck[] = [];

  const correct = q.options.find((o) => o.isCorrect);
  const correctWord = correct?.wordId ? wordMap.get(correct.wordId) : undefined;

  // 1. 唯一正确答案
  const correctCount = q.options.filter((o) => o.isCorrect).length;
  checks.push({
    label: "唯一正确答案",
    ok: correctCount === 1 && q.correctOptionId === correct?.id,
    detail: `正确选项 ${correctCount} 个，correctOptionId=${q.correctOptionId}`,
  });

  // 2. 题干释义与正确词释义一致
  const stemOk =
    !!correctWord && normalizeText(q.stem).includes(normalizeText(correctWord.definition));
  checks.push({
    label: "题干释义与正确词一致",
    ok: stemOk,
    detail: correctWord ? `正确词：${correctWord.term}` : "未找到正确词",
  });

  // 3. 原文引用逐字一致
  const excerptOk =
    !!correctWord && q.source.sourceExcerpt === correctWord.definition;
  checks.push({
    label: "原文引用逐字一致",
    ok: excerptOk,
    detail: excerptOk ? "与 definition 完全相同" : "与 definition 不一致",
  });

  // 4. 选项均为词语
  const allTerms = q.options.every(
    (o) => o.wordId && wordMap.get(o.wordId)?.term === o.content,
  );
  checks.push({
    label: "选项均为词语",
    ok: allTerms,
    detail: `${q.options.length} 个选项`,
  });

  // 5. 同分类限制
  const { section, groupId, subcategory } = parseCategoryKey(q.categoryKey);
  const sameCategory = q.wordIds.every((id) => {
    const w = wordMap.get(id);
    if (!w) return false;
    const entries = w.categoryEntries?.length
      ? w.categoryEntries
      : [
          {
            section: w.section ?? "",
            groupId: w.groupId ?? -1,
            subcategory: w.subcategory,
          },
        ];
    return entries.some(
      (e) =>
        e.section === section &&
        e.groupId === groupId &&
        (e.subcategory?.trim() ?? "") === subcategory,
    );
  });
  checks.push({
    label: "全部选项同分类",
    ok: sameCategory,
    detail: `${section} · ${groupId}组 · ${subcategory}`,
  });

  // 6. 干扰项区分度（客观：干扰项释义是否高度雷同）
  const distractorWords = q.options
    .filter((o) => !o.isCorrect)
    .map((o) => (o.wordId ? wordMap.get(o.wordId) : undefined))
    .filter((w): w is Word => !!w);
  const uniqueDefs = new Set(distractorWords.map((w) => normalizeText(w.definition)));
  checks.push({
    label: "干扰项释义互不重复",
    ok: uniqueDefs.size === distractorWords.length,
    detail: `${distractorWords.length} 个干扰项`,
  });

  // 7. 来源页码
  checks.push({
    label: "来源页码可溯源",
    ok: typeof q.source.sourcePage === "number",
    detail: q.source.citation,
  });

  return checks;
}

/** 读取题库与词库（题目管理页一次性加载） */
export async function loadQuizAdminData(): Promise<{
  questions: QuizQuestion[];
  wordMap: Map<string, Word>;
}> {
  const db = await getDB();
  const [questions, words] = await Promise.all([getAllQuestions(), db.getAll("words")]);
  return {
    questions,
    wordMap: new Map((words as Word[]).map((w) => [w.id, w])),
  };
}

/** 当前只支持近义词辨析（其余模式未开发，避免误用） */
export const SUPPORTED_MODE: TrainingMode = "synonym";
