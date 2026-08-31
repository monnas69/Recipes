/**
 * Light, dark, or follow the system — one implementation for every page this
 * repo builds.
 *
 * Inlined into the recipe cards, the index and the planner with its `export`
 * keywords stripped, the same trick format.js uses. The point of sharing it is
 * the storage key: the choice is remembered once, for the whole site, so
 * picking dark on the index and then opening a recipe does not throw you back
 * into light.
 */

export var THEME_KEY = 'ninja-recipe:theme';
export var THEMES = ['auto', 'light', 'dark'];

export function readTheme(fallback) {
  try {
    var stored = window.localStorage.getItem(THEME_KEY);
    if (stored && THEMES.indexOf(stored) !== -1) return stored;
  } catch (err) { /* private mode or blocked storage — the page still works */ }
  return THEMES.indexOf(fallback) !== -1 ? fallback : 'auto';
}

export function writeTheme(theme) {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch (err) { /* nothing to do */ }
}

/** auto -> light -> dark -> auto. */
export function nextTheme(theme) {
  return theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
}

/**
 * Put a theme on the page. "auto" means no attribute at all, leaving the CSS
 * to follow prefers-color-scheme.
 */
export function applyTheme(theme) {
  var root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');

  var button = document.getElementById('theme-toggle');
  if (button) {
    button.textContent = theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐';
    button.setAttribute('aria-label', 'Theme: ' + theme + '. Click to change.');
    button.title = 'Theme: ' + theme;
  }
  return theme;
}

/**
 * Apply the stored theme and wire the page's #theme-toggle, if it has one.
 *
 * `fallback` is used when nothing is stored site-wide yet. Pages that kept
 * their own setting before this was shared pass it here, so a choice made
 * earlier survives rather than silently resetting.
 *
 * `onChange` lets a page keep its own copy in step — the cards still write
 * theme into their per-recipe state, so an older build reading that state
 * finds what it expects.
 */
export function initTheme(fallback, onChange) {
  var theme = applyTheme(readTheme(fallback));
  writeTheme(theme);

  var button = document.getElementById('theme-toggle');
  if (button) {
    button.addEventListener('click', function () {
      theme = applyTheme(nextTheme(theme));
      writeTheme(theme);
      if (onChange) onChange(theme);
    });
  }
  return theme;
}
