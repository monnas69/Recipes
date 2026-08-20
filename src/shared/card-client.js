/**
 * Runtime for an exported recipe card.
 *
 * Inlined into the HTML together with format.js (whose helpers — formatAmount,
 * scaledAmountWithUnit, formatClock, formatDuration — are in scope here). Reads the
 * recipe from window.RECIPE_DATA. No dependencies, no network.
 */
(function () {
  'use strict';

  var recipe = window.RECIPE_DATA;
  if (!recipe) return;

  var storeKey = 'ninja-recipe:' + (recipe.slug || 'card');
  var state = { servings: recipe.base_servings, ingredients: {}, steps: {}, theme: 'auto' };
  var timers = {};
  var audioCtx = null;

  /* ---------------- persistence ---------------- */

  function loadState() {
    try {
      var stored = window.localStorage.getItem(storeKey);
      if (!stored) return;
      var parsed = JSON.parse(stored);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.servings === 'number' && parsed.servings > 0) state.servings = parsed.servings;
        state.ingredients = parsed.ingredients || {};
        state.steps = parsed.steps || {};
        if (parsed.theme) state.theme = parsed.theme;
      }
    } catch (err) { /* private mode, blocked storage: fall back to defaults */ }
  }

  function saveState() {
    try {
      window.localStorage.setItem(storeKey, JSON.stringify(state));
    } catch (err) { /* nothing to do — the card still works in-memory */ }
  }

  /* ---------------- scaling ---------------- */

  function factor() {
    var base = recipe.base_servings || 1;
    return state.servings / base;
  }

  function renderAmounts() {
    var f = factor();
    var nodes = document.querySelectorAll('[data-ingredient]');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var ingredient = recipe.ingredients[Number(node.getAttribute('data-index'))];
      if (!ingredient) continue;
      var amountEl = node.querySelector('.amount');
      if (!amountEl) continue;
      amountEl.textContent = ingredient.scalable
        ? scaledAmountWithUnit(ingredient, f)
        : [ingredient.amount_text, ingredient.unit].filter(Boolean).join(' ');
    }

    var value = document.getElementById('servings-value');
    if (value) value.textContent = String(state.servings);
    var range = document.getElementById('servings-range');
    if (range && Number(range.value) !== state.servings) range.value = String(state.servings);

    var echo = document.getElementById('servings-echo');
    if (echo) echo.textContent = String(state.servings);

    var note = document.getElementById('scale-note');
    if (note) {
      var scaled = state.servings !== recipe.base_servings;
      note.hidden = !scaled;
      if (scaled) {
        note.textContent = 'scaled ' + formatAmount(f, '') + '× from ' + recipe.base_servings;
      }
    }
  }

  function setServings(next) {
    var value = Math.max(1, Math.min(99, Math.round(next)));
    if (value === state.servings) return;
    state.servings = value;
    renderAmounts();
    saveState();
  }

  /* ---------------- checklists ---------------- */

  function applyChecks() {
    var boxes = document.querySelectorAll('input[type="checkbox"][data-key]');
    for (var i = 0; i < boxes.length; i += 1) {
      var box = boxes[i];
      var bucket = box.getAttribute('data-kind') === 'step' ? state.steps : state.ingredients;
      var checked = Boolean(bucket[box.getAttribute('data-key')]);
      box.checked = checked;
      var row = box.closest('.ingredient, .step');
      if (row) row.classList.toggle('checked', checked);
    }
    renderProgress();
  }

  function renderProgress() {
    var total = recipe.steps.length;
    var done = 0;
    for (var key in state.steps) {
      if (Object.prototype.hasOwnProperty.call(state.steps, key) && state.steps[key]) done += 1;
    }
    var bar = document.getElementById('progress-bar');
    var label = document.getElementById('progress-label');
    var percent = total ? Math.round((done / total) * 100) : 0;
    if (bar) {
      bar.style.width = percent + '%';
      bar.parentNode.setAttribute('aria-valuenow', String(percent));
    }
    if (label) label.textContent = done + ' of ' + total + ' steps done';
  }

  function onCheckboxChange(event) {
    var box = event.target;
    if (!box || box.type !== 'checkbox' || !box.getAttribute('data-key')) return;
    var bucket = box.getAttribute('data-kind') === 'step' ? state.steps : state.ingredients;
    bucket[box.getAttribute('data-key')] = box.checked;
    var row = box.closest('.ingredient, .step');
    if (row) row.classList.toggle('checked', box.checked);
    renderProgress();
    saveState();
  }

  /* ---------------- timers ---------------- */

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
      var now = audioCtx.currentTime;
      for (var i = 0; i < 3; i += 1) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, now + i * 0.45);
        gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.45 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.45 + 0.32);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + i * 0.45);
        osc.stop(now + i * 0.45 + 0.35);
      }
    } catch (err) { /* audio is a nicety, never a requirement */ }
  }

  function paintTimer(timer) {
    var el = timer.el;
    var remaining = Math.max(0, Math.ceil(timer.remaining));
    el.querySelector('.timer-time').textContent = formatClock(remaining);
    var hint = el.querySelector('.timer-hint');
    el.classList.toggle('running', timer.status === 'running');
    el.classList.toggle('paused', timer.status === 'paused');
    el.classList.toggle('done', timer.status === 'done');
    el.querySelector('.timer-icon').textContent =
      timer.status === 'running' ? '⏸' : (timer.status === 'done' ? '✓' : '⏱');
    if (hint) {
      hint.textContent = timer.status === 'running' ? 'tap to pause'
        : timer.status === 'paused' ? 'tap to resume'
        : timer.status === 'done' ? 'time!' : 'tap to start';
    }
    var reset = el.parentNode.querySelector('.timer-reset');
    if (reset) reset.hidden = timer.status === 'idle';
    el.setAttribute('aria-label', 'Step ' + timer.step + ' timer, ' + formatClock(remaining) + ' remaining, ' + timer.status);
  }

  function tick(timer) {
    if (timer.status !== 'running') return;
    var now = Date.now();
    timer.remaining = Math.max(0, (timer.endsAt - now) / 1000);
    if (timer.remaining <= 0) {
      timer.status = 'done';
      timer.remaining = 0;
      window.clearInterval(timer.handle);
      timer.handle = null;
      paintTimer(timer);
      finish(timer);
      return;
    }
    paintTimer(timer);
    updateTitle();
  }

  function finish(timer) {
    beep();
    if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch (err) {} }
    var live = document.getElementById('timer-live');
    if (live) live.textContent = 'Timer finished for step ' + timer.step + '.';
    updateTitle();
  }

  function updateTitle() {
    var active = null;
    for (var id in timers) {
      if (timers[id].status === 'running') {
        if (!active || timers[id].remaining < active.remaining) active = timers[id];
      }
    }
    var base = recipe.title;
    document.title = active ? formatClock(active.remaining) + ' · ' + base : base;
  }

  function toggleTimer(el) {
    var id = el.getAttribute('data-timer');
    var seconds = Number(el.getAttribute('data-seconds'));
    var timer = timers[id];
    if (!timer) {
      timer = timers[id] = {
        el: el,
        total: seconds,
        remaining: seconds,
        status: 'idle',
        handle: null,
        endsAt: 0,
        step: el.getAttribute('data-step') || id
      };
    }
    if (timer.status === 'running') {
      timer.status = 'paused';
      timer.remaining = Math.max(0, (timer.endsAt - Date.now()) / 1000);
      window.clearInterval(timer.handle);
      timer.handle = null;
    } else {
      if (timer.status === 'done') timer.remaining = timer.total;
      timer.status = 'running';
      timer.endsAt = Date.now() + timer.remaining * 1000;
      window.clearInterval(timer.handle);
      timer.handle = window.setInterval(function () { tick(timer); }, 250);
      beepUnlock();
    }
    paintTimer(timer);
    updateTitle();
  }

  // Browsers need a user gesture before audio can play; warm the context here.
  function beepUnlock() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
    } catch (err) {}
  }

  function resetTimer(el) {
    var id = el.getAttribute('data-timer-reset');
    var timer = timers[id];
    if (!timer) return;
    window.clearInterval(timer.handle);
    timer.handle = null;
    timer.status = 'idle';
    timer.remaining = timer.total;
    paintTimer(timer);
    updateTitle();
  }

  /* ---------------- theme ---------------- */

  function applyTheme() {
    var root = document.documentElement;
    if (state.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', state.theme);
    var button = document.getElementById('theme-toggle');
    if (button) {
      var icon = state.theme === 'dark' ? '☾' : state.theme === 'light' ? '☀' : '◐';
      button.textContent = icon;
      button.setAttribute('aria-label', 'Theme: ' + state.theme + '. Click to change.');
      button.title = 'Theme: ' + state.theme;
    }
  }

  function cycleTheme() {
    state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
    applyTheme();
    saveState();
  }

  /* ---------------- wiring ---------------- */

  function resetAll() {
    state.servings = recipe.base_servings;
    state.ingredients = {};
    state.steps = {};
    for (var id in timers) {
      window.clearInterval(timers[id].handle);
      timers[id].handle = null;
      timers[id].status = 'idle';
      timers[id].remaining = timers[id].total;
      paintTimer(timers[id]);
    }
    renderAmounts();
    applyChecks();
    updateTitle();
    saveState();
  }

  function init() {
    loadState();
    applyTheme();
    renderAmounts();
    applyChecks();

    document.addEventListener('change', onCheckboxChange);

    document.addEventListener('click', function (event) {
      var timerEl = event.target.closest ? event.target.closest('[data-timer]') : null;
      if (timerEl) { toggleTimer(timerEl); return; }
      var resetEl = event.target.closest ? event.target.closest('[data-timer-reset]') : null;
      if (resetEl) { resetTimer(resetEl); return; }
    });

    var minus = document.getElementById('servings-minus');
    var plus = document.getElementById('servings-plus');
    var range = document.getElementById('servings-range');
    if (minus) minus.addEventListener('click', function () { setServings(state.servings - 1); });
    if (plus) plus.addEventListener('click', function () { setServings(state.servings + 1); });
    if (range) range.addEventListener('input', function () { setServings(Number(range.value)); });

    var printBtn = document.getElementById('print-button');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

    var themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) themeBtn.addEventListener('click', cycleTheme);

    var resetBtn = document.getElementById('reset-button');
    if (resetBtn) resetBtn.addEventListener('click', resetAll);

    // Keep timers honest after the tab has been backgrounded or the device slept.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      for (var id in timers) if (timers[id].status === 'running') tick(timers[id]);
    });

    window.addEventListener('beforeprint', function () {
      document.documentElement.setAttribute('data-printing', 'true');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
