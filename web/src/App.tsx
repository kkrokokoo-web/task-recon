import { useCallback, useEffect, useMemo, useState } from "react";

type Progress = {
  total: number;
  applied: number;
  left_unmatched: number;
  pending: number;
  waiting: number;
  unmatched: number;
};

type Statement = {
  id: number;
  filename: string;
  uploaded_at: string;
  uploaded_by: string;
  transaction_count: number;
  reconcile_request_id: number | null;
  reconcile_status: string | null;
};

type ReconcileRequest = {
  id: number;
  statement_id: number;
  filename: string;
  status: string;
  created_at: string;
  created_by: string;
  progress: Progress;
};

type Outcome =
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
  | { status: "left_unmatched"; reason: string }
  | { status: "unmatched" };

type Transfer = {
  bank_txn_id: string;
  value_date: string;
  amount: number;
  currency: string;
  payer_name: string;
  description: string;
  outcome: Outcome;
};

type RequestDetail = ReconcileRequest & { transfers: Transfer[] };

type AuditEntry = {
  id: number;
  at: string;
  actor: string;
  action: string;
  bank_txn_id: string | null;
  details: Record<string, unknown>;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body as T;
}

function fmtAmount(n: number) {
  return n.toLocaleString("en-US");
}

function outcomeLabel(o: Outcome): string {
  switch (o.status) {
    case "applied":
      return "Applied";
    case "pending":
      return "Waiting for manager";
    case "rejected":
      return "Rejected";
    case "left_unmatched":
      return "Left unmatched";
    default:
      return "Unmatched";
  }
}

function outcomeDetail(o: Outcome): string {
  switch (o.status) {
    case "applied":
      return `${o.loan_no} · due ${fmtAmount(o.amount_due)} · diff ${fmtAmount(o.difference)}`;
    case "pending":
      return `${o.loan_no} · ${o.reason}`;
    case "rejected":
      return `${o.loan_no}${o.manager_note ? ` · ${o.manager_note}` : ""}`;
    case "left_unmatched":
      return o.reason;
    default:
      return "Needs manager decision";
  }
}

export function App() {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [requests, setRequests] = useState<ReconcileRequest[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const hasOpen = useMemo(
    () => requests.some((r) => r.status === "open"),
    [requests]
  );

  const refresh = useCallback(async () => {
    try {
      const [stmts, reqs, logs] = await Promise.all([
        api<Statement[]>("/api/statements"),
        api<ReconcileRequest[]>("/api/reconcile-requests"),
        api<AuditEntry[]>("/api/audit-log?limit=80"),
      ]);
      setStatements(stmts);
      setRequests(reqs);
      setAudit(logs);
      setError(null);

      const nextSelected =
        selectedId && reqs.some((r) => r.id === selectedId)
          ? selectedId
          : reqs[0]?.id ?? null;
      if (nextSelected !== selectedId) {
        setSelectedId(nextSelected);
      }
      if (nextSelected) {
        const d = await api<RequestDetail>(`/api/reconcile-requests/${nextSelected}`);
        setDetail(d);
      } else {
        setDetail(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hasOpen) return;
    const id = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(id);
  }, [hasOpen, refresh]);

  async function onUpload() {
    if (!file) {
      setError("Choose a CSV statement first");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const uploaded = await api<{
        id: number;
        filename: string;
        transaction_count: number;
        duplicate: boolean;
      }>("/api/statements", { method: "POST", body: form });
      setMessage(
        uploaded.duplicate
          ? `File already imported as statement #${uploaded.id} (${uploaded.transaction_count} transfers).`
          : `Imported ${uploaded.filename}: ${uploaded.transaction_count} transfers (statement #${uploaded.id}).`
      );
      setFile(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSendReconcile(statementId: number) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api<{ id: number; status: string; already_exists: boolean }>(
        `/api/statements/${statementId}/reconcile`,
        { method: "POST" }
      );
      setMessage(
        res.already_exists
          ? `Reconcile request #${res.id} already exists (${res.status}).`
          : `Sent for reconciliation as request #${res.id}.`
      );
      setSelectedId(res.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectRequest(id: number) {
    setSelectedId(id);
    setBusy(true);
    try {
      const d = await api<RequestDetail>(`/api/reconcile-requests/${id}`);
      setDetail(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="header">
        <div>
          <h1>Recon</h1>
          <p>
            Accountant desk: upload daily bank statements, send them for
            reconciliation, and watch outcomes as the manager works in Claude Code.
          </p>
        </div>
        <div className="badge">read-only for money moves</div>
      </header>

      {error && <div className="error">{error}</div>}
      {message && <div className="ok">{message}</div>}

      <section className="panel">
        <div className="panel-head">
          <h2>Upload statement</h2>
        </div>
        <div className="row">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
          <button type="button" onClick={() => void onUpload()} disabled={busy || !file}>
            Upload CSV
          </button>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Re-uploading the same file does not create duplicate transfers.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Statements</h2>
          {loading && <span className="loading">Loading…</span>}
        </div>
        {statements.length === 0 ? (
          <p className="muted">No statements uploaded yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>File</th>
                <th>Transfers</th>
                <th>Reconcile</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id}</td>
                  <td>
                    {s.filename}
                    <div className="muted">{new Date(s.uploaded_at).toLocaleString()}</div>
                  </td>
                  <td>{s.transaction_count}</td>
                  <td>
                    {s.reconcile_request_id ? (
                      <span className={`pill ${s.reconcile_status ?? ""}`}>
                        #{s.reconcile_request_id} {s.reconcile_status}
                      </span>
                    ) : (
                      <span className="muted">Not sent</span>
                    )}
                  </td>
                  <td>
                    {!s.reconcile_request_id && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void onSendReconcile(s.id)}
                      >
                        Send for reconciliation
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="layout-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Reconcile requests</h2>
            {hasOpen && <span className="muted">Live · polling 2s</span>}
          </div>
          {requests.length === 0 ? (
            <p className="muted">No reconcile requests yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Progress</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr
                    key={r.id}
                    className={`clickable ${selectedId === r.id ? "selected" : ""}`}
                    onClick={() => void selectRequest(r.id)}
                  >
                    <td>
                      <span className="mono">#{r.id}</span> {r.filename}
                    </td>
                    <td>
                      <span className={`pill ${r.status}`}>{r.status}</span>
                    </td>
                    <td>
                      <div className="progress">
                        <span>{r.progress.applied}/{r.progress.total} applied</span>
                        <span>{r.progress.waiting} waiting</span>
                        <span>{r.progress.unmatched} unmatched</span>
                        <span>{r.progress.left_unmatched} left</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {detail && (
            <>
              <div className="panel-head" style={{ marginTop: 22 }}>
                <h2>Transfers · request #{detail.id}</h2>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Txn</th>
                    <th>Date / Amount</th>
                    <th>Payer</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.transfers.map((t) => (
                    <tr key={t.bank_txn_id}>
                      <td className="mono">{t.bank_txn_id}</td>
                      <td>
                        {t.value_date}
                        <div className="mono">
                          {fmtAmount(t.amount)} {t.currency}
                        </div>
                      </td>
                      <td>
                        {t.payer_name}
                        <div className="muted">{t.description}</div>
                      </td>
                      <td>
                        <span className={`pill ${t.outcome.status}`}>
                          {outcomeLabel(t.outcome)}
                        </span>
                        <div className="muted" style={{ marginTop: 4 }}>
                          {outcomeDetail(t.outcome)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Audit log</h2>
          </div>
          {audit.length === 0 ? (
            <p className="muted">No audit events yet.</p>
          ) : (
            <ul className="audit-list">
              {audit.map((a) => (
                <li key={a.id}>
                  <div className="meta">
                    {new Date(a.at).toLocaleString()} · {a.actor} · {a.action}
                    {a.bank_txn_id ? ` · ${a.bank_txn_id}` : ""}
                  </div>
                  <div>{summarizeAudit(a)}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function summarizeAudit(a: AuditEntry): string {
  const d = a.details || {};
  switch (a.action) {
    case "statement_uploaded":
      return `Uploaded ${String(d.filename ?? "")} (${String(d.transaction_count ?? "")} transfers)`;
    case "reconcile_requested":
      return `Request #${String(d.request_id ?? "")} created`;
    case "match_proposed":
      return `Proposed ${String(d.loan_no ?? "")}: ${String(d.reason ?? "")}`;
    case "match_approved":
      return `Approved ${String(d.loan_no ?? "")}, payment #${String(d.payment_id ?? "")}, diff ${String(d.difference ?? "")}`;
    case "match_rejected":
      return `Rejected ${String(d.loan_no ?? "")}${d.note ? `: ${String(d.note)}` : ""}`;
    case "left_unmatched":
      return `Left unmatched: ${String(d.reason ?? "")}`;
    default:
      return a.action;
  }
}
