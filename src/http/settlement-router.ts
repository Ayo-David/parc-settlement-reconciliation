import { randomUUID } from "node:crypto";
import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { z } from "zod";
import {
  ParcAuthError,
  principalOf,
  type AccessPolicy,
} from "../security/parc-service-auth.js";
import {
  breakTreatments,
  type PostingService,
} from "../services/posting-service.js";
import type { SettlementReadService } from "../services/read-service.js";
import {
  breakTypes,
  manualResolutions,
  type ReconciliationService,
} from "../services/reconciliation-service.js";
import {
  participantKinds,
  type StatementService,
} from "../services/statement-service.js";
import { type Actor, SettlementError } from "../services/support.js";
import { maxStatementBytes } from "../services/statement-format.js";

/**
 * CB-7 slice A (D183, D184): administrator routes, for delegated
 * administrator tokens through the Admin BFF, for the token's tenant.
 */
const admin = (scope: string): AccessPolicy => ({
  scopes: [scope],
  kinds: ["delegated"],
  subjectTypes: ["ADMINISTRATOR"],
  actors: ["parc-admin-bff"],
});
export const settlementPolicies = {
  read: admin("settlement.reconciliation.read"),
  manage: admin("settlement.reconciliation.manage"),
} satisfies Record<string, AccessPolicy>;

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
    {
      message: "Invalid date",
    },
  );
const uuid = z.string().uuid();
const paging = {
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  page_cursor: z.string().min(1).max(500).optional(),
};

const participantInput = z
  .object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,49}$/),
    name: z.string().trim().min(1).max(150),
    kind: z.enum(participantKinds),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("NGN"),
    grace_days: z.number().int().min(0).max(30).default(2),
  })
  .strict();
const participantUpdate = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(150).optional(),
    grace_days: z.number().int().min(0).max(30).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  })
  .strict();
// The base64 of a 1 MiB file is at most 1,398,104 characters.
const importInput = z
  .object({
    participant_id: uuid,
    statement_date: date,
    file_name: z.string().trim().min(1).max(255),
    content_base64: z
      .string()
      .min(4)
      .max(Math.ceil(maxStatementBytes / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    correction: z.boolean().default(false),
  })
  .strict();
const runInput = z
  .object({ participant_id: uuid, period_from: date, period_to: date })
  .strict();
const resolveInput = z
  .object({
    resolution_type: z.enum(manualResolutions),
    note: z.string().trim().min(10).max(2000),
  })
  .strict();

// CB-7 slice B (D185–D189).
const postingNote = z.string().trim().min(10).max(1000);
const previewPostingInput = z
  .object({ treatment: z.enum(breakTreatments), note: postingNote })
  .strict();
const postPostingInput = z
  .object({
    treatment: z.enum(breakTreatments),
    note: postingNote,
    approval_id: uuid,
  })
  .strict();
const previewReleaseInput = z.object({ note: postingNote }).strict();
const releaseInput = z
  .object({ note: postingNote, approval_id: uuid })
  .strict();
const clearInput = z.object({ journal_id: uuid, note: postingNote }).strict();
const noteInput = z
  .object({ note: z.string().trim().min(1).max(2000) })
  .strict();

export interface SettlementRouterInput {
  statements: StatementService;
  reconciliation: ReconciliationService;
  postings: PostingService;
  reads: SettlementReadService;
  require: (policy: AccessPolicy) => RequestHandler;
}

export function createSettlementRouter(input: SettlementRouterInput): Router {
  const { statements, reconciliation, postings, reads, require } = input;
  const router = Router();
  const read = require(settlementPolicies.read);
  const manage = require(settlementPolicies.manage);

  router.get(
    "/internal/v1/settlement-participants",
    read,
    route(async (request, response) => {
      response.json({
        items: await statements.listParticipants(tenant(request)),
      });
    }),
  );
  router.post(
    "/internal/v1/settlement-participants",
    manage,
    route(async (request, response) => {
      const body = participantInput.parse(request.body);
      const result = await statements.createParticipant(
        tenant(request),
        {
          code: body.code,
          name: body.name,
          kind: body.kind,
          currency: body.currency,
          graceDays: body.grace_days,
        },
        actor(request),
        idempotencyKey(request),
      );
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.put(
    "/internal/v1/settlement-participants/:id",
    manage,
    route(async (request, response) => {
      const body = participantUpdate.parse(request.body);
      response.json(
        await statements.updateParticipant(
          tenant(request),
          id(request),
          {
            version: body.version,
            name: body.name,
            graceDays: body.grace_days,
            status: body.status,
          },
          actor(request),
        ),
      );
    }),
  );

  router.get(
    "/internal/v1/statement-imports",
    read,
    route(async (request, response) => {
      const query = z
        .object({
          ...paging,
          participant_id: uuid.optional(),
          from: date.optional(),
          to: date.optional(),
        })
        .parse(request.query);
      response.json(
        await reads.listImports(tenant(request), {
          pageSize: query.page_size,
          cursor: query.page_cursor,
          participantId: query.participant_id,
          from: query.from,
          to: query.to,
        }),
      );
    }),
  );
  router.post(
    "/internal/v1/statement-imports",
    manage,
    route(async (request, response) => {
      const body = importInput.parse(request.body);
      const content = Buffer.from(body.content_base64, "base64");
      if (content.toString("base64") !== body.content_base64)
        throw new SettlementError(
          400,
          "INVALID_BASE64",
          "content_base64 is not canonical base64",
        );
      const result = await statements.importStatement(
        tenant(request),
        {
          participantId: body.participant_id,
          statementDate: body.statement_date,
          fileName: body.file_name,
          content,
          correction: body.correction,
        },
        actor(request),
        idempotencyKey(request),
      );
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.get(
    "/internal/v1/statement-imports/:id",
    read,
    route(async (request, response) => {
      response.json(await reads.getImport(tenant(request), id(request)));
    }),
  );
  router.get(
    "/internal/v1/statement-imports/:id/lines",
    read,
    route(async (request, response) => {
      const query = z
        .object({
          page_size: z.coerce.number().int().min(1).max(500).default(100),
          page_cursor: z.coerce.number().int().min(0).optional(),
        })
        .parse(request.query);
      response.json(
        await reads.listLines(tenant(request), id(request), {
          pageSize: query.page_size,
          afterLine: query.page_cursor,
        }),
      );
    }),
  );

  router.get(
    "/internal/v1/reconciliation-runs",
    read,
    route(async (request, response) => {
      const query = z
        .object({ ...paging, participant_id: uuid.optional() })
        .parse(request.query);
      response.json(
        await reads.listRuns(tenant(request), {
          pageSize: query.page_size,
          cursor: query.page_cursor,
          participantId: query.participant_id,
        }),
      );
    }),
  );
  router.post(
    "/internal/v1/reconciliation-runs",
    manage,
    route(async (request, response) => {
      const body = runInput.parse(request.body);
      const result = await reconciliation.startRun(
        tenant(request),
        {
          participantId: body.participant_id,
          periodFrom: body.period_from,
          periodTo: body.period_to,
        },
        actor(request),
        idempotencyKey(request),
      );
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.get(
    "/internal/v1/reconciliation-runs/:id",
    read,
    route(async (request, response) => {
      response.json(await reads.getRun(tenant(request), id(request)));
    }),
  );

  router.get(
    "/internal/v1/reconciliation-breaks",
    read,
    route(async (request, response) => {
      const query = z
        .object({
          ...paging,
          status: z.enum(["OPEN", "RESOLVED"]).optional(),
          break_type: z.enum(breakTypes).optional(),
          participant_id: uuid.optional(),
          run_id: uuid.optional(),
        })
        .parse(request.query);
      response.json(
        await reads.listBreaks(tenant(request), {
          pageSize: query.page_size,
          cursor: query.page_cursor,
          status: query.status,
          breakType: query.break_type,
          participantId: query.participant_id,
          runId: query.run_id,
        }),
      );
    }),
  );
  router.get(
    "/internal/v1/reconciliation-breaks/:id",
    read,
    route(async (request, response) => {
      response.json(await reads.getBreak(tenant(request), id(request)));
    }),
  );
  router.post(
    "/internal/v1/reconciliation-breaks/:id/resolve",
    manage,
    route(async (request, response) => {
      const body = resolveInput.parse(request.body);
      const result = await reconciliation.resolveBreak(
        tenant(request),
        id(request),
        { resolutionType: body.resolution_type, note: body.note },
        actor(request),
        idempotencyKey(request),
      );
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );

  router.post(
    "/internal/v1/reconciliation-breaks/:id/posting-resolutions/preview",
    manage,
    route(async (request, response) => {
      const body = previewPostingInput.parse(request.body);
      response.json(
        await postings.previewBreak(
          tenant(request),
          id(request),
          body,
          actor(request),
          idempotencyKey(request),
        ),
      );
    }),
  );
  router.post(
    "/internal/v1/reconciliation-breaks/:id/posting-resolutions",
    manage,
    route(async (request, response) => {
      const body = postPostingInput.parse(request.body);
      const result = await postings.postBreak(
        tenant(request),
        id(request),
        {
          treatment: body.treatment,
          note: body.note,
          approvalId: body.approval_id,
        },
        actor(request),
        idempotencyKey(request),
      );
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );

  router.get(
    "/internal/v1/suspense-investigations",
    read,
    route(async (request, response) => {
      const query = z
        .object({
          ...paging,
          status: z.enum(["OPEN", "CLOSED"]).optional(),
          participant_id: uuid.optional(),
        })
        .parse(request.query);
      response.json(
        await reads.listInvestigations(tenant(request), {
          pageSize: query.page_size,
          cursor: query.page_cursor,
          status: query.status,
          participantId: query.participant_id,
        }),
      );
    }),
  );
  router.get(
    "/internal/v1/suspense-investigations/:id",
    read,
    route(async (request, response) => {
      response.json(await reads.getInvestigation(tenant(request), id(request)));
    }),
  );
  router.post(
    "/internal/v1/suspense-investigations/:id/notes",
    manage,
    route(async (request, response) => {
      const body = noteInput.parse(request.body);
      const result = await postings.addNote(
        tenant(request),
        id(request),
        body.note,
        actor(request),
        idempotencyKey(request),
      );
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.post(
    "/internal/v1/suspense-investigations/:id/release/preview",
    manage,
    route(async (request, response) => {
      const body = previewReleaseInput.parse(request.body);
      response.json(
        await postings.previewRelease(
          tenant(request),
          id(request),
          body,
          actor(request),
          idempotencyKey(request),
        ),
      );
    }),
  );
  router.post(
    "/internal/v1/suspense-investigations/:id/release",
    manage,
    route(async (request, response) => {
      const body = releaseInput.parse(request.body);
      const result = await postings.release(
        tenant(request),
        id(request),
        { note: body.note, approvalId: body.approval_id },
        actor(request),
        idempotencyKey(request),
      );
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.post(
    "/internal/v1/suspense-investigations/:id/clear-by-journal",
    manage,
    route(async (request, response) => {
      const body = clearInput.parse(request.body);
      const result = await postings.clearByJournal(
        tenant(request),
        id(request),
        { journalId: body.journal_id, note: body.note },
        actor(request),
        idempotencyKey(request),
      );
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  return router;
}

function tenant(request: Request): string {
  const principal = principalOf(request);
  if (principal.tenantId === null)
    throw new ParcAuthError(
      403,
      "TENANT_REQUIRED",
      "A tenant-bound token is required",
    );
  return principal.tenantId;
}

function actor(request: Request): Actor {
  const subject = principalOf(request).subject;
  if (!subject)
    throw new ParcAuthError(
      403,
      "SUBJECT_REQUIRED",
      "An administrator is required",
    );
  const header = request.header("x-correlation-id");
  return {
    administratorId: subject.id,
    correlationId:
      header && uuid.safeParse(header).success ? header : randomUUID(),
  };
}

function idempotencyKey(request: Request): string {
  const key = request.header("idempotency-key");
  if (!key || key.length > 255)
    throw new SettlementError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key is required",
    );
  return key;
}

function id(request: Request): string {
  const parsed = uuid.safeParse(request.params.id);
  if (!parsed.success)
    throw new SettlementError(404, "NOT_FOUND", "No such resource");
  return parsed.data;
}

function route(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    response.setHeader("Cache-Control", "no-store");
    void handler(request, response).catch(next);
  };
}
