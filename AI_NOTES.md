# AI notes

## Tools used

- Cursor Agent (Composer) for scaffolding the monorepo, shared domain layer, Fastify API, MCP server, React accountant UI, Dockerfiles, and docs from `INSTRUCTIONS.md` and the attached plan.
- Web search / MCP SDK docs for Streamable HTTP session handling and `elicitation/create` (`elicitInput` with form mode).

## Where AI output was wrong or changed

- Early CSV amount parsing had a broken fractional check; replaced with a clear whole-MNT rule and unit tests.
- Approval “difference after apply” cannot be recomputed from live installments once `apply_payment` has run; stored amount due / difference in the `match_approved` audit details and read them back for the UI.
- Elicitation schema must be built from DB-loaded preview fields, not from tool arguments — kept that separation in `approve_match`.
- Host had no Docker Desktop and no system Node/npm on PATH (TLS interception also broke Node’s default cert trust until `NODE_TLS_REJECT_UNAUTHORIZED=0`). Verified Vitest + TypeScript builds with a portable Node 22. Full `docker compose up --build` and Claude Code elicitation still need a machine with Docker + Claude Code.

## Checked by hand

- Vitest coverage for `parseValueDate`, `parseAmount`, and sample statement CSV rows (including quoted thousands separators).
- TypeScript build of `@recon/shared`, `@recon/api`, `@recon/mcp`, and `@recon/web`.
- Reviewed that only `applyApprovedMatch` (called after elicitation accept) invokes `apply_payment`, and that a second approve short-circuits when `payment_id` is already set.
