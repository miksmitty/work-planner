# Work Planner

Estimate delivery timelines for a portfolio of AI use cases and view them as an MS Project-style Gantt chart. Node.js, **no dependencies**.

## Run

```bash
npm start        # http://localhost:3417
npm test
```

Plan data is saved to `data.json` (git-ignored). Set `PORT` to change the port.

## Test data

`seed-data.json` holds a ready-made test plan (17 placeholder use cases spread across the stages, five of them in triage). It is loaded automatically the first time the app starts, when there is no `data.json`. To discard your changes and reload it:

```bash
npm run start:fresh    # or use "Reset to test data" on the Use cases tab
```

## What it does

- Every use case has a current stage. Default stages: Ideation → Discovery → Feasibility → Build → Validate and Release → Operate (all editable; Build is the engineering stage).
- **Stage 0, Stakeholder Triage:** the clock has not started (the use case is still being refined with its submitter), so it is left out of the plan until you move it to a real stage.
- Earlier stages than a use case's current stage are skipped, and an optional "in stage since" date counts time already spent.
- **SME required (High / Medium / Low)** per use case: how much subject-matter-expert time it needs. It stretches the stages that depend on experts (Ideation, Discovery, Feasibility, Validate and Release by default; toggle per stage): Low ×1, Medium ×1.25, High ×1.6 (editable assumptions). A blank rating has no effect, and explicit overrides are never stretched.
- **Reuse (High / Medium / Low)** per use case: how much of the engineering plumbing already exists from earlier deliveries. It reduces the effort of stages flagged REUSE (Build by default): High ×0.5, Medium ×0.7, Low ×0.85 (editable assumptions). A use case can also *build on* another use case in the plan, and then the saving only applies once that use case's Build has finished, so delivery order matters. Effort you set yourself is never reduced.
- Rows are sorted by most advanced stage first, then by priority (1 = highest); developers are handed out in the same order.
- Engineering length comes from complexity (best / likely / worst dev-weeks, PERT-weighted) and a shared pool of developers.
- Standard techniques: three-point (PERT) estimating, resource-constrained scheduling, a WIP limit, a Brooks'-law team-overhead penalty, and a Monte Carlo forecast (50 / 80 / 90% dates).
- Gantt with quarter and month grid, today line, fit-to-width, and PNG download for slides.
- Import use cases from a SharePoint list export (CSV), including stage/status and priority, keeping the SharePoint ID and a link back to each item. A use case with no URL of its own gets one built from the base URL (Setup tab) + its ID.
- Change a use case's complexity straight from the Gantt (click the Complexity cell); drag any column edge in the table header to resize it (double-click to fit that column, "Reset columns" to restore defaults).
- All dates are shown as dd-mmm-yyyy (date boxes also accept d/m/yyyy).

See `sample-sharepoint-export.csv` for an example import file.
