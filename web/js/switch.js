// The one page that manages every switchable link.
//
// Edits go straight to the database through /api/links and take effect on the
// next scan — there is no build step and no file to push any more. The token
// is held in sessionStorage rather than localStorage so closing the tab signs
// you out; it is the password to something already printed on paper.
(function () {
  "use strict";

  var UI = window.QodeUI;
  var TOKEN_KEY = "qode-admin-token";

  // Keys become URL path segments and get printed, so they are held to what
  // survives a URL, a filename and a label equally well.
  var KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

  var gate = document.getElementById("gate");
  var gateForm = document.getElementById("gate-form");
  var gateToken = document.getElementById("gate-token");
  var gateSubmit = document.getElementById("gate-submit");
  var gateError = document.getElementById("gate-error");

  var editor = document.getElementById("links-editor");
  var rowsEl = document.getElementById("link-rows");
  var subEl = document.getElementById("links-sub");
  var statusEl = document.getElementById("status");
  var addBtn = document.getElementById("link-add");
  var saveBtn = document.getElementById("save");
  var revertBtn = document.getElementById("revert");
  var signOutBtn = document.getElementById("sign-out");

  var token = "";
  var live = {}; // what the database currently holds
  var meta = {}; // key -> {hits, updatedAt}
  var rows = []; // working copy: [{key, url}]

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }

  function setToken(v) {
    try {
      if (v) sessionStorage.setItem(TOKEN_KEY, v);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
    token = v;
  }

  // ---- API ----------------------------------------------------------------

  function api(method, body) {
    var opts = { method: method, headers: {}, cache: "no-store" };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch("/api/links", opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.error || "Request failed (" + r.status + ")");
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  function absorb(list) {
    live = {};
    meta = {};
    (list || []).forEach(function (l) {
      live[l.key] = l.url;
      meta[l.key] = { hits: l.hits, updatedAt: l.updatedAt };
    });
  }

  function fromLive() {
    return Object.keys(live).sort().map(function (k) {
      return { key: k, url: live[k] };
    });
  }

  // ---- Gate ---------------------------------------------------------------

  function showGate(message) {
    gate.hidden = false;
    editor.hidden = true;
    if (message) {
      gateError.hidden = false;
      gateError.querySelector("span").textContent = message;
    } else {
      gateError.hidden = true;
    }
    gateToken.focus();
  }

  function showEditor() {
    gate.hidden = true;
    editor.hidden = false;
    rows = fromLive();
    if (!rows.length) rows = [{ key: "", url: "" }];
    render();
  }

  gateForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var candidate = gateToken.value.trim();
    if (!candidate) return;

    gateSubmit.disabled = true;
    gateSubmit.textContent = "Checking…";
    setToken(candidate);

    // Saving the current state back is the cheapest way to prove the token
    // without a dedicated auth route: it validates, changes nothing, and
    // returns the live list.
    api("POST", { links: live })
      .then(function (data) {
        absorb(data.links);
        gateToken.value = "";
        showEditor();
      })
      .catch(function (err) {
        setToken("");
        showGate(err.message);
      })
      .then(function () {
        gateSubmit.disabled = false;
        gateSubmit.textContent = "Unlock";
      });
  });

  signOutBtn.addEventListener("click", function () {
    setToken("");
    showGate("");
  });

  // ---- Validation ---------------------------------------------------------

  function rowProblem(row, index) {
    var key = (row.key || "").trim();
    var url = (row.url || "").trim();
    if (!key && !url) return null; // blank row, simply ignored

    if (!key) return "Needs a name.";
    if (!KEY_RE.test(key)) return "Lowercase letters, digits and hyphens only.";
    for (var i = 0; i < rows.length; i++) {
      if (i !== index && (rows[i].key || "").trim() === key) return "Already used.";
    }
    if (!url) return "Needs a destination.";
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return "Not a complete web address.";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "Must be http:// or https://";
    }
    return null;
  }

  function buildObject() {
    var out = {};
    rows.forEach(function (r, i) {
      var key = (r.key || "").trim();
      var url = (r.url || "").trim();
      if (key && url && !rowProblem(r, i)) out[key] = url;
    });
    return out;
  }

  function anyProblem() {
    return rows.some(function (r, i) { return !!rowProblem(r, i); });
  }

  function dirty() {
    var next = buildObject();
    var a = Object.keys(next).sort();
    var b = Object.keys(live).sort();
    if (a.length !== b.length) return true;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i] || next[a[i]] !== live[b[i]]) return true;
    }
    return false;
  }

  // ---- Render -------------------------------------------------------------

  function render() {
    rowsEl.innerHTML = "";

    rows.forEach(function (row, index) {
      var problem = rowProblem(row, index);
      var key = (row.key || "").trim();
      var isLive = Object.prototype.hasOwnProperty.call(live, key);
      var changed = isLive && live[key] !== (row.url || "").trim();
      var hits = isLive && meta[key] ? meta[key].hits : 0;

      var el = document.createElement("div");
      el.className = "link-row" + (problem ? " has-problem" : "");

      var metaBits = "";
      if (problem) {
        metaBits = '<span class="lr-problem">' + UI.escapeHtml(problem) + "</span>";
      } else {
        if (changed) metaBits += '<span class="lr-note">unsaved</span>';
        if (hits) {
          metaBits += '<span class="lr-hits">' + hits + " scan" + (hits === 1 ? "" : "s") + "</span>";
        }
        if (key) metaBits += '<button class="lr-qr" type="button">QR</button>';
      }

      el.innerHTML =
        '<div class="link-row-main">' +
          '<span class="lr-prefix mono" aria-hidden="true">/go/</span>' +
          '<input class="lr-key" type="text" spellcheck="false" placeholder="poster" ' +
            'value="' + UI.escapeHtml(row.key || "") + '" aria-label="Code name" />' +
          '<input class="lr-url" type="url" spellcheck="false" placeholder="https://example.com" ' +
            'value="' + UI.escapeHtml(row.url || "") + '" aria-label="Destination URL" />' +
          '<button class="repeater-del lr-del" type="button" aria-label="Remove this link">' +
            '<svg viewBox="0 0 22 22" aria-hidden="true"><use href="#i-trash" /></svg>' +
          "</button>" +
        "</div>" +
        (metaBits ? '<div class="link-row-meta">' + metaBits + "</div>" : "");

      var keyInput = el.querySelector(".lr-key");
      var urlInput = el.querySelector(".lr-url");

      keyInput.addEventListener("input", function () {
        rows[index].key = keyInput.value;
        onChange("key", index);
      });
      urlInput.addEventListener("input", function () {
        rows[index].url = urlInput.value;
        onChange("url", index);
      });

      el.querySelector(".lr-del").addEventListener("click", function () {
        // Deleting a live key breaks every code already carrying it, and no
        // amount of editing brings those back — the paper is already out there.
        if (isLive) {
          var ok = window.confirm(
            'Remove "' + key + '"?\n\n' +
            "This name is live. Any QR code already printed with it stops working " +
            "the moment you save, and only restoring the name exactly brings it back."
          );
          if (!ok) return;
        }
        rows.splice(index, 1);
        if (!rows.length) rows = [{ key: "", url: "" }];
        render();
      });

      var qrBtn = el.querySelector(".lr-qr");
      if (qrBtn) {
        qrBtn.addEventListener("click", function () {
          window.location.href =
            "/?data=" + encodeURIComponent(window.location.origin + "/go/" + key);
        });
      }

      rowsEl.appendChild(el);
    });

    var count = Object.keys(live).length;
    subEl.textContent = count
      ? count + (count === 1 ? " link live." : " links live.") + " Changes apply the moment you save."
      : "No links yet. Add one, then save.";

    var isDirty = dirty();
    saveBtn.disabled = !isDirty || anyProblem();
    revertBtn.hidden = !isDirty;
  }

  function onChange(field, index) {
    render();
    // Re-rendering blows away focus; put it back so typing is not interrupted.
    var node = rowsEl.children[index] &&
      rowsEl.children[index].querySelector(field === "key" ? ".lr-key" : ".lr-url");
    if (node) {
      node.focus();
      try { node.setSelectionRange(node.value.length, node.value.length); } catch (e) {}
    }
  }

  // ---- Actions ------------------------------------------------------------

  addBtn.addEventListener("click", function () {
    rows.push({ key: "", url: "" });
    render();
    var last = rowsEl.lastElementChild;
    if (last) last.querySelector(".lr-key").focus();
  });

  revertBtn.addEventListener("click", function () {
    rows = fromLive();
    if (!rows.length) rows = [{ key: "", url: "" }];
    UI.message(statusEl, "info", "Reverted to what is live.");
    render();
  });

  saveBtn.addEventListener("click", function () {
    var payload = buildObject();
    var gone = Object.keys(live).filter(function (k) {
      return !Object.prototype.hasOwnProperty.call(payload, k);
    });
    if (gone.length) {
      var ok = window.confirm(
        "Saving will remove " + gone.length + " live link(s): " + gone.join(", ") + ".\n\n" +
        "Any QR code already printed with those names stops working immediately."
      );
      if (!ok) return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    api("POST", { links: payload })
      .then(function (data) {
        absorb(data.links);
        rows = fromLive();
        if (!rows.length) rows = [{ key: "", url: "" }];
        UI.message(statusEl, "ok", "Saved. Every printed code now points at its new destination.");
        render();
      })
      .catch(function (err) {
        if (err.status === 401) {
          setToken("");
          return showGate("That session expired. Sign in again.");
        }
        UI.message(statusEl, "bad", err.message);
        render();
      })
      .then(function () {
        saveBtn.textContent = "Save";
      });
  });

  // Losing unsaved edits to a stray navigation would be a genuinely annoying
  // way to break a printed code.
  window.addEventListener("beforeunload", function (e) {
    if (!editor.hidden && dirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---- Boot ---------------------------------------------------------------

  // The list is public — these destinations are printed on posters, so there
  // is nothing to hide. Only writing needs the password.
  api("GET")
    .then(function (data) {
      absorb(data.links);
      token = getToken();
      if (token) showEditor();
      else showGate("");
    })
    .catch(function (err) {
      showGate("Couldn't reach the server (" + err.message + ").");
    });
})();
