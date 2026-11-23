import {
  parseStatement,
  statementHeader,
} from "../src/services/statement-format.js";

const header = statementHeader.join(",");
const csv = (...lines: string[]) => Buffer.from([header, ...lines].join("\n"));

/** D180: the canonical statement CSV. */
describe("canonical statement format", () => {
  it("parses lines, totals and quoted fields", () => {
    const parsed = parseStatement(
      csv(
        'L1,PR-1,OUT,250000,NGN,2026-11-18,"Transfer, to ""Ada"""',
        "L2,,IN,1000,NGN,2026-11-18,",
      ),
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.totalOut).toBe(250000n);
    expect(parsed.totalIn).toBe(1000n);
    expect(parsed.lines[0]).toMatchObject({
      lineNumber: 1,
      providerReference: "PR-1",
      narration: 'Transfer, to "Ada"',
    });
    expect(parsed.lines[1]?.providerReference).toBeNull();
    expect(parsed.lines[0]?.lineHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts CRLF, a byte-order mark and a trailing line end", () => {
    const parsed = parseStatement(
      Buffer.from(
        `${String.fromCharCode(0xfeff)}${header}\r\nL1,PR,IN,5,NGN,2026-01-31,x\r\n`,
      ),
    );
    expect(parsed.ok).toBe(true);
  });

  it("reports each invalid field with its file line", () => {
    const parsed = parseStatement(
      csv(
        "L1,PR,SIDEWAYS,0,ngn,2026-02-30,",
        "L1,PR,IN,10,NGN,2026-02-01,",
        "L3,PR,IN,10,NGN",
      ),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual([
      { line: 2, field: "direction", code: "IN_OR_OUT" },
      { line: 2, field: "amount_minor", code: "POSITIVE_MINOR_UNITS" },
      { line: 2, field: "currency", code: "ISO_4217" },
      { line: 2, field: "value_date", code: "YYYY_MM_DD" },
      { line: 4, code: "WRONG_FIELD_COUNT" },
    ]);
  });

  it("refuses duplicate line references in one file", () => {
    const parsed = parseStatement(
      csv("L1,A,IN,10,NGN,2026-02-01,", "L1,B,IN,10,NGN,2026-02-01,"),
    );
    expect(parsed).toEqual({
      ok: false,
      issues: [{ line: 3, field: "line_reference", code: "DUPLICATE_IN_FILE" }],
    });
  });

  it.each([
    [Buffer.alloc(0), "EMPTY_FILE"],
    [Buffer.from("a,b\n"), "INVALID_HEADER"],
    [Buffer.from(header), "NO_LINES"],
    [Buffer.from([0xff, 0xfe, 0x00]), "NOT_UTF8"],
    [csv('L1,"PR,IN,10,NGN,2026-02-01,'), "UNTERMINATED_QUOTE"],
    [Buffer.alloc(1_048_577, 65), "FILE_TOO_LARGE"],
  ])("refuses a malformed file (%#: %s)", (content, code) => {
    const parsed = parseStatement(content);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]?.code).toBe(code);
  });

  it("refuses an amount beyond 15 digits", () => {
    const parsed = parseStatement(
      csv("L1,P,IN,1000000000000000,NGN,2026-02-01,"),
    );
    expect(parsed.ok).toBe(false);
  });
});
