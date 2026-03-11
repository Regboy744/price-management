# SSRS Price Costs API

Express + TypeScript API that logs in to SSRS, sweeps report filters, and writes CSV output.

Main purpose: run a full scrape across stores, departments, subdepartments, commodities, and families.

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
- `GET /api/v1/jobs/:jobId`
- `GET /api/v1/jobs/:jobId/result`
- `GET /api/v1/jobs/:jobId/artifacts`

## Example Requests

Start a full scrape job:

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

Scrape specific stores only:

```bash
curl -X POST http://localhost:3000/api/v1/jobs/scrape \
  -H 'Content-Type: application/json' \
  -d '{
    "stores": ["1", "241"],
    "parallel": false
  }'
```

Check one job:

```bash
curl http://localhost:3000/api/v1/jobs/<job-id>
```

## Notes

- Scrape jobs are asynchronous and return `202 Accepted` with a `jobId`.
- Job artifacts are written under `outputs/jobs/<jobId>/`.
- Scrape jobs require either `autoLogin` credentials or an existing authenticated browser profile with `freshProfile=false`.
