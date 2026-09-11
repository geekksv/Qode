// Shared, page-agnostic UI primitives. Two accessible composite widgets
// (segmented radiogroup, tablist) plus small helpers that every page needs.
//
// The point of pulling these out is that the ARIA state and the keyboard
// model live in exactly one place: previously each page re-implemented
// "toggle a class on click" and neither screen readers nor keyboard users
// got anything at all.
window.QodeUI = (function () {
  "use strict";

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * Wires a `.seg` element as a proper ARIA radiogroup.
   *
   * Click selects. Arrow keys move *and* select (the standard radiogroup
   * model), Home/End jump to the ends. Only the selected button is in the
   * tab order, so Tab treats the whole group as one stop.
   *
   * Returns { value(), set(v) } so callers can read or drive it later.
   */
  function segmented(el, onChange) {
    if (!el) return { value: function () { return null; }, set: function () {} };
    var buttons = Array.prototype.slice.call(el.querySelectorAll('[role="radio"]'));

    function set(value, focus, notify) {
      var found = false;
      buttons.forEach(function (b) {
        var on = b.dataset.val === value;
        if (on) found = true;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
      if (!found) return;
      el.dataset.value = value;
      if (notify !== false && typeof onChange === "function") onChange(value);
    }

    el.addEventListener("click", function (e) {
      var btn = e.target.closest('[role="radio"]');
      if (!btn || !el.contains(btn)) return;
      if (btn.getAttribute("aria-checked") === "true") return;
      set(btn.dataset.val, false, true);
    });

    el.addEventListener("keydown", function (e) {
      var idx = buttons.indexOf(document.activeElement);
      if (idx === -1) return;
      var next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % buttons.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + buttons.length) % buttons.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = buttons.length - 1;
      if (next === null) return;
      e.preventDefault();
      set(buttons[next].dataset.val, true, true);
    });

    return {
      value: function () { return el.dataset.value; },
      // set() without notifying is how code changes the control programmatically
      // (e.g. bumping ECC to H after a logo upload) without re-entering its own
      // change handler.
      set: function (v, notify) { set(v, false, notify === true); },
    };
  }

  /**
   * Wires a `[role="tablist"]` of buttons. Same keyboard contract as the
   * segmented control; selection drives `aria-selected` and points the
   * associated tabpanel's `aria-labelledby` at the active tab.
   */
  function tablist(el, onChange) {
    if (!el) return { set: function () {} };
    var tabs = Array.prototype.slice.call(el.querySelectorAll('[role="tab"]'));

    function set(value, focus, notify) {
      var active = null;
      tabs.forEach(function (t) {
        var on = t.dataset.type === value;
        if (on) active = t;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        if (on && focus) t.focus();
      });
      if (!active) return;
      var panelId = active.getAttribute("aria-controls");
      var panel = panelId && document.getElementById(panelId);
      if (panel) panel.setAttribute("aria-labelledby", active.id);
      if (notify !== false && typeof onChange === "function") onChange(value);
    }

    el.addEventListener("click", function (e) {
      var tab = e.target.closest('[role="tab"]');
      if (!tab || !el.contains(tab)) return;
      if (tab.getAttribute("aria-selected") === "true") return;
      set(tab.dataset.type, false, true);
    });

    el.addEventListener("keydown", function (e) {
      var idx = tabs.indexOf(document.activeElement);
      if (idx === -1) return;
      var next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      set(tabs[next].dataset.type, true, true);
    });

    return { set: function (v, notify) { set(v, false, notify === true); } };
  }

  /**
   * Wires a `[role="tablist"]` whose tabs each show one `[role="tabpanel"]`,
   * named by the tab's `aria-controls`. Used for the Shape / Color / Logo
   * design panels: showing one at a time is what keeps the whole generator
   * inside a single viewport.
   */
  function panelTabs(el) {
    if (!el) return;
    var tabs = Array.prototype.slice.call(el.querySelectorAll('[role="tab"]'));

    function set(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    }

    el.addEventListener("click", function (e) {
      var tab = e.target.closest('[role="tab"]');
      if (tab && el.contains(tab)) set(tab, false);
    });

    el.addEventListener("keydown", function (e) {
      var idx = tabs.indexOf(document.activeElement);
      if (idx === -1) return;
      var next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      set(tabs[next], true);
    });
  }

  /**
   * UTF-8-safe base64url encode. btoa() alone throws on any character above
   * U+00FF, which a page title or a link label can easily contain, so the
   * string is encoded to bytes first. Mirrors the decoder in redirect.js.
   */
  function b64url(str) {
    var bytes = new TextEncoder().encode(String(str));
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** Shows/hides one of the `.msg` inline banners. Pass kind === null to hide. */
  function message(el, kind, text) {
    if (!el) return;
    if (!kind) {
      el.classList.remove("is-visible");
      return;
    }
    el.className = "msg is-visible " + kind;
    var slot = el.querySelector("span:last-child");
    if (slot) slot.textContent = text;
    else el.textContent = text;
  }

  /** Triggers a browser download for a Blob, cleaning up the object URL after. */
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  /** Standard drag-and-drop wiring: highlights on hover, calls back with the file. */
  function dropTarget(el, onFile) {
    if (!el) return;
    ["dragenter", "dragover"].forEach(function (evt) {
      el.addEventListener(evt, function (e) {
        e.preventDefault();
        el.classList.add("is-drag");
      });
    });
    ["dragleave", "dragend"].forEach(function (evt) {
      el.addEventListener(evt, function () { el.classList.remove("is-drag"); });
    });
    el.addEventListener("drop", function (e) {
      e.preventDefault();
      el.classList.remove("is-drag");
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  function debounce(fn, ms) {
    var handle = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(handle);
      handle = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  return {
    escapeHtml: escapeHtml,
    segmented: segmented,
    tablist: tablist,
    panelTabs: panelTabs,
    b64url: b64url,
    message: message,
    download: download,
    dropTarget: dropTarget,
    debounce: debounce,
  };
})();
