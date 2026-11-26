/**
 * Turns the text of a question paper and its answer key into structured
 * multiple-choice questions.
 *
 * Pure and dependency-free so it can be unit-tested and run anywhere. The
 * input is positioned lines (see `extract.ts`); the parser uses both the text
 * and the indentation, and it never guesses silently: everything it could not
 * reconcile is reported as an error (blocks saving) or a warning (shown to the
 * admin in the preview).
 *
 * Supported question-paper conventions
 *   1. Stem text that may wrap over several lines            ("1." "1)" "Q1." "Question 1:")
 *   I. Roman-numeral statements inside the stem              (kept as separate lines)
 *      A. Option text that may wrap                          ("A." "A)" "(A)" "a.")
 *      A. one  B. two  C. three  D. four                     (several options on one line)
 *   Set 1 / Section B / Part 2                               (section headings)
 *   Answer: C                                                (optional inline answer)
 *
 * Supported answer-key conventions
 *   1. C  2. D  3. B                                         (key grid, any number per line)
 *   1. C - Explanation that may wrap over several lines      (explanations; "-", "–", "—" or ":")
 *   1-C, 1: C, 1) (C), Q1 C
 * When both a grid and explanations are present they are cross-checked.
 */

export interface PdfLine {
  page: number;
  /** Left edge in PDF points. */
  x: number;
  /** Baseline in PDF points (origin bottom-left, so larger is higher on the page). */
  y: number;
  /** Approximate font size in points. */
  size: number;
  text: string;
}

export interface ParsedOption {
  key: string;
  text: string;
}

export interface ParsedQuestion {
  number: number;
  section: string | null;
  prompt: string;
  options: ParsedOption[];
  answer: string | null;
  explanation: string | null;
}

export interface ParseIssue {
  number?: number;
  message: string;
}

export interface ParsedPaper {
  title: string | null;
  subtitle: string | null;
  description: string | null;
  questions: ParsedQuestion[];
  errors: ParseIssue[];
  warnings: ParseIssue[];
  stats: { questionCount: number; answeredCount: number; explanationCount: number; sections: string[] };
}

interface KeyEntry {
  letter: string;
  gridLetter: string | null;
  explanationLetter: string | null;
  explanation: string | null;
}

const MAX_QUESTIONS = 500;
const MAX_OPTIONS = 8;
const OPTION_LETTERS = "ABCDEFGH";

// ── Text helpers ─────────────────────────────────────────────────────────────

function clean(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[  -​  　]/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Joins wrapped lines: keeps hyphenated words together, otherwise adds a space. */
function joinWrapped(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a + b;
  return `${a} ${b}`;
}

const SECTION_RE = /^(?:set|section|part)\s+(?:[0-9]{1,3}|[A-Z]|[IVX]{1,5})\b[\s:.\-–—]*(.{0,60})$/i;
const QUESTION_RE = /^(?:q(?:uestion)?\s*)?(\d{1,4})\s*[.):]\s*(.*)$/i;
const OPTION_RE = /^\(?([A-Ha-h])\s*[.)]\s*(.*)$/;
const ROMAN_ITEM_RE = /^\(?(?:[IVX]{1,5}|[ivx]{1,5})[.)]\s+\S/;
const INLINE_ANSWER_RE = /^(?:correct\s+)?(?:answer|ans)\s*[:\-–—.]\s*\(?([A-Ha-h])\)?\b/i;

function isSectionHeading(text: string): boolean {
  if (text.length > 50 || /[?]$/.test(text)) return false;
  return SECTION_RE.test(text);
}

/**
 * Finds several option markers on one line ("A. x B. y C. z"). Returns the
 * split options when the markers run in sequence from `expected`, else null.
 */
function splitInlineOptions(text: string, expected: string): ParsedOption[] | null {
  const re = /(?:^|\s)\(?([A-H])[.)]\s+/g;
  const marks: { letter: string; index: number; end: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    marks.push({ letter: m[1]!, index: m.index + (m[0].startsWith(" ") ? 1 : 0), end: m.index + m[0].length });
  }
  if (marks.length < 2 || marks[0]!.index !== 0 || marks[0]!.letter !== expected) return null;
  for (let i = 1; i < marks.length; i++) {
    if (OPTION_LETTERS.indexOf(marks[i]!.letter) !== OPTION_LETTERS.indexOf(marks[i - 1]!.letter) + 1) return null;
  }
  return marks.map((mark, i) => ({
    key: mark.letter,
    text: clean(text.slice(mark.end, i + 1 < marks.length ? marks[i + 1]!.index : undefined)),
  }));
}

// ── Running headers and footers ─────────────────────────────────────────────

/**
 * Removes lines that repeat on most pages (running headers, footers, page
 * numbers) and bare page numbers.
 */
export function stripPageFurniture(lines: PdfLine[]): PdfLine[] {
  const byPage = new Map<number, PdfLine[]>();
  for (const line of lines) {
    if (!byPage.has(line.page)) byPage.set(line.page, []);
    byPage.get(line.page)!.push(line);
  }
  // Only the top and bottom few lines of a page can be running furniture.
  const edge = new Set<PdfLine>();
  for (const pageLines of byPage.values()) {
    const sorted = [...pageLines].sort((a, b) => b.y - a.y);
    for (const l of [...sorted.slice(0, 3), ...sorted.slice(-3)]) edge.add(l);
  }
  const pageCount = byPage.size;
  const signature = (t: string) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const seenOn = new Map<string, Set<number>>();
  for (const line of edge) {
    const sig = signature(line.text);
    if (!seenOn.has(sig)) seenOn.set(sig, new Set());
    seenOn.get(sig)!.add(line.page);
  }
  const threshold = Math.max(2, Math.ceil(pageCount * 0.6));
  return lines.filter((line) => {
    const text = line.text.trim();
    if (!text) return false;
    if (!edge.has(line)) return true;
    if (/^(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i.test(text)) return false;
    if (pageCount >= 2 && (seenOn.get(signature(text))?.size ?? 0) >= threshold) return false;
    return true;
  });
}

// ── Question paper ──────────────────────────────────────────────────────────

interface Draft {
  number: number;
  section: string | null;
  stem: string[];
  options: ParsedOption[];
  inlineAnswer: string | null;
  stemX: number;
}

export function parseQuestionPaper(input: PdfLine[]): {
  title: string | null;
  subtitle: string | null;
  description: string | null;
  questions: Omit<ParsedQuestion, "explanation">[];
  errors: ParseIssue[];
  warnings: ParseIssue[];
} {
  const lines = stripPageFurniture(input).map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text);
  const errors: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  const preamble: PdfLine[] = [];
  const drafts: Draft[] = [];
  let section: string | null = null;
  let current: Draft | null = null;
  // Left margin of question numbers, learnt from the first question.
  let questionX: number | null = null;

  const finish = () => {
    if (current) drafts.push(current);
    current = null;
  };

  for (const line of lines) {
    const text = line.text;

    // A heading can only sit between complete questions, never inside a stem.
    if (isSectionHeading(text) && (!current || current.options.length >= 2)) {
      finish();
      section = text;
      continue;
    }

    const q = QUESTION_RE.exec(text);
    if (q) {
      const number = Number(q[1]);
      const last: number = current?.number ?? drafts.at(-1)?.number ?? 0;
      const atMargin = questionX === null || line.x <= questionX + 4;
      const sequential = number === last + 1;
      // A number is a new question when it continues the sequence, or when it is
      // at the question margin and moves forward (a gap is reported below).
      // Anything else is ordinary text that happens to start with a number.
      const awaitingOptions = current !== null && current.options.length === 0 && !sequential;
      // Small forward jumps (a question missing from the paper) are accepted with a
      // warning; larger ones are text such as a year at the start of a wrapped line.
      const smallJump = atMargin && last > 0 && number > last && number <= last + 3;
      if (!awaitingOptions && (sequential || smallJump || (last === 0 && drafts.length === 0))) {
        if (!sequential && last > 0) {
          warnings.push({ number, message: `Question numbering jumps from ${last} to ${number}.` });
        }
        finish();
        questionX ??= line.x;
        current = { number, section, stem: q[2] ? [q[2]] : [], options: [], inlineAnswer: null, stemX: line.x };
        continue;
      }
    }

    if (!current) {
      preamble.push(line);
      continue;
    }

    const answer = INLINE_ANSWER_RE.exec(text);
    if (answer && current.options.length > 0) {
      current.inlineAnswer = answer[1]!.toUpperCase();
      continue;
    }

    const expected = OPTION_LETTERS[current.options.length]!;
    const inline = splitInlineOptions(text, expected);
    if (inline && current.options.length + inline.length <= MAX_OPTIONS) {
      current.options.push(...inline);
      continue;
    }

    const opt = OPTION_RE.exec(text);
    if (opt && opt[1]!.toUpperCase() === expected && current.options.length < MAX_OPTIONS) {
      // Lower-case "a." at the stem margin is more likely a sentence fragment
      // than an option when options are normally indented; accept upper case anywhere.
      current.options.push({ key: expected, text: opt[2] ?? "" });
      continue;
    }

    if (current.options.length > 0) {
      const lastOption = current.options.at(-1)!;
      lastOption.text = joinWrapped(lastOption.text, text);
    } else if (ROMAN_ITEM_RE.test(text) || current.stem.length === 0) {
      current.stem.push(text);
    } else {
      const lastIndex = current.stem.length - 1;
      current.stem[lastIndex] = joinWrapped(current.stem[lastIndex]!, text);
    }
  }
  finish();

  // Title, subtitle and description come from the text before the first question.
  let title: string | null = null;
  let subtitle: string | null = null;
  let description: string | null = null;
  if (preamble.length > 0) {
    const firstPage = preamble.filter((l) => l.page === preamble[0]!.page);
    const maxSize = Math.max(...firstPage.map((l) => l.size));
    const bodySize = median(preamble.map((l) => l.size));
    const titleLines = maxSize > bodySize + 0.5 ? firstPage.filter((l) => l.size >= maxSize - 0.5) : firstPage.slice(0, 1);
    title = clean(titleLines.map((l) => l.text).join(" ")).slice(0, 200) || null;
    const rest = preamble.filter((l) => !titleLines.includes(l)).map((l) => l.text);
    // A short line without closing punctuation right under the title reads as a subtitle.
    if (rest[0] && rest[0].length <= 120 && !/[.?!:;,]$/.test(rest[0])) subtitle = rest.shift()!.slice(0, 200);
    description = rest.reduce(joinWrapped, "").trim().slice(0, 4000) || null;
  }

  if (drafts.length === 0) {
    errors.push({ message: "No numbered questions were found. Questions must start with a number such as \"1.\"." });
  }
  if (drafts.length > MAX_QUESTIONS) {
    errors.push({ message: `The paper has ${drafts.length} questions; the limit is ${MAX_QUESTIONS}.` });
  }

  const seen = new Set<number>();
  const questions = drafts.slice(0, MAX_QUESTIONS).map((d) => {
    if (seen.has(d.number)) errors.push({ number: d.number, message: `Question ${d.number} appears more than once.` });
    seen.add(d.number);
    const prompt = d.stem.map(clean).filter(Boolean).join("\n");
    const options = d.options.map((o) => ({ key: o.key, text: clean(o.text) }));
    if (!prompt) errors.push({ number: d.number, message: `Question ${d.number} has no question text.` });
    if (options.length < 2) {
      errors.push({ number: d.number, message: `Question ${d.number} has ${options.length} option(s); at least 2 are needed.` });
    }
    for (const o of options) {
      if (!o.text) errors.push({ number: d.number, message: `Question ${d.number}, option ${o.key} is empty.` });
    }
    if (prompt.length > 4000) errors.push({ number: d.number, message: `Question ${d.number} is too long.` });
    return { number: d.number, section: d.section, prompt, options, answer: d.inlineAnswer };
  });

  const counts = new Map<number, number>();
  for (const q of questions) counts.set(q.options.length, (counts.get(q.options.length) ?? 0) + 1);
  const usual = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const q of questions) {
    if (usual !== undefined && q.options.length >= 2 && q.options.length !== usual) {
      warnings.push({ number: q.number, message: `Question ${q.number} has ${q.options.length} options; most have ${usual}.` });
    }
  }

  return { title, subtitle, description, questions, errors, warnings };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// ── Answer key ──────────────────────────────────────────────────────────────

const GRID_TOKEN = /(?:^|\s)(?:q\s*)?(\d{1,4})\s*[.):\-–]?\s*\(?([A-H])\)?(?=\s|$)/gi;
const GRID_LINE = /^(?:\s*(?:q\s*)?\d{1,4}\s*[.):\-–]?\s*\(?[A-H]\)?)+\s*$/i;
const EXPLANATION_RE = /^(?:q(?:uestion)?\s*)?(\d{1,4})\s*[.):]?\s*\(?([A-H])\)?\s*(?:[-–—:]|\.\s)\s*(.+)$/i;
const KEY_HEADING_RE = /^(?:answer\s*key|answers?|explanations?|solutions?|key|rationale)\b.{0,40}$/i;

export function parseAnswerKey(input: PdfLine[]): {
  entries: Map<number, KeyEntry>;
  errors: ParseIssue[];
  warnings: ParseIssue[];
} {
  const lines = stripPageFurniture(input).map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text);
  const entries = new Map<number, KeyEntry>();
  const errors: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  let explaining: number | null = null;

  const entry = (n: number): KeyEntry => {
    let e = entries.get(n);
    if (!e) {
      e = { letter: "", gridLetter: null, explanationLetter: null, explanation: null };
      entries.set(n, e);
    }
    return e;
  };

  for (const { text } of lines) {
    if (GRID_LINE.test(text)) {
      const tokens = [...text.matchAll(GRID_TOKEN)];
      for (const t of tokens) {
        const n = Number(t[1]);
        const letter = t[2]!.toUpperCase();
        const e = entry(n);
        if (e.gridLetter && e.gridLetter !== letter) {
          errors.push({ number: n, message: `The answer key lists question ${n} twice (${e.gridLetter} and ${letter}).` });
        }
        e.gridLetter = letter;
      }
      // A single "12. C" line may be followed by its explanation on the next lines.
      explaining = tokens.length === 1 ? Number(tokens[0]![1]) : null;
      continue;
    }

    const ex = EXPLANATION_RE.exec(text);
    if (ex) {
      const n = Number(ex[1]);
      const letter = ex[2]!.toUpperCase();
      const e = entry(n);
      if (e.explanationLetter && e.explanationLetter !== letter) {
        errors.push({ number: n, message: `Question ${n} has two explanations with different answers (${e.explanationLetter} and ${letter}).` });
      }
      e.explanationLetter = letter;
      e.explanation = clean(ex[3] ?? "") || null;
      explaining = n;
      continue;
    }

    if (isSectionHeading(text) || KEY_HEADING_RE.test(text)) {
      explaining = null;
      continue;
    }

    if (explaining !== null) {
      const e = entry(explaining);
      e.explanation = joinWrapped(e.explanation ?? "", text);
    }
  }

  for (const [n, e] of entries) {
    if (e.gridLetter && e.explanationLetter && e.gridLetter !== e.explanationLetter) {
      errors.push({
        number: n,
        message: `Question ${n}: the key grid says ${e.gridLetter} but the explanation says ${e.explanationLetter}.`,
      });
    }
    e.letter = e.gridLetter ?? e.explanationLetter ?? "";
  }

  return { entries, errors, warnings };
}

// ── Merge ───────────────────────────────────────────────────────────────────

export function parseExamPapers(questionLines: PdfLine[], answerLines: PdfLine[]): ParsedPaper {
  const paper = parseQuestionPaper(questionLines);
  const key = parseAnswerKey(answerLines);
  const errors = [...paper.errors, ...key.errors];
  const warnings = [...paper.warnings, ...key.warnings];
  const numbers = new Set(paper.questions.map((q) => q.number));
  if (key.entries.size === 0 && paper.questions.some((q) => !q.answer)) {
    errors.push({ message: "No answers were found in the answer key. Use lines like \"1. C\" or \"1. C - explanation\"." });
  }

  const questions: ParsedQuestion[] = paper.questions.map((q) => {
    const k = key.entries.get(q.number);
    let answer = k?.letter || null;
    if (q.answer && answer && q.answer !== answer) {
      errors.push({ number: q.number, message: `Question ${q.number}: the paper says ${q.answer} but the answer key says ${answer}.` });
    }
    answer ??= q.answer;
    if (!answer) {
      errors.push({ number: q.number, message: `Question ${q.number} has no answer in the answer key.` });
    } else if (!q.options.some((o) => o.key === answer)) {
      errors.push({ number: q.number, message: `Question ${q.number}: answer ${answer} is not one of its options.` });
    }
    return { ...q, answer, explanation: k?.explanation ?? null };
  });

  const extra = [...key.entries.keys()].filter((n) => !numbers.has(n)).sort((a, b) => a - b);
  if (extra.length > 0) {
    warnings.push({ message: `The answer key has answers for questions that are not in the paper: ${summarise(extra)}.` });
  }

  const sections = [...new Set(questions.map((q) => q.section).filter((s): s is string => !!s))];
  return {
    title: paper.title,
    subtitle: paper.subtitle,
    description: paper.description,
    questions,
    errors: dedupe(errors),
    warnings: dedupe(warnings),
    stats: {
      questionCount: questions.length,
      answeredCount: questions.filter((q) => q.answer).length,
      explanationCount: questions.filter((q) => q.explanation).length,
      sections,
    },
  };
}

function summarise(numbers: number[]): string {
  return numbers.length > 12 ? `${numbers.slice(0, 12).join(", ")} and ${numbers.length - 12} more` : numbers.join(", ");
}

function dedupe(issues: ParseIssue[]): ParseIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.number ?? ""}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
