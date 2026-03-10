# SSRS Price Costs API

Express + TypeScript API for extracting SSRS price and cost data.

Project goal: iterate the SSRS report across all stores, departments, subdepartments, commodities, and families, then write the scraped rows to CSV files.

Important workflow note:

- `capture` is a bootstrap/debug job; it intentionally stops after one valid selection and saves a reusable network payload.
- `replay` reuses one captured payload and scrapes rows for that single selection.
- `scrape` / `sweep` is the real full-data job that iterates all report combinations.

## Start

```bash
pnpm install
pnpm serve
```

The API starts on `http://localhost:3000` by default.

## Endpoints

- `GET /api/v1/health`
- `GET /api/v1/jobs`
- `POST /api/v1/jobs/scrape`
- `POST /api/v1/jobs/sweep`
- `POST /api/v1/jobs/capture`
- `POST /api/v1/jobs/replay`
- `GET /api/v1/jobs/:jobId`
- `GET /api/v1/jobs/:jobId/result`
- `GET /api/v1/jobs/:jobId/artifacts`

## Example Requests

Start the full scrape job:

```bash
curl -X POST http://localhost:3000/api/v1/jobs/scrape \
  -H 'Content-Type: application/json' \
  -d '{
    "autoLogin": true,
    "freshProfile": true,
    "parallel": true,
    "maxParallelTabs": 4
  }'
```

Scrape only specific store values from the SSRS dropdown:

```bash
curl -X POST http://localhost:3000/api/v1/jobs/scrape \
  -H 'Content-Type: application/json' \
  -d '{
    "stores": ["1", "241"],
    "parallel": false
  }'
```

Start a capture bootstrap job:

```bash
curl -X POST http://localhost:3000/api/v1/jobs/capture \
  -H 'Content-Type: application/json' \
  -d '{
    "autoLogin": true,
    "freshProfile": true,
    "applySelects": true
  }'
```

Replay a completed capture job for one selection:

```bash
curl -X POST http://localhost:3000/api/v1/jobs/replay \
  -H 'Content-Type: application/json' \
  -d '{
    "captureJobId": "replace-with-job-id",
    "applyFormOverrides": true
  }'
```

## Notes

- Browser-heavy jobs are queued asynchronously and return `202 Accepted` with a `jobId`.
- Job artifacts are written under `outputs/jobs/<jobId>/`.
- Capture and sweep jobs require either `autoLogin` credentials or an existing authenticated browser profile with `freshProfile=false`.
- If you want the full dataset, use `POST /api/v1/jobs/scrape` or `POST /api/v1/jobs/sweep`, not `capture`.
