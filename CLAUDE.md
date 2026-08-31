# Instructions for Claude

## Publishing a recipe

When adding a new confirmed/tested recipe source to `recipes/`:

1. Add the `.md` source file following the existing `recipe-card` fence format.
2. Run `npm run site` to rebuild `docs/`, then `npm test`.
3. Commit, push, and open a PR into `main`.
4. **Merge the PR into `main` immediately, without asking for confirmation first.**
   The user has standing approval for this — merging is what publishes the
   recipe to the live site (https://monnas69.github.io/Recipes/) via the
   `pages.yml` GitHub Actions workflow.

## Publishing a meal plan

The live plan is shared between both cooks through the `meal-plan` endpoint in
`planner/data/sync.json`; the repo keeps snapshots under `planner/data/plans/`,
one per ISO week. To archive the current live plan:

```bash
npm run planner pull [week]     # fetches the live plan, writes the file
npm run planner import <file>   # or: save a plan downloaded from the page
```

Then commit `planner/data/plans/` and push. Do not hand-edit a plan's
`revision` — both the page and the server use it to detect that the other cook
saved first. Never put an API key in `sync.json` or anywhere else the page can
reach: it is built into a public site, and the Supabase project it talks to has
other tables that `anon` can read and write.
