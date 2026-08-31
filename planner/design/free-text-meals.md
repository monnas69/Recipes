# Spec — free-text meals

Status: proposed. Nothing below is built yet.

## The problem

Every meal on the plan today has to be a recipe in `recipes/`. That is right for
the things we cook from a card, and wrong for most of the week. "Bangers and
mash", "leftovers", "fish and chips", "Karen's out — toastie" are all real
entries in a real week, and none of them will ever be worth a `recipe-card`
fence.

The cost of the gap is not the missing rows; it is that the week stops being
true. A planner that only holds four of seven days is a planner you check less
often, and a shopping list built from a plan you no longer trust is worse than
one built from a plan you do.

So: let a day hold a meal that is just a name.

## What this is not

**A free-text meal contributes nothing to the shopping list.** There is no
ingredient list to scale, sum or convert, and this tool does not guess. The page
and the CLI say so plainly rather than letting the list quietly under-report —
the same instinct that keeps grams from merging with cups.

It is also not a recipe stub, a to-do, or somewhere to paste a method. If a meal
earns a method it earns a card in `recipes/`.

## The shape of it

An entry in a day is currently `{ slug, servings, note }`. A free-text entry is
an entry with **`text` and no `slug`**:

```json
"2026-09-01": [
  { "slug": "pad-see-ew-thai-stir-fried-noodles", "servings": 4, "note": "" },
  { "text": "Bangers and mash", "note": "use up the gravy" }
]
```

The discriminator is the presence of a non-empty `slug`, not a `kind` field.
Every plan file already committed stays valid and unchanged, and the union has
exactly one reading: **`slug` wins**. An entry carrying both is normalised to the
recipe and its `text` is dropped, so no file can mean two things at once.

Rules, all enforced in `normalizePlan`'s `coerceEntry` and mirrored in the
page's `normalise`:

| Field | Free-text entry |
| --- | --- |
| `text` | trimmed, capped at 80 characters; empty after trimming drops the entry, exactly as a missing `slug` does today |
| `note` | as now — trimmed, capped at 200 |
| `servings` | **dropped.** Nothing consumes it |
| `slug` | absent |

Dropping `servings` is the one deliberate subtraction. There is nothing to scale,
so a servings box on a free-text row would be a control that changes no number
anywhere — a small lie, repeated every week. If "how many are eating" turns out
to matter, it wants to be a property of the day, not of a meal with no
ingredients, and that is a different change.

The per-day cap of 12 entries is unchanged and counts both kinds.

## Code changes

### `planner/plan-store.js`

- **`coerceEntry`** — when there is no `slug`, look for `text`. Return
  `{ text, note }` when it is non-empty, `null` otherwise. A bare string is still
  a slug, as today.
- **`missingSlugs`** — must skip entries with no `slug`. It currently asks
  `recipesBySlug.has(entry.slug)` for every entry; with free-text entries that
  becomes `has(undefined)`, which is false, and `import` would refuse the plan
  citing a missing recipe called `undefined`. This is the one line that fails
  loudly if it is forgotten, so it goes in first.
- **`planAssignments`** — emit free-text entries as
  `{ date, text, note, recipe: null, servings: null }`, in day order alongside
  the recipe assignments. Entries whose `slug` is genuinely missing from
  `recipes/` are still skipped, so the existing "drops assignments for recipes
  that vanished" test keeps its meaning.
- **`isEmptyPlan`** — unchanged. A week of nothing but free-text meals is not an
  empty week.

Callers that map over assignments must stop assuming `a.recipe` is set — inside
this repo that is `buildShoppingList` (already tolerant) and one assertion in
`test/planner-plan.test.js`.

### `planner/shared/shopping.js`

- **`buildShoppingList`** — an assignment with no `recipe` but with `text` is
  collected into a new `freeText: [{ date, text, note }]` on the result instead
  of being skipped. `recipeCount`, `itemCount` and every merge rule are
  untouched: free-text meals never reach the aggregation.
- **`shoppingListToText`** — when `freeText` is non-empty, append a short block
  after the items:

  ```
  Not on this list (no recipe):
  - Bangers and mash — Mon 31 Aug
  ```

  This is the list that gets pasted into a phone and taken to the shops, so the
  gap belongs *in* it. Knowing you planned a meal the list ignores is what stops
  you coming home without sausages.

### `planner/shared/planner-client.js`

- **`normalise`** — keep entries with `text` (it currently `continue`s on a
  missing slug).
- **`daysSignature`** — include `text` in the joined signature. It currently
  joins `slug`, `servings` and `note`; on a free-text entry `slug` is
  `undefined`, so every free-text meal on a day stringifies identically.
  *Adding* one still reads as dirty, but **renaming one, or swapping it for a
  different free-text meal, does not**: the save bar drops back to "Saved",
  `persistDraft` clears the draft, and the edit is gone on the next load. This is
  the second must-not-forget line, and the quietest.
- **`assignText(date, text)`** — new mutation beside `assign`, pushing
  `{ text, note: '' }`, setting `state.target`, and toasting
  `text + ' → ' + dayName(date)` like its sibling.
- **`setText(date, index, value)`** — rename in place; an empty value removes
  the entry (a name that has been cleared is not a meal).
- **`currentAssignments`** — emit free-text entries with `recipe: null`, the
  same union `planAssignments` produces.
- **`renderAssignment`** — for a free-text entry, no recipe link, no servings
  input, no "missing from recipes/" warning. The name renders as a borderless
  text input (`data-text`, `.freeform-input`) that reads as plain text until
  focused, so a typo is fixed by clicking it rather than by deleting the row and
  starting again. The meta line reads `not in the shopping list`. Reorder and
  remove already work by index and need no change.
- **`renderShopping`** — when `list.freeText` is non-empty, extend the count line
  to `12 items from 4 meals · 3 without recipes` and render the same short
  "not on this list" block under the ticked items, printed with them.
- **`bind`** — one new `change` handler for `[data-text]`, matching the existing
  `[data-servings]` one.

### Adding one: the search box does it

No new panel and no modal. The recipe filter is already where a cook types the
name of the meal they want; when what they type matches nothing, that is
precisely the moment they want a free-text meal.

- Whenever the filter box is non-empty, a final row appears in the recipe list:
  **`+ Add "roast chicken" to Tue 1 Sep`**, targeting the same day the picker
  hint already names.
- Enter in the filter box does the same thing, so the whole interaction is
  type-and-return.
- Either way the box clears afterwards, restoring the full recipe list.

This costs one row in `renderPicker`, one `keydown` handler, and no new
vocabulary. Free-text meals are not draggable in v1; the day is chosen before
the text exists, which is the opposite order from dragging a card.

### `planner/render.js` and `planner.css`

- `.freeform-input`: full width, transparent background, no border until
  `:hover`/`:focus`, inheriting the `.assignment-main a` type so a free-text row
  sits at the same weight as a recipe row.
- `.assignment.freeform .assignment-meta`: the muted "not in the shopping list"
  line.
- Print block: `.freeform-input` loses its border and appearance so a printed
  week shows names, not form fields. The new picker row is `.no-print`.

### `planner/cli.js`

- `formatPlan` prints free-text meals in day order with a marker that survives a
  monospace terminal:

  ```
  Tue 1 Sep  Pad See Ew  [4 servings]
             Bangers and mash  (no recipe)
  ```

- `shopping` inherits the new block from `shoppingListToText`.
- `import` prints the free-text count in its summary
  (`3 recipes, 2 free-text meals`). Cheap, and it makes the compatibility note
  below visible at the one moment it could bite.

### Docs

`planner/README.md` gains a short section under "Using it", and the plan-format
example grows a free-text entry. The top-level `README.md` planner paragraph
gets one sentence.

## Compatibility

A **new plan read by an old checkout** loses its free-text entries: the old
`coerceEntry` returns `null` for them, and re-importing writes them away for
good. Both halves ship from this repo and the site rebuilds on push, so the
only exposure is someone running `npm run planner import` from a stale working
copy. The `import` summary above makes that a visible change in the output
rather than a silent one, and `git diff` on the plan file catches the rest. No
version field, no migration — the cost of guarding this properly is larger than
the failure.

An **old plan read by new code** is unaffected: nothing about the recipe entry
shape changes.

## Tests

- `planner-plan.test.js` — `coerceEntry` accepts `{ text }`, trims and caps it,
  drops `servings` on it, prefers `slug` when both are present, drops an entry
  whose text is blank; `missingSlugs` ignores free-text entries; `planAssignments`
  returns the union in day order; a round-trip through `writePlan`/`readPlan`
  preserves text and note.
- `planner-shopping.test.js` — a free-text assignment adds nothing to `items`
  and does not move `recipeCount`; it lands in `freeText`;
  `shoppingListToText` prints the trailing block, and prints nothing extra when
  there are none.
- `planner-build.test.js` — a committed plan containing a free-text meal builds a
  page whose payload carries the text.
- `planner-browser.test.js` — type a name into the filter, press Enter, assert
  the day card shows it, the shopping list is unchanged, the save bar goes
  dirty, and the downloaded JSON contains the entry. Then **rename it in place
  and assert the bar is dirty again** — that second assertion is the only one
  that catches the `daysSignature` omission, since adding a row registers
  either way.

## Later, maybe

- **Promote to a recipe.** A free-text meal that keeps reappearing is a recipe
  asking to be written down; the row could link to a pre-filled `recipes/` stub.
- **Suggestions.** Past free-text names across committed weeks, de-duplicated,
  offered under the filter box — "Bangers and mash" typed once a month is worth
  one keystroke.
- **A shopping scratch line.** Free-text *ingredients* ("milk, bin bags") are a
  different feature with a different home — the shopping list, not the day.
