/**
 * 真题训练模块 · 类型定义（v3 修订版，已审核）
 *
 * 与辨析训练类型（quiz.ts）、FSRS 学习数据（index.ts）完全独立。
 * 题目数据来自静态 JSON（public/data/exam_questions.json），不进 IndexedDB。
 */

/** 篇章：成语篇 / 实词篇 */
export type ExamSection = "成语" | "实词";

/** 题型：单空 / 多空（多空题仍是单选题，用户只选一个选项字母） */
export type ExamQuestionType = "单空" | "多空";

/** 选项标识（公考言语理解真题均为四选一） */
export type ExamOptionId = "A" | "B" | "C" | "D";

export const EXAM_OPTION_IDS = ["A", "B", "C", "D"] as const;

/** 选项 */
export interface ExamOption {
  /** 选项标识："A" / "B" / "C" / "D" */
  id: ExamOptionId;
  /** 选项内容（原文逐字保留；多空题为多组词语的组合文本） */
  content: string;
}

/** 真题题目 */
export interface ExamQuestion {
  /** 稳定题目 ID：ex_ + fnv1a32("exam::" + section + "::" + questionNumber + "::" + examSource) */
  id: string;
  /** 篇章 */
  section: ExamSection;
  /** 篇章内题号：成语 1~177、实词 1~27 */
  questionNumber: number;
  /** 考试年份（来自 examSource 原文提取，number 类型） */
  year: number;
  /** 考试来源（原文逐字保留，如「2019 年浙江省考」） */
  examSource: string;
  /** 题干（原文逐字保留） */
  questionText: string;
  /** 选项（恰好 4 个，id 恰为 A/B/C/D） */
  options: ExamOption[];
  /** 正确选项字母（多空题同样是单个字母，全对或全错） */
  answer: ExamOptionId;
  /** 题型 */
  questionType: ExamQuestionType;
  /** 空格数量：单空=1，多空≥2（与题干空线数一致） */
  blankCount: number;
  /** 起始 PDF 页码 */
  pdfPage: number;
  /** 结束 PDF 页码（仅跨页题存在，> pdfPage） */
  pdfPageEnd?: number;
  /** 起始印刷页码 */
  printedPage?: number;
  /** 结束印刷页码（仅跨页题存在） */
  printedPageEnd?: number;
  /** 是否跨页 */
  isCrossPage: boolean;
  /** 解析（当前 204 题均为空字符串；空串表示无解析，UI 显示「本题暂无解析」） */
  explanation: string;
  /** 来源册别（上册/下册），仅作展示溯源 */
  sourceVolume?: string;
  /** 内容来源类型：真题数据全部为教材/试卷原文 */
  sourceType: "original";
}

/** 单题校验：返回第一条错误信息；通过返回 null */
export function validateExamQuestion(q: ExamQuestion): string | null {
  if (!q.id || !q.id.startsWith("ex_")) return "ID 必须以 ex_ 开头";
  if (q.section !== "成语" && q.section !== "实词") return `篇章非法：${q.section}`;
  if (!Number.isInteger(q.questionNumber) || q.questionNumber < 1)
    return `题号非法：${q.questionNumber}`;
  if (typeof q.year !== "number" || !Number.isInteger(q.year) || q.year < 2000 || q.year > 2100)
    return `年份非法：${q.year}`;
  if (!q.examSource?.trim()) return "考试来源为空";
  if (!q.questionText?.trim()) return "题干为空";
  if (!Array.isArray(q.options) || q.options.length !== 4)
    return `选项数量必须为 4，实际 ${q.options?.length}`;
  const ids = q.options.map((o) => o.id).join("");
  if (ids !== "ABCD") return `选项 ID 必须恰为 A/B/C/D，实际 ${ids}`;
  if (q.options.some((o) => !o.content?.trim())) return "存在空选项内容";
  if (!(EXAM_OPTION_IDS as readonly string[]).includes(q.answer)) return `答案非法：${q.answer}`;
  if (q.questionType !== "单空" && q.questionType !== "多空")
    return `题型非法：${q.questionType}`;
  if (!Number.isInteger(q.blankCount) || q.blankCount < 1)
    return `空格数非法：${q.blankCount}`;
  if (q.questionType === "单空" && q.blankCount !== 1) return "单空题 blankCount 必须为 1";
  if (q.questionType === "多空" && q.blankCount < 2) return "多空题 blankCount 必须 ≥ 2";
  if (!Number.isInteger(q.pdfPage) || q.pdfPage < 1) return `pdfPage 非法：${q.pdfPage}`;
  if (q.isCrossPage) {
    if (typeof q.pdfPageEnd !== "number" || q.pdfPageEnd <= q.pdfPage)
      return "跨页题必须有大于起始页的 pdfPageEnd";
    if (q.printedPageEnd !== undefined && q.printedPageEnd <= (q.printedPage ?? 0))
      return "跨页题 printedPageEnd 必须大于 printedPage";
  } else {
    if (q.pdfPageEnd !== undefined || q.printedPageEnd !== undefined)
      return "非跨页题不得出现结束页字段";
  }
  if (typeof q.explanation !== "string") return "explanation 必须为字符串";
  if (q.sourceType !== "original") return "真题 sourceType 必须为 original";
  return null;
}

/** 数据集校验：返回错误列表（空数组 = 通过） */
export function validateExamDataset(questions: ExamQuestion[]): string[] {
  const errors: string[] = [];
  if (questions.length !== 204) errors.push(`总题数应为 204，实际 ${questions.length}`);
  const bySection = new Map<string, number[]>();
  const ids = new Set<string>();
  for (const q of questions) {
    const err = validateExamQuestion(q);
    if (err) errors.push(`[${q.section}${q.questionNumber}] ${err}`);
    if (ids.has(q.id)) errors.push(`ID 重复：${q.id}`);
    ids.add(q.id);
    const list = bySection.get(q.section) ?? [];
    list.push(q.questionNumber);
    bySection.set(q.section, list);
  }
  for (const [section, nos] of bySection) {
    nos.sort((a, b) => a - b);
    const expected = Array.from({ length: nos.length }, (_, i) => i + 1);
    if (nos.some((n, i) => n !== expected[i]))
      errors.push(`${section} 题号不连续`);
    if (section === "成语" && nos.length !== 177) errors.push(`成语应为 177 题，实际 ${nos.length}`);
    if (section === "实词" && nos.length !== 27) errors.push(`实词应为 27 题，实际 ${nos.length}`);
  }
  return errors;
}
