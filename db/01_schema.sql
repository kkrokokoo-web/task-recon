-- Loan book for the reconciliation take-home.
-- All money is whole tögrög (MNT) stored as bigint. Dates are business dates.
--
-- Installment rule used to build every schedule:
--   fixed monthly installment, interest = round(outstanding principal x monthly_rate),
--   principal part = installment - interest, last installment takes the remaining principal.
--
-- You may add your own tables (transactions, proposals, audit log, ...).
-- Please don't change these tables or the functions in 02_functions.sql.

CREATE TABLE customers (
    id            serial PRIMARY KEY,
    customer_no   text   NOT NULL UNIQUE,          -- C-0001
    first_name    text   NOT NULL,                 -- Latin, e.g. Bat-Erdene
    last_name     text   NOT NULL,                 -- Latin patronymic, e.g. Dorj
    first_name_mn text   NOT NULL,                 -- Cyrillic, e.g. Бат-Эрдэнэ
    last_name_mn  text   NOT NULL,                 -- Cyrillic, e.g. Дорж
    phone         text   NOT NULL,                 -- 8 digits
    register_no   text   NOT NULL UNIQUE           -- national ID number: sensitive
);

CREATE TABLE loans (
    id            serial  PRIMARY KEY,
    loan_no       text    NOT NULL UNIQUE,         -- LN-1042
    customer_id   int     NOT NULL REFERENCES customers(id),
    principal     bigint  NOT NULL CHECK (principal > 0),
    monthly_rate  numeric(6,4) NOT NULL,           -- 0.0250 = 2.5% a month
    term_months   int     NOT NULL,
    installment   bigint  NOT NULL,                -- fixed monthly amount
    disbursed_on  date    NOT NULL,
    status        text    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))
);

CREATE TABLE installments (
    id             serial PRIMARY KEY,
    loan_id        int    NOT NULL REFERENCES loans(id),
    seq            int    NOT NULL,
    due_date       date   NOT NULL,
    principal_due  bigint NOT NULL,
    interest_due   bigint NOT NULL,
    principal_paid bigint NOT NULL DEFAULT 0,
    interest_paid  bigint NOT NULL DEFAULT 0,
    UNIQUE (loan_id, seq),
    CHECK (principal_paid BETWEEN 0 AND principal_due),
    CHECK (interest_paid  BETWEEN 0 AND interest_due)
);

-- Every payment applied to a loan. Written only by apply_payment().
CREATE TABLE payments (
    id          serial PRIMARY KEY,
    loan_id     int    NOT NULL REFERENCES loans(id),
    amount      bigint NOT NULL CHECK (amount > 0),
    value_date  date   NOT NULL,
    source      text   NOT NULL,                   -- 'history' for seed data
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- How each payment was split across installments.
CREATE TABLE payment_allocations (
    payment_id     int    NOT NULL REFERENCES payments(id),
    installment_id int    NOT NULL REFERENCES installments(id),
    interest       bigint NOT NULL,
    principal      bigint NOT NULL,
    PRIMARY KEY (payment_id, installment_id)
);

CREATE INDEX ON installments (loan_id, seq);
CREATE INDEX ON payments (loan_id);
CREATE INDEX ON loans (customer_id);

-- Current balance per loan, independent of any date.
CREATE VIEW loan_balances AS
SELECT l.id                                                     AS loan_id,
       l.loan_no,
       l.status,
       COALESCE(SUM(i.principal_due - i.principal_paid), 0)    AS outstanding_principal,
       COALESCE(SUM(i.interest_due  - i.interest_paid),  0)    AS outstanding_interest,
       COALESCE(SUM(i.principal_due - i.principal_paid
                  + i.interest_due  - i.interest_paid),  0)    AS total_outstanding
FROM loans l
LEFT JOIN installments i ON i.loan_id = l.id
GROUP BY l.id, l.loan_no, l.status;
