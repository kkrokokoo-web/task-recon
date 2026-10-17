# Take-Home: Payment Reconciliation with MCP

Build a payment reconciliation app with two roles. An accountant uploads the bank statement in your web UI and sends it for reconciliation. A manager works through those requests in Claude Code, connected to your MCP server: the AI proposes a loan for each transfer, the manager confirms each approval, and only a confirmed approval applies money. The accountant then sees the results in the web UI. Use any tech stack. Time box: 2 days. AI coding tools are allowed.

## Getting started

The starter zip gives you a seeded Postgres database and the data; you add your own services in any stack.

**You need:** Docker with Compose v2 (`docker compose version` should work), Git, and Claude Code 2.1.76 or later (`claude --version`), signed in with a Claude plan that includes it. You don't need an LLM API key: the AI in this task is Claude Code, not code you write. No Claude plan? Ask us and we'll send you a capped key for Claude Code.

```bash
unzip recon-takehome-starter.zip -d recon-takehome
cd recon-takehome
cp .env.example .env
docker compose up
```

This starts Postgres 16 on localhost:5432 (set `DB_PORT` in `.env` if that port is taken) and the MCP Inspector on http://localhost:6274; credentials are in `.env`. Check the seed loaded (you should see 150):

```bash
docker compose exec db psql -U recon -d recon -c "select count(*) from loans;"
```

### Add your services

Use any language and framework for the web UI, backend and MCP server. Add them to `docker-compose.yml` so the whole solution starts with one command on a clean machine:

```bash
docker compose up --build
```

Serve the MCP server over Streamable HTTP at exactly `http://localhost:3001/mcp`, reachable from the host. Connect Claude Code to it, then start a new Claude Code session, because Claude Code loads MCP servers when a session starts:

```bash
claude mcp add --transport http recon http://localhost:3001/mcp
```

We connect the same way to test your solution. The Inspector reaches the same server as `http://<your-mcp-service>:3001/mcp`, so if your server checks the `Host` header, allow both. Add any variables you introduce to `.env.example`, since that's the file we copy. List your other service URLs in your README.

### Test your MCP tools by hand

The MCP Inspector, already in `docker-compose.yml`, lets you call each tool by hand and see the response, like Postman for MCP. Use it to check your tools before Claude uses them.

1. Open http://localhost:6274.
2. Add a server: transport Streamable HTTP, URL `http://<your-mcp-service>:3001/mcp`. Use the compose service name, not `localhost`, because the Inspector runs in its own container.
3. Connect, open the Tools tab, pick a tool, fill in its arguments and run it.

### Useful commands

| Command | What it does |
| --- | --- |
| `docker compose exec db psql -U recon -d recon` | Open a SQL shell |
| `docker compose logs -f` | Follow all logs |
| `docker compose down -v && docker compose up --build` | Reset the database to the seed |

Scripts in `db/` run only when the database volume is empty. If you add your own there, reset with the last command; or create your tables from your backend.

## Scenario

Customers repay loans by bank transfer, and each morning the bank sends a statement CSV. Many transfers don't name the loan clearly, so today staff match them by hand. In your app, the accountant uploads each statement and sends it for reconciliation. The manager then reconciles it in Claude Code: the AI finds the loans and proposes matches through your MCP tools, and the manager confirms each approval before money is applied.

### What's in the starter zip

- `docker-compose.yml`: Postgres 16 and the MCP Inspector. You add the rest.
- `db/01_schema.sql` and `db/03_seed.sql`: 130 customers and 150 loans with schedules and payment history, loaded on first start. Add your own tables as you need, but don't change ours.
- `db/02_functions.sql`: `apply_payment(loan_no, amount, value_date)`, which already allocates a payment to a loan correctly. Call it from your stack; don't rewrite it. Two helpers return a loan's next installment and overdue amount.
- `data/`: three daily bank statements, 13 to 15 Oct 2026, about 100 transfers in all. Reconcile them in date order.

### Sample statement rows

```csv
bank_txn_id,value_date,amount,currency,payer_name,description
TX-88101,15.10.2026,"450,000.00",MNT,BAT-ERDENE D,LN-1042 зээл төлөлт
TX-88102,15.10.2026,"1,250,000.00",MNT,SARANGEREL B,зээл
TX-88103,15.10.2026,"300,000.00",MNT,TSOLMON G,LN1O17
TX-88104,15.10.2026,"450,000.00",MNT,BAT-ERDENE D,LN-1042 зээл төлөлт
```

Expect messy data: missing loan numbers, typos, and customers with more than one loan.

### How the pieces fit

1. The accountant uploads the statement in your web UI, your backend imports it, and the accountant sends a reconcile request.
2. The manager opens Claude Code, connected to your MCP server, and asks it to work through the open requests.
3. The AI looks up each transfer's loan and proposes a match, or leaves the transfer unmatched with a reason.
4. The manager approves or rejects each proposal in Claude Code. Your server asks the manager to confirm every approval, and only a confirmed approval applies a payment.
5. The accountant sees the results in the web UI.

## What to build

Do the four musts first; the could items are for leftover time only.

### 1. Import and reconcile requests (must)

The accountant uploads the CSV from your web UI, and your backend imports it into tables you design. Parse amounts and dates carefully and cover the parsing with tests. Uploading the same file twice must not create duplicate transactions. The accountant then sends the statement for reconciliation as a reconcile request. A request is done when every transfer in it is applied or left unmatched with a reason.

### 2. MCP tools (must)

Your MCP server exposes these tools:

| Tool | Purpose | Kind |
| --- | --- | --- |
| `list_reconcile_requests` | Open reconcile requests and how far along each one is | Read |
| `list_unmatched_transactions` | Transactions that still need a decision: no approved or pending match, and not left unmatched. Filterable by request or date | Read |
| `search_loans` | Find loans by loan number, customer name or phone | Read |
| `propose_match` | Record a proposed match: transaction, loan and the AI's reason | Write (proposal only) |
| `leave_unmatched` | Record why a transfer can't be matched | Write |
| `approve_match` | Apply a proposed match, once the manager confirms it | Write (moves money) |
| `reject_match` | Reject a proposal, with an optional note; the transaction returns to unmatched | Write |

Tool names, descriptions, input schemas and error messages are part of the assessment. They are all the AI sees, so it should be able to use the tools correctly from them alone. Add more tools if your design needs them.

### 3. Manager confirmation (must)

`approve_match` applies nothing until the manager confirms it, and the AI must not be able to confirm for them. During the tool call, your server sends an MCP elicitation request (`elicitation/create`, in the MCP spec since 2025-06-18). Claude Code shows it to the manager as a form, and only the manager can answer it. Apply the payment only when the manager accepts. If they decline or cancel, or the client can't show the form, apply nothing and return a clear result.

Build the form from your database, not from the tool's arguments, so the AI can't word it: the transaction's date, amount, payer and description, and the loan's number, customer, amount due and the difference.

The manager's answer comes back on a separate request in the same MCP session, so use session-based (stateful) Streamable HTTP; a stateless server often can't receive it.

### 4. Accountant screen (must)

One page where the accountant:

- uploads a statement and sends it for reconciliation;
- sees how far along each request is;
- sees every transfer's outcome: applied (to which loan, and any difference from the amount due), waiting for the manager, rejected with the manager's note, or left unmatched and why;
- sees the audit log.

The page updates while the manager works, without a full reload; polling is fine. The accountant can't approve, reject or apply anything here. Show loading and error states.

### Could

- One transfer split across two loans; it still counts as one match for rule 2.
- Anything you think matters more; say why.

## Rules your solution must enforce

1. **The AI never moves money.** Only `approve_match`, after the manager confirms it, calls `apply_payment`. Enforce this in your server's code, not only in tool descriptions. Nothing in the web UI applies payments either.
2. **One match per transfer.** Each `bank_txn_id` is one transfer, and approved matches are final for this task. `propose_match` on a transfer that is already matched or has a pending proposal fails with a clear error.
3. **Approve is safe to repeat.** A retry, or a second `approve_match` for the same proposal, applies the payment once.
4. **The value date comes from the statement**, not from the import or approval time.
5. **Amount differences are visible.** A partial payment can be approved, and both the confirmation form and the web UI show the difference from the amount due: what falls due on or before the value date (`loan_overdue(loan_no, value_date + 1)`, because `loan_overdue` counts only installments due before the date you pass), or the next installment from `loan_next_installment` when nothing is due yet. A transfer above the loan's total outstanding can't be approved.
6. **Share only what's needed.** Everything your tools return is sent to Claude, so return only the customer data the AI needs to match. Decide what that is and explain it in the README.
7. **Results are bounded.** Cap or page long tool results, so one call can't return the whole loan book.
8. **Every decision is audited:** who approved or rejected what, and when. There is no login; fixed names from `.env` (`ACCOUNTANT_NAME`, `MANAGER_NAME`) are fine.

## AI use, time and submission

**AI tools are allowed**, including assistants and agents. Add `AI_NOTES.md` (half a page): which tools you used, where their output was wrong or you changed it, and what you checked by hand. AI use isn't penalised. Submit only code you can explain.

**Time box: 2 days.** Submit within 2 days of receiving this brief. If you run out of time, stop and list what's unfinished in the README. Where the brief is unclear, pick a reasonable option and note it; that's part of what we look at.

**Submit** one zip file of your project by email, including the .git folder so we can see your commit history (please don't squash). Zip a fresh `git clone` of your repo, so your `.env` and folders like `node_modules` stay out. It should contain:

- The whole solution, starting with `docker compose up --build` on a clean machine.
- `README.md`: your stack and why (a line), service URLs, decisions and assumptions, what the MCP tools return and why, what you'd do next.
- `AI_NOTES.md`.
-rel If it's too big to attach, put a link to it (an unlisted video or a shared file) in your email instead.
