import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * D180: raw statement files are kept in MinIO (ADR-026, ADR-034), encrypted
 * by this service before upload so encryption at rest does not depend on
 * MinIO's KMS. AES-256-GCM with a 96-bit random IV; the object key is the
 * additional authenticated data, so a file copied to another key fails to
 * decrypt. Layout: "PSE1" | key id length (1 byte) | key id | IV | ciphertext
 * | 16-byte tag.
 */
const magic = Buffer.from("PSE1", "ascii");

export interface StatementKey {
  id: string;
  key: Buffer;
}

export function statementKey(id: string, base64: string): StatementKey {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32)
    throw new Error("STATEMENT_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id))
    throw new Error("STATEMENT_ENCRYPTION_KEY_ID is invalid");
  return { id, key };
}

export function encryptStatement(
  key: StatementKey,
  objectKey: string,
  plaintext: Buffer,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(Buffer.from(objectKey, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const id = Buffer.from(key.id, "utf8");
  return Buffer.concat([
    magic,
    Buffer.from([id.length]),
    id,
    iv,
    body,
    cipher.getAuthTag(),
  ]);
}

export function decryptStatement(
  keys: readonly StatementKey[],
  objectKey: string,
  sealed: Buffer,
): Buffer {
  if (sealed.length < 34 || !sealed.subarray(0, 4).equals(magic))
    throw new Error("Not a sealed statement");
  const idLength = sealed[4] ?? 0;
  const id = sealed.subarray(5, 5 + idLength).toString("utf8");
  const key = keys.find((candidate) => candidate.id === id);
  if (!key) throw new Error("Statement key is not available");
  const ivStart = 5 + idLength;
  const iv = sealed.subarray(ivStart, ivStart + 12);
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(ivStart + 12, sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key.key, iv);
  decipher.setAAD(Buffer.from(objectKey, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Where sealed statement files are kept. */
export interface StatementStore {
  readonly keyId: string;
  /** Encrypts and stores the file; never overwrites an existing object. */
  put(objectKey: string, plaintext: Buffer): Promise<void>;
  get(objectKey: string): Promise<Buffer>;
  /** Best effort, for an upload whose import was not recorded. */
  remove(objectKey: string): Promise<void>;
}

export class StatementStoreUnavailableError extends Error {
  public constructor() {
    super("The statement store is unavailable");
    this.name = "StatementStoreUnavailableError";
  }
}

export interface S3StatementStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  key: StatementKey;
  /** Older keys, for reading files sealed before a rotation. */
  previousKeys?: readonly StatementKey[];
}

export class S3StatementStore implements StatementStore {
  private readonly client: S3Client;

  public constructor(private readonly options: S3StatementStoreOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      maxAttempts: 2,
    });
  }

  public get keyId(): string {
    return this.options.key.id;
  }

  /** Creates the bucket if it is missing (startup; idempotent). */
  public async ensureBucket(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.options.bucket }),
      );
    } catch {
      await this.client
        .send(new CreateBucketCommand({ Bucket: this.options.bucket }))
        .catch((error: unknown) => {
          if (
            !(error instanceof Error) ||
            !/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(error.name)
          )
            throw error;
        });
    }
  }

  public async put(objectKey: string, plaintext: Buffer): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
          Body: encryptStatement(this.options.key, objectKey, plaintext),
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
        }),
      );
    } catch {
      throw new StatementStoreUnavailableError();
    }
  }

  public async get(objectKey: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
    );
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) throw new Error("Statement object is empty");
    return decryptStatement(
      [this.options.key, ...(this.options.previousKeys ?? [])],
      objectKey,
      Buffer.from(bytes),
    );
  }

  public async remove(objectKey: string): Promise<void> {
    await this.client
      .send(
        new DeleteObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
        }),
      )
      .catch(() => undefined);
  }
}

/** Tests and local runs without MinIO. Seals like the real store. */
export class MemoryStatementStore implements StatementStore {
  public readonly objects = new Map<string, Buffer>();
  public failPuts = false;

  public constructor(private readonly key: StatementKey) {}

  public get keyId(): string {
    return this.key.id;
  }

  public put(objectKey: string, plaintext: Buffer): Promise<void> {
    if (this.failPuts)
      return Promise.reject(new StatementStoreUnavailableError());
    if (this.objects.has(objectKey))
      return Promise.reject(new Error("Object exists"));
    this.objects.set(
      objectKey,
      encryptStatement(this.key, objectKey, plaintext),
    );
    return Promise.resolve();
  }

  public get(objectKey: string): Promise<Buffer> {
    const sealed = this.objects.get(objectKey);
    if (!sealed) return Promise.reject(new Error("No such object"));
    return Promise.resolve(decryptStatement([this.key], objectKey, sealed));
  }

  public remove(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
    return Promise.resolve();
  }
}
