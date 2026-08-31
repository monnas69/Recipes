# Meal planner

A weekly meal plan and an automatic shopping list, built from the same recipe
sources as the rest of the site. Open the link, edit a day, and it is on the
other cook's planner — no account, nothing to install, no app.

**Live: https://monnas69.github.io/Recipes/planner.html**

## Using it

1. Open the planner. It starts on the current ISO week.
2. Click **+ Add** on a day, then click a recipe (or drag one onto any day).
3. Adjust servings per meal — the shopping list rescales as you type.
4. The shopping list builds itself underneath. Tick things off as you shop;
   the ticks are remembered on that device.

Not every meal is a recipe. Type anything into the filter box and press return
and it goes on the day as a plain name — "bangers and mash", "leftovers",
"fish and chips". Click the name to fix a typo; clear it to remove the meal.

Those meals have no ingredients, so **they add nothing to the shopping list**.
The list names them at the bottom instead of pretending they are not there —
knowing the list ignores a meal is what stops you coming home without it.

Edits save themselves. There is no save button because there is nothing to
press: a change is written to the browser as you make it, and to the shared
plan a moment later. The bar at the top is a status line, not a form — it says
"Saved for both of you", or that you are offline and it will catch up.

## Sharing a plan between two people

Send the other cook the link. That is the whole setup.

Both planners edit one shared copy of the week. Their change appears on your
page within about twenty seconds, or immediately when you switch back to the
tab. Neither of you needs an account, a token, or the repo.

### When you both edit at once

Every save carries the revision it was based on, and the server refuses one
based on a revision that has moved on. So the second save is never a silent
overwrite: that page shows "Someone else saved this week while you were
editing" and asks whether to keep yours or take theirs.

### When you are offline

Edits go to the browser first, so a tunnel or a dead signal changes nothing you
can see. The bar says it will sync when you are back, and it does — including
the conflict check, so an edit made offline still cannot clobber one made in
the meantime.

### How it is wired

The page holds **no API key**. It calls one endpoint — a Supabase Edge Function
that keeps the service key server-side and can read and write exactly one
table, `meal_plans`.

That indirection is the point. The database lives in a project whose other
tables (groceries, fuel, tipping) are readable *and writable* by `anon`, so
publishing that project's key on a public site would have put all of it on the
internet. The function exposes the meal plan and nothing else, and the table
itself has RLS on with no policies at all, so even a leaked anon key cannot
reach it.

Anyone with the planner link can edit the plan. That is deliberate — it is what
makes "just send Karen the link" work — and the blast radius is a wrong
shopping list.

### Keeping the repo as the archive

Git is no longer how plans travel, but it is still where they are kept:

```bash
npm run planner pull 2026-W36
git add planner/data/plans && git commit -m "Plan 2026-W36" && git push
```

Committed plans are also the fallback the page falls back to when it cannot
reach the shared planner, and what a build with no `sync.json` uses on its own.

## Command line

```bash
npm run planner                        # rebuild docs/planner.html
npm run planner show                   # this week's plan
npm run planner shopping 2026-W36      # a week's shopping list, as text
npm run planner pull [week]            # snapshot the live plan into the repo
npm run planner import <file> [week]   # save a downloaded plan
npm run planner -- --help
```

`shopping` is the one worth knowing — it prints a plain list you can paste into
a phone, without opening the page at all.

## How the shopping list merges

Aggregation is the part that can quietly go wrong, so the rules are
conservative and visible in the output:

- Ingredients group by a normalised name, so `Garlic,` and `garlic` are one line.
- Quantities merge only when the units genuinely convert: grams with kilograms,
  teaspoons with tablespoons and cups. **Mass never merges with volume** — this
  tool does not know the density of flour, and a wrong number on a shopping
  list is worse than two right ones.
- Units that cannot be reconciled stay as separate quantities on the same line
  (`butter — 200 g + 2 cups`), flagged in the page, rather than being added
  together or dropped.
- Amounts that never parsed (`to taste`, `a pinch`) are carried through as text.
- A plural name folds into its singular only when both spellings are actually
  present, so `egg` + `eggs` merge but `oats` is never mistaken for `oat`.

Every recipe is scaled to the servings it was planned for before anything is
summed. Ingredients a recipe marks `"scalable": false` (curing salt, say) are
left alone.

Spoon and cup volumes are US customary.

## Layout

```
planner/build.js            pipeline: recipes + plans → docs/planner.html
planner/cli.js              argument parsing for the meal-planner command
planner/render.js           the page template; inlines every asset below
planner/plan-store.js       reading, validating and writing plan JSON
planner/shared/week.js      ISO week maths (shared with the browser)
planner/shared/shopping.js  aggregation (shared with the browser)
planner/shared/planner-client.js   the page's runtime
planner/shared/planner.css  styles, layered on src/shared/card.css
planner/data/plans/         one committed JSON file per week
planner/data/sync.json      where the live plan lives (an endpoint, never a key)
planner/shared/sync.js      talking to it, shared with the CLI
```

`week.js` and `shopping.js` are imported by Node **and** inlined into the page
with their `import`/`export` lines stripped — the same trick `src/shared/format.js`
uses — so the list the page shows and the list the CLI prints come from one
implementation, covered by one set of tests.

Recipes come from `src/export.js`, the exporter's own parser. There is no second
copy of the recipe-parsing rules.

## Plan format

```json
{
  "week": "2026-W36",
  "revision": 2,
  "updated_at": "2026-08-30T09:12:44.000Z",
  "updated_by": "shayne",
  "days": {
    "2026-08-31": [{ "slug": "pad-see-ew-thai-stir-fried-noodles", "servings": 4, "note": "" }],
    "2026-09-01": [{ "text": "Bangers and mash", "note": "use up the gravy" }],
    "2026-09-02": []
  }
}
```

Days are ISO dates, not weekday names, so a plan is unambiguous on its own.
`servings` may be `null` to use the recipe's own base. `slug` is the recipe's
slug — the filename it renders to in `docs/`.

An entry with `text` and no `slug` is a meal that is just a name. It carries no
`servings`, because there is nothing to scale. The two kinds are told apart by
whether there is a `slug`, so every plan committed before this existed is still
a valid plan; if an entry somehow has both, the `slug` wins.

Files are hand-editable; everything read back is re-validated, and anything
malformed is dropped rather than trusted.
