# Drop your chats here

Anything you save in this folder gets turned into a recipe card the next time
the site builds.

1. Copy a Claude conversation that contains a recipe (or just the recipe part).
2. Save it here as a `.md`, `.txt`, `.json` or `.html` file — the name is up to
   you; a date prefix keeps the folder tidy (`2026-08-20-miso-salmon.md`).
3. Commit and push. GitHub Actions rebuilds the site and the new card appears
   in the index at the published URL.

To preview locally before pushing:

```bash
npm run site && open docs/index.html
```

Files here are *sources*, not output — editing a card in `docs/` by hand will be
overwritten on the next build. Change the source and rebuild instead.
