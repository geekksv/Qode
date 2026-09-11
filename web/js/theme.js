// Three-state theme control: dark -> light -> system -> dark.
//
// Dark is the product's default look, so a visitor who never touches the
// toggle gets dark regardless of their OS setting. "System" is still on
// offer, but it has to be chosen — which is why it is stored explicitly
// rather than represented by an absent key. An absent key means "never
// chose", and that resolves to dark.
//
// The first `data-theme` write happens in a tiny inline script in each
// page's <head>, before first paint, so nobody sees a white flash on the
// way to a dark page. This file handles only the interactive part: the
// toggle, its label, and reacting to the OS preference changing while the
// tab is open.
(function () {
  var STORAGE_KEY = "qode-theme";
  var DEFAULT_MODE = "dark";
  var root = document.documentElement;
  var mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function stored() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === "light" || v === "dark" || v === "system" ? v : DEFAULT_MODE;
    } catch (e) {
      return DEFAULT_MODE;
    }
  }

  function persist(mode) {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) {
      /* private mode / storage disabled — the session still themes correctly,
         it just won't be remembered. Not worth surfacing to the user. */
    }
  }

  // The theme actually in effect right now, which for "system" depends on the OS.
  function resolved(mode) {
    if (mode === "light" || mode === "dark") return mode;
    return mql && mql.matches ? "dark" : "light";
  }

  function apply(mode) {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    // Drives which glyph the toggle shows (see .theme-toggle rules in CSS).
    root.setAttribute("data-theme-mode", mode);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved(mode) === "dark" ? "#08090a" : "#fafaf9");

    var btn = document.querySelector("[data-theme-toggle]");
    if (btn) {
      var label =
        mode === "dark" ? "Theme: dark. Switch to light."
        : mode === "light" ? "Theme: light. Switch to system."
        : "Theme: system. Switch to dark.";
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    }
  }

  var mode = stored();
  apply(mode);

  // If the visitor is on "system" and flips their OS theme mid-session,
  // keep the theme-color meta (and the toggle's label) honest.
  if (mql) {
    var onChange = function () { if (mode === "system") apply("system"); };
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else if (mql.addListener) mql.addListener(onChange);
  }

  function wire() {
    var btn = document.querySelector("[data-theme-toggle]");
    if (!btn) return;
    apply(mode); // re-run now that the button exists, to set its label
    btn.addEventListener("click", function () {
      mode = mode === "dark" ? "light" : mode === "light" ? "system" : "dark";
      persist(mode);
      apply(mode);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
