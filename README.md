# Work Planner

Estimate delivery timelines for a portfolio of AI use cases and view them as an MS Project-style Gantt chart. Node.js, **no dependencies**.

## Run

```bash
npm start        # http://localhost:3417
npm test
```

Plan data is saved to `data.json` (git-ignored). Set `PORT` to change the port.

## Test data

`seed-data.json` holds a ready-made test plan (17 placeholder use cases). It is loaded automatically the first time the app starts, when there is no `data.json`. To discard your changes and reload it:

```bash
npm run start:fresh    # or use "Reset to test data" on the Use cases tab
```

## What it does

- Every use case moves through configurable stages (default: Discovery → Proof of value → Engineering → Production readiness → Deployment → Support transition).
- Engineering length comes from complexity (best / likely / worst dev-weeks, PERT-weighted) and a shared pool of developers.
- Standard techniques: three-point (PERT) estimating, resource-constrained scheduling, a WIP limit, a Brooks'-law team-overhead penalty, and a Monte Carlo forecast (50 / 80 / 90% dates).
- Gantt with quarter and month grid, today line, fit-to-width, and PNG download for slides.
- Import use cases from a SharePoint list export (CSV), keeping the SharePoint ID and a link back to each item. A use case with no URL of its own gets one built from the base URL (Setup tab) + its ID.
- Change a use case's complexity straight from the Gantt (click the Complexity cell); drag the Task name column edge to resize it (double-click to fit).
- All dates are shown as dd-mmm-yyyy (date boxes also accept d/m/yyyy).

See `sample-sharepoint-export.csv` for an example import file.
