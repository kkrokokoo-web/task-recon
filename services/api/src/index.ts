import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  DomainError,
  createReconcileRequest,
  getReconcileRequestDetail,
  importStatement,
  listAuditLog,
  listReconcileRequests,
  listStatements,
} from "@recon/shared";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 },
});

function sendError(reply: { status: (c: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof DomainError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "csv_parse_error" || err.code === "invalid_input"
          ? 400
          : 400;
    return reply.status(status).send({ error: err.message, code: err.code });
  }
  app.log.error(err);
  return reply.status(500).send({ error: "Internal server error" });
}

app.get("/health", async () => ({ ok: true }));

app.get("/api/statements", async (_req, reply) => {
  try {
    return await listStatements();
  } catch (err) {
    return sendError(reply, err);
  }
});

app.post("/api/statements", async (req, reply) => {
  try {
    const file = await req.file();
    if (!file) {
      return reply.status(400).send({ error: "CSV file is required", code: "missing_file" });
    }
    const buffer = await file.toBuffer();
    const filename = file.filename || "statement.csv";
    const result = await importStatement(filename, buffer);
    return {
      id: result.statementId,
      filename: result.filename,
      transaction_count: result.transactionCount,
      duplicate: result.duplicate,
    };
  } catch (err) {
    return sendError(reply, err);
  }
});

app.post<{ Params: { id: string } }>("/api/statements/:id/reconcile", async (req, reply) => {
  try {
    const statementId = Number(req.params.id);
    if (!Number.isInteger(statementId) || statementId <= 0) {
      return reply.status(400).send({ error: "Invalid statement id", code: "invalid_input" });
    }
    const result = await createReconcileRequest(statementId);
    return {
      id: result.requestId,
      status: result.status,
      already_exists: result.alreadyExists,
    };
  } catch (err) {
    return sendError(reply, err);
  }
});

app.get("/api/reconcile-requests", async (req, reply) => {
  try {
    const q = req.query as { include_done?: string; limit?: string; offset?: string };
    return await listReconcileRequests({
      includeDone: q.include_done !== "false",
      limit: q.limit ? Number(q.limit) : 50,
      offset: q.offset ? Number(q.offset) : 0,
    });
  } catch (err) {
    return sendError(reply, err);
  }
});

app.get<{ Params: { id: string } }>("/api/reconcile-requests/:id", async (req, reply) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: "Invalid request id", code: "invalid_input" });
    }
    return await getReconcileRequestDetail(id);
  } catch (err) {
    return sendError(reply, err);
  }
});

app.get("/api/audit-log", async (req, reply) => {
  try {
    const q = req.query as { limit?: string; offset?: string };
    return await listAuditLog({
      limit: q.limit ? Number(q.limit) : 100,
      offset: q.offset ? Number(q.offset) : 0,
    });
  } catch (err) {
    return sendError(reply, err);
  }
});

const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.API_HOST ?? "0.0.0.0";

await app.listen({ port, host });
app.log.info(`API listening on http://${host}:${port}`);
