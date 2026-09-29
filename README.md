# Work Planner

Estimate delivery timelines for a portfolio of AI use cases and view them as an MS Project-style Gantt chart. Node.js, **no dependencies**.

## Run

```bash
npm start        # http://localhost:3417
npm test
```

Plan data is saved to `data.json` (git-ignored). Set `PORT` to change the port.

## What it does

- Every use case moves through configurable stages (default: Discovery → Proof of value → Engineering → Production readiness → Deployment → Support transition).
- Engineering length comes from complexity (best / likely / worst dev-weeks, PERT-weighted) and a shared pool of developers.
- Standard techniques: three-point (PERT) estimating, resource-constrained scheduling, a WIP limit, a Brooks'-law team-overhead penalty, and a Monte Carlo forecast (50 / 80 / 90% dates).
- Gantt with quarter and month grid, today line, fit-to-width, and PNG download for slides.
- Import use cases from a SharePoint list export (CSV), keeping the SharePoint ID and a link back to each item.

See `sample-sharepoint-export.csv` for an example import file.
