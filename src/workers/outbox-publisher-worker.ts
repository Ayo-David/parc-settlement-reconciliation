import { z } from "zod";
import { createDatabase } from "../database/client.js";
import {
  SettlementOutboxPublisher,
  type PublisherLogger,
} from "../messaging/outbox/outbox-publisher.js";
import { outboxTenantsWithWork } from "../runtime/outbox-tenants.js";
import {
  exportPurgeIntervalMs,
  purgeExpiredExports,
} from "../services/export-service.js";

/**
 * CB-7: relays outbox_events (reconciliation.run-started.v1,
 * reconciliation.break-detected.v1, reconciliation.break-resolved.v1) to RabbitMQ.
 * Tenants are discovered from the database (CB1-11), so no tenant list is
 * configured.
 */
const config = z
  .object({
    DATABASE_URL: z.string().default("postgresql:///parc_treasury_settlement"),
    RABBITMQ_URL: z.string().url().default("amqp://127.0.0.1:5672"),
    OUTBOX_POLL_MS: z.coerce.number().int().min(100).default(1000),
  })
  .parse(process.env);

/** JSON lines, one per event; never payloads or connection strings. */
const logger: PublisherLogger = {
  info: (message, fields) =>
    console.info(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) =>
    console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) =>
    console.error(JSON.stringify({ level: "error", message, ...fields })),
};

const database = createDatabase(config.DATABASE_URL);
const publisher = new SettlementOutboxPublisher(
  database,
  config.RABBITMQ_URL,
  () => outboxTenantsWithWork(database),
  logger,
);

// CB-7 slice D (D191): clear export files past their 24 hours.
const purge = () =>
  purgeExpiredExports(database).then(
    (purged) => {
      if (purged > 0) logger.info("Expired exports cleared", { purged });
    },
    () => logger.error("Export purge failed", {}),
  );
void purge();
const purgeTimer = setInterval(() => void purge(), exportPurgeIntervalMs);

let stopping = false;
async function run(): Promise<void> {
  logger.info("Settlement outbox publisher started");
  while (!stopping) {
    const published = await publisher.runBatch();
    if (published > 0) logger.info("Outbox events published", { published });
    // Drain without pausing while events are flowing; poll once idle.
    if (published === 0)
      await new Promise<void>((resolve) =>
        setTimeout(resolve, config.OUTBOX_POLL_MS),
      );
  }
  clearInterval(purgeTimer);
  await publisher.close();
  await database.destroy();
}

process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
await run();
