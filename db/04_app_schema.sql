-- Application tables for payment reconciliation.
-- Does not modify the loan book schema in 01_schema.sql.

CREATE TABLE bank_statements (
    id              serial PRIMARY KEY,
    filename        text NOT NULL,
    content_sha256  text NOT NULL UNIQUE,
    uploaded_by     text NOT NULL,
    uploaded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_transactions (
    id              serial PRIMARY KEY,
    bank_txn_id     text NOT NULL UNIQUE,
    statement_id    int NOT NULL REFERENCES bank_statements(id),
    value_date      date NOT NULL,
    amount          bigint NOT NULL CHECK (amount > 0),
    currency        text NOT NULL,
    payer_name      text NOT NULL,
    description     text NOT NULL
);

CREATE INDEX ON bank_transactions (statement_id);
CREATE INDEX ON bank_transactions (value_date);

CREATE TABLE reconcile_requests (
    id              serial PRIMARY KEY,
    statement_id    int NOT NULL REFERENCES bank_statements(id),
    status          text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'done')),
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (statement_id)
);

CREATE TABLE match_proposals (
    id              serial PRIMARY KEY,
    bank_txn_id     text NOT NULL REFERENCES bank_transactions(bank_txn_id),
    loan_no         text NOT NULL,
    reason          text NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),
    proposed_at     timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz,
    manager_note    text,
    payment_id      int REFERENCES payments(id)
);

-- At most one pending or approved proposal per transfer.
CREATE UNIQUE INDEX match_proposals_active_txn
    ON match_proposals (bank_txn_id)
    WHERE status IN ('pending', 'approved');

CREATE INDEX ON match_proposals (bank_txn_id);
CREATE INDEX ON match_proposals (status);

CREATE TABLE unmatched_decisions (
    bank_txn_id     text PRIMARY KEY REFERENCES bank_transactions(bank_txn_id),
    reason          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    actor           text NOT NULL
);

CREATE TABLE audit_log (
    id              serial PRIMARY KEY,
    at              timestamptz NOT NULL DEFAULT now(),
    actor           text NOT NULL,
    action          text NOT NULL,
    bank_txn_id     text,
    details         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX ON audit_log (at DESC);
CREATE INDEX ON audit_log (bank_txn_id);
