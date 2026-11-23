import { randomBytes } from "node:crypto";
import {
  decryptStatement,
  encryptStatement,
  MemoryStatementStore,
  statementKey,
} from "../src/runtime/statement-store.js";

/** D180: files are sealed by the service before they reach MinIO. */
describe("statement sealing", () => {
  const key = statementKey("k1", randomBytes(32).toString("base64"));
  const plaintext = Buffer.from("line_reference,provider_reference\nL1,PR\n");

  it("round-trips and never stores the plaintext", () => {
    const sealed = encryptStatement(key, "settlement/t/p/d/i", plaintext);
    expect(sealed.includes(plaintext)).toBe(false);
    expect(sealed.subarray(0, 4).toString()).toBe("PSE1");
    expect(decryptStatement([key], "settlement/t/p/d/i", sealed)).toEqual(
      plaintext,
    );
  });

  it("refuses a file moved to another object key or tampered with", () => {
    const sealed = encryptStatement(key, "a", plaintext);
    expect(() => decryptStatement([key], "b", sealed)).toThrow();
    const tampered = Buffer.from(sealed);
    const at = tampered.length - 20;
    tampered[at] = (tampered[at] ?? 0) ^ 1;
    expect(() => decryptStatement([key], "a", tampered)).toThrow();
  });

  it("decrypts with the key named in the file after a rotation", () => {
    const next = statementKey("k2", randomBytes(32).toString("base64"));
    const sealed = encryptStatement(key, "a", plaintext);
    expect(decryptStatement([next, key], "a", sealed)).toEqual(plaintext);
    expect(() => decryptStatement([next], "a", sealed)).toThrow(
      "Statement key is not available",
    );
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() =>
      statementKey("k", randomBytes(16).toString("base64")),
    ).toThrow();
  });

  it("the memory store seals like the real one and never overwrites", async () => {
    const store = new MemoryStatementStore(key);
    await store.put("x", plaintext);
    expect(store.objects.get("x")?.includes(plaintext)).toBe(false);
    expect(await store.get("x")).toEqual(plaintext);
    await expect(store.put("x", plaintext)).rejects.toThrow();
  });
});
