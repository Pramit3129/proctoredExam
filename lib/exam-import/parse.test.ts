/**
 * Parser tests. Run with: npm test
 * Lines are written as text; leading spaces become indentation (x offset).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseExamPapers, stripPageFurniture, type PdfLine } from "./parse.ts";

function pages(...texts: string[]): PdfLine[] {
  const out: PdfLine[] = [];
  texts.forEach((text, p) => {
    text.split("\n").forEach((raw, i) => {
      const indent = raw.length - raw.trimStart().length;
      const size = raw.startsWith("#") ? 18 : 11;
      out.push({ page: p + 1, x: 50 + indent * 4, y: 760 - i * 14, size, text: raw.replace(/^#\s*/, "").trim() });
    });
  });
  return out;
}

test("CPH-style paper: wrapped stems and options, Roman statements, sections, key grid + explanations", () => {
  const q = pages(
    `Coach | example.com
# Chapter 6 Questions
Product Due Diligence
Choose one best answer per question.
Set 1
1. A retired client's needs are unchanged. She instructs her RR to replace half her
bond portfolio. What is the best next step?
   A. Accept a waiver.
   B. Increase the recorded risk tolerance.
   C. Consult the supervisor before executing, follow firm policy, and document the
   circumstances.
   D. Execute immediately.
2. Which combination belongs in monitoring?
I. Review complaints.
II. Reassess training.
   A. I only.
   B. II only.
   C. I and II.
   D. Neither.
Chapter 6 | Questions 1`,
    `Coach | example.com
Set 2
3. A wrapped stem that mentions the year
2019. and keeps going?
   A. One.
   B. Two.
Chapter 6 | Questions 2`,
  );
  const a = pages(
    `Coach | example.com
Set 1 Answer Key
1. C 2. C 3. B
Explanations
1. C - Escalate and document. The order
must be reviewed.
2. C - Both are expected.
3. B - Because.
Coach | example.com`,
    `Coach | example.com
nothing else`,
  );
  const r = parseExamPapers(q, a);
  assert.deepEqual(r.errors, []);
  assert.equal(r.title, "Chapter 6 Questions");
  assert.equal(r.subtitle, "Product Due Diligence");
  assert.equal(r.questions.length, 3);
  assert.deepEqual(r.stats.sections, ["Set 1", "Set 2"]);
  const [q1, q2, q3] = r.questions;
  assert.equal(q1!.options[2]!.text, "Consult the supervisor before executing, follow firm policy, and document the circumstances.");
  assert.equal(q1!.answer, "C");
  assert.equal(q1!.explanation, "Escalate and document. The order must be reviewed.");
  assert.equal(q2!.prompt, "Which combination belongs in monitoring?\nI. Review complaints.\nII. Reassess training.");
  assert.equal(q3!.prompt, "A wrapped stem that mentions the year 2019. and keeps going?");
  assert.equal(q3!.section, "Set 2");
});

test("inline options, Q-prefixed numbers, lower-case letters and inline answers", () => {
  const q = pages(`Q1) What is 2 + 2?
A. 3 B. 4 C. 5 D. 22
Answer: B
Q2) Pick the vowel.
(a) b
(b) e
(c) k
Answer: B`);
  const r = parseExamPapers(q, pages("Answers\n(none)"));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.questions[0]!.options.map((o) => o.text), ["3", "4", "5", "22"]);
  assert.equal(r.questions[0]!.answer, "B");
  assert.deepEqual(r.questions[1]!.options.map((o) => o.key), ["A", "B", "C"]);
  assert.equal(r.questions[1]!.answer, "B");
});

test("answer key formats and cross-checks", () => {
  const q = pages(
    [1, 2, 3, 4].map((n) => `${n}. Question ${n}?\n   A. a\n   B. b\n   C. c\n   D. d`).join("\n"),
  );
  const r = parseExamPapers(q, pages(`1-C   2: D   3) (B)
4. A - grid missing, explanation only
1. D - disagrees with the grid`));
  assert.equal(r.questions[1]!.answer, "D");
  assert.equal(r.questions[2]!.answer, "B");
  assert.equal(r.questions[3]!.answer, "A");
  assert.ok(r.errors.some((e) => e.number === 1 && /grid says C but the explanation says D/.test(e.message)));
});

test("reports missing answers, unknown options and short questions", () => {
  const q = pages(`1. Only one option?
   A. lonely
2. Fine?
   A. yes
   B. no
3. Also fine?
   A. yes
   B. no`);
  const r = parseExamPapers(q, pages("2. E\n3. B"));
  assert.ok(r.errors.some((e) => e.number === 1 && /at least 2/.test(e.message)));
  assert.ok(r.errors.some((e) => e.number === 1 && /no answer/.test(e.message)));
  assert.ok(r.errors.some((e) => e.number === 2 && /not one of its options/.test(e.message)));
  assert.equal(r.questions[2]!.answer, "B");
});

test("numbering gaps warn; text before the first question is never a question", () => {
  const q = pages(`Read carefully.
1. First?
   A. x
   B. y
3. Third (2 is missing)?
   A. x
   B. y`);
  const r = parseExamPapers(q, pages("1. A 3. B"));
  assert.equal(r.questions.length, 2);
  assert.ok(r.warnings.some((w) => /jumps from 1 to 3/.test(w.message)));
  assert.equal(r.title, "Read carefully.");
});

test("strips running headers, footers and page numbers only at page edges", () => {
  const lines = pages("Header\nBody one\nSet 1\nFooter 1", "Header\nBody two\nSet 1\nFooter 2", "Header\nBody three\nmiddle\nmore\nSet 1 inside\nend\nFooter 3");
  const kept = stripPageFurniture(lines).map((l) => l.text);
  assert.ok(!kept.includes("Header"));
  assert.ok(!kept.some((t) => t.startsWith("Footer")));
  assert.ok(kept.includes("Body two"));
});

test("no questions at all is an error", () => {
  const r = parseExamPapers(pages("Just a title\nand some prose."), pages("1. A"));
  assert.ok(r.errors.some((e) => /No numbered questions/.test(e.message)));
});
