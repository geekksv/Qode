// Switchable codes: make one, or re-aim one you already printed.
//
// Private — everything here is behind the admin token, which is held in
// sessionStorage so closing the tab signs you out.
//
// This was briefly open to the public, with a per-link edit key proving
// ownership. Closed again by choice: a free anonymous redirector is a
// phishing-laundering vector, and the cost of that going wrong is the whole
// domain being blocklisted rather than just this page breaking.
//
// One thing that has never been true, in either version: that holding the
// printed code lets you change it. Anyone can photograph a poster, so
// possession of a code is not a credential and never was. Uploading one here
// only ever *reads* it.
(function () {
  "use strict";

  var UI = window.QodeUI;
  var TOKEN_KEY = "qode-admin-token";
  var JSQR_URL = "/js/vendor/jsqr.js";

  var el = function (id) { return document.getElementById(id); };

  var gate = el("gate");
  var gateForm = el("gate-form");
  var gateToken = el("gate-token");
  var gateSubmit = el("gate-submit");
  var gateError = el("gate-error");
  var workspace = el("workspace");
  var liveCount = el("live-count");
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

  var nameLookup = el("name-lookup");
  var lookupKey = el("lookup-key");

  var found = el("found");
  var foundName = el("found-name");
  var foundCurrent = el("found-current");
  var foundUrl = el("found-url");
  var foundError = el("found-error");
  var foundSave = el("found-save");
  var foundDelete = el("found-delete");

  var foreign = el("foreign");
  var foreignContent = el("foreign-content");
  var foreignWhy = el("foreign-why");
  var foreignActions = el("foreign-actions");
  var foreignCreate = el("foreign-create");

  var known = el("known");
  var rowsEl = el("link-rows");
  var statusEl = el("status");

  var editingKey = null;
  var editingCurrent = "";
  var lastSvg = null;
  var lastKey = null;

  var token = "";
  var live = {}; // key -> url, as the server currently has it

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

  function api(method, body, query) {
    var opts = { method: method, headers: {}, cache: "no-store" };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch("/api/links" + (query || ""), opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.error || "Request failed (" + r.status + ")");
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function setError(node, message) {
    if (!message) { node.hidden = true; return; }
    node.hidden = false;
    node.querySelector("span").textContent = message;
  }

  // ---- Validation, mirroring the server -----------------------------------
  //
  // Duplicated deliberately: this half is for telling someone what is wrong
  // while they type. The server's half is the one that actually decides.

  var KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
  var RESERVED = ["go", "api", "switch", "wizard", "bulk", "studio", "admin", "login",
    "signin", "sign-in", "signup", "sign-up", "auth", "account", "password", "reset",
    "verify", "secure", "update", "confirm", "billing", "payment", "pay", "invoice",
    "wallet", "bank", "support", "help", "settings", "qode", "www", "mail", "root",
    "test", "favicon", "robots", "sitemap", "assets", "static", "js", "css", "img",
    "images", "wasm", "vendor", "r"];

  function keyProblem(key) {
    if (!key) return "Give it a name.";
    if (key.length < 3) return "Names need at least 3 characters.";
    if (key.length > 40) return "Names can be at most 40 characters.";
    if (!KEY_RE.test(key)) return "Lowercase letters, digits and hyphens only, starting with a letter or digit.";
    if (key.charAt(key.length - 1) === "-") return "Names can't end with a hyphen.";
    if (key.indexOf("--") !== -1) return "Names can't contain two hyphens in a row.";
    if (RESERVED.indexOf(key) !== -1) return '"' + key + '" is reserved.';
    return null;
  }

  var SHORTENERS = ["bit.ly", "bitly.com", "j.mp", "tinyurl.com", "t.co", "goo.gl",
    "ow.ly", "buff.ly", "is.gd", "v.gd", "cutt.ly", "rebrand.ly", "shorturl.at", "rb.gy",
    "tiny.cc", "shorte.st", "adf.ly", "bc.vc", "t.ly", "s.id", "short.io", "kutt.it",
    "clck.ru", "vk.cc", "qr.ae", "lnkd.in", "trib.al", "dlvr.it", "ift.tt", "tr.im",
    "chilp.it", "soo.gd", "surl.li", "gg.gg", "urlz.fr", "1url.com", "shrtco.de"];

  function urlProblem(url) {
    if (!url) return "Give it a destination.";
    var u;
    try { u = new URL(url); } catch (e) { return "That isn't a complete web address. It needs the https:// too."; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http:// and https:// addresses can be used.";
    if (u.username || u.password) return "Addresses with a username or password in them aren't allowed.";
    var h = u.hostname.toLowerCase();
    if (h === "localhost" || h.indexOf(".") === -1) return "That doesn't look like a public web address.";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return "Use a domain name rather than a bare IP address.";
    if (h === window.location.hostname && /^\/(go|r)(\/|$)/.test(u.pathname)) {
      return "That points back at this site's redirector, which would just loop.";
    }
    // Chaining through another shortener hides where people actually end up,
    // from this site's checks and from the visitor alike. The server refuses
    // it too; this is only so the answer arrives before the button is pressed.
    var root = h.split(".").slice(-2).join(".");
    if (SHORTENERS.indexOf(h) !== -1 || SHORTENERS.indexOf(root) !== -1) {
      return "That's another link shortener. Point the code at the real page instead.";
    }
    if (h.split(".").some(function (label) { return label.indexOf("xn--") === 0; })) {
      return "Internationalised domain names aren't accepted, because they can be made to look " +
        "like other sites.";
    }
    return null;
  }

  // ---- Tabs ---------------------------------------------------------------

  function selectTab(which) {
    var isCreate = which === "create";
    tabCreate.setAttribute("aria-selected", isCreate ? "true" : "false");
    tabChange.setAttribute("aria-selected", isCreate ? "false" : "true");
    tabCreate.tabIndex = isCreate ? 0 : -1;
    tabChange.tabIndex = isCreate ? -1 : 0;
    panelCreate.hidden = !isCreate;
    panelChange.hidden = isCreate;
    if (!isCreate) { loadDecoder(); renderMine(); }
  }

  tabCreate.addEventListener("click", function () { selectTab("create"); });
  tabChange.addEventListener("click", function () { selectTab("change"); });

  [tabCreate, tabChange].forEach(function (btn) {
    btn.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      var next = btn === tabCreate ? tabChange : tabCreate;
      selectTab(next === tabCreate ? "create" : "change");
      next.focus();
    });
  });

  // ---- Generate -----------------------------------------------------------

  function createState() {
    var key = newKey.value.trim().toLowerCase();
    var url = newUrl.value.trim();
    var problem = (key ? keyProblem(key) : "x") || (url ? urlProblem(url) : "x");
    createBtn.disabled = !!problem;
    // Only complain about a field once there is something in it.
    setError(createError, (key && keyProblem(key)) || (url && urlProblem(url)) || null);
  }

  newKey.addEventListener("input", function () {
    var pos = newKey.selectionStart;
    newKey.value = newKey.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
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
    setError(createError, null);

    api("POST", { key: key, url: url })
      .then(function (data) {
        live[data.link.key] = data.link;
        renderCount();
        newKey.value = "";
        newUrl.value = "";
        return showCode(data.link.key, data.link.url);
      })
      .catch(function (err) {
        if (err.status === 404) return signedOut();
        setError(createError, err.message);
      })
      .then(function () {
        createBtn.textContent = "Generate code";
        createState();
      });
  });

  // A 404 from the API means the token stopped working — it answers that to
  // anyone unauthenticated rather than confirming the endpoint exists.
  function signedOut() {
    setToken("");
    showGate("That session expired. Sign in again.");
  }

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
          cellPx: 10, quietZone: 4, moduleShape: "square", eyeShape: "rounded",
          fgColor: "#0A0A0A", bgColor: "#FFFFFF",
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
        UI.message(statusEl, "warn", "The code was saved, but drawing it failed: " + err.message);
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
    if (lastKey) window.location.href = "/?data=" + encodeURIComponent(targetFor(lastKey));
  });

  // ---- Decoder ------------------------------------------------------------

  var decoderPromise = null;

  function loadDecoder() {
    if (decoderPromise) return decoderPromise;
    decoderPromise = new Promise(function (resolve, reject) {
      if (window.jsQR) return resolve(window.jsQR);
      var s = document.createElement("script");
      s.src = JSQR_URL;
      s.onload = function () { window.jsQR ? resolve(window.jsQR) : reject(new Error("decoder did not register")); };
      s.onerror = function () { reject(new Error("couldn't load the decoder")); };
      document.head.appendChild(s);
    });
    return decoderPromise;
  }

  // Phone photos are enormous and the decoder is O(pixels); past ~1000px it
  // costs seconds and buys nothing, since a QR needs only a few pixels per
  // module to be read.
  var MAX_SIDE = 1000;

  function imageDataFrom(img, scale) {
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    // Exported codes often sit on transparency; painting white underneath
    // makes them decodable instead of reading as solid black.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function decodeImage(img) {
    return loadDecoder().then(function (jsQR) {
      var base = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      // Progressively different passes. A photograph that fails at full size
      // often reads once downsampled, because scaling averages away print
      // texture and JPEG noise.
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
    if (!/^image\//.test(file.type)) return setError(scanError, "That isn't an image file.");
    if (file.size > 20 * 1024 * 1024) {
      return setError(scanError, "That image is over 20MB. A smaller photo reads just as well.");
    }

    setError(scanError, null);
    dropzone.classList.add("is-busy");

    var objectUrl = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      decodeImage(img)
        .then(function (text) {
          if (!text) {
            return setError(scanError,
              "Couldn't find a QR code in that image. Try a straighter, better-lit photo with the " +
              "whole code in frame and a little white space around it.");
          }
          return interpret(text);
        })
        .catch(function (err) { setError(scanError, "Couldn't read that image — " + err.message + "."); })
        .then(function () {
          dropzone.classList.remove("is-busy");
          URL.revokeObjectURL(objectUrl);
        });
    };
    img.onerror = function () {
      dropzone.classList.remove("is-busy");
      URL.revokeObjectURL(objectUrl);
      setError(scanError, "That file couldn't be opened as an image.");
    };
    img.src = objectUrl;
  }

  // Three outcomes, and the last two are worth explaining rather than
  // rejecting — someone holding a printed code deserves to know why it
  // cannot be moved.
  function interpret(text) {
    var u = null;
    try { u = new URL(text); } catch (e) { /* not a URL at all */ }

    var match = u && u.origin === window.location.origin &&
      u.pathname.match(/^\/go\/([^/]+)\/?$/);

    if (match) {
      return lookup(decodeURIComponent(match[1]).toLowerCase());
    }
    if (u && u.origin === window.location.origin && /\/r$/.test(u.pathname)) {
      return showForeign(text, "Not switchable",
        "This is a Qode code, but a self-contained one: it carries its destination inside itself " +
        "and reaches it without asking any server. That is why it cannot be re-aimed — there is " +
        "nothing in between to change.");
    }
    if (u) {
      return showForeign(text, "Not switchable",
        "This code contains a plain web address, encoded directly into the ink. Nothing forwards " +
        "it, so there is nothing to re-aim. Only codes made in the Generate tab can be switched.");
    }
    showForeign(text, "Not a link",
      "This code carries text rather than a web address, so there is no destination to change.");
  }

  function lookup(key) {
    return api("GET", null, "?key=" + encodeURIComponent(key))
      .then(function (data) { showFound(data.link); })
      .catch(function (err) {
        if (err.status === 404) {
          return showForeign(window.location.origin + "/go/" + key, "Not switchable",
            'This is a switchable code for the name "' + key + '", but no code by that name exists ' +
            "here any more. Whoever made it may have deleted it. Creating it again with exactly " +
            "this name would bring every printed copy back to life.", key);
        }
        setError(scanError, err.message);
      });
  }

  function showFound(link) {
    editingKey = link.key;
    editingCurrent = link.url;
    found.hidden = false;
    foreign.hidden = true;
    foreignActions.hidden = true;
    dropzone.hidden = true;
    nameLookup.hidden = true;
    known.hidden = true;
    setError(scanError, null);
    setError(foundError, null);

    foundName.textContent = "/go/" + link.key;
    foundCurrent.textContent = link.url;
    foundUrl.value = link.url;
    // If this browser made the code, fill the key in — it is a convenience,
    // not an authorisation: the server still checks it.
    foundState();
    foundUrl.focus();
    foundUrl.select();
  }

  function showForeign(text, pill, why, offerKey) {
    found.hidden = true;
    foreign.hidden = false;
    dropzone.hidden = true;
    nameLookup.hidden = true;
    known.hidden = true;
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
    editingCurrent = "";
    found.hidden = true;
    foreign.hidden = true;
    foreignActions.hidden = true;
    nameLookup.hidden = true;
    dropzone.hidden = false;
    setError(scanError, null);
    qrFile.value = "";
    renderMine();
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

  // ---- Look up by name ----------------------------------------------------

  el("by-name").addEventListener("click", function () {
    dropzone.hidden = true;
    nameLookup.hidden = false;
    known.hidden = true;
    lookupKey.focus();
  });
  el("lookup-cancel").addEventListener("click", resetScan);
  el("lookup-btn").addEventListener("click", doLookup);
  lookupKey.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); doLookup(); }
  });

  function doLookup() {
    var key = lookupKey.value.trim().toLowerCase();
    if (!key) return;
    setError(scanError, null);
    api("GET", null, "?key=" + encodeURIComponent(key))
      .then(function (data) { showFound(data.link); })
      .catch(function (err) {
        nameLookup.hidden = false;
        setError(scanError, err.status === 404 ? "No code called \"" + key + "\"." : err.message);
      });
  }

  // ---- Change -------------------------------------------------------------

  function foundState() {
    var url = foundUrl.value.trim();
    var problem = urlProblem(url);
    var changed = url !== editingCurrent;
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
    setError(foundError, null);

    api("PATCH", { key: editingKey, url: url })
      .then(function (data) {
        editingCurrent = data.link.url;
        foundCurrent.textContent = data.link.url;
        live[editingKey] = data.link;
        renderCount();
        UI.message(statusEl, "ok",
          "Done. Every printed copy of /go/" + editingKey + " now opens " + data.link.url + ".");
      })
      .catch(function (err) {
        if (err.status === 404) return signedOut();
        setError(foundError, err.message);
      })
      .then(function () {
        foundSave.textContent = "Save new destination";
        foundState();
      });
  });

  foundDelete.addEventListener("click", function () {
    if (!editingKey) return;
    var ok = window.confirm(
      'Delete "' + editingKey + '"?\n\n' +
      "Every QR code already printed with this name stops working immediately, and only " +
      "recreating the name exactly brings them back."
    );
    if (!ok) return;

    foundDelete.disabled = true;
    api("DELETE", { key: editingKey })
      .then(function () {
        UI.message(statusEl, "info", '"' + editingKey + '" is gone.');
        delete live[editingKey];
        renderCount();
        resetScan();
      })
      .catch(function (err) { setError(foundError, err.message); })
      .then(function () { foundDelete.disabled = false; });
  });

  // ---- Dropzone -----------------------------------------------------------

  browseBtn.addEventListener("click", function (e) { e.stopPropagation(); qrFile.click(); });
  qrFile.addEventListener("change", function () { readFile(qrFile.files[0]); });

  dropzone.addEventListener("click", function (e) {
    if (e.target.closest("button")) return;
    qrFile.click();
  });

  ["dragenter", "dragover"].forEach(function (type) {
    dropzone.addEventListener(type, function (e) { e.preventDefault(); dropzone.classList.add("is-drag"); });
  });
  ["dragleave", "drop"].forEach(function (type) {
    dropzone.addEventListener(type, function (e) { e.preventDefault(); dropzone.classList.remove("is-drag"); });
  });
  dropzone.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });

  // A screenshot straight from the clipboard, which is how most people will
  // have the code to hand.
  window.addEventListener("paste", function (e) {
    if (panelChange.hidden || !e.clipboardData) return;
    var items = e.clipboardData.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image/") === 0) {
        var file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          if (dropzone.hidden) resetScan();
          return readFile(file);
        }
      }
    }
  });

  // ---- Codes made here ----------------------------------------------------

  // Every code on the site, not just ones made in this browser — the admin
  // token can see and change all of them.
  function renderMine() {
    var keys = Object.keys(live).sort();
    known.hidden = !keys.length || !found.hidden || !foreign.hidden || !nameLookup.hidden;
    rowsEl.innerHTML = "";

    keys.forEach(function (key) {
      var entry = live[key];
      var hits = entry.hits || 0;
      var row = document.createElement("div");
      row.className = "link-row";
      row.innerHTML =
        '<div class="known-row">' +
          '<div class="known-main">' +
            '<span class="known-key mono">/go/' + UI.escapeHtml(key) + "</span>" +
            '<span class="known-url">' + UI.escapeHtml(entry.url || "") + "</span>" +
          "</div>" +
          '<div class="known-side">' +
            (hits ? '<span class="lr-hits">' + hits + " scan" + (hits === 1 ? "" : "s") + "</span>" : "") +
            '<button class="btn btn-secondary btn-sm known-edit" type="button">Change</button>' +
          "</div>" +
        "</div>";

      row.querySelector(".known-edit").addEventListener("click", function () {
        showFound(entry);
      });

      rowsEl.appendChild(row);
    });
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
    refresh();
  }

  // The list doubles as the credential check: it is admin-only, so a token
  // that can read it is a token that works.
  function refresh() {
    return api("GET")
      .then(function (data) {
        live = {};
        (data.links || []).forEach(function (l) { live[l.key] = l; });
        renderCount();
        renderMine();
        return true;
      });
  }

  gateForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var candidate = gateToken.value.trim();
    if (!candidate) return;

    gateSubmit.disabled = true;
    gateSubmit.textContent = "Checking…";
    setToken(candidate);

    refresh()
      .then(function () {
        gateToken.value = "";
        showWorkspace();
      })
      .catch(function (err) {
        setToken("");
        // The API answers 404 to anyone without the token, so say something
        // useful rather than passing that through.
        showGate(err.status === 404 ? "That password isn't right." : err.message);
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

  function renderCount() {
    var n = Object.keys(live).length;
    liveCount.textContent = n
      ? n + (n === 1 ? " code is live." : " codes are live.") + " Changes apply on the next scan."
      : "No codes yet.";
  }

  // ---- Boot ---------------------------------------------------------------

  createState();
  token = getToken();
  if (token) {
    refresh().then(showWorkspace, function () { setToken(""); showGate(""); });
  } else {
    showGate("");
  }
})();
