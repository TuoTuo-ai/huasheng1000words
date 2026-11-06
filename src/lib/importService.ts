/**
 * 正式词库导入服务
 *
 * 规则（产品确认）：
 * - 每个唯一词语一张学习卡片（按 term 去重）
 * - 重复词（如「不绝如缕」上下册各一次）保留全部分类来源到 categoryEntries
 * - 同名词已存在（如 6 个测试词）时只更新内容字段，保留 id/createdAt/progress/logs
 * - examples 保存全部例句；example 旧字段兼容 = examples[0]
 * - aiCollocations 独立数组字段（当前为空）
 * - 逐条原子写入：单条失败不影响其余，数据不会出现半写状态
 */
import type { CategoryEntry, Word } from "@/types";
import {
  TEST_WORD_SOURCE,
  deleteWord,
  getAllWords,
  getProgress,
  upsertWord,
} from "@/db/wordRepository";

/** 数据包原始记录（snake_case，见 word_schema.json） */
export interface RawVocabRecord {
  term: string;
  volume: string;
  section: string;
  group_id: number;
  group_title: string;
  subcategory?: string;
  definition: string;
  examples: string[];
  source_page?: number;
  source: string;
  ai_collocations?: string[];
  extraction_status?: string;
}

export interface ImportStats {
  /** 新增词语数 */
  added: number;
  /** 更新已有词（如重叠测试词）数 */
  updated: number;
  /** 跳过数（重复词的后续记录，已合并进 categoryEntries） */
  skipped: number;
  /** 校验或写入失败的记录数 */
  failed: number;
  /** 失败详情（词 + 原因） */
  failures: Array<{ term: string; reason: string }>;
  /** 导入后清理掉的残留演示测试词数量（不属正式词库且无学习记录） */
  removedTestWords?: number;
}

/** 校验单条记录必需字段，返回错误原因或 null */
function validate(raw: RawVocabRecord): string | null {
  if (!raw || typeof raw !== "object") return "记录不是对象";
  if (typeof raw.term !== "string" || !raw.term.trim()) return "缺少 term";
  if (typeof raw.definition !== "string" || !raw.definition.trim())
    return "缺少 definition";
  if (!Array.isArray(raw.examples)) return "examples 不是数组";
  if (typeof raw.section !== "string" || !raw.section) return "缺少 section";
  if (typeof raw.group_id !== "number") return "缺少 group_id";
  return null;
}

/** 原始记录 → CategoryEntry（分类来源） */
function toCategoryEntry(raw: RawVocabRecord): CategoryEntry {
  return {
    volume: raw.volume,
    section: raw.section,
    groupId: raw.group_id,
    groupTitle: raw.group_title,
    subcategory: raw.subcategory,
    sourcePage: raw.source_page,
    source: raw.source,
  };
}

/** 原始记录 → Word 内容字段 */
function toWordContent(raw: RawVocabRecord) {
  const examples = raw.examples.filter(
    (e) => typeof e === "string" && e.trim(),
  );
  return {
    term: raw.term.trim(),
    definition: raw.definition,
    examples,
    // 旧字段兼容：默认取第一条例句
    example: examples[0],
    source: raw.source,
    volume: raw.volume,
    section: raw.section,
    groupId: raw.group_id,
    groupTitle: raw.group_title,
    subcategory: raw.subcategory,
    sourcePage: raw.source_page,
    aiCollocations: raw.ai_collocations ?? [],
  };
}

/** 内容字段 + 学习顺序（由 dedupeRecords 按 JSON 原始下标写入） */
type WordContent = ReturnType<typeof toWordContent> & { sortOrder?: number };

/** 按 term 去重并合并全部分类来源（保持原记录顺序，sortOrder 取首次出现的下标） */
export function dedupeRecords(
  records: RawVocabRecord[],
  offset = 0,
): Array<{ content: WordContent; entries: CategoryEntry[] }> {
  const map = new Map<string, { content: WordContent; entries: CategoryEntry[] }>();
  records.forEach((raw, i) => {
    const term = raw.term.trim();
    if (!map.has(term)) {
      map.set(term, {
        content: { ...toWordContent(raw), sortOrder: offset + i },
        entries: [],
      });
    }
    map.get(term)!.entries.push(toCategoryEntry(raw));
  });
  return Array.from(map.values());
}

/**
 * 执行导入：解析 → 校验 → 去重合并 → 逐条 upsert
 * 事务安全：每条记录原子写入，失败仅计入 failed，不影响其余数据
 */
export async function importVocabulary(
  records: RawVocabRecord[],
): Promise<ImportStats> {
  const stats: ImportStats = {
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };

  // 先整体校验并去重，保证同一词的记录全部合并
  // sortOrder 必须使用【原始数组下标】：即使中间有校验失败的记录，也保留其在 JSON 中的位置
  const valid: Array<{ term: string; content: WordContent; entries: CategoryEntry[]; index: number }> = [];
  records.forEach((raw, index) => {
    const error = validate(raw);
    if (error) {
      stats.failed++;
      stats.failures.push({ term: raw?.term ?? "未知", reason: error });
      return;
    }
    const merged = dedupeRecords([raw])[0];
    merged.content.sortOrder = index; // 覆盖为原始下标
    valid.push({ term: raw.term.trim(), ...merged, index });
  });
  // 跨记录合并重复词的 categoryEntries（保留首次出现的 sortOrder）
  const merged = new Map<string, { content: WordContent; entries: CategoryEntry[] }>();
  for (const item of valid) {
    if (!merged.has(item.term)) {
      merged.set(item.term, { content: item.content, entries: item.entries });
    } else {
      merged.get(item.term)!.entries.push(...item.entries);
      stats.skipped++;
    }
  }

  for (const { content, entries } of merged.values()) {
    const word: Omit<Word, "id" | "createdAt"> = {
      ...content,
      categoryEntries: entries,
      // 学习顺序 = 正式词库 JSON 数组原始下标（0 起，唯一且确定）
      // 例：源远流长为 0，永远第一个学
      sortOrder: content.sortOrder,
    };
    try {
      const result = await upsertWord(word);
      result === "added" ? stats.added++ : stats.updated++;
    } catch (err) {
      stats.failed++;
      stats.failures.push({
        term: content.term,
        reason: err instanceof Error ? err.message : "写入失败",
      });
    }
  }

  // —— 清理残留演示词：正式词库导入后，测试词不得混入新词学习队列 ——
  // 仅在本次导入确实写入了正式词条时执行（全部记录非法时不清理，保留原有测试词）。
  // 只删除「来源为测试词库、且不属于本次正式词库、且从未学习过」的词条；
  // 同名正式词已在上面 upsert 覆盖，不会被误删。
  if (stats.added + stats.updated > 0) {
    stats.removedTestWords = await removeLeftoverTestWords(
      new Set(Array.from(merged.values(), (m) => m.content.term)),
    );
  } else {
    stats.removedTestWords = 0;
  }
  return stats;
}

/**
 * 删除正式词库中不存在的演示测试词。
 * 保护规则（缺一不可）：
 * 1. 该词 source 必须为「测试词库」
 * 2. 该词名词不在本次正式词库中（否则是合法正式词，已由 upsert 覆盖）
 * 3. 该词没有学习进度（有 progress 说明用户已学过，保留数据不删）
 * 返回实际删除数量。
 */
export async function removeLeftoverTestWords(formalTerms: Set<string>): Promise<number> {
  const all = await getAllWords();
  let removed = 0;
  for (const w of all) {
    if (w.source !== TEST_WORD_SOURCE) continue;
    if (formalTerms.has(w.term)) continue;
    const progress = await getProgress(w.id);
    if (progress) continue;
    await deleteWord(w.id);
    removed++;
  }
  return removed;
}
