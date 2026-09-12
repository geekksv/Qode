// The one page that manages every switchable link.
//
// It is a full editor for links.json with no save button, because git is the
// save button. You edit here, copy the JSON out, and push — the build turns
// each entry into a standalone redirect page at /go/<key>, so a scan is one
// request with the destination already baked in.
//
// The deliberate consequence of having no backend: nothing here writes
// anywhere. Everything is local until you commit it.
(function () {
  "use strict";

  var UI = window.QodeUI;

  var DRAFT_KEY = "qode-links-draft";
  // Keys become URL path segments, so they are restricted to what survives a
  // URL, a filename and a printed label equally well.
  var KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

  var rowsEl = document.getElementById("link-rows");
  var addBtn = document.getElementById("link-add");
  var jsonEl = document.getElementById("json-out");
  var copyBtn = document.getElementById("json-copy");
  var downloadBtn = document.getElementById("json-download");
  var statusEl = document.getElementById("links-status");
  var draftNote = document.getElementById("draft-note");
  var discardBtn = document.getElementById("draft-discard");
  var emptyEl = document.getElementById("links-empty");

  // What is actually deployed right now. Kept separate from the working copy
  // so the page can tell you which keys are live — and therefore which ones
  // are dangerous to rename.
  var live = {};
  var rows = []; // [{key, url}]

  // ---- Load ---------------------------------------------------------------

  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function saveDraft() {
    try {
      if (matchesLive()) localStorage.removeItem(DRAFT_KEY);
      else localStorage.setItem(DRAFT_KEY, JSON.stringify(rows));
    } catch (e) {
      /* storage disabled — the page still works, edits just are not kept */
    }
  }

  function matchesLive() {
    var a = {};
    rows.forEach(function (r) { if (r.key) a[r.key] = r.url; });
    var ak = Object.keys(a).sort();
    var lk = Object.keys(live).sort();
    if (ak.length !== lk.length) return false;
    for (var i = 0; i < ak.length; i++) {
      if (ak[i] !== lk[i] || a[ak[i]] !== live[lk[i]]) return false;
    }
    return true;
  }

  function fromLive() {
    return Object.keys(live).map(function (k) { return { key: k, url: live[k] }; });
  }

  // links.json is same-origin, so no CORS and no configuration.
  fetch("/links.json", { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (data) {
      Object.keys(data || {}).forEach(function (k) {
        if (k.charAt(0) === "_") return; // _readme and friends
        if (typeof data[k] === "string") live[k] = data[k];
      });

      var draft = loadDraft();
      rows = draft && draft.length ? draft : fromLive();
      if (!rows.length) rows = [{ key: "", url: "" }];

      render();
      UI.message(statusEl, "info",
        Object.keys(live).length + " link(s) currently live on this site.");
    })
    .catch(function (err) {
      rows = loadDraft() || [{ key: "", url: "" }];
      render();
      UI.message(statusEl, "warn",
        "Couldn't read the live links.json (" + (err.message || "error") +
        "). You can still build one here — the list above just isn't showing " +
        "what is currently deployed.");
    });

  // ---- Validation ---------------------------------------------------------

  function rowProblem(row, index) {
    var key = (row.key || "").trim();
    var url = (row.url || "").trim();
    if (!key && !url) return null; // blank row, simply ignored

    if (!key) return "Needs a name.";
    if (!KEY_RE.test(key)) {
      return "Use lowercase letters, digits and hyphens only.";
    }
    for (var i = 0; i < rows.length; i++) {
      if (i !== index && (rows[i].key || "").trim() === key) {
        return "Another row already uses this name.";
      }
    }
    if (!url) return "Needs a destination.";
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return "Not a complete web address.";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "Must start with http:// or https://";
    }
    return null;
  }

  function usableRows() {
    return rows.filter(function (r, i) {
      return (r.key || "").trim() && (r.url || "").trim() && !rowProblem(r, i);
    });
  }

  // ---- Render -------------------------------------------------------------

  function render() {
    rowsEl.innerHTML = "";

    rows.forEach(function (row, index) {
      var problem = rowProblem(row, index);
      var key = (row.key || "").trim();
      var isLive = Object.prototype.hasOwnProperty.call(live, key);
      var changed = isLive && live[key] !== (row.url || "").trim();

      var el = document.createElement("div");
      el.className = "link-row" + (problem ? " has-problem" : "");

      el.innerHTML =
        '<div class="link-row-main">' +
          '<input class="lr-key" type="text" spellcheck="false" placeholder="poster" ' +
            'value="' + UI.escapeHtml(row.key || "") + '" aria-label="Code name" />' +
          '<input class="lr-url" type="url" spellcheck="false" placeholder="https://example.com" ' +
            'value="' + UI.escapeHtml(row.url || "") + '" aria-label="Destination URL" />' +
          '<button class="repeater-del lr-del" type="button" aria-label="Remove this link">' +
            '<svg viewBox="0 0 22 22" aria-hidden="true"><use href="#i-trash" /></svg>' +
          "</button>" +
        "</div>" +
        '<div class="link-row-meta">' +
          (isLive
            ? '<span class="pill ok">Live</span><span class="lr-path mono">/go/' +
              UI.escapeHtml(key) + "</span>"
            : key && !problem
              ? '<span class="pill">New</span><span class="lr-path mono">/go/' +
                UI.escapeHtml(key) + "</span>"
              : "") +
          (changed ? '<span class="lr-note">changed — push to apply</span>' : "") +
          (problem ? '<span class="lr-problem">' + UI.escapeHtml(problem) + "</span>" : "") +
          (key && !problem
            ? '<button class="btn btn-secondary btn-sm lr-qr" type="button">Make QR</button>'
            : "") +
        "</div>";

      var keyInput = el.querySelector(".lr-key");
      var urlInput = el.querySelector(".lr-url");

      keyInput.addEventListener("input", function () {
        rows[index].key = keyInput.value;
        onChange({ keepFocus: "key", index: index });
      });
      urlInput.addEventListener("input", function () {
        rows[index].url = urlInput.value;
        onChange({ keepFocus: "url", index: index });
      });

      el.querySelector(".lr-del").addEventListener("click", function () {
        // Deleting a live key breaks every code already carrying it, and that
        // cannot be undone by reprinting — the paper is already out there.
        if (isLive) {
          var ok = window.confirm(
            'Remove "' + key + '"?\n\n' +
            "This name is live. Any QR code already printed with it will stop " +
            "working the moment you push this change, and nothing can bring it " +
            "back except restoring the name exactly."
          );
          if (!ok) return;
        }
        rows.splice(index, 1);
        if (!rows.length) rows = [{ key: "", url: "" }];
        onChange({});
      });

      var qrBtn = el.querySelector(".lr-qr");
      if (qrBtn) {
        qrBtn.addEventListener("click", function () {
          // Hand off to the Studio, exactly like the Dynamic Link wizard does,
          // so the code can be styled and exported like any other.
          var target = window.location.origin + "/go/" + key;
          window.location.href = "/?data=" + encodeURIComponent(target);
        });
      }

      rowsEl.appendChild(el);
    });

    emptyEl.hidden = rows.some(function (r) { return (r.key || "").trim(); });
    renderJson();

    var dirty = !matchesLive();
    draftNote.hidden = !dirty;
  }

  function onChange(opts) {
    saveDraft();
    render();
    // Re-rendering blows away focus; put it back so typing is not interrupted.
    if (opts && opts.keepFocus) {
      var sel = opts.keepFocus === "key" ? ".lr-key" : ".lr-url";
      var node = rowsEl.children[opts.index] &&
                 rowsEl.children[opts.index].querySelector(sel);
      if (node) {
        node.focus();
        var v = node.value;
        try { node.setSelectionRange(v.length, v.length); } catch (e) {}
      }
    }
  }

  function buildObject() {
    var out = {};
    usableRows().forEach(function (r) {
      out[r.key.trim()] = r.url.trim();
    });
    return out;
  }

  function renderJson() {
    var obj = buildObject();
    var text = JSON.stringify(obj, null, 2) + "\n";
    jsonEl.textContent = text;
    var none = !Object.keys(obj).length;
    copyBtn.disabled = none;
    downloadBtn.disabled = none;
  }

  // ---- Actions ------------------------------------------------------------

  addBtn.addEventListener("click", function () {
    rows.push({ key: "", url: "" });
    render();
    var last = rowsEl.lastElementChild;
    if (last) last.querySelector(".lr-key").focus();
  });

  copyBtn.addEventListener("click", function () {
    var text = jsonEl.textContent;
    var done = function () {
      var original = copyBtn.textContent;
      copyBtn.textContent = "Copied";
      setTimeout(function () { copyBtn.textContent = original; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      // execCommand is deprecated but is the only option on http:// origins
      // and in older in-app browsers, where the clipboard API is unavailable.
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) {
        UI.message(statusEl, "warn", "Couldn't copy automatically — select the text above.");
      }
      ta.remove();
    }
  });

  downloadBtn.addEventListener("click", function () {
    UI.download(new Blob([jsonEl.textContent], { type: "application/json" }), "links.json");
  });

  discardBtn.addEventListener("click", function () {
    rows = fromLive();
    if (!rows.length) rows = [{ key: "", url: "" }];
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    render();
  });
})();
