/**
 * 真题数据一次性转换脚本（第一阶段）
 *
 * 输入：exam_fix/真题清单_修复版.json（审核归档，只读，绝不修改）
 * 输出：public/data/exam_questions.json（App 运行时唯一数据）
 *       data/exam_questions.json（测试 import 副本，同一产物复制）
 *
 * 用法：node scripts/buildExamJson.mjs
 * 重复执行幂等：同一输入产出完全相同的文件（ID 为稳定哈希）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(root, "exam_fix", "真题清单_修复版.json");

/** fnv1a32 稳定哈希（与实施方案一致；应用层 TypeScript 将使用同一算法） */
export function fnv1a32(str) {
  let h = 2166136261;
  for (const b of Buffer.from(str, "utf-8")) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function examId(section, questionNumber, examSource) {
  return `ex_${fnv1a32(`exam::${section}::${questionNumber}::${examSource}`).toString(16)}`;
}

/** 剥离跨页结束字段：非跨页题不得出现结束页字段 */
function buildQuestion(raw) {
  const isCrossPage = raw.cross_page === "是";
  const q = {
    id: examId(raw.section, raw.example_no, raw.exam_source),
    section: raw.section,
    questionNumber: raw.example_no,
    year: raw.year,
    examSource: raw.exam_source,
    questionText: raw.question,
    options: [
      { id: "A", content: raw.option_A },
      { id: "B", content: raw.option_B },
      { id: "C", content: raw.option_C },
      { id: "D", content: raw.option_D },
    ],
    answer: raw.answer,
    questionType: raw.question_type,
    blankCount: raw.blank_count,
    pdfPage: raw.pdf_page_start,
    printedPage: raw.printed_page_start,
    isCrossPage,
    explanation: "", // 审核归档中的占位文案不进入正式数据
    sourceVolume: raw.volume,
    sourceType: "original",
  };
  if (isCrossPage) {
    q.pdfPageEnd = raw.pdf_page_end;
    q.printedPageEnd = raw.printed_page_end;
  }
  return q;
}

// —— 转换 ——
const rawList = JSON.parse(readFileSync(SRC, "utf-8"));
if (rawList.length !== 204) throw new Error(`审核归档题数异常：${rawList.length}`);
const questions = rawList.map(buildQuestion);

// —— 内置校验（等价 validateExamDataset 核心规则）——
function validate(list) {
  const errors = [];
  if (list.length !== 204) errors.push(`总数 ${list.length}`);
  const ids = new Set();
  const bySection = {};
  let danKong = 0;
  for (const q of list) {
    if (!q.id.startsWith("ex_")) errors.push(`ID 前缀 ${q.id}`);
    if (ids.has(q.id)) errors.push(`ID 重复 ${q.id}`);
    ids.add(q.id);
    if (typeof q.year !== "number") errors.push(`year 类型 ${q.id}`);
    if (q.sourceType !== "original") errors.push(`sourceType ${q.id}`);
    if (q.explanation !== "") errors.push(`explanation 非空 ${q.id}`);
    if (q.questionType === "单空") danKong++;
    if (!q.isCrossPage && ("pdfPageEnd" in q || "printedPageEnd" in q))
      errors.push(`非跨页题含结束页 ${q.id}`);
    if (q.isCrossPage && !(q.pdfPageEnd > q.pdfPage))
      errors.push(`跨页起止页异常 ${q.id}`);
    bySection[q.section] = (bySection[q.section] ?? 0) + 1;
  }
  if (bySection["成语"] !== 177) errors.push(`成语 ${bySection["成语"]}`);
  if (bySection["实词"] !== 27) errors.push(`实词 ${bySection["实词"]}`);
  if (danKong !== 38) errors.push(`单空 ${danKong}`);
  const cross = list.filter((q) => q.isCrossPage);
  if (cross.length !== 4) errors.push(`跨页题 ${cross.length}`);
  return { errors, cross };
}

const { errors, cross } = validate(questions);
if (errors.length) {
  console.error("校验失败：", errors);
  process.exit(1);
}

// —— 输出（排序保持审核归档顺序；JSON 序列化确定性）——
const json = JSON.stringify(questions, null, 2) + "\n";
mkdirSync(path.join(root, "public", "data"), { recursive: true });
mkdirSync(path.join(root, "data"), { recursive: true });
writeFileSync(path.join(root, "public", "data", "exam_questions.json"), json);
writeFileSync(path.join(root, "data", "exam_questions.json"), json);

const sha = createHash("sha256").update(json).digest("hex");
console.log(`转换完成：204 题；跨页题 ${cross.length} 道：`);
for (const q of cross)
  console.log(
    `  ${q.section}${q.questionNumber} pdf ${q.pdfPage}-${q.pdfPageEnd} printed ${q.printedPage}-${q.printedPageEnd}`,
  );
console.log(`运行时文件 SHA-256：${sha}`);
