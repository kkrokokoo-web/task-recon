import type { Db } from "./db.js";
import { accountantName, managerName, withTransaction } from "./db.js";
import { CsvParseError, parseStatementCsv, type ParsedStatementRow } from "./csv.js";
import { createHash } from "node:crypto";

/** Prefer SQL `date::text`; fall back without local-timezone day shift. */
function asDateText(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string = "domain_error"
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export type ProgressCounts = {
  total: number;
  applied: number;
  left_unmatched: number;
  pending: number;
  waiting: number; // same as pending — needs manager decision on a proposal
  unmatched: number; // still needs a decision
};

export type TxnOutcome =
  | {
      status: "applied";
      loan_no: string;
      amount_due: number;
      difference: number;
      payment_id: number;
      proposal_id: number;
    }
  | {
      status: "pending";
      loan_no: string;
      reason: string;
      proposal_id: number;
      amount_due: number;
      difference: number;
    }
  | {
      status: "rejected";
      loan_no: string;
      manager_note: string | null;
      proposal_id: number;
    }
  | {
      status: "left_unmatched";
      reason: string;
    }
  | {
      status: "unmatched";
    };

async function writeAudit(
  db: Db,
  actor: string,
  action: string,
  bankTxnId: string | null,
  details: Record<string, unknown> = {}
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor, action, bank_txn_id, details)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [actor, action, bankTxnId, JSON.stringify(details)]
  );
}

export async function getAmountDue(
  db: Db,
  loanNo: string,
  valueDate: string
): Promise<{ amountDue: number; source: "overdue" | "next_installment"; totalOutstanding: number }> {
  const overdueRes = await db.query<{ overdue: string }>(
    `SELECT loan_overdue($1, ($2::date + 1)) AS overdue`,
    [loanNo, valueDate]
  );
  const overdue = Number(overdueRes.rows[0]?.overdue ?? 0);

  const balRes = await db.query<{ total_outstanding: string }>(
    `SELECT total_outstanding FROM loan_balances WHERE loan_no = $1`,
    [loanNo]
  );
  if (balRes.rowCount === 0) {
    throw new DomainError(`Loan ${loanNo} not found`, "loan_not_found");
  }
  const totalOutstanding = Number(balRes.rows[0].total_outstanding);

  if (overdue > 0) {
    return { amountDue: overdue, source: "overdue", totalOutstanding };
  }

  const nextRes = await db.query<{ amount_remaining: string }>(
    `SELECT amount_remaining FROM loan_next_installment($1)`,
    [loanNo]
  );
  const amountDue = Number(nextRes.rows[0]?.amount_remaining ?? 0);
  return { amountDue, source: "next_installment", totalOutstanding };
}

export async function importStatement(
  filename: string,
  content: string | Buffer
): Promise<{
  statementId: number;
  filename: string;
  transactionCount: number;
  duplicate: boolean;
}> {
  const text = typeof content === "string" ? content : content.toString("utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  const actor = accountantName();

  return withTransaction(async (db) => {
    const existing = await db.query<{ id: number; filename: string }>(
      `SELECT id, filename FROM bank_statements WHERE content_sha256 = $1`,
      [sha256]
    );
    if (existing.rowCount && existing.rows[0]) {
      const countRes = await db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM bank_transactions WHERE statement_id = $1`,
        [existing.rows[0].id]
      );
      return {
        statementId: existing.rows[0].id,
        filename: existing.rows[0].filename,
        transactionCount: Number(countRes.rows[0].c),
        duplicate: true,
      };
    }

    let rows: ParsedStatementRow[];
    try {
      rows = parseStatementCsv(text);
    } catch (err) {
      if (err instanceof CsvParseError) {
        throw new DomainError(err.message, "csv_parse_error");
      }
      throw err;
    }

    const ins = await db.query<{ id: number }>(
      `INSERT INTO bank_statements (filename, content_sha256, uploaded_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [filename, sha256, actor]
    );
    const statementId = ins.rows[0].id;

    for (const row of rows) {
      try {
        await db.query(
          `INSERT INTO bank_transactions
             (bank_txn_id, statement_id, value_date, amount, currency, payer_name, description)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7)`,
          [
            row.bankTxnId,
            statementId,
            row.valueDate,
            row.amount,
            row.currency,
            row.payerName,
            row.description,
          ]
        );
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === "23505") {
          throw new DomainError(
            `bank_txn_id ${row.bankTxnId} already exists from another statement`,
            "duplicate_txn"
          );
        }
        throw err;
      }
    }

    await writeAudit(db, actor, "statement_uploaded", null, {
      statement_id: statementId,
      filename,
      transaction_count: rows.length,
    });

    return {
      statementId,
      filename,
      transactionCount: rows.length,
      duplicate: false,
    };
  });
}

export async function createReconcileRequest(statementId: number): Promise<{
  requestId: number;
  status: string;
  alreadyExists: boolean;
}> {
  const actor = accountantName();
  return withTransaction(async (db) => {
    const stmt = await db.query(`SELECT id FROM bank_statements WHERE id = $1`, [
      statementId,
    ]);
    if (!stmt.rowCount) {
      throw new DomainError(`Statement ${statementId} not found`, "not_found");
    }

    const existing = await db.query<{ id: number; status: string }>(
      `SELECT id, status FROM reconcile_requests WHERE statement_id = $1`,
      [statementId]
    );
    if (existing.rowCount && existing.rows[0]) {
      return {
        requestId: existing.rows[0].id,
        status: existing.rows[0].status,
        alreadyExists: true,
      };
    }

    const ins = await db.query<{ id: number; status: string }>(
      `INSERT INTO reconcile_requests (statement_id, created_by)
       VALUES ($1, $2) RETURNING id, status`,
      [statementId, actor]
    );

    await writeAudit(db, actor, "reconcile_requested", null, {
      request_id: ins.rows[0].id,
      statement_id: statementId,
    });

    return {
      requestId: ins.rows[0].id,
      status: ins.rows[0].status,
      alreadyExists: false,
    };
  });
}

async function progressForRequest(db: Db, requestId: number): Promise<ProgressCounts> {
  const res = await db.query<{
    total: string;
    applied: string;
    left_unmatched: string;
    pending: string;
    unmatched: string;
  }>(
    `
    WITH txns AS (
      SELECT t.bank_txn_id
      FROM bank_transactions t
      JOIN reconcile_requests r ON r.statement_id = t.statement_id
      WHERE r.id = $1
    )
    SELECT
      (SELECT count(*) FROM txns)::text AS total,
      (SELECT count(*) FROM txns t
         JOIN match_proposals p ON p.bank_txn_id = t.bank_txn_id AND p.status = 'approved'
      )::text AS applied,
      (SELECT count(*) FROM txns t
         JOIN unmatched_decisions u ON u.bank_txn_id = t.bank_txn_id
      )::text AS left_unmatched,
      (SELECT count(*) FROM txns t
         JOIN match_proposals p ON p.bank_txn_id = t.bank_txn_id AND p.status = 'pending'
      )::text AS pending,
      (SELECT count(*) FROM txns t
         WHERE NOT EXISTS (
           SELECT 1 FROM match_proposals p
           WHERE p.bank_txn_id = t.bank_txn_id AND p.status IN ('pending', 'approved')
         )
         AND NOT EXISTS (
           SELECT 1 FROM unmatched_decisions u WHERE u.bank_txn_id = t.bank_txn_id
         )
      )::text AS unmatched
    `,
    [requestId]
  );
  const row = res.rows[0];
  const pending = Number(row.pending);
  return {
    total: Number(row.total),
    applied: Number(row.applied),
    left_unmatched: Number(row.left_unmatched),
    pending,
    waiting: pending,
    unmatched: Number(row.unmatched),
  };
}

export async function maybeCompleteRequest(db: Db, requestId: number): Promise<void> {
  const progress = await progressForRequest(db, requestId);
  if (progress.total > 0 && progress.unmatched === 0 && progress.pending === 0) {
    await db.query(
      `UPDATE reconcile_requests SET status = 'done' WHERE id = $1 AND status = 'open'`,
      [requestId]
    );
  }
}

async function requestIdForTxn(db: Db, bankTxnId: string): Promise<number | null> {
  const res = await db.query<{ id: number }>(
    `SELECT r.id
     FROM reconcile_requests r
     JOIN bank_transactions t ON t.statement_id = r.statement_id
     WHERE t.bank_txn_id = $1`,
    [bankTxnId]
  );
  return res.rows[0]?.id ?? null;
}

export async function listReconcileRequests(opts?: {
  includeDone?: boolean;
  limit?: number;
  offset?: number;
}): Promise<
  Array<{
    id: number;
    statement_id: number;
    filename: string;
    status: string;
    created_at: string;
    created_by: string;
    progress: ProgressCounts;
  }>
> {
  const limit = Math.min(opts?.limit ?? 50, 100);
  const offset = opts?.offset ?? 0;
  const includeDone = opts?.includeDone ?? true;
  const db = (await import("./db.js")).getPool();

  const res = await db.query<{
    id: number;
    statement_id: number;
    filename: string;
    status: string;
    created_at: Date;
    created_by: string;
  }>(
    `SELECT r.id, r.statement_id, s.filename, r.status, r.created_at, r.created_by
     FROM reconcile_requests r
     JOIN bank_statements s ON s.id = r.statement_id
     WHERE ($1::boolean OR r.status = 'open')
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [includeDone, limit, offset]
  );

  const out = [];
  for (const row of res.rows) {
    const progress = await progressForRequest(db, row.id);
    out.push({
      id: row.id,
      statement_id: row.statement_id,
      filename: row.filename,
      status: row.status,
      created_at: row.created_at.toISOString(),
      created_by: row.created_by,
      progress,
    });
  }
  return out;
}

export async function getTxnOutcome(db: Db, bankTxnId: string): Promise<TxnOutcome> {
    const approved = await db.query<{
    id: number;
    loan_no: string;
    payment_id: number;
    value_date: string;
    amount: string;
  }>(
    `SELECT p.id, p.loan_no, p.payment_id, t.value_date::text, t.amount::text
     FROM match_proposals p
     JOIN bank_transactions t ON t.bank_txn_id = p.bank_txn_id
     WHERE p.bank_txn_id = $1 AND p.status = 'approved'
     LIMIT 1`,
    [bankTxnId]
  );
  if (approved.rowCount && approved.rows[0]) {
    const a = approved.rows[0];
    const valueDate = asDateText(a.value_date);
    const { amountDue } = await getAmountDue(db, a.loan_no, valueDate);
    // After payment, amount due reflects post-payment state; show difference at apply time
    // using payment amount vs due-before would need snapshot. We store difference in audit;
    // for UI, recompute as payment.amount - due_at_value_date is wrong post-apply.
    // Use payment amount vs amount that was due: fetch from payments + recompute overdue
    // as if payment weren't applied is hard. Simpler: store amount_due_at_approval on proposal.
    // For now compute difference as amount - current amountDue is misleading.
    // We'll add amount_due_snapshot column... Plan didn't have it. Use audit or recompute
    // from loan_overdue with the value date — but installments already paid.
    // Best fix: add columns. Quick fix without migration change mid-flight:
    // read details from latest approve audit.
    const audit = await db.query<{ details: { amount_due?: number; difference?: number } }>(
      `SELECT details FROM audit_log
       WHERE bank_txn_id = $1 AND action = 'match_approved'
       ORDER BY at DESC LIMIT 1`,
      [bankTxnId]
    );
    const amount = Number(a.amount);
    const amountDueSnap = audit.rows[0]?.details?.amount_due ?? amountDue;
    const difference =
      audit.rows[0]?.details?.difference ?? amount - amountDueSnap;
    return {
      status: "applied",
      loan_no: a.loan_no,
      amount_due: amountDueSnap,
      difference,
      payment_id: a.payment_id,
      proposal_id: a.id,
    };
  }

  const pending = await db.query<{
    id: number;
    loan_no: string;
    reason: string;
    value_date: string;
    amount: string;
  }>(
    `SELECT p.id, p.loan_no, p.reason, t.value_date::text, t.amount::text
     FROM match_proposals p
     JOIN bank_transactions t ON t.bank_txn_id = p.bank_txn_id
     WHERE p.bank_txn_id = $1 AND p.status = 'pending'
     LIMIT 1`,
    [bankTxnId]
  );
  if (pending.rowCount && pending.rows[0]) {
    const p = pending.rows[0];
    const valueDate = asDateText(p.value_date);
    const { amountDue } = await getAmountDue(db, p.loan_no, valueDate);
    const amount = Number(p.amount);
    return {
      status: "pending",
      loan_no: p.loan_no,
      reason: p.reason,
      proposal_id: p.id,
      amount_due: amountDue,
      difference: amount - amountDue,
    };
  }

  const left = await db.query<{ reason: string }>(
    `SELECT reason FROM unmatched_decisions WHERE bank_txn_id = $1`,
    [bankTxnId]
  );
  if (left.rowCount && left.rows[0]) {
    return { status: "left_unmatched", reason: left.rows[0].reason };
  }

  const rejected = await db.query<{
    id: number;
    loan_no: string;
    manager_note: string | null;
  }>(
    `SELECT id, loan_no, manager_note FROM match_proposals
     WHERE bank_txn_id = $1 AND status = 'rejected'
     ORDER BY resolved_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [bankTxnId]
  );
  // Only show rejected if there's no newer pending/approved (already handled)
  // and txn is still unmatched — show last rejection note for UI
  if (rejected.rowCount && rejected.rows[0]) {
    // Still unmatched for decision purposes, but UI wants to see rejection
    // Spec: "rejected with the manager's note" as an outcome. If returned to unmatched,
    // it can be proposed again. Show as unmatched for MCP list, but for accountant
    // include last rejection info when unmatched.
    return {
      status: "rejected",
      loan_no: rejected.rows[0].loan_no,
      manager_note: rejected.rows[0].manager_note,
      proposal_id: rejected.rows[0].id,
    };
  }

  return { status: "unmatched" };
}

export async function getReconcileRequestDetail(requestId: number) {
  const db = (await import("./db.js")).getPool();
  const req = await db.query<{
    id: number;
    statement_id: number;
    filename: string;
    status: string;
    created_at: Date;
    created_by: string;
  }>(
    `SELECT r.id, r.statement_id, s.filename, r.status, r.created_at, r.created_by
     FROM reconcile_requests r
     JOIN bank_statements s ON s.id = r.statement_id
     WHERE r.id = $1`,
    [requestId]
  );
  if (!req.rowCount) {
    throw new DomainError(`Reconcile request ${requestId} not found`, "not_found");
  }
  const row = req.rows[0];
  const progress = await progressForRequest(db, requestId);

  const txns = await db.query<{
    bank_txn_id: string;
    value_date: string;
    amount: string;
    currency: string;
    payer_name: string;
    description: string;
  }>(
    `SELECT bank_txn_id, value_date::text, amount::text, currency, payer_name, description
     FROM bank_transactions WHERE statement_id = $1
     ORDER BY bank_txn_id`,
    [row.statement_id]
  );

  const transfers = [];
  for (const t of txns.rows) {
    const outcome = await getTxnOutcome(db, t.bank_txn_id);
    transfers.push({
      bank_txn_id: t.bank_txn_id,
      value_date: asDateText(t.value_date),
      amount: Number(t.amount),
      currency: t.currency,
      payer_name: t.payer_name,
      description: t.description,
      outcome,
    });
  }

  return {
    id: row.id,
    statement_id: row.statement_id,
    filename: row.filename,
    status: row.status,
    created_at: row.created_at.toISOString(),
    created_by: row.created_by,
    progress,
    transfers,
  };
}

/** Outcome for MCP unmatched list: only truly needing a decision. */
export async function isAwaitingDecision(db: Db, bankTxnId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 WHERE
       NOT EXISTS (
         SELECT 1 FROM match_proposals p
         WHERE p.bank_txn_id = $1 AND p.status IN ('pending', 'approved')
       )
       AND NOT EXISTS (
         SELECT 1 FROM unmatched_decisions u WHERE u.bank_txn_id = $1
       )`,
    [bankTxnId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listUnmatchedTransactions(opts: {
  requestId?: number;
  valueDate?: string;
  limit?: number;
  offset?: number;
}) {
  const db = (await import("./db.js")).getPool();
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = opts.offset ?? 0;

  const res = await db.query<{
    bank_txn_id: string;
    value_date: string;
    amount: string;
    currency: string;
    payer_name: string;
    description: string;
    request_id: number;
  }>(
    `
    SELECT t.bank_txn_id, t.value_date::text, t.amount::text, t.currency,
           t.payer_name, t.description, r.id AS request_id
    FROM bank_transactions t
    JOIN reconcile_requests r ON r.statement_id = t.statement_id
    WHERE r.status = 'open'
      AND ($1::int IS NULL OR r.id = $1)
      AND ($2::date IS NULL OR t.value_date = $2::date)
      AND NOT EXISTS (
        SELECT 1 FROM match_proposals p
        WHERE p.bank_txn_id = t.bank_txn_id AND p.status IN ('pending', 'approved')
      )
      AND NOT EXISTS (
        SELECT 1 FROM unmatched_decisions u WHERE u.bank_txn_id = t.bank_txn_id
      )
    ORDER BY t.value_date, t.bank_txn_id
    LIMIT $3 OFFSET $4
    `,
    [opts.requestId ?? null, opts.valueDate ?? null, limit, offset]
  );

  return res.rows.map((t) => ({
    bank_txn_id: t.bank_txn_id,
    value_date: asDateText(t.value_date),
    amount: Number(t.amount),
    currency: t.currency,
    payer_name: t.payer_name,
    description: t.description,
    request_id: t.request_id,
  }));
}

export async function searchLoans(opts: {
  query: string;
  asOf?: string;
  limit?: number;
  offset?: number;
}) {
  const db = (await import("./db.js")).getPool();
  const limit = Math.min(opts.limit ?? 25, 50);
  const offset = opts.offset ?? 0;
  const q = opts.query.trim();
  if (!q) {
    throw new DomainError("query is required", "invalid_input");
  }

  const like = `%${q}%`;
  const res = await db.query<{
    loan_no: string;
    status: string;
    customer_no: string;
    first_name: string;
    last_name: string;
    first_name_mn: string;
    last_name_mn: string;
    phone: string;
    total_outstanding: string;
  }>(
    `
    SELECT l.loan_no, l.status, c.customer_no,
           c.first_name, c.last_name, c.first_name_mn, c.last_name_mn, c.phone,
           b.total_outstanding::text
    FROM loans l
    JOIN customers c ON c.id = l.customer_id
    JOIN loan_balances b ON b.loan_id = l.id
    WHERE l.loan_no ILIKE $1
       OR c.phone LIKE $1
       OR (c.first_name || ' ' || c.last_name) ILIKE $1
       OR (c.last_name || ' ' || c.first_name) ILIKE $1
       OR (c.first_name_mn || ' ' || c.last_name_mn) ILIKE $1
       OR (c.last_name_mn || ' ' || c.first_name_mn) ILIKE $1
       OR c.first_name ILIKE $1 OR c.last_name ILIKE $1
       OR c.first_name_mn ILIKE $1 OR c.last_name_mn ILIKE $1
    ORDER BY l.loan_no
    LIMIT $2 OFFSET $3
    `,
    [like, limit, offset]
  );

  const asOf = opts.asOf;
  const results = [];
  for (const row of res.rows) {
    let amount_due: number | null = null;
    let amount_due_source: string | null = null;
    if (asOf) {
      const due = await getAmountDue(db, row.loan_no, asOf);
      amount_due = due.amountDue;
      amount_due_source = due.source;
    }
    results.push({
      loan_no: row.loan_no,
      status: row.status,
      customer_no: row.customer_no,
      customer_name: `${row.first_name} ${row.last_name}`,
      customer_name_mn: `${row.first_name_mn} ${row.last_name_mn}`,
      phone: row.phone,
      total_outstanding: Number(row.total_outstanding),
      amount_due,
      amount_due_source,
      // deliberately omit register_no
    });
  }
  return { results, limit, offset };
}

export async function proposeMatch(input: {
  bankTxnId: string;
  loanNo: string;
  reason: string;
}) {
  const actor = managerName();
  return withTransaction(async (db) => {
    const txn = await db.query<{
      bank_txn_id: string;
      value_date: string;
      amount: string;
    }>(
      `SELECT bank_txn_id, value_date::text, amount::text FROM bank_transactions WHERE bank_txn_id = $1`,
      [input.bankTxnId]
    );
    if (!txn.rowCount) {
      throw new DomainError(`Transaction ${input.bankTxnId} not found`, "not_found");
    }

    const reqId = await requestIdForTxn(db, input.bankTxnId);
    if (reqId == null) {
      throw new DomainError(
        `Transaction ${input.bankTxnId} is not part of a reconcile request`,
        "not_in_request"
      );
    }

    const left = await db.query(
      `SELECT 1 FROM unmatched_decisions WHERE bank_txn_id = $1`,
      [input.bankTxnId]
    );
    if (left.rowCount) {
      throw new DomainError(
        `Transaction ${input.bankTxnId} was left unmatched and cannot receive a proposal`,
        "already_left_unmatched"
      );
    }

    const active = await db.query<{ status: string }>(
      `SELECT status FROM match_proposals
       WHERE bank_txn_id = $1 AND status IN ('pending', 'approved')`,
      [input.bankTxnId]
    );
    if (active.rowCount && active.rows[0]) {
      throw new DomainError(
        `Transaction ${input.bankTxnId} already has a ${active.rows[0].status} match proposal`,
        "already_matched"
      );
    }

    const loan = await db.query(`SELECT loan_no, status FROM loans WHERE loan_no = $1`, [
      input.loanNo,
    ]);
    if (!loan.rowCount) {
      throw new DomainError(`Loan ${input.loanNo} not found`, "loan_not_found");
    }

    const ins = await db.query<{ id: number }>(
      `INSERT INTO match_proposals (bank_txn_id, loan_no, reason, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [input.bankTxnId, input.loanNo, input.reason]
    );

    const valueDate = asDateText(txn.rows[0].value_date);
    const amount = Number(txn.rows[0].amount);
    const { amountDue, totalOutstanding } = await getAmountDue(db, input.loanNo, valueDate);

    await writeAudit(db, actor, "match_proposed", input.bankTxnId, {
      proposal_id: ins.rows[0].id,
      loan_no: input.loanNo,
      reason: input.reason,
      amount,
      amount_due: amountDue,
      difference: amount - amountDue,
      total_outstanding: totalOutstanding,
    });

    return {
      proposal_id: ins.rows[0].id,
      bank_txn_id: input.bankTxnId,
      loan_no: input.loanNo,
      status: "pending" as const,
      amount,
      amount_due: amountDue,
      difference: amount - amountDue,
      total_outstanding: totalOutstanding,
    };
  });
}

export async function leaveUnmatched(input: { bankTxnId: string; reason: string }) {
  const actor = managerName();
  return withTransaction(async (db) => {
    const txn = await db.query(
      `SELECT bank_txn_id FROM bank_transactions WHERE bank_txn_id = $1`,
      [input.bankTxnId]
    );
    if (!txn.rowCount) {
      throw new DomainError(`Transaction ${input.bankTxnId} not found`, "not_found");
    }

    const reqId = await requestIdForTxn(db, input.bankTxnId);
    if (reqId == null) {
      throw new DomainError(
        `Transaction ${input.bankTxnId} is not part of a reconcile request`,
        "not_in_request"
      );
    }

    const active = await db.query<{ status: string }>(
      `SELECT status FROM match_proposals
       WHERE bank_txn_id = $1 AND status IN ('pending', 'approved')`,
      [input.bankTxnId]
    );
    if (active.rowCount) {
      throw new DomainError(
        `Cannot leave unmatched: transaction has a ${active.rows[0].status} proposal`,
        "has_active_proposal"
      );
    }

    const existing = await db.query(
      `SELECT 1 FROM unmatched_decisions WHERE bank_txn_id = $1`,
      [input.bankTxnId]
    );
    if (existing.rowCount) {
      throw new DomainError(
        `Transaction ${input.bankTxnId} is already left unmatched`,
        "already_left_unmatched"
      );
    }

    await db.query(
      `INSERT INTO unmatched_decisions (bank_txn_id, reason, actor)
       VALUES ($1, $2, $3)`,
      [input.bankTxnId, input.reason, actor]
    );

    await writeAudit(db, actor, "left_unmatched", input.bankTxnId, {
      reason: input.reason,
    });

    await maybeCompleteRequest(db, reqId);

    return { bank_txn_id: input.bankTxnId, status: "left_unmatched" as const, reason: input.reason };
  });
}

export async function rejectMatch(input: {
  proposalId: number;
  note?: string;
}) {
  const actor = managerName();
  return withTransaction(async (db) => {
    const prop = await db.query<{
      id: number;
      bank_txn_id: string;
      loan_no: string;
      status: string;
    }>(`SELECT id, bank_txn_id, loan_no, status FROM match_proposals WHERE id = $1 FOR UPDATE`, [
      input.proposalId,
    ]);
    if (!prop.rowCount) {
      throw new DomainError(`Proposal ${input.proposalId} not found`, "not_found");
    }
    const p = prop.rows[0];
    if (p.status !== "pending") {
      throw new DomainError(
        `Proposal ${input.proposalId} is ${p.status}, not pending`,
        "not_pending"
      );
    }

    await db.query(
      `UPDATE match_proposals
       SET status = 'rejected', resolved_at = now(), manager_note = $2
       WHERE id = $1`,
      [input.proposalId, input.note ?? null]
    );

    await writeAudit(db, actor, "match_rejected", p.bank_txn_id, {
      proposal_id: p.id,
      loan_no: p.loan_no,
      note: input.note ?? null,
    });

    return {
      proposal_id: p.id,
      bank_txn_id: p.bank_txn_id,
      status: "rejected" as const,
      note: input.note ?? null,
    };
  });
}

export type ApprovalPreview = {
  proposal_id: number;
  bank_txn_id: string;
  value_date: string;
  amount: number;
  payer_name: string;
  description: string;
  loan_no: string;
  customer_name: string;
  customer_name_mn: string;
  amount_due: number;
  amount_due_source: string;
  difference: number;
  total_outstanding: number;
  already_approved: boolean;
  payment_id: number | null;
};

export async function loadApprovalPreview(proposalId: number): Promise<ApprovalPreview> {
  const db = (await import("./db.js")).getPool();
  const res = await db.query<{
    id: number;
    bank_txn_id: string;
    loan_no: string;
    status: string;
    payment_id: number | null;
    value_date: string;
    amount: string;
    payer_name: string;
    description: string;
    first_name: string;
    last_name: string;
    first_name_mn: string;
    last_name_mn: string;
  }>(
    `
    SELECT p.id, p.bank_txn_id, p.loan_no, p.status, p.payment_id,
           t.value_date::text, t.amount::text, t.payer_name, t.description,
           c.first_name, c.last_name, c.first_name_mn, c.last_name_mn
    FROM match_proposals p
    JOIN bank_transactions t ON t.bank_txn_id = p.bank_txn_id
    JOIN loans l ON l.loan_no = p.loan_no
    JOIN customers c ON c.id = l.customer_id
    WHERE p.id = $1
    `,
    [proposalId]
  );
  if (!res.rowCount) {
    throw new DomainError(`Proposal ${proposalId} not found`, "not_found");
  }
  const row = res.rows[0];
  const valueDate = asDateText(row.value_date);
  const amount = Number(row.amount);

  if (row.status === "approved" && row.payment_id) {
    const audit = await db.query<{ details: { amount_due?: number; difference?: number; amount_due_source?: string; total_outstanding?: number } }>(
      `SELECT details FROM audit_log
       WHERE bank_txn_id = $1 AND action = 'match_approved'
       ORDER BY at DESC LIMIT 1`,
      [row.bank_txn_id]
    );
    return {
      proposal_id: row.id,
      bank_txn_id: row.bank_txn_id,
      value_date: valueDate,
      amount,
      payer_name: row.payer_name,
      description: row.description,
      loan_no: row.loan_no,
      customer_name: `${row.first_name} ${row.last_name}`,
      customer_name_mn: `${row.first_name_mn} ${row.last_name_mn}`,
      amount_due: audit.rows[0]?.details?.amount_due ?? 0,
      amount_due_source: audit.rows[0]?.details?.amount_due_source ?? "overdue",
      difference: audit.rows[0]?.details?.difference ?? 0,
      total_outstanding: audit.rows[0]?.details?.total_outstanding ?? 0,
      already_approved: true,
      payment_id: row.payment_id,
    };
  }

  if (row.status !== "pending") {
    throw new DomainError(
      `Proposal ${proposalId} is ${row.status}, not pending`,
      "not_pending"
    );
  }

  const { amountDue, source, totalOutstanding } = await getAmountDue(
    db,
    row.loan_no,
    valueDate
  );

  return {
    proposal_id: row.id,
    bank_txn_id: row.bank_txn_id,
    value_date: valueDate,
    amount,
    payer_name: row.payer_name,
    description: row.description,
    loan_no: row.loan_no,
    customer_name: `${row.first_name} ${row.last_name}`,
    customer_name_mn: `${row.first_name_mn} ${row.last_name_mn}`,
    amount_due: amountDue,
    amount_due_source: source,
    difference: amount - amountDue,
    total_outstanding: totalOutstanding,
    already_approved: false,
    payment_id: null,
  };
}

/**
 * Apply a pending proposal after the manager has confirmed via elicitation.
 * Idempotent: repeating approve on an already-approved proposal returns success.
 */
export async function applyApprovedMatch(proposalId: number): Promise<{
  proposal_id: number;
  bank_txn_id: string;
  loan_no: string;
  payment_id: number;
  status: "approved";
  amount: number;
  amount_due: number;
  difference: number;
  idempotent: boolean;
}> {
  const actor = managerName();
  return withTransaction(async (db) => {
    const prop = await db.query<{
      id: number;
      bank_txn_id: string;
      loan_no: string;
      status: string;
      payment_id: number | null;
    }>(
      `SELECT id, bank_txn_id, loan_no, status, payment_id
       FROM match_proposals WHERE id = $1 FOR UPDATE`,
      [proposalId]
    );
    if (!prop.rowCount) {
      throw new DomainError(`Proposal ${proposalId} not found`, "not_found");
    }
    const p = prop.rows[0];

    if (p.status === "approved" && p.payment_id) {
      const audit = await db.query<{
        details: { amount?: number; amount_due?: number; difference?: number };
      }>(
        `SELECT details FROM audit_log
         WHERE bank_txn_id = $1 AND action = 'match_approved'
         ORDER BY at DESC LIMIT 1`,
        [p.bank_txn_id]
      );
      return {
        proposal_id: p.id,
        bank_txn_id: p.bank_txn_id,
        loan_no: p.loan_no,
        payment_id: p.payment_id,
        status: "approved" as const,
        amount: audit.rows[0]?.details?.amount ?? 0,
        amount_due: audit.rows[0]?.details?.amount_due ?? 0,
        difference: audit.rows[0]?.details?.difference ?? 0,
        idempotent: true,
      };
    }

    if (p.status !== "pending") {
      throw new DomainError(
        `Proposal ${proposalId} is ${p.status}, not pending`,
        "not_pending"
      );
    }

    const txn = await db.query<{
      value_date: string;
      amount: string;
    }>(
      `SELECT value_date::text, amount::text FROM bank_transactions WHERE bank_txn_id = $1`,
      [p.bank_txn_id]
    );
    const valueDate = asDateText(txn.rows[0].value_date);
    const amount = Number(txn.rows[0].amount);
    const { amountDue, source, totalOutstanding } = await getAmountDue(
      db,
      p.loan_no,
      valueDate
    );

    if (amount > totalOutstanding) {
      throw new DomainError(
        `Transfer amount ${amount} exceeds total outstanding ${totalOutstanding} on loan ${p.loan_no}`,
        "amount_exceeds_outstanding"
      );
    }

    let paymentId: number;
    try {
      const pay = await db.query<{ apply_payment: number }>(
        `SELECT apply_payment($1, $2::bigint, $3::date) AS apply_payment`,
        [p.loan_no, amount, valueDate]
      );
      paymentId = pay.rows[0].apply_payment;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DomainError(`apply_payment failed: ${msg}`, "apply_failed");
    }

    await db.query(
      `UPDATE match_proposals
       SET status = 'approved', resolved_at = now(), payment_id = $2
       WHERE id = $1`,
      [proposalId, paymentId]
    );

    const difference = amount - amountDue;
    await writeAudit(db, actor, "match_approved", p.bank_txn_id, {
      proposal_id: p.id,
      loan_no: p.loan_no,
      payment_id: paymentId,
      amount,
      amount_due: amountDue,
      amount_due_source: source,
      difference,
      total_outstanding: totalOutstanding,
      value_date: valueDate,
    });

    const reqId = await requestIdForTxn(db, p.bank_txn_id);
    if (reqId != null) await maybeCompleteRequest(db, reqId);

    return {
      proposal_id: p.id,
      bank_txn_id: p.bank_txn_id,
      loan_no: p.loan_no,
      payment_id: paymentId,
      status: "approved" as const,
      amount,
      amount_due: amountDue,
      difference,
      idempotent: false,
    };
  });
}

export async function listAuditLog(opts?: { limit?: number; offset?: number }) {
  const db = (await import("./db.js")).getPool();
  const limit = Math.min(opts?.limit ?? 100, 200);
  const offset = opts?.offset ?? 0;
  const res = await db.query<{
    id: number;
    at: Date;
    actor: string;
    action: string;
    bank_txn_id: string | null;
    details: unknown;
  }>(
    `SELECT id, at, actor, action, bank_txn_id, details
     FROM audit_log
     ORDER BY at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    actor: r.actor,
    action: r.action,
    bank_txn_id: r.bank_txn_id,
    details: r.details,
  }));
}

export async function listStatements() {
  const db = (await import("./db.js")).getPool();
  const res = await db.query<{
    id: number;
    filename: string;
    uploaded_at: Date;
    uploaded_by: string;
    txn_count: string;
    request_id: number | null;
    request_status: string | null;
  }>(
    `
    SELECT s.id, s.filename, s.uploaded_at, s.uploaded_by,
           (SELECT count(*)::text FROM bank_transactions t WHERE t.statement_id = s.id) AS txn_count,
           r.id AS request_id,
           r.status AS request_status
    FROM bank_statements s
    LEFT JOIN reconcile_requests r ON r.statement_id = s.id
    ORDER BY s.uploaded_at DESC
    `
  );
  return res.rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    uploaded_at: r.uploaded_at.toISOString(),
    uploaded_by: r.uploaded_by,
    transaction_count: Number(r.txn_count),
    reconcile_request_id: r.request_id,
    reconcile_status: r.request_status,
  }));
}
