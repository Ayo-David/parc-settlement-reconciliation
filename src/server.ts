import { createServer } from "node:http";
import { z } from "zod";
import { createApp } from "./app.js";
import { createDatabase } from "./database/client.js";
import { S3StatementStore, statementKey } from "./runtime/statement-store.js";
import { createParcAuth } from "./security/parc-service-auth.js";
import { SettlementReadService } from "./services/read-service.js";
import { ReconciliationService } from "./services/reconciliation-service.js";
import { StatementService } from "./services/statement-service.js";

const config = z
  .object({
    PORT: z.coerce.number().int().positive().default(3011),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().default("postgresql:///parc_treasury_settlement"),
    AUTH_JWKS_URL: z
      .string()
      .url()
      .default("http://127.0.0.1:3001/.well-known/jwks.json"),
    AUTH_JWT_ISSUER: z.string().url().default("https://auth.parc.invalid"),
    // D180: sealed statement files in MinIO.
    STATEMENT_STORE_ENDPOINT: z.string().url(),
    STATEMENT_STORE_REGION: z.string().min(1).default("us-east-1"),
    STATEMENT_STORE_BUCKET: z
      .string()
      .min(3)
      .default("parc-settlement-statements"),
    STATEMENT_STORE_ACCESS_KEY_ID: z.string().min(1),
    STATEMENT_STORE_SECRET_ACCESS_KEY: z.string().min(1),
    STATEMENT_ENCRYPTION_KEY_ID: z.string().min(1),
    STATEMENT_ENCRYPTION_KEY_BASE64: z.string().min(1),
  })
  .parse(process.env);

const database = createDatabase(config.DATABASE_URL);
const store = new S3StatementStore({
  endpoint: config.STATEMENT_STORE_ENDPOINT,
  region: config.STATEMENT_STORE_REGION,
  bucket: config.STATEMENT_STORE_BUCKET,
  accessKeyId: config.STATEMENT_STORE_ACCESS_KEY_ID,
  secretAccessKey: config.STATEMENT_STORE_SECRET_ACCESS_KEY,
  key: statementKey(
    config.STATEMENT_ENCRYPTION_KEY_ID,
    config.STATEMENT_ENCRYPTION_KEY_BASE64,
  ),
});
await store.ensureBucket();
const access = createParcAuth({
  issuer: config.AUTH_JWT_ISSUER,
  audience: "parc-settlement-reconciliation",
  jwksUrl: config.AUTH_JWKS_URL,
});
const server = createServer(
  createApp({
    access,
    statements: new StatementService(database, store),
    reconciliation: new ReconciliationService(database),
    reads: new SettlementReadService(database),
    ready: async () => {
      await database.raw("SELECT 1");
    },
  }),
);
server.listen(config.PORT, config.HOST);
process.on("SIGTERM", () => server.close(() => void database.destroy()));
