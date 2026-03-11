# AGENTS.md

## Purpose
- This file is the local operating guide for coding agents working in `ssrs-price-costs`.
- Follow these conventions before making code changes, running commands, or reporting completion.

## Repository Snapshot
- Stack: Node.js + TypeScript (ESM) + Express + Playwright + Axios.
- Package manager: `pnpm` (lockfile is `pnpm-lock.yaml`).
- Runtime entrypoint: compiled server at `dist/src/server.js`.
- Main code roots: `src/` and `config/`.
- Build output: `dist/` (generated, do not hand-edit).
- Job artifacts/logs: `outputs/jobs/<jobId>/`.

## Important Paths
- API app bootstrapping: `src/app.ts`, `src/server.ts`.
- API routes/controllers: `src/api/routes/`, `src/api/controllers/`.
- API validation schemas: `src/api/schemas/`.
- App errors and middleware: `src/shared/errors/`, `src/api/middlewares/`.
- Job queue manager: `src/modules/jobs/job-manager.ts`.
- Sweep orchestration: `src/modules/sweep/sweep.service.ts`.
- Scrape engine: `src/scrape/`.
- Runtime/env config: `src/config/env.ts`, `config/*.ts`.

## Setup Commands
- Install dependencies: `pnpm install`
- Local env bootstrap: `cp .env.example .env` (then edit secrets)
- Development run (watch + rebuild + restart): `pnpm dev`
- Build and run compiled app: `pnpm serve`
- Start already-built app: `pnpm start`

## Build, Lint, and Test Commands
- Build: `pnpm build`
- Typecheck-only (no emit): `pnpm exec tsc --noEmit`
- Lint: no linter is currently configured in `package.json`.
- Format: no formatter script is currently configured.
- Test suite: no test runner/test script is currently configured.

## Single-Test Execution (Current State)
- There are currently no first-party tests in this repository.
- There is no `pnpm test` script and no Jest/Vitest config.
- If you add tests, document the runner and add scripts in `package.json`.
- Recommended temporary pattern for a single compiled JS test file:
- 1) `pnpm build`
- 2) `node --test dist/path/to/your.test.js`
- Do not claim tests passed unless you actually ran a concrete test command.

## Docker Commands (If Needed)
- Build + run containerized dev setup: `docker compose up --build`
- The Docker image runs `pnpm build` during image build.
- The container entrypoint re-runs `pnpm install` as needed.

## Runtime and Env Notes
- Copy `.env.example` to `.env` for local runs.
- Default API URL is `http://localhost:3000`.
- API route prefix is `/api/v1`.
- Scrape jobs are async and should return `202 Accepted` when queued.
- Browser profile defaults to `.playwright-profile` unless overridden.
- Output artifacts should be written under `outputs/jobs/<jobId>/`.
- Never print plaintext credentials from `MS_USERNAME` / `MS_PASSWORD`.
- Prefer env-driven configuration over hard-coded timeouts and limits.

## Code Style: TypeScript and Formatting
- Use TypeScript strict-mode compatible code (repo has `"strict": true`).
- Indentation: 2 spaces.
- Strings: single quotes.
- Keep semicolons.
- Prefer trailing commas in multiline objects/arrays/args.
- Use numeric separators for large numeric literals (example: `120_000`).
- Keep functions small and explicit at module boundaries.
- Add comments only where behavior is non-obvious.

## Imports and Module Rules
- ESM is enabled (`"type": "module"`), keep ESM syntax.
- Use explicit `.js` extensions in relative imports from TS files.
- Import Node builtins with `node:` prefixes (example: `node:fs`, `node:path`).
- Prefer `import type` for type-only imports.
- Typical import order in this repo:
- 1) Node builtins
- 2) third-party packages
- 3) local relative imports
- Keep imports grouped and avoid unused imports.

## Types and Data Modeling
- Prefer explicit interfaces/types for payloads and module contracts.
- Use `unknown` for untrusted input; narrow before use.
- Avoid `any`; if unavoidable, keep it tightly scoped and justified.
- For optional caps/limits, this codebase often uses `number | null`.
- Prefer readonly semantics for immutable class fields where appropriate.
- Preserve existing response/job type contracts unless intentionally versioning APIs.

## Naming Conventions
- Files: kebab-case (examples: `job-manager.ts`, `error-handler.ts`).
- Some domain suffixes are intentional: `*.service.ts`, `*.types.ts`, `*.controller.ts`.
- Types/interfaces/classes: PascalCase.
- Functions/variables: camelCase.
- Constants: UPPER_SNAKE_CASE for true constants; otherwise descriptive camelCase.
- Boolean helpers typically use `is*`, `has*`, `should*` naming.

## Error Handling Conventions
- API/domain errors should use `AppError` subclasses where appropriate.
- Use `ValidationError` for request/input validation failures.
- Use `NotFoundError`/`ConflictError` where semantically correct.
- Convert unknown thrown values at boundaries with `toAppError`.
- In Express handlers, route async errors through `asyncHandler`.
- In middleware, return structured error responses with request IDs.

## Logging and Sensitive Data
- Use the structured logger (`src/config/logger.ts`) instead of ad-hoc logs for API/job lifecycle.
- Include useful metadata (jobId, requestId, status, timings).
- Never log plaintext secrets (passwords/tokens/cookies).
- Redact sensitive fields before persistence/logging (`redactSensitiveData`).
- Keep job-level logs under each job artifact directory.

## Scraper and Browser Automation Guidelines
- Always clean up resources in `finally` blocks:
- - close browser/pages
- - detach capture listeners
- - close CSV appenders/streams
- Preserve retry/backoff patterns for flaky network/browser operations.
- Keep timeout values configurable via env where practical.
- For dropdown/report flows, preserve postback/state checks to avoid stale assumptions.
- Avoid introducing unbounded memory growth (capture buffers are intentionally bounded).

## API and Job Execution Guidelines
- Keep controllers thin: parse/validate input, dispatch to services, shape response.
- Keep heavy logic in services/modules (`modules/` and `scrape/`).
- Job creation should persist snapshots/artifacts consistently.
- Maintain async job semantics (`202 Accepted` for queued scrape jobs).
- Preserve API base prefix `/api/v1` and existing endpoint structure unless requested.

## Change Safety Rules for Agents
- Do not edit generated artifacts in `dist/` by hand.
- Do not commit secrets from `.env` or runtime output logs.
- Keep backward compatibility for public API payload fields when possible.
- Make the smallest coherent change that solves the task.
- Update docs when behavior/commands/contracts change.

## Cursor and Copilot Rules
- No Cursor rules were found at `.cursor/rules/`.
- No `.cursorrules` file was found.
- No Copilot instructions were found at `.github/copilot-instructions.md`.
- In absence of those files, treat this `AGENTS.md` as the authoritative agent guide.

## Pre-Completion Checklist
- Run `pnpm build` after code changes.
- Run `pnpm exec tsc --noEmit` for strict type validation if needed.
- If you added tests, run them and include exact command(s) in your report.
- Mention any commands you could not run and why.
- Summarize touched files and behavior changes clearly.
- If scraping behavior changed, include notes on retry/backoff/cleanup behavior.
