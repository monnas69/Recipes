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
