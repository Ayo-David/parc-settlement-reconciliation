import { randomBytes, randomUUID } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  S3StatementStore,
  statementKey,
} from "../src/runtime/statement-store.js";

const endpoint = process.env.TEST_MINIO_URL;
const accessKeyId = process.env.TEST_MINIO_ACCESS_KEY ?? "";
const secretAccessKey = process.env.TEST_MINIO_SECRET_KEY ?? "";
const describeMinio = endpoint ? describe : describe.skip;

/** D180 against a real MinIO (ADR-034 build): sealed at rest, never overwritten. */
describeMinio("statement store on MinIO", () => {
  const bucket = `parc-settlement-test-${randomUUID().slice(0, 8)}`;
  const store = new S3StatementStore({
    endpoint: endpoint ?? "",
    region: "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    key: statementKey("test-key", randomBytes(32).toString("base64")),
  });
  const raw = new S3Client({
    endpoint: endpoint ?? "",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  it("stores the file sealed, reads it back, and refuses an overwrite", async () => {
    await store.ensureBucket();
    await store.ensureBucket();
    const objectKey = `settlement/${randomUUID()}/statement.csv.sealed`;
    const content = Buffer.from(
      "line_reference,provider_reference\nL1,PR-SECRET-NARRATION\n",
    );
    await store.put(objectKey, content);
    const stored = await raw.send(
      new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    );
    const bytes = Buffer.from(
      (await stored.Body?.transformToByteArray()) ?? [],
    );
    expect(bytes.includes(Buffer.from("PR-SECRET-NARRATION"))).toBe(false);
    expect(await store.get(objectKey)).toEqual(content);
    await expect(store.put(objectKey, content)).rejects.toThrow(
      "The statement store is unavailable",
    );
    await store.remove(objectKey);
    await expect(store.get(objectKey)).rejects.toThrow();
  });
});
