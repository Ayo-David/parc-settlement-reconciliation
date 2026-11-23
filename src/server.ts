import { createServer } from "node:http";
import { z } from "zod";
import { createApp } from "./app.js";
import { createDatabase } from "./database/client.js";
import { S3StatementStore, statementKey } from "./runtime/statement-store.js";
import { HttpLedgerGateway } from "./runtime/ledger-client.js";
import {
  createParcAuth,
  ParcTokenClient,
} from "./security/parc-service-auth.js";
import { SettlementAdminService } from "./services/admin-reports.js";
import { settlementExports } from "./services/admin-reports.js";
import { AdminExportService } from "./services/export-service.js";
import { PostingService } from "./services/posting-service.js";
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
    // CB-7 slice B (D185, D186): Ledger GL mappings and manual adjustments.
    AUTH_TOKEN_URL: z
      .string()
      .url()
      .default("http://127.0.0.1:3001/internal/v1/oauth/token"),
    SERVICE_CLIENT_KEY_ID: z.string().min(1),
    SERVICE_CLIENT_PRIVATE_KEY_BASE64: z.string().min(1),
    LEDGER_URL: z.string().url().default("http://127.0.0.1:3003"),
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
const tokens = await ParcTokenClient.fromBase64Key({
  tokenUrl: config.AUTH_TOKEN_URL,
  issuer: config.AUTH_JWT_ISSUER,
  clientId: "parc-settlement-reconciliation",
  keyId: config.SERVICE_CLIENT_KEY_ID,
  privateKeyBase64: config.SERVICE_CLIENT_PRIVATE_KEY_BASE64,
});
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
    postings: new PostingService(
      database,
      new HttpLedgerGateway(config.LEDGER_URL, tokens),
    ),
    reads: new SettlementReadService(database),
    admin: new SettlementAdminService(database),
    exports: new AdminExportService(database, settlementExports, "settlement"),
    ready: async () => {
      await database.raw("SELECT 1");
    },
  }),
);
server.listen(config.PORT, config.HOST);
process.on("SIGTERM", () => server.close(() => void database.destroy()));
