/**
 * 真题训练模块 · 第一阶段测试
 * 覆盖：类型校验、数据集校验、ID 稳定唯一、与审核归档逐项一致、跨页页码、解析规则
 */
import { describe, expect, it } from "vitest";
import examQuestions from "../../../data/exam_questions.json";
import rawArchive from "../../../exam_fix/真题清单_修复版.json";
import {
  EXAM_OPTION_IDS,
  validateExamDataset,
  validateExamQuestion,
  type ExamQuestion,
} from "@/types/exam";

const questions = examQuestions as ExamQuestion[];

/** 与转换脚本一致的 fnv1a32（按 UTF-8 字节，用于验证 ID 稳定性） */
const encoder = new TextEncoder();
function fnv1a32(str: string): string {
  let h = 2166136261;
  for (const b of encoder.encode(str)) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

describe("真题数据集（第一阶段产物）", () => {
  it("总数 204，成语 177、实词 27", () => {
    expect(questions).toHaveLength(204);
    expect(questions.filter((q) => q.section === "成语")).toHaveLength(177);
    expect(questions.filter((q) => q.section === "实词")).toHaveLength(27);
  });

  it("单空 38、多空 166", () => {
    expect(questions.filter((q) => q.questionType === "单空")).toHaveLength(38);
    expect(questions.filter((q) => q.questionType === "多空")).toHaveLength(166);
  });

  it("数据集校验通过（含题号连续、ID 唯一）", () => {
    expect(validateExamDataset(questions)).toEqual([]);
  });

  it("每题逐字段通过 validateExamQuestion", () => {
    for (const q of questions) expect(validateExamQuestion(q)).toBeNull();
  });

  it("ID 全部以 ex_ 开头且与 fnv1a32(section::questionNumber::examSource) 稳定一致", () => {
    for (const q of questions) {
      expect(q.id.startsWith("ex_")).toBe(true);
      expect(q.id).toBe(
        `ex_${fnv1a32(`exam::${q.section}::${q.questionNumber}::${q.examSource}`)}`,
      );
    }
  });

  it("year 全部为 number 且与 examSource 年份一致", () => {
    for (const q of questions) {
      expect(typeof q.year).toBe("number");
      const m = q.examSource.match(/(19|20)\d{2}/);
      expect(m).not.toBeNull();
      expect(q.year).toBe(Number(m![0]));
    }
  });

  it("sourceType 全部为 original，explanation 全部为空字符串", () => {
    for (const q of questions) {
      expect(q.sourceType).toBe("original");
      expect(q.explanation).toBe("");
      expect(q.explanation).not.toContain("PDF中未提取到");
    }
  });

  it("跨页题 4 道，起止页码正确；非跨页题无结束页字段", () => {
    const cross = questions.filter((q) => q.isCrossPage);
    expect(cross).toHaveLength(4);
    const expected = new Set([
      "成语:29", "成语:118", "成语:130", "成语:157",
    ]);
    expect(cross.map((q) => `${q.section}:${q.questionNumber}`).sort()).toEqual(
      [...expected].sort(),
    );
    for (const q of cross) {
      expect(q.pdfPageEnd).toBeGreaterThan(q.pdfPage);
      expect(q.printedPageEnd).toBeGreaterThan(q.printedPage!);
    }
    for (const q of questions) {
      if (!q.isCrossPage) {
        expect(q.pdfPageEnd).toBeUndefined();
        expect(q.printedPageEnd).toBeUndefined();
      }
    }
  });

  it("题干、选项、答案与审核归档逐项一致", () => {
    const rawMap = new Map(
      rawArchive.map((r: Record<string, unknown>) => [
        `${r.section}:${r.example_no}`,
        r,
      ]),
    );
    expect(rawMap.size).toBe(204);
    for (const q of questions) {
      const r = rawMap.get(`${q.section}:${q.questionNumber}`);
      expect(r).toBeDefined();
      expect(q.questionText).toBe(r!.question);
      expect(q.examSource).toBe(r!.exam_source);
      expect(q.answer).toBe(r!.answer);
      expect(q.options.map((o) => o.id)).toEqual([...EXAM_OPTION_IDS]);
      expect(q.options.map((o) => o.content)).toEqual([
        r!.option_A, r!.option_B, r!.option_C, r!.option_D,
      ]);
      expect(q.pdfPage).toBe(r!.pdf_page_start);
      expect(q.printedPage).toBe(r!.printed_page_start);
      expect(q.sourceVolume).toBe(r!.volume);
      expect(q.blankCount).toBe(r!.blank_count);
      expect(q.questionType).toBe(r!.question_type);
    }
  });

  it("制作过程字段不进入正式数据", () => {
    for (const q of questions) {
      expect(q).not.toHaveProperty("answer_match_status");
      expect(q).not.toHaveProperty("extraction_status");
      expect(q).not.toHaveProperty("pdf_pages");
      expect(q).not.toHaveProperty("cross_page");
      expect(q).not.toHaveProperty("source_explanation");
      expect(q).not.toHaveProperty("option_A");
    }
  });
});

describe("validateExamQuestion 校验规则", () => {
  const base = questions[0];

  it("合法题目返回 null", () => {
    expect(validateExamQuestion(base)).toBeNull();
  });

  it("ID 前缀非法", () => {
    expect(validateExamQuestion({ ...base, id: "bad" })).toContain("ex_");
  });

  it("选项数量不为 4", () => {
    expect(validateExamQuestion({ ...base, options: base.options.slice(0, 3) })).toContain("4");
  });

  it("答案非法", () => {
    expect(validateExamQuestion({ ...base, answer: "E" as never })).toContain("答案非法");
  });

  it("year 类型/范围非法", () => {
    expect(validateExamQuestion({ ...base, year: "2019" as never })).toContain("年份非法");
    expect(validateExamQuestion({ ...base, year: 1900 })).toContain("年份非法");
  });

  it("非跨页题含结束页字段被拒绝", () => {
    expect(validateExamQuestion({ ...base, pdfPageEnd: 12 })).toContain("非跨页题");
  });

  it("跨页题缺少 pdfPageEnd 被拒绝", () => {
    const cross = questions.find((q) => q.isCrossPage)!;
    expect(validateExamQuestion({ ...cross, pdfPageEnd: undefined })).toContain("跨页题");
  });

  it("多空题 blankCount < 2 被拒绝", () => {
    expect(validateExamQuestion({ ...base, blankCount: 1 })).toContain("多空题");
  });
});
