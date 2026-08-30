# Committed meal plans

One JSON file per ISO week, named for the week it holds: `2026-W36.json`.

These are the shared copies. Plan a week in the planner page, press **Download
plan**, then save it here:

```bash
npm run planner import ~/Downloads/2026-W36.json
git add planner/data/plans && git commit -m "Plan 2026-W36" && git push
```

Editing a file here by hand is fine — the format is in `planner/README.md`, and
everything is re-validated on read. Deleting one simply empties that week.
