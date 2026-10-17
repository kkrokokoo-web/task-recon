# Payment reconciliation take-home

TypeScript stack on the seeded Postgres loan book: accountant web UI + REST API, and a stateful MCP Streamable HTTP server for the manager in Claude Code.

**Why this stack:** one language for API, UI, and MCP; official `@modelcontextprotocol/sdk` supports session-based Streamable HTTP and form elicitation required for safe approvals.

## Start

```bash
cp .env.example .env
docker compose up --build
```

| Service | URL |
| --- | --- |
| Accountant UI | http://localhost:8080 |
| REST API | http://localhost:3000 |
| MCP (Streamable HTTP) | http://localhost:3001/mcp |
| MCP Inspector | http://localhost:6274 |
| Postgres | localhost:5432 (or `DB_PORT`) |

```bash
docker compose exec db psql -U recon -d recon -c "select count(*) from loans;"   # 150
```

Connect Claude Code (new session after adding the server):

```bash
claude mcp add --transport http recon http://localhost:3001/mcp
```

Inspector (from its container) should use `http://mcp:3001/mcp`. The MCP server accepts Host `localhost` and `mcp`.

## Flow

1. Accountant uploads a CSV at http://localhost:8080 and clicks **Send for reconciliation**.
2. Manager asks Claude Code to work open requests via MCP tools.
3. AI proposes matches / leaves unmatched; manager confirms each **approve** in the elicitation form.
4. Accountant page polls every 2s and shows outcomes + audit log.

Reconcile sample files in `data/` in date order: 13 → 14 → 15 Oct 2026.

## MCP tools

| Tool | Notes |
| --- | --- |
| `list_reconcile_requests` | Progress: total / applied / pending / unmatched / left_unmatched |
| `list_unmatched_transactions` | Filter by `request_id` or `value_date` |
| `search_loans` | By loan no, name, phone; optional `as_of` for amount due |
| `propose_match` | Proposal only — never calls `apply_payment` |
| `leave_unmatched` | Reason required |
| `approve_match` | Elicitation form from DB; only then `apply_payment` |
| `reject_match` | Optional note; transfer becomes unmatched again |

List/search results are capped (defaults 25–50). Tool payloads omit `register_no` and other unused PII; they return loan number, Latin/Cyrillic names, phone, status, outstanding, and amount due / difference when relevant — enough to match messy statement text without exposing national IDs.

## Money-move rules (enforced in server code)

- Only `approve_match` after manager **accept** on elicitation calls `apply_payment`.
- UI/API have no apply/approve endpoints.
- One pending/approved proposal per `bank_txn_id`.
- Repeat `approve_match` is idempotent (payment applied once).
- Value date comes from the statement row.
- Amount due = `loan_overdue(loan, value_date + 1 day)`, else next installment remaining; difference is transfer − due. Transfers above total outstanding cannot be approved.

## Layout

```
packages/shared   CSV parsing, domain, DB access
services/api      Fastify REST for the accountant UI
services/mcp      MCP Streamable HTTP (:3001/mcp)
web               React accountant page (nginx → api)
db/04_app_schema.sql   App tables (loan book unchanged)
```

## Assumptions

- Statement amounts are whole MNT (fractional parts other than `.00` rejected).
- Re-uploading the same file content (SHA-256) returns the existing statement.
- Fixed actor names from `.env` (`ACCOUNTANT_NAME`, `MANAGER_NAME`).
- Split one transfer across two loans is not implemented (could-have).

## Local tests

```bash
npm install
npm test   # CSV amount/date parsing (Vitest)
```

## Demo checklist

1. `docker compose up --build`
2. Open http://localhost:8080 — upload `data/statement-2026-10-13.csv`, send for reconciliation
3. Connect Claude Code to `http://localhost:3001/mcp` (new session)
4. Ask the manager AI to list open requests, match unmatched transfers, and approve with confirmation
5. Watch the accountant UI update (polling every 2s)
6. Repeat for 14 Oct then 15 Oct statements

## What we'd do next

- Snapshot amount-due on approval in a column (not only audit JSON).
- Optional split-payment proposals.
- Stronger matching hints (normalized loan-number OCR fixes) as a read-only helper tool.
