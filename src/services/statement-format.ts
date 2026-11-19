import { canonicalJson, sha256 } from "./support.js";

/**
 * D180: Parc's canonical statement CSV. Provider and bank formats (Paystack,
 * Monnify, BankOne, MT940) become adapters that convert to this form, so
 * matching never changes.
 *
 * - UTF-8, RFC 4180 quoting, LF or CRLF line ends, at most 1 MiB and 20,000
 *   lines, and exactly this header.
 * - Direction is from the participant account's side: IN credits it (money
 *   received, such as a collection), OUT debits it (a transfer or bill paid).
 * - Amounts are positive minor units of at most 15 digits.
 */
export const statementHeader = [
  "line_reference",
  "provider_reference",
  "direction",
  "amount_minor",
  "currency",
  "value_date",
  "narration",
] as const;
export const maxStatementBytes = 1_048_576;
export const maxStatementLines = 20_000;
const maxIssues = 20;

export interface StatementLine {
  lineNumber: number;
  lineReference: string;
  providerReference: string | null;
  direction: "IN" | "OUT";
  amountMinor: string;
  currency: string;
  valueDate: string;
  narration: string | null;
  lineHash: string;
}

export interface StatementIssue {
  line: number;
  field?: string;
  code: string;
}

export type ParsedStatement =
  | { ok: true; lines: StatementLine[]; totalIn: bigint; totalOut: bigint }
  | { ok: false; issues: StatementIssue[] };

export function parseStatement(content: Buffer): ParsedStatement {
  if (content.length === 0)
    return { ok: false, issues: [{ line: 0, code: "EMPTY_FILE" }] };
  if (content.length > maxStatementBytes)
    return { ok: false, issues: [{ line: 0, code: "FILE_TOO_LARGE" }] };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return { ok: false, issues: [{ line: 0, code: "NOT_UTF8" }] };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = splitCsv(text);
  if (records === undefined)
    return { ok: false, issues: [{ line: 0, code: "UNTERMINATED_QUOTE" }] };
  const [header, ...rows] = records;
  if (
    header === undefined ||
    header.length !== statementHeader.length ||
    header.some((value, index) => value.trim() !== statementHeader[index])
  )
    return { ok: false, issues: [{ line: 1, code: "INVALID_HEADER" }] };
  if (rows.length === 0)
    return { ok: false, issues: [{ line: 1, code: "NO_LINES" }] };
  if (rows.length > maxStatementLines)
    return { ok: false, issues: [{ line: 0, code: "TOO_MANY_LINES" }] };

  const issues: StatementIssue[] = [];
  const lines: StatementLine[] = [];
  const seen = new Map<string, number>();
  let totalIn = 0n;
  let totalOut = 0n;
  rows.forEach((row, index) => {
    const lineNumber = index + 1;
    const fileLine = index + 2;
    const issue = (field: string | undefined, code: string) =>
      issues.push({ line: fileLine, ...(field ? { field } : {}), code });
    if (row.length !== statementHeader.length) {
      issue(undefined, "WRONG_FIELD_COUNT");
      return;
    }
    const [
      reference,
      providerReference,
      direction,
      amount,
      currency,
      valueDate,
      narration,
    ] = row.map((value) => value.trim()) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const before = issues.length;
    if (reference.length === 0 || reference.length > 200)
      issue("line_reference", "REQUIRED_MAX_200");
    else if (seen.has(reference)) issue("line_reference", "DUPLICATE_IN_FILE");
    if (providerReference.length > 200) issue("provider_reference", "MAX_200");
    if (direction !== "IN" && direction !== "OUT")
      issue("direction", "IN_OR_OUT");
    if (!/^[1-9][0-9]{0,14}$/.test(amount))
      issue("amount_minor", "POSITIVE_MINOR_UNITS");
    if (!/^[A-Z]{3}$/.test(currency)) issue("currency", "ISO_4217");
    if (!isDate(valueDate)) issue("value_date", "YYYY_MM_DD");
    if (narration.length > 500) issue("narration", "MAX_500");
    if (issues.length > before) return;
    seen.set(reference, fileLine);
    const line: Omit<StatementLine, "lineHash"> = {
      lineNumber,
      lineReference: reference,
      providerReference: providerReference || null,
      direction: direction as "IN" | "OUT",
      amountMinor: amount,
      currency,
      valueDate,
      narration: narration || null,
    };
    if (line.direction === "IN") totalIn += BigInt(amount);
    else totalOut += BigInt(amount);
    lines.push({ ...line, lineHash: sha256(canonicalJson(line)) });
  });
  if (issues.length > 0)
    return { ok: false, issues: issues.slice(0, maxIssues) };
  return { ok: true, lines, totalIn, totalOut };
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** RFC 4180 records; a trailing line end is allowed; blank lines skipped. */
function splitCsv(text: string): string[][] | undefined {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
      fieldStarted = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      if (!(record.length === 1 && record[0] === "")) records.push(record);
      record = [];
      field = "";
      fieldStarted = false;
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) return undefined;
  if (fieldStarted || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}
