import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DomainError,
  applyApprovedMatch,
  leaveUnmatched,
  listReconcileRequests,
  listUnmatchedTransactions,
  loadApprovalPreview,
  proposeMatch,
  rejectMatch,
  searchLoans,
} from "@recon/shared";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  if (err instanceof DomainError) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: err.message, code: err.code }),
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "recon-mcp",
    version: "1.0.0",
  });

  server.tool(
    "list_reconcile_requests",
    `List open reconcile requests with progress counts.
Set include_done=true to also include completed requests.
Progress fields: total, applied, left_unmatched, pending/waiting (proposal awaiting manager), unmatched (still need a decision).
Results are capped (default 50, max 100).`,
    {
      include_done: z
        .boolean()
        .optional()
        .describe("Include completed requests (default false — open only)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 50)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    },
    async (args) => {
      try {
        const requests = await listReconcileRequests({
          includeDone: args.include_done ?? false,
          limit: args.limit,
          offset: args.offset,
        });
        return textResult({ requests, count: requests.length });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "list_unmatched_transactions",
    `List bank transfers that still need a decision: no pending/approved match and not left unmatched.
Optionally filter by reconcile request id or value_date (YYYY-MM-DD).
Returns only fields needed to match: bank_txn_id, value_date, amount, currency, payer_name, description, request_id.
Capped (default 50, max 100).`,
    {
      request_id: z.number().int().positive().optional().describe("Filter by reconcile request id"),
      value_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Filter by value date YYYY-MM-DD"),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (args) => {
      try {
        const transactions = await listUnmatchedTransactions({
          requestId: args.request_id,
          valueDate: args.value_date,
          limit: args.limit,
          offset: args.offset,
        });
        return textResult({ transactions, count: transactions.length });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "search_loans",
    `Search loans by loan number, customer name (Latin or Cyrillic), or phone.
Does not return national ID (register_no).
Optional as_of (YYYY-MM-DD) adds amount_due for that value date:
  overdue installments via loan_overdue(loan, as_of+1 day), else next installment remaining.
Capped (default 25, max 50).`,
    {
      query: z.string().min(1).describe("Loan number, name fragment, or phone"),
      as_of: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Value date for amount_due calculation"),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (args) => {
      try {
        const result = await searchLoans({
          query: args.query,
          asOf: args.as_of,
          limit: args.limit,
          offset: args.offset,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "propose_match",
    `Record a proposed match of one bank transfer to one loan. Does NOT apply money.
Fails if the transfer already has a pending or approved proposal, or was left unmatched.
Provide a short reason the AI used to choose this loan.`,
    {
      bank_txn_id: z.string().min(1).describe("Bank transfer id, e.g. TX-88101"),
      loan_no: z.string().min(1).describe("Loan number, e.g. LN-1042"),
      reason: z.string().min(1).describe("Why this loan matches the transfer"),
    },
    async (args) => {
      try {
        const result = await proposeMatch({
          bankTxnId: args.bank_txn_id,
          loanNo: args.loan_no,
          reason: args.reason,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "leave_unmatched",
    `Mark a transfer as left unmatched with a reason. Does not apply money.
Fails if there is a pending or approved proposal.`,
    {
      bank_txn_id: z.string().min(1),
      reason: z.string().min(1).describe("Why the transfer cannot be matched"),
    },
    async (args) => {
      try {
        const result = await leaveUnmatched({
          bankTxnId: args.bank_txn_id,
          reason: args.reason,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "reject_match",
    `Reject a pending match proposal. The transfer returns to unmatched so it can be proposed again.
Optional note is stored for the accountant UI.`,
    {
      proposal_id: z.number().int().positive().describe("Id returned by propose_match"),
      note: z.string().optional().describe("Optional manager note"),
    },
    async (args) => {
      try {
        const result = await rejectMatch({
          proposalId: args.proposal_id,
          note: args.note,
        });
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "approve_match",
    `Apply a pending match proposal AFTER the manager confirms via an interactive form.
The AI cannot confirm for the manager. Money moves only when the manager accepts.
Safe to retry: a second approve for an already-applied proposal does not double-apply.
Rejects transfers above the loan's total outstanding.`,
    {
      proposal_id: z.number().int().positive().describe("Id returned by propose_match"),
    },
    async (args) => {
      try {
        const preview = await loadApprovalPreview(args.proposal_id);

        if (preview.already_approved && preview.payment_id) {
          return textResult({
            status: "approved",
            message: "Proposal was already approved; payment was not applied again.",
            proposal_id: preview.proposal_id,
            bank_txn_id: preview.bank_txn_id,
            loan_no: preview.loan_no,
            payment_id: preview.payment_id,
            amount: preview.amount,
            amount_due: preview.amount_due,
            difference: preview.difference,
            idempotent: true,
          });
        }

        if (preview.amount > preview.total_outstanding) {
          return errorResult(
            new DomainError(
              `Transfer amount ${preview.amount} exceeds total outstanding ${preview.total_outstanding} on loan ${preview.loan_no}`,
              "amount_exceeds_outstanding"
            )
          );
        }

        // Build confirmation form from DB only (not tool args) so the AI cannot word it.
        let elicitResult: { action: string; content?: Record<string, unknown> };
        try {
          elicitResult = await server.server.elicitInput({
            mode: "form",
            message:
              "Confirm applying this bank transfer to the loan. Accept only if the match is correct.",
            requestedSchema: {
              type: "object",
              properties: {
                summary: {
                  type: "string",
                  title: "Payment to apply",
                  description: [
                    `Transaction: ${preview.bank_txn_id}`,
                    `Date: ${preview.value_date}`,
                    `Amount: ${preview.amount.toLocaleString("en-US")} ${"MNT"}`,
                    `Payer: ${preview.payer_name}`,
                    `Description: ${preview.description}`,
                    `Loan: ${preview.loan_no}`,
                    `Customer: ${preview.customer_name} / ${preview.customer_name_mn}`,
                    `Amount due (${preview.amount_due_source}): ${preview.amount_due.toLocaleString("en-US")} MNT`,
                    `Difference (transfer − due): ${preview.difference.toLocaleString("en-US")} MNT`,
                    `Total outstanding: ${preview.total_outstanding.toLocaleString("en-US")} MNT`,
                  ].join("\n"),
                  default: "Review the details above, then accept or decline.",
                },
              },
              required: [],
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return textResult({
            status: "not_applied",
            reason: "elicitation_unavailable",
            message:
              "Could not show the manager confirmation form (client may not support elicitation). Payment was not applied.",
            detail: message,
            proposal_id: preview.proposal_id,
          });
        }

        if (elicitResult.action === "accept") {
          const applied = await applyApprovedMatch(args.proposal_id);
          return textResult({
            ...applied,
            message: applied.idempotent
              ? "Proposal was already approved; payment was not applied again."
              : "Manager confirmed; payment applied.",
          });
        }

        if (elicitResult.action === "decline") {
          return textResult({
            status: "not_applied",
            reason: "manager_declined",
            message: "Manager declined confirmation. Payment was not applied. Proposal remains pending.",
            proposal_id: preview.proposal_id,
            bank_txn_id: preview.bank_txn_id,
          });
        }

        return textResult({
          status: "not_applied",
          reason: "manager_cancelled",
          message: "Manager cancelled confirmation. Payment was not applied. Proposal remains pending.",
          proposal_id: preview.proposal_id,
          bank_txn_id: preview.bank_txn_id,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

const sessions = new Map<string, Session>();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
  } catch (err) {
    console.error("MCP POST error", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const handleSessionRequest = async (
  req: express.Request,
  res: express.Response
) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const session = sessions.get(sessionId)!;
  await session.transport.handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const port = Number(process.env.MCP_PORT ?? 3001);
const host = process.env.MCP_HOST ?? "0.0.0.0";

app.listen(port, host, () => {
  console.log(`MCP Streamable HTTP listening on http://${host}:${port}/mcp`);
});
