/**
 * Runtime for the meal planner page.
 *
 * Inlined together with format.js, week.js and shopping.js, so every helper
 * those export (weekDates, buildShoppingList, scaledAmountWithUnit …) is in
 * scope here. Reads the recipes and the committed plans from
 * window.PLANNER_DATA. No dependencies, no network, no server.
 *
 * The page is the editor; git is the database. Edits live in localStorage as a
 * draft until they are downloaded as JSON and committed — so the draft always
 * remembers which committed revision it was based on, and can tell the cook
 * when the other one of them has published something newer.
 */
(function () {
  'use strict';

  var data = window.PLANNER_DATA;
  if (!data) return;

  /** Matches MAX_TEXT_LENGTH in plan-store.js. */
  var MAX_TEXT = 80;

  var DRAFT_PREFIX = 'meal-planner:draft:';
  var TICKS_PREFIX = 'meal-planner:ticked:';
  /** Where the planner kept its theme before it became site-wide. */
  var LEGACY_THEME_KEY = 'meal-planner:theme';

  var recipes = data.recipes || [];
  var published = data.plans || {};
  var sync = data.sync || null;

  /** Debounce on saving: a burst of typing is one write, not twenty. */
  var PUSH_DELAY_MS = 900;
  /** How often to look for the other cook's edits while the tab is in front. */
  var POLL_MS = 20000;
  var recipesBySlug = {};
  for (var i = 0; i < recipes.length; i += 1) recipesBySlug[recipes[i].slug] = recipes[i];

  var state = {
    week: data.week,
    plan: null,
    target: null,
    ticked: {},
    toastTimer: null,
    // The server's copy per week, once fetched. It outranks the plan committed
    // to git: git is the archive now, not the way plans reach each other.
    remote: {},
    syncState: syncEnabled(sync) ? 'idle' : 'off',
    pushTimer: null,
    pollTimer: null
  };

  var el = {};

  /* ---------------- storage ---------------- */

  function readStore(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null; // private mode or blocked storage — the page still works
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (err) { /* nothing to do */ }
  }

  function clearStore(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) { /* nothing to do */ }
  }

  /* ---------------- plans ---------------- */

  function emptyPlan(week) {
    var plan = { week: week, revision: 0, updated_at: null, updated_by: '', days: {} };
    var dates = weekDates(week);
    for (var d = 0; d < dates.length; d += 1) plan.days[dates[d]] = [];
    return plan;
  }

  /**
   * The copy this page is editing *against* — the server's if we have it, the
   * one committed to git otherwise. Everything that asks "has this changed?"
   * or "what revision am I based on?" goes through here.
   */
  function publishedPlan(week) {
    var stored = state.remote[week] || published[week];
    return stored ? normalise(clone(stored), week) : emptyPlan(week);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /** Only the assignments matter for "has this changed?" — not revision or timestamps. */
  function daysSignature(plan) {
    var dates = weekDates(plan.week);
    var out = [];
    for (var d = 0; d < dates.length; d += 1) {
      var entries = plan.days[dates[d]] || [];
      for (var e = 0; e < entries.length; e += 1) {
        // `text` is in here for a reason: without it every free-text meal on a
        // day stringifies the same, so renaming one — or swapping it for a
        // different one — would read as "no change", clear the draft and lose
        // the edit on the next load.
        out.push(dates[d] + '|' + (entries[e].slug || '') + '|' + (entries[e].text || '')
          + '|' + (entries[e].servings || '') + '|' + (entries[e].note || ''));
      }
      out.push('/');
    }
    return out.join(',');
  }

  function isDirty() {
    return daysSignature(state.plan) !== daysSignature(publishedPlan(state.week));
  }

  /**
   * A draft is stale when it was based on an older revision than the one now
   * committed — i.e. the other person published while this browser held edits.
   */
  function draftIsStale() {
    var draft = readStore(DRAFT_PREFIX + state.week);
    if (!draft) return false;
    var base = typeof draft.base_revision === 'number' ? draft.base_revision : 0;
    return base < (publishedPlan(state.week).revision || 0);
  }

  function loadWeek(week) {
    state.week = week;
    state.target = null;
    state.ticked = readStore(TICKS_PREFIX + week) || {};

    var draft = readStore(DRAFT_PREFIX + week);
    if (draft && draft.plan && draft.plan.days) {
      state.plan = normalise(draft.plan, week);
    } else {
      state.plan = publishedPlan(week);
    }
    render();
    // Render first, fetch second: the page is usable before the network is.
    pullRemote(week);
  }

  /** Re-shape anything read back from storage so the rest of the code can trust it. */
  function normalise(raw, week) {
    var plan = emptyPlan(week);
    plan.revision = Number(raw.revision) || 0;
    plan.updated_at = raw.updated_at || null;
    plan.updated_by = raw.updated_by || '';
    var dates = weekDates(week);
    for (var d = 0; d < dates.length; d += 1) {
      var entries = (raw.days && raw.days[dates[d]]) || [];
      if (!entries.length) continue;
      var kept = [];
      for (var e = 0; e < entries.length; e += 1) {
        var entry = entries[e];
        var slug = entry && typeof entry === 'object' ? entry.slug : entry;
        var note = entry && entry.note ? String(entry.note) : '';
        if (!slug) {
          var text = entry && entry.text ? String(entry.text).trim().slice(0, MAX_TEXT) : '';
          if (text) kept.push({ text: text, note: note });
          continue;
        }
        var servings = Number(entry && entry.servings);
        kept.push({
          slug: String(slug),
          servings: servings > 0 ? Math.round(servings) : null,
          note: note
        });
      }
      plan.days[dates[d]] = kept;
    }
    return plan;
  }

  /* ---------------- sync ---------------- */

  function setSyncState(next) {
    if (state.syncState === 'off') return;
    state.syncState = next;
    renderSaveBar();
  }

  /**
   * Does this browser hold edits of its own for a week? The stored draft is the
   * only honest answer. isDirty() cannot be used for it: once the server has
   * the other cook's changes, this page's plan differs from the published one
   * whether the difference came from here or from them — and treating their
   * work as "my unsaved edits" means never displaying it.
   */
  function hasLocalEdits(week) {
    return !!readStore(DRAFT_PREFIX + week);
  }

  /**
   * Take the server's copy of a week. With no local edits, adopt it outright —
   * that is the other cook's work arriving. With local edits, leave them alone:
   * publishedPlan now points at the newer revision, so draftIsStale raises the
   * conflict banner instead of one of them quietly losing.
   */
  function adoptRemote(week, plan) {
    if (!plan) return;
    state.remote[week] = plan;
    if (week !== state.week) return;
    if (!hasLocalEdits(week)) state.plan = publishedPlan(week);
    render();
  }

  function pullRemote(week) {
    if (!syncEnabled(sync)) return;
    pullPlan(sync, week).then(function (result) {
      if (!result.ok) {
        setSyncState('offline');
        return;
      }
      setSyncState('synced');
      if (result.plan) adoptRemote(week, result.plan);
      else if (week === state.week && !isDirty()) render();
    });
  }

  function schedulePush() {
    if (!syncEnabled(sync)) return;
    if (state.pushTimer) clearTimeout(state.pushTimer);
    setSyncState('saving');
    state.pushTimer = setTimeout(pushRemote, PUSH_DELAY_MS);
  }

  function pushRemote() {
    if (!syncEnabled(sync) || !isDirty()) return;
    var week = state.week;
    var base = publishedPlan(week).revision || 0;
    var days = clone(state.plan.days);
    var author = el.author.value.trim().slice(0, 60);

    pushPlan(sync, week, days, base, author).then(function (result) {
      if (result.ok) {
        // The server's copy is now this copy, so nothing is outstanding: the
        // draft goes, and the bar can honestly say it is saved for both.
        state.remote[week] = result.plan;
        if (week === state.week) {
          state.plan = publishedPlan(week);
          clearStore(DRAFT_PREFIX + week);
        }
        setSyncState('synced');
        render();
        return;
      }
      if (result.stale) {
        // The other cook saved first. Keep this page's edits and let the
        // conflict banner ask which one wins — never overwrite silently.
        if (result.plan) state.remote[week] = result.plan;
        setSyncState('conflict');
        render();
        return;
      }
      setSyncState('offline');
    });
  }

  function startPolling() {
    if (!syncEnabled(sync) || state.pollTimer) return;
    state.pollTimer = setInterval(function () {
      if (document.visibilityState === 'visible') pullRemote(state.week);
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') pullRemote(state.week);
    });
    window.addEventListener('online', function () { pullRemote(state.week); pushRemote(); });
  }

  function persistDraft() {
    if (isDirty()) {
      writeStore(DRAFT_PREFIX + state.week, {
        plan: state.plan,
        base_revision: publishedPlan(state.week).revision || 0,
        saved_at: new Date().toISOString()
      });
    } else {
      clearStore(DRAFT_PREFIX + state.week);
    }
  }

  /* ---------------- mutations ---------------- */

  function assign(date, slug) {
    var recipe = recipesBySlug[slug];
    if (!recipe || !state.plan.days[date]) return;
    state.plan.days[date].push({ slug: slug, servings: null, note: '' });
    state.target = date;
    changed();
    toast(recipe.title + ' → ' + dayName(date));
  }

  /** A meal that is just a name — no recipe, nothing for the shopping list. */
  function assignText(date, text) {
    var name = String(text == null ? '' : text).trim().slice(0, MAX_TEXT);
    if (!name || !state.plan.days[date]) return;
    state.plan.days[date].push({ text: name, note: '' });
    state.target = date;
    changed();
    toast(name + ' → ' + dayName(date));
  }

  function unassign(date, index) {
    var entries = state.plan.days[date];
    if (!entries || !entries[index]) return;
    entries.splice(index, 1);
    changed();
  }

  function move(date, index, delta) {
    var entries = state.plan.days[date];
    if (!entries || !entries[index]) return;
    var next = index + delta;
    if (next < 0 || next >= entries.length) return;
    var held = entries[index];
    entries[index] = entries[next];
    entries[next] = held;
    changed();
  }

  function setServings(date, index, value) {
    var entries = state.plan.days[date];
    if (!entries || !entries[index]) return;
    var number = Number(value);
    entries[index].servings = number > 0 ? Math.round(number) : null;
    changed();
  }

  /** Rename a free-text meal in place; clearing the name removes it. */
  function setText(date, index, value) {
    var entries = state.plan.days[date];
    if (!entries || !entries[index] || entries[index].slug) return;
    var name = String(value == null ? '' : value).trim().slice(0, MAX_TEXT);
    if (name === entries[index].text) return;
    if (name) entries[index].text = name;
    else entries.splice(index, 1);
    changed();
  }

  function changed() {
    persistDraft();
    render();
    schedulePush();
  }

  /* ---------------- rendering ---------------- */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function todayId() {
    var now = new Date();
    return toDateId(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
  }

  function render() {
    renderWeekBar();
    renderDays();
    renderPicker();
    renderShopping();
    renderSaveBar();
  }

  function renderWeekBar() {
    el.weekName.textContent = state.week;
    el.weekRange.textContent = weekLabel(state.week);
    el.todayChip.hidden = state.week !== currentWeekId(new Date());
  }

  function renderDays() {
    var dates = weekDates(state.week);
    var today = todayId();
    var html = '';

    for (var d = 0; d < dates.length; d += 1) {
      var date = dates[d];
      var entries = state.plan.days[date] || [];
      var classes = ['day'];
      if (date === today) classes.push('today');
      if (date === state.target) classes.push('drop-target');

      html += '<li class="' + classes.join(' ') + '" data-date="' + date + '">'
        + '<div class="day-head">'
        + '<strong>' + escapeHtml(dayName(date)) + '</strong>'
        + '<span>' + escapeHtml(dayLabel(date)) + '</span>'
        + '<button type="button" class="day-add no-print" data-add="' + date + '">+ Add</button>'
        + '</div>';

      if (!entries.length) {
        html += '<p class="day-empty">Nothing planned</p>';
      } else {
        html += '<ul class="day-list">';
        for (var e = 0; e < entries.length; e += 1) {
          html += renderAssignment(date, entries[e], e, entries.length);
        }
        html += '</ul>';
      }
      html += '</li>';
    }
    el.days.innerHTML = html;
  }

  /** The reorder/remove buttons, identical for both kinds of meal. */
  function assignmentControls(date, index, total, label) {
    return (total > 1
      ? '<button type="button" class="icon-button no-print" data-move="-1" data-date="' + date
        + '" data-index="' + index + '" aria-label="Move ' + escapeHtml(label) + ' earlier"'
        + (index === 0 ? ' disabled' : '') + '>↑</button>'
      : '')
      + '<button type="button" class="icon-button no-print" data-remove="' + index + '" data-date="' + date
      + '" aria-label="Remove ' + escapeHtml(label) + '">×</button>';
  }

  /**
   * A free-text meal. The name is an input that reads as plain text until it is
   * hovered or focused, so a typo is fixed by clicking it rather than by
   * deleting the row and typing it again.
   */
  function renderFreeformAssignment(date, entry, index, total) {
    var name = entry.text || '';
    return '<li class="assignment freeform" data-date="' + date + '" data-index="' + index + '">'
      + '<div class="assignment-main">'
      + '<input class="freeform-input" type="text" value="' + escapeHtml(name) + '"'
      + ' maxlength="' + MAX_TEXT + '" data-text="' + index + '" data-date="' + date + '"'
      + ' aria-label="Meal on ' + escapeHtml(dayName(date) + ' ' + dayLabel(date)) + '">'
      + '<span class="assignment-meta">not in the shopping list</span></div>'
      + assignmentControls(date, index, total, name)
      + '</li>';
  }

  function renderAssignment(date, entry, index, total) {
    if (!entry.slug) return renderFreeformAssignment(date, entry, index, total);

    var recipe = recipesBySlug[entry.slug];
    var title = recipe ? recipe.title : entry.slug;
    var servings = entry.servings || (recipe ? recipe.base_servings : null);
    var unit = recipe ? recipe.servings_unit : 'servings';
    var meta = recipe
      ? escapeHtml(servings + ' ' + unit)
      : '<em>missing from recipes/</em>';
    var link = recipe
      ? '<a href="' + escapeHtml(recipe.slug) + '.html">' + escapeHtml(title) + '</a>'
      : escapeHtml(title);

    return '<li class="assignment" data-date="' + date + '" data-index="' + index + '">'
      + '<div class="assignment-main">' + link
      + '<span class="assignment-meta">' + meta + '</span></div>'
      + (recipe
        ? '<input class="servings-input no-print" type="number" min="1" step="1" value="'
          + escapeHtml(servings) + '" data-servings="' + index + '" data-date="' + date + '"'
          + ' aria-label="Servings of ' + escapeHtml(title) + '">'
        : '')
      + assignmentControls(date, index, total, title)
      + '</li>';
  }

  function renderPicker() {
    if (el.recipeList.dataset.built !== 'yes') {
      var html = '';
      for (var r = 0; r < recipes.length; r += 1) {
        var recipe = recipes[r];
        var bits = [recipe.base_servings + ' ' + recipe.servings_unit];
        if (recipe.meta && recipe.meta.total_time) bits.push(recipe.meta.total_time);
        else if (recipe.meta && recipe.meta.cook_time) bits.push(recipe.meta.cook_time);
        if (recipe.meta && recipe.meta.difficulty) bits.push(recipe.meta.difficulty);

        html += '<li data-search="' + escapeHtml((recipe.title + ' ' + (recipe.description || '')).toLowerCase()) + '">'
          + '<button type="button" class="recipe-option" draggable="true" data-slug="' + escapeHtml(recipe.slug) + '">'
          + '<strong>' + escapeHtml(recipe.title) + '</strong>'
          + '<span>' + escapeHtml(bits.join(' · ')) + '</span>'
          + '</button></li>';
      }
      el.recipeList.innerHTML = html || '<li><p class="day-empty">No recipes found.</p></li>';
      el.recipeList.dataset.built = 'yes';
    }

    var target = state.target || defaultTarget();
    el.pickerHint.textContent = recipes.length
      ? 'Click a recipe to add it to ' + dayName(target) + ' ' + dayLabel(target)
        + ', or drag it onto any day. Anything else you type can go on as a plain name.'
      : 'Add recipe sources to recipes/ and rebuild.';
    renderFreeformAdd();
  }

  /**
   * When the filter box has text in it, offer it as a meal. Typing the name of
   * something and finding nothing is exactly the moment a free-text meal is
   * wanted, so the search box doubles as the entry field — no second control.
   */
  function renderFreeformAdd() {
    var query = el.search ? el.search.value.trim() : '';
    if (!query) {
      el.freeformAdd.hidden = true;
      el.freeformAdd.textContent = '';
      return;
    }
    var target = state.target || defaultTarget();
    el.freeformAdd.hidden = false;
    el.freeformAdd.textContent = '+ Add \u201c' + query + '\u201d to ' + dayName(target) + ' ' + dayLabel(target);
  }

  function filterRecipes() {
    var query = el.search.value.trim().toLowerCase();
    var rows = el.recipeList.querySelectorAll('li[data-search]');
    for (var r = 0; r < rows.length; r += 1) {
      rows[r].hidden = query !== '' && rows[r].getAttribute('data-search').indexOf(query) === -1;
    }
  }

  /** Clear the box before assigning, so the re-render hides the add row. */
  function addFromSearch() {
    var query = el.search.value.trim();
    if (!query) return;
    var target = state.target || defaultTarget();
    el.search.value = '';
    filterRecipes();
    assignText(target, query);
  }

  function defaultTarget() {
    var dates = weekDates(state.week);
    var today = todayId();
    return dates.indexOf(today) !== -1 ? today : dates[0];
  }

  function currentAssignments() {
    var dates = weekDates(state.week);
    var out = [];
    for (var d = 0; d < dates.length; d += 1) {
      var entries = state.plan.days[dates[d]] || [];
      for (var e = 0; e < entries.length; e += 1) {
        if (!entries[e].slug) {
          out.push({
            recipe: null,
            text: entries[e].text,
            note: entries[e].note,
            servings: null,
            date: dates[d]
          });
          continue;
        }
        var recipe = recipesBySlug[entries[e].slug];
        if (!recipe) continue;
        out.push({
          recipe: recipe,
          servings: entries[e].servings || recipe.base_servings,
          date: dates[d]
        });
      }
    }
    return out;
  }

  /** Name the meals the list could not account for, rather than leaving a gap. */
  function renderFreeformNote(freeText) {
    if (!freeText.length) {
      el.freeformNote.hidden = true;
      el.freeformNote.innerHTML = '';
      return;
    }
    var rows = '';
    for (var i = 0; i < freeText.length; i += 1) {
      var meal = freeText[i];
      var when = meal.date ? dayName(meal.date) + ' ' + dayLabel(meal.date) : '';
      rows += '<li>' + escapeHtml(meal.text)
        + (when ? '<span class="from">' + escapeHtml(when) + '</span>' : '')
        + '</li>';
    }
    el.freeformNote.innerHTML = '<strong>Not on this list (no recipe)</strong><ul>' + rows + '</ul>';
    el.freeformNote.hidden = false;
  }

  function renderShopping() {
    var assignments = currentAssignments();
    var list = buildShoppingList(assignments);
    var freeText = list.freeText || [];

    var count = list.itemCount
      ? list.itemCount + ' item' + (list.itemCount === 1 ? '' : 's') + ' from ' + list.recipeCount
        + ' meal' + (list.recipeCount === 1 ? '' : 's')
      : '';
    if (freeText.length) {
      count += (count ? ' · ' : '') + freeText.length + ' without recipe' + (freeText.length === 1 ? '' : 's');
    }
    el.shoppingCount.textContent = count;
    renderFreeformNote(freeText);

    if (!list.items.length) {
      el.shoppingList.innerHTML = '';
      el.shoppingEmpty.hidden = false;
      el.shoppingEmpty.textContent = freeText.length
        ? 'Nothing to buy — every meal planned this week is a plain name.'
        : 'Assign a recipe to a day and the list builds itself.';
      el.shoppingActions.hidden = true;
      return;
    }
    el.shoppingEmpty.hidden = true;
    el.shoppingActions.hidden = false;

    var html = '';
    for (var i = 0; i < list.items.length; i += 1) {
      var item = list.items[i];
      var amounts = [];
      for (var q = 0; q < item.quantities.length; q += 1) amounts.push(item.quantities[q].text);
      for (var x = 0; x < item.extras.length; x += 1) amounts.push(item.extras[x]);
      var ticked = state.ticked[item.key] === true;
      var id = 'shop-' + i;

      html += '<li class="shopping-item' + (ticked ? ' checked' : '') + '">'
        + '<input type="checkbox" id="' + id + '" data-tick="' + escapeHtml(item.key) + '"'
        + (ticked ? ' checked' : '') + '>'
        + '<label for="' + id + '">'
        + (amounts.length ? '<span class="qty">' + escapeHtml(amounts.join(' + ')) + '</span> ' : '')
        + escapeHtml(item.name)
        + (item.split ? '<span class="split-flag" title="These units could not be added together">2 units</span>' : '')
        + '<span class="from">' + escapeHtml(item.recipes.join(', ')) + '</span>'
        + '</label></li>';
    }
    el.shoppingList.innerHTML = html;
  }

  /** Who last touched the shared copy, when we know. */
  function lastChangedBy(plan) {
    if (!plan.updated_by) return '';
    return ' — last changed by ' + plan.updated_by;
  }

  function renderSaveBar() {
    var dirty = isDirty();
    var stale = draftIsStale() || state.syncState === 'conflict';
    var plan = publishedPlan(state.week);
    el.saveBar.dataset.state = dirty ? 'dirty' : 'clean';

    if (state.syncState === 'off') {
      // No endpoint in this build: the old download-and-commit flow, unchanged.
      el.saveText.textContent = dirty
        ? 'Saved on this device. Share it to put it on the other cook\u2019s planner.'
        : (plan.revision
          ? 'Shared — revision ' + plan.revision
            + (plan.updated_at ? ' on ' + plan.updated_at.slice(0, 10) : '')
            + (plan.updated_by ? ' by ' + plan.updated_by : '')
          : 'Nothing shared for this week yet.');
    } else if (state.syncState === 'conflict') {
      el.saveText.textContent = 'Someone else saved this week while you were editing.';
    } else if (state.syncState === 'offline') {
      el.saveText.textContent = 'Saved on this device — it will sync when you are back online.';
    } else if (dirty || state.syncState === 'saving') {
      el.saveText.textContent = 'Saving…';
    } else {
      el.saveText.textContent = plan.revision
        ? 'Saved for both of you' + lastChangedBy(plan)
        : 'Nothing planned for this week yet.';
    }

    el.discardButton.hidden = !dirty;
    el.conflictBanner.hidden = !(stale && dirty);

    // With sync on, downloading is an archive step rather than how the plan
    // gets shared, so it moves out of the way.
    var live = state.syncState !== 'off';
    el.downloadButton.hidden = live;
    el.downloadCopy.hidden = !live;
    el.moreToggle.hidden = false;
    if (!live) {
      // Nothing worth expanding for on a week with no edits and nothing shared.
      el.moreToggle.hidden = !dirty && !plan.revision;
      if (el.moreToggle.hidden) {
        el.saveMore.hidden = true;
        el.moreToggle.setAttribute('aria-expanded', 'false');
      }
    }
  }

  /* ---------------- saving ---------------- */

  function planForExport() {
    var out = clone(state.plan);
    out.revision = (publishedPlan(state.week).revision || 0) + 1;
    out.updated_at = new Date().toISOString();
    out.updated_by = el.author.value.trim().slice(0, 60);
    return out;
  }

  function download() {
    var payload = JSON.stringify(planForExport(), null, 2) + '\n';
    var blob = new Blob([payload], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = state.week + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Downloaded ' + state.week + '.json — commit it to ' + data.plansDir + '/ to share it');
  }

  function copyText(text, message) {
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch (err) { /* clipboard unavailable */ }
      document.body.removeChild(area);
      toast(message);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(message); }, fallback);
    } else {
      fallback();
    }
  }

  function shoppingText() {
    var list = buildShoppingList(currentAssignments());
    return shoppingListToText(list, 'Shopping list — ' + weekLabel(state.week));
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  /* ---------------- wiring ---------------- */

  function bind() {
    el.weekName = document.getElementById('week-name');
    el.weekRange = document.getElementById('week-range');
    el.todayChip = document.getElementById('today-chip');
    el.days = document.getElementById('days');
    el.recipeList = document.getElementById('recipe-list');
    el.pickerHint = document.getElementById('picker-hint');
    el.search = document.getElementById('recipe-search');
    el.shoppingList = document.getElementById('shopping-list');
    el.shoppingCount = document.getElementById('shopping-count');
    el.shoppingEmpty = document.getElementById('shopping-empty');
    el.shoppingActions = document.getElementById('shopping-actions');
    el.freeformAdd = document.getElementById('freeform-add');
    el.freeformNote = document.getElementById('shopping-freeform');
    el.saveBar = document.getElementById('save-bar');
    el.saveText = document.getElementById('save-text');
    el.discardButton = document.getElementById('discard-button');
    el.conflictBanner = document.getElementById('conflict-banner');
    el.author = document.getElementById('author');
    el.moreToggle = document.getElementById('more-toggle');
    el.saveMore = document.getElementById('save-more');
    el.downloadButton = document.getElementById('download-button');
    el.downloadCopy = document.getElementById('download-copy');
    el.toast = document.getElementById('toast');

    document.getElementById('prev-week').addEventListener('click', function () {
      loadWeek(shiftWeek(state.week, -1));
    });
    document.getElementById('next-week').addEventListener('click', function () {
      loadWeek(shiftWeek(state.week, 1));
    });
    document.getElementById('this-week').addEventListener('click', function () {
      loadWeek(currentWeekId(new Date()));
    });

    el.moreToggle.addEventListener('click', function () {
      var open = el.saveMore.hidden;
      el.saveMore.hidden = !open;
      el.moreToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    el.downloadButton.addEventListener('click', download);
    el.downloadCopy.addEventListener('click', download);
    document.getElementById('copy-plan').addEventListener('click', function () {
      copyText(JSON.stringify(planForExport(), null, 2), 'Plan JSON copied');
    });
    document.getElementById('copy-shopping').addEventListener('click', function () {
      copyText(shoppingText(), 'Shopping list copied');
    });
    document.getElementById('print-shopping').addEventListener('click', function () {
      window.print();
    });
    el.discardButton.addEventListener('click', function () {
      if (!window.confirm('Discard your unsaved changes for ' + state.week + '?')) return;
      clearStore(DRAFT_PREFIX + state.week);
      loadWeek(state.week);
    });
    document.getElementById('take-published').addEventListener('click', function () {
      clearStore(DRAFT_PREFIX + state.week);
      loadWeek(state.week);
      toast('Loaded the other cook\u2019s plan');
    });
    document.getElementById('keep-mine').addEventListener('click', function () {
      // Re-base the draft on the current revision: the cook has seen the
      // conflict and chosen their own copy, so stop warning about it.
      writeStore(DRAFT_PREFIX + state.week, {
        plan: state.plan,
        base_revision: publishedPlan(state.week).revision || 0,
        saved_at: new Date().toISOString()
      });
      // Rebased on their revision, so this can now be saved over the top.
      if (state.syncState === 'conflict') setSyncState('saving');
      render();
      schedulePush();
    });

    el.days.addEventListener('click', function (event) {
      var add = event.target.closest('[data-add]');
      if (add) {
        state.target = add.getAttribute('data-add');
        render();
        el.search.focus();
        return;
      }
      var remove = event.target.closest('[data-remove]');
      if (remove) {
        unassign(remove.getAttribute('data-date'), Number(remove.getAttribute('data-remove')));
        return;
      }
      var mover = event.target.closest('[data-move]');
      if (mover) {
        move(mover.getAttribute('data-date'), Number(mover.getAttribute('data-index')), Number(mover.getAttribute('data-move')));
      }
    });

    el.days.addEventListener('change', function (event) {
      var servings = event.target.closest('[data-servings]');
      if (servings) {
        setServings(servings.getAttribute('data-date'), Number(servings.getAttribute('data-servings')), servings.value);
        return;
      }
      var text = event.target.closest('[data-text]');
      if (text) setText(text.getAttribute('data-date'), Number(text.getAttribute('data-text')), text.value);
    });

    el.recipeList.addEventListener('click', function (event) {
      var option = event.target.closest('[data-slug]');
      if (option) assign(state.target || defaultTarget(), option.getAttribute('data-slug'));
    });

    el.recipeList.addEventListener('dragstart', function (event) {
      var option = event.target.closest('[data-slug]');
      if (!option) return;
      event.dataTransfer.setData('text/plain', option.getAttribute('data-slug'));
      event.dataTransfer.effectAllowed = 'copy';
    });

    el.days.addEventListener('dragover', function (event) {
      var day = event.target.closest('.day');
      if (!day) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      day.classList.add('drop-target');
    });
    el.days.addEventListener('dragleave', function (event) {
      var day = event.target.closest('.day');
      if (day && day.getAttribute('data-date') !== state.target) day.classList.remove('drop-target');
    });
    el.days.addEventListener('drop', function (event) {
      var day = event.target.closest('.day');
      if (!day) return;
      event.preventDefault();
      var slug = event.dataTransfer.getData('text/plain');
      if (slug) assign(day.getAttribute('data-date'), slug);
    });

    el.search.addEventListener('input', function () {
      filterRecipes();
      renderFreeformAdd();
    });

    // Type a name, press return: the whole interaction, without reaching for
    // the mouse or leaving the box.
    el.search.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addFromSearch();
    });

    el.freeformAdd.addEventListener('click', addFromSearch);

    el.shoppingList.addEventListener('change', function (event) {
      var box = event.target.closest('[data-tick]');
      if (!box) return;
      var key = box.getAttribute('data-tick');
      if (box.checked) state.ticked[key] = true;
      else delete state.ticked[key];
      writeStore(TICKS_PREFIX + state.week, state.ticked);
      var row = box.closest('.shopping-item');
      if (row) row.classList.toggle('checked', box.checked);
    });

    document.getElementById('clear-ticks').addEventListener('click', function () {
      state.ticked = {};
      clearStore(TICKS_PREFIX + state.week);
      renderShopping();
    });

    el.author.value = readStore('meal-planner:author') || '';
    el.author.addEventListener('change', function () {
      writeStore('meal-planner:author', el.author.value.trim());
    });

    // Deliberately no beforeunload warning: the draft is already in
    // localStorage, so leaving loses nothing, and the day cards link straight
    // to the recipe cards — a prompt on every one of those would be noise.
    // The save bar carries the "unsaved" state instead.
  }

  // Site-wide theme (see src/shared/theme.js), falling back to whatever this
  // page stored on its own before that. initTheme wires the button too, so the
  // planner and the recipe cards now cycle in the same order.
  initTheme(readStore(LEGACY_THEME_KEY) || 'auto');
  bind();
  loadWeek(data.week);
  startPolling();
})();
