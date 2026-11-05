/**
 * 分类集中学习服务：只组织队列与展示，评分仍走现有 submitGrade（FSRS 原生调度）
 * 不触碰每日新词队列，不影响原有学习/复习流程
 */
import type { CategoryEntry, Word, WordProgress } from "@/types";
import { getDB } from "@/db/database";
import { submitGrade } from "@/lib/studyService";
import type { Grade } from "ts-fsrs";
import { isDue } from "@/lib/fsrs";

export { submitGrade };

/** 分类学习队列项 */
export interface CategoryStudyItem {
  word: Word;
  progress: WordProgress | undefined;
  learned: boolean;
}

/**
 * 读取某分类下的词语队列：
 * 未学词在前（保持原始顺序），已学词在后（可查看，不重复建档）
 */
export async function getCategoryStudyQueue(
  groupId: number,
  section: string,
  subName: string,
  noSubLabel: string,
): Promise<CategoryStudyItem[]> {
  const db = await getDB();
  const [words, progressList] = await Promise.all([
    db.getAll("words"),
    db.getAll("progress"),
  ]);
  const progressMap = new Map(progressList.map((p) => [p.wordId, p]));
  // 依据全部分类来源归属（重复词可能属于多个分类）；旧数据回退顶层字段
  const filtered = words.filter((w) => {
    const sources: CategoryEntry[] = w.categoryEntries?.length
      ? w.categoryEntries
      : w.groupTitle && typeof w.groupId === "number"
        ? [
            {
              volume: w.volume ?? "",
              section: w.section ?? "",
              groupId: w.groupId,
              groupTitle: w.groupTitle,
              subcategory: w.subcategory,
            },
          ]
        : [];
    return sources.some(
      (s) =>
        s.groupId === groupId &&
        s.section === section &&
        ((s.subcategory?.trim() || noSubLabel) === subName),
    );
  });
  const items: CategoryStudyItem[] = filtered.map((w) => {
    const p = progressMap.get(w.id);
    return { word: w, progress: p, learned: !!p && p.reps > 0 };
  });
  return [
    ...items.filter((i) => !i.learned),
    ...items.filter((i) => i.learned),
  ];
}

/** 分类学习结果 */
export interface CategoryResult {
  studied: number;
  again: number;
  hard: number;
  good: number;
}

/** 分类学习的评分提交（复用现有 submitGrade，FSRS 逻辑不变） */
export async function gradeInCategory(
  word: Word,
  grade: Grade,
  wasNew: boolean,
): Promise<{ isNew: boolean; due: number; state: number }> {
  const p = await submitGrade(word, grade, wasNew);
  return { isNew: wasNew, due: p.due, state: p.state };
}

/** 是否到期（透传，供页面展示） */
export function isCardDue(progress: WordProgress | undefined): boolean {
  return !!progress && progress.state !== 0 && isDue(progress);
}

/** 分类条目上的全部分类来源（用于从详情页返回时展示） */
export function describeEntries(entries: CategoryEntry[] | undefined): string {
  if (!entries?.length) return "";
  return entries.map((e) => `${e.section}·${e.groupTitle}`).join("；");
}
