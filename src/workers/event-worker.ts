import amqp from "amqplib";
import { z } from "zod";
import { createDatabase } from "../database/client.js";
import {
  consumedEvents,
  ExpectedItemsConsumer,
} from "../services/expected-items.js";

/**
 * CB-7 slice A (D179): consumes Payment's completions and reversals and
 * Ledger's posted journals into settlement's own projection. A redelivered
 * event changes nothing (inbox). An event that fails to process is
 * dead-lettered; one that does not parse is dead-lettered too, so a
 * contract break is visible rather than silently dropped.
 */
const config = z
  .object({
    DATABASE_URL: z.string().default("postgresql:///parc_treasury_settlement"),
    RABBITMQ_URL: z.string().url().default("amqp://127.0.0.1:5672"),
  })
  .parse(process.env);
const log = (
  level: string,
  message: string,
  fields: Record<string, unknown> = {},
) => console.log(JSON.stringify({ level, message, ...fields }));

const database = createDatabase(config.DATABASE_URL);
const consumer = new ExpectedItemsConsumer(database);
const queue = "parc-settlement-reconciliation.expected-items";
const connection = await amqp.connect(config.RABBITMQ_URL);
const channel = await connection.createChannel();
await channel.assertExchange("parc.events", "topic", { durable: true });
await channel.assertQueue(queue, {
  durable: true,
  arguments: { "x-dead-letter-exchange": "parc.events.dlx" },
});
for (const routingKey of consumedEvents)
  await channel.bindQueue(queue, "parc.events", routingKey);
await channel.prefetch(16);
await channel.consume(queue, (message) => {
  if (!message) return;
  void (async () => {
    try {
      const outcome = await consumer.handle(
        JSON.parse(message.content.toString("utf8")) as unknown,
      );
      if (outcome === "INVALID") {
        log("warn", "Settlement event rejected", {
          eventType: message.fields.routingKey,
        });
        channel.nack(message, false, false);
        return;
      }
      log("info", "Settlement event handled", {
        eventType: message.fields.routingKey,
        outcome,
      });
      channel.ack(message);
    } catch (error) {
      log("error", "Settlement event failed", {
        eventType: message.fields.routingKey,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      channel.nack(message, false, false);
    }
  })();
});
log("info", "Settlement event worker started");

const stop = () => {
  void channel
    .close()
    .catch(() => undefined)
    .then(() => connection.close().catch(() => undefined))
    .then(() => database.destroy());
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
