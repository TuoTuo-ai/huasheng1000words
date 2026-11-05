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
import { upsertWord } from "@/db/wordRepository";

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

/** 按 term 去重并合并全部分类来源（保持原记录顺序） */
export function dedupeRecords(
  records: RawVocabRecord[],
): Array<{ content: ReturnType<typeof toWordContent>; entries: CategoryEntry[] }> {
  const map = new Map<
    string,
    { content: ReturnType<typeof toWordContent>; entries: CategoryEntry[] }
  >();
  for (const raw of records) {
    const term = raw.term.trim();
    if (!map.has(term)) {
      map.set(term, { content: toWordContent(raw), entries: [] });
    }
    map.get(term)!.entries.push(toCategoryEntry(raw));
  }
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
  const valid: Array<{ term: string; content: ReturnType<typeof toWordContent>; entries: CategoryEntry[] }> = [];
  for (const raw of records) {
    const error = validate(raw);
    if (error) {
      stats.failed++;
      stats.failures.push({ term: raw?.term ?? "未知", reason: error });
      continue;
    }
    valid.push({ term: raw.term.trim(), ...dedupeRecords([raw])[0] });
  }
  // 跨记录合并重复词的 categoryEntries
  const merged = new Map<string, { content: ReturnType<typeof toWordContent>; entries: CategoryEntry[] }>();
  for (const item of valid) {
    if (!merged.has(item.term)) {
      merged.set(item.term, item);
    } else {
      merged.get(item.term)!.entries.push(...item.entries);
      stats.skipped++;
    }
  }

  for (const { content, entries } of merged.values()) {
    const word: Omit<Word, "id" | "createdAt"> = {
      ...content,
      categoryEntries: entries,
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
  return stats;
}
