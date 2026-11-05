/**
 * 分类服务：沿用正式词库原始一级/二级分类，不重新分类、不补造分类
 * 数据来源：words 表（导入时写入的 section/groupId/groupTitle/subcategory）
 */
import type { Word, WordProgress, CategoryEntry } from "@/types";
import { getDB } from "@/db/database";

/** 无二级分类的词语归入此入口（不丢失） */
export const NO_SUBCATEGORY = "未设置二级分类";

export interface SubCategoryNode {
  /** 二级分类名称 */
  name: string;
  /** 词语条目 */
  entries: WordbookEntryLite[];
  /** 该分类已学词数 */
  learned: number;
}

export interface GroupNode {
  groupId: number;
  groupTitle: string;
  section: string;
  /** 一级分类下词数 */
  total: number;
  /** 已学词数 */
  learned: number;
  subs: SubCategoryNode[];
}

export interface WordbookEntryLite {
  word: Word;
  progress: WordProgress | undefined;
  learned: boolean;
}

/** 读取分类树：一级分类 → 二级分类 → 词语
 *  归类依据 categoryEntries 中的全部原始来源（重复词会出现在多个分类下） */
export async function getCategoryTree(): Promise<GroupNode[]> {
  const db = await getDB();
  const [words, progressList] = await Promise.all([
    db.getAll("words"),
    db.getAll("progress"),
  ]);
  const progressMap = new Map(progressList.map((p) => [p.wordId, p]));
  const groups = new Map<string, GroupNode>();

  for (const word of words as Word[]) {
    // 优先使用全部分类来源；旧数据（无 categoryEntries）回退到顶层字段
    const sources: CategoryEntry[] = word.categoryEntries?.length
      ? word.categoryEntries
      : word.groupTitle && typeof word.groupId === "number"
        ? [
            {
              volume: word.volume ?? "",
              section: word.section ?? "",
              groupId: word.groupId,
              groupTitle: word.groupTitle,
              subcategory: word.subcategory,
              sourcePage: word.sourcePage,
              source: word.source,
            },
          ]
        : [];
    if (sources.length === 0) continue;

    const progress = progressMap.get(word.id);
    const learned = !!progress && progress.reps > 0;
    for (const src of sources) {
      const key = `${src.section}::${src.groupId}`;
      if (!groups.has(key)) {
        groups.set(key, {
          groupId: src.groupId,
          groupTitle: src.groupTitle,
          section: src.section,
          total: 0,
          learned: 0,
          subs: [],
        });
      }
      const g = groups.get(key)!;
      const subName = src.subcategory?.trim() || NO_SUBCATEGORY;
      let sub = g.subs.find((s) => s.name === subName);
      if (!sub) {
        sub = { name: subName, entries: [], learned: 0 };
        g.subs.push(sub);
      }
      // 同一词在同一分类下只计一次
      if (!sub.entries.some((e) => e.word.id === word.id)) {
        sub.entries.push({ word, progress, learned });
        sub.learned += learned ? 1 : 0;
        g.total++;
        g.learned += learned ? 1 : 0;
      }
    }
  }

  // 按原始 groupId 升序；「未设置二级分类」固定在末尾
  return Array.from(groups.values())
    .sort((a, b) => a.groupId - b.groupId)
    .map((g) => ({
      ...g,
      subs: g.subs.sort((a, b) => {
        if (a.name === NO_SUBCATEGORY) return 1;
        if (b.name === NO_SUBCATEGORY) return -1;
        return a.name.localeCompare(b.name, "zh-CN");
      }),
    }));
}

/** 分类身份标识（唯一）：section + groupId，两篇同号不会串组 */
export function groupKey(groupId: number, section: string): string {
  return `${section}::${groupId}`;
}

/** 展示用：「组号 · 分类名称」（不改动数据库中的 groupTitle 原值） */
export function groupLabel(group: {
  groupId: number;
  groupTitle: string;
}): string {
  return `${group.groupId}组 · ${group.groupTitle}`;
}

/** 从 groupKey 还原分类身份 */
export function parseGroupKey(key: string): { section: string; groupId: number } {
  const idx = key.lastIndexOf("::");
  return {
    section: key.slice(0, idx),
    groupId: Number(key.slice(idx + 2)),
  };
}
