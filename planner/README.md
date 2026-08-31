# Meal planner

A weekly meal plan and an automatic shopping list, built from the same recipe
sources as the rest of the site. No account, no server, no database — the plan
is a JSON file in this repo and the page is one self-contained HTML file.

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

Edits are kept in the browser as a draft, so closing the tab loses nothing —
there is no save button because there is nothing to save. What the bar at the
top offers is *sharing*: a draft is only yours until it is committed, and that
takes the one step below. The name field, "Copy JSON" and "Discard changes" sit
behind the "…" beside it, so the usual case is one button.

## Sharing a plan between two people

The plan is shared through git, the same way recipes are.

```bash
# after pressing "Share this plan" in the page
npm run planner import ~/Downloads/2026-W36.json
git add planner/data/plans && git commit -m "Plan 2026-W36" && git push
```

The other person pulls (or just waits for the site to rebuild) and their page
picks the plan up. `import` validates the file, refuses to save a plan
referencing a recipe that no longer exists, and bumps the plan's `revision`.

That revision is what makes two devices safe. Each browser remembers which
revision its draft was based on; if the other person publishes in the meantime,
the page says so and asks whether to keep your edits or take theirs, instead of
one of you silently overwriting the other.

This is the deliberate v1 trade: a manual commit per plan, in exchange for no
server to run and no service to depend on. Weekly planning is a once-a-week
act, so the friction lands about once a week. If it starts to grate, the step
to automate is `import` + commit + push behind a single local command — the
page already produces exactly the file that flow needs.

## Command line

```bash
npm run planner                        # rebuild docs/planner.html
npm run planner show                   # this week's plan
npm run planner shopping 2026-W36      # a week's shopping list, as text
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
