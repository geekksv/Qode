// Switchable links: the page where codes are made and re-aimed.
//
// Two tasks, two tabs, because they are genuinely different jobs:
//
//   Generate  — name a code, give it a destination, get the QR.
//   Change    — hand it the code you already printed, point it somewhere new.
//
// The second one is the reason this feature exists. You photograph the poster,
// the tab reads the code, and it tells you where that exact piece of paper
// currently sends people. Nothing about the printed code changes, ever; only
// the row behind it does.
//
// The token lives in sessionStorage rather than localStorage, so closing the
// tab signs you out — it is the password to something already out in public.
(function () {
  "use strict";

  var UI = window.QodeUI;
  var TOKEN_KEY = "qode-admin-token";

  // Keys become URL path segments and get printed, so they are held to what
  // survives a URL, a filename and a label equally well.
  var KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

  // The decoder is a quarter of a megabyte and most visits never open the
  // Change tab, so it is fetched the first time it is actually needed.
  var JSQR_URL = "/js/vendor/jsqr.js";

  var el = function (id) { return document.getElementById(id); };

  var gate = el("gate");
  var gateForm = el("gate-form");
  var gateToken = el("gate-token");
  var gateSubmit = el("gate-submit");
  var gateError = el("gate-error");

  var workspace = el("workspace");
  var liveCount = el("live-count");
  var statusEl = el("status");
  var signOutBtn = el("sign-out");

  var tabCreate = el("tab-create");
  var tabChange = el("tab-change");
  var panelCreate = el("panel-create");
  var panelChange = el("panel-change");

  var newKey = el("new-key");
  var newUrl = el("new-url");
  var createBtn = el("create-btn");
  var createError = el("create-error");
  var createResult = el("create-result");
  var createStage = el("create-stage");
  var createTarget = el("create-target");
  var createDest = el("create-dest");

  var dropzone = el("dropzone");
  var browseBtn = el("browse-btn");
  var qrFile = el("qr-file");
  var scanError = el("scan-error");

  var found = el("found");
  var foundName = el("found-name");
  var foundCurrent = el("found-current");
  var foundUrl = el("found-url");
  var foundError = el("found-error");
  var foundSave = el("found-save");

  var foreign = el("foreign");
  var foreignContent = el("foreign-content");
  var foreignWhy = el("foreign-why");
  var foreignActions = el("foreign-actions");
  var foreignCreate = el("foreign-create");

  var known = el("known");
  var rowsEl = el("link-rows");
  var knownEmpty = el("known-empty");

  var token = "";
  var live = {}; // key -> url
  var meta = {}; // key -> {hits, updatedAt}
  var editingKey = null;
  var lastSvg = null;
  var lastKey = null;

  // ---- Token --------------------------------------------------------------

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

  // Every write sends the whole set, so a partial save can never leave some
  // printed codes on the old destination and some on the new one.
  function saveAll(next) {
    return api("POST", { links: next }).then(function (data) {
      absorb(data.links);
      renderCount();
      renderKnown();
      return data;
    });
  }

  function handleAuthLoss(err) {
    if (err && err.status === 401) {
      setToken("");
      showGate("That session expired. Sign in again.");
      return true;
    }
    return false;
  }

  // ---- Gate ---------------------------------------------------------------

  function showGate(message) {
    gate.hidden = false;
    workspace.hidden = true;
    if (message) {
      gateError.hidden = false;
      gateError.querySelector("span").textContent = message;
    } else {
      gateError.hidden = true;
    }
    gateToken.focus();
  }

  function showWorkspace() {
    gate.hidden = true;
    workspace.hidden = false;
    renderCount();
    renderKnown();
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
    saveAll(live)
      .then(function () {
        gateToken.value = "";
        showWorkspace();
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

  // ---- Tabs ---------------------------------------------------------------

  function selectTab(which) {
    var isCreate = which === "create";
    tabCreate.setAttribute("aria-selected", isCreate ? "true" : "false");
    tabChange.setAttribute("aria-selected", isCreate ? "false" : "true");
    tabCreate.tabIndex = isCreate ? 0 : -1;
    tabChange.tabIndex = isCreate ? -1 : 0;
    panelCreate.hidden = !isCreate;
    panelChange.hidden = isCreate;
    if (!isCreate) loadDecoder();
  }

  tabCreate.addEventListener("click", function () { selectTab("create"); });
  tabChange.addEventListener("click", function () { selectTab("change"); });

  // Arrow keys move between tabs, which is the standard tablist model.
  [tabCreate, tabChange].forEach(function (btn) {
    btn.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      var next = btn === tabCreate ? tabChange : tabCreate;
      selectTab(next === tabCreate ? "create" : "change");
      next.focus();
    });
  });

  // ---- Shared validation --------------------------------------------------

  function keyProblem(key, ignoreKey) {
    if (!key) return "Give it a name.";
    if (!KEY_RE.test(key)) return "Lowercase letters, digits and hyphens only, starting with a letter or digit.";
    if (key !== ignoreKey && Object.prototype.hasOwnProperty.call(live, key)) {
      return 'You already have a code called "' + key + '".';
    }
    return null;
  }

  function urlProblem(url) {
    if (!url) return "Give it a destination.";
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return "That isn't a complete web address. It needs the https:// too.";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "Only http:// and https:// addresses can be used.";
    }
    return null;
  }

  function setError(node, message) {
    if (!message) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.querySelector("span").textContent = message;
  }

  // ---- Generate -----------------------------------------------------------

  function createState() {
    var key = newKey.value.trim().toLowerCase();
    var url = newUrl.value.trim();
    // Stay quiet until there is something to be wrong about — validating an
    // empty form as you arrive is just nagging.
    var problem = (key || url) ? (keyProblem(key) || urlProblem(url)) : "a";
    createBtn.disabled = !!problem;
    setError(createError, key && url ? (keyProblem(key) || urlProblem(url)) : null);
  }

  newKey.addEventListener("input", function () {
    // Typed names are lowercased as you go rather than rejected afterwards.
    var pos = newKey.selectionStart;
    newKey.value = newKey.value.toLowerCase().replace(/\s+/g, "-");
    try { newKey.setSelectionRange(pos, pos); } catch (e) {}
    createState();
  });
  newUrl.addEventListener("input", createState);

  createBtn.addEventListener("click", function () {
    var key = newKey.value.trim().toLowerCase();
    var url = newUrl.value.trim();
    var problem = keyProblem(key) || urlProblem(url);
    if (problem) return setError(createError, problem);

    createBtn.disabled = true;
    createBtn.textContent = "Generating…";

    var next = {};
    Object.keys(live).forEach(function (k) { next[k] = live[k]; });
    next[key] = url;

    saveAll(next)
      .then(function () {
        setError(createError, null);
        newKey.value = "";
        newUrl.value = "";
        createState();
        return showCode(key, url);
      })
      .catch(function (err) {
        if (handleAuthLoss(err)) return;
        setError(createError, err.message);
      })
      .then(function () {
        createBtn.textContent = "Generate code";
        createState();
      });
  });

  function targetFor(key) {
    return window.location.origin + "/go/" + key;
  }

  // The engine is ~3MB, so it is only fetched once a code actually needs
  // drawing — arriving at this page should not cost that.
  function showCode(key, url) {
    var target = targetFor(key);
    lastKey = key;
    createResult.hidden = false;
    createTarget.textContent = target;
    createDest.textContent = "goes to " + url;
    createStage.innerHTML = '<div class="qr-skeleton" aria-label="Drawing the code"></div>';

    return window.Qode.load()
      .then(function () {
        var result = window.qrbitGenerate(target, "M");
        if (!result || result.error) throw new Error(result && result.error ? result.error : "Could not encode that.");
        lastSvg = window.QRRenderer.renderSVG(result, {
          cellPx: 10,
          quietZone: 4,
          moduleShape: "square",
          eyeShape: "rounded",
          fgColor: "#0A0A0A",
          bgColor: "#FFFFFF",
        });
        createStage.innerHTML = lastSvg;
        var svg = createStage.querySelector("svg");
        if (svg) {
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", "QR code for " + target);
        }
      })
      .catch(function (err) {
        lastSvg = null;
        createStage.innerHTML = "";
        setError(createError, "The code was saved, but drawing it failed: " + err.message);
      });
  }

  el("dl-png").addEventListener("click", function () {
    if (!lastSvg) return;
    window.QRRenderer.svgToPngBlob(lastSvg, 1200).then(function (blob) {
      UI.download(blob, "qode-" + lastKey + ".png");
    });
  });

  el("dl-svg").addEventListener("click", function () {
    if (!lastSvg) return;
    UI.download(new Blob([lastSvg], { type: "image/svg+xml" }), "qode-" + lastKey + ".svg");
  });

  el("open-studio").addEventListener("click", function () {
    if (!lastKey) return;
    window.location.href = "/?data=" + encodeURIComponent(targetFor(lastKey));
  });

  // ---- Decoder ------------------------------------------------------------

  var decoderPromise = null;

  function loadDecoder() {
    if (decoderPromise) return decoderPromise;
    decoderPromise = new Promise(function (resolve, reject) {
      if (window.jsQR) return resolve(window.jsQR);
      var s = document.createElement("script");
      s.src = JSQR_URL;
      s.onload = function () {
        window.jsQR ? resolve(window.jsQR) : reject(new Error("decoder did not register"));
      };
      s.onerror = function () { reject(new Error("couldn't load the decoder")); };
      document.head.appendChild(s);
    });
    return decoderPromise;
  }

  // Phone photos are enormous and the decoder is O(pixels); anything past
  // ~1000px costs seconds and buys nothing, since a QR only needs a few
  // pixels per module to be read.
  var MAX_SIDE = 1000;

  function imageDataFrom(img, scale) {
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    // A code photographed on paper is often light-on-dark after a filter, or
    // sits on transparency when exported; painting white underneath makes both
    // cases decodable.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function decodeImage(img) {
    return loadDecoder().then(function (jsQR) {
      var base = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      // Progressively smaller passes, then an inverted pass. A photograph that
      // fails at full size often reads once downsampled, because scaling
      // averages away print texture and JPEG noise.
      var scales = [base, base * 0.6, base * 1.4, base * 0.35];
      for (var i = 0; i < scales.length; i++) {
        var scale = Math.min(scales[i], 1.6);
        if (scale <= 0) continue;
        var data = imageDataFrom(img, scale);
        var hit = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
        if (hit && hit.data) return hit.data;
      }
      return null;
    });
  }

  function readFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      return setError(scanError, "That isn't an image file.");
    }
    if (file.size > 20 * 1024 * 1024) {
      return setError(scanError, "That image is over 20MB. A smaller photo reads just as well.");
    }

    setError(scanError, null);
    dropzone.classList.add("is-busy");

    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      decodeImage(img)
        .then(function (text) {
          if (!text) {
            setError(scanError,
              "Couldn't find a QR code in that image. Try a straighter, better-lit photo with the " +
              "whole code in frame and a little white space around it.");
            return;
          }
          interpret(text);
        })
        .catch(function (err) {
          setError(scanError, "Couldn't read that image — " + err.message + ".");
        })
        .then(function () {
          dropzone.classList.remove("is-busy");
          URL.revokeObjectURL(url);
        });
    };
    img.onerror = function () {
      dropzone.classList.remove("is-busy");
      URL.revokeObjectURL(url);
      setError(scanError, "That file couldn't be opened as an image.");
    };
    img.src = url;
  }

  // What the scanned code turned out to be. Three outcomes, and the last two
  // are worth explaining rather than rejecting — someone holding a printed
  // code deserves to know why it cannot be moved.
  function interpret(text) {
    var u = null;
    try { u = new URL(text); } catch (e) { /* not a URL at all */ }

    var match = u && u.origin === window.location.origin &&
      u.pathname.match(/^\/go\/([^/]+)\/?$/);

    if (match) {
      var key = decodeURIComponent(match[1]).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(live, key)) return showFound(key);
      return showForeign(text,
        "Not switchable",
        'This is a Qode switchable code for the name "' + key + '", but that name is not in your ' +
        "list — it may have been removed. Recreating it with exactly this name brings every " +
        "printed copy back to life.",
        key);
    }

    if (u && /\/r$/.test(u.pathname) && u.origin === window.location.origin) {
      return showForeign(text, "Not switchable",
        "This is a Qode code, but a self-contained one: it carries its destination inside itself " +
        "and reaches it without asking any server. That is why it cannot be repointed — there is " +
        "nothing in between to change.");
    }

    if (u) {
      return showForeign(text, "Not switchable",
        "This code contains a plain web address, encoded directly into the ink. Nothing forwards " +
        "it, so there is nothing to re-aim. Only codes generated in the Generate tab can be " +
        "switched.");
    }

    showForeign(text, "Not a link",
      "This code carries text rather than a web address, so there is no destination to change.");
  }

  function showFound(key) {
    editingKey = key;
    found.hidden = false;
    foreign.hidden = true;
    // Reset the other panel's offer too, so a stale "Create this name" button
    // cannot resurface the next time a foreign code is scanned.
    foreignActions.hidden = true;
    known.hidden = true;
    dropzone.hidden = true;
    setError(scanError, null);
    setError(foundError, null);

    foundName.textContent = "/go/" + key;
    foundCurrent.textContent = live[key];
    foundUrl.value = live[key];
    foundState();
    foundUrl.focus();
    foundUrl.select();
  }

  function showForeign(text, pill, why, offerKey) {
    found.hidden = true;
    foreign.hidden = false;
    known.hidden = true;
    dropzone.hidden = true;
    setError(scanError, null);

    el("foreign-pill").textContent = pill;
    // textContent, never innerHTML: this came out of a QR code that anybody
    // could have generated.
    foreignContent.textContent = text.length > 300 ? text.slice(0, 300) + "…" : text;
    foreignWhy.textContent = why;

    foreignActions.hidden = !offerKey;
    foreignCreate.dataset.key = offerKey || "";
  }

  function resetScan() {
    editingKey = null;
    found.hidden = true;
    foreign.hidden = true;
    known.hidden = false;
    dropzone.hidden = false;
    setError(scanError, null);
    qrFile.value = "";
  }

  el("scan-again").addEventListener("click", resetScan);
  el("foreign-again").addEventListener("click", resetScan);

  foreignCreate.addEventListener("click", function () {
    var key = foreignCreate.dataset.key;
    if (!key) return;
    resetScan();
    selectTab("create");
    newKey.value = key;
    newUrl.value = "";
    createState();
    newUrl.focus();
  });

  // ---- Change -------------------------------------------------------------

  function foundState() {
    var url = foundUrl.value.trim();
    var problem = urlProblem(url);
    var changed = url !== live[editingKey];
    foundSave.disabled = !!problem || !changed;
    setError(foundError, url ? problem : null);
  }

  foundUrl.addEventListener("input", foundState);

  foundSave.addEventListener("click", function () {
    if (!editingKey) return;
    var url = foundUrl.value.trim();
    var problem = urlProblem(url);
    if (problem) return setError(foundError, problem);

    foundSave.disabled = true;
    foundSave.textContent = "Saving…";

    var next = {};
    Object.keys(live).forEach(function (k) { next[k] = live[k]; });
    next[editingKey] = url;

    var key = editingKey;
    saveAll(next)
      .then(function () {
        UI.message(statusEl, "ok",
          "Done. Every printed copy of /go/" + key + " now opens " + url + ".");
        foundCurrent.textContent = url;
        foundState();
      })
      .catch(function (err) {
        if (handleAuthLoss(err)) return;
        setError(foundError, err.message);
      })
      .then(function () {
        foundSave.textContent = "Save new destination";
        foundState();
      });
  });

  // ---- Dropzone -----------------------------------------------------------

  browseBtn.addEventListener("click", function () { qrFile.click(); });
  qrFile.addEventListener("change", function () { readFile(qrFile.files[0]); });

  dropzone.addEventListener("click", function (e) {
    if (e.target === browseBtn || browseBtn.contains(e.target)) return;
    qrFile.click();
  });

  ["dragenter", "dragover"].forEach(function (type) {
    dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      dropzone.classList.add("is-drag");
    });
  });
  ["dragleave", "drop"].forEach(function (type) {
    dropzone.addEventListener(type, function (e) {
      e.preventDefault();
      dropzone.classList.remove("is-drag");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      readFile(e.dataTransfer.files[0]);
    }
  });

  // Screenshot straight from the clipboard, which is how most people will
  // have the code to hand.
  window.addEventListener("paste", function (e) {
    if (panelChange.hidden || !e.clipboardData) return;
    var items = e.clipboardData.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image/") === 0) {
        var file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          if (!dropzone.hidden) return readFile(file);
          resetScan();
          return readFile(file);
        }
      }
    }
  });

  // ---- The list -----------------------------------------------------------

  function renderCount() {
    var n = Object.keys(live).length;
    liveCount.textContent = n
      ? n + (n === 1 ? " code is live." : " codes are live.") + " Changes apply on the next scan."
      : "No codes yet.";
  }

  function renderKnown() {
    rowsEl.innerHTML = "";
    var keys = Object.keys(live).sort();
    knownEmpty.hidden = keys.length > 0;

    keys.forEach(function (key) {
      var hits = meta[key] ? meta[key].hits : 0;
      var row = document.createElement("div");
      row.className = "link-row";
      row.innerHTML =
        '<div class="known-row">' +
          '<div class="known-main">' +
            '<span class="known-key mono">/go/' + UI.escapeHtml(key) + "</span>" +
            '<span class="known-url">' + UI.escapeHtml(live[key]) + "</span>" +
          "</div>" +
          '<div class="known-side">' +
            (hits ? '<span class="lr-hits">' + hits + " scan" + (hits === 1 ? "" : "s") + "</span>" : "") +
            '<button class="btn btn-secondary btn-sm known-edit" type="button">Change</button>' +
            '<button class="repeater-del known-del" type="button" aria-label="Delete ' + UI.escapeHtml(key) + '">' +
              '<svg viewBox="0 0 22 22" aria-hidden="true"><use href="#i-trash" /></svg>' +
            "</button>" +
          "</div>" +
        "</div>";

      row.querySelector(".known-edit").addEventListener("click", function () {
        showFound(key);
      });

      row.querySelector(".known-del").addEventListener("click", function () {
        // The one irreversible action here. Deleting a name breaks every code
        // already carrying it, and the paper is already out in the world.
        var ok = window.confirm(
          'Delete "' + key + '"?\n\n' +
          "Every QR code already printed with this name stops working the moment you confirm, " +
          "and only recreating the name exactly brings them back."
        );
        if (!ok) return;

        var next = {};
        Object.keys(live).forEach(function (k) { if (k !== key) next[k] = live[k]; });
        saveAll(next)
          .then(function () {
            UI.message(statusEl, "info", '"' + key + '" is gone.');
          })
          .catch(function (err) {
            if (handleAuthLoss(err)) return;
            UI.message(statusEl, "bad", err.message);
          });
      });

      rowsEl.appendChild(row);
    });
  }

  // ---- Boot ---------------------------------------------------------------

  // The list is public — these destinations are printed on posters, so there
  // is nothing to hide. Only writing needs the password.
  api("GET")
    .then(function (data) {
      absorb(data.links);
      token = getToken();
      if (token) showWorkspace();
      else showGate("");
    })
    .catch(function (err) {
      showGate("Couldn't reach the server (" + err.message + ").");
    });

  createState();
})();
