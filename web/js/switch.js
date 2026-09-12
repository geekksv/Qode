// Switchable codes: make one, or re-aim one you already printed.
//
// Anyone can use this, which changes what the page has to be careful about.
// Two things follow from it and drive most of what is here:
//
//   1. Photographing a code proves nothing. Anyone can do that to a poster on
//      a wall, so the upload only ever *reads* a code. Changing where it goes
//      needs the edit key issued when it was made.
//
//   2. The edit key is shown once. It is stored server-side only as a hash,
//      so it genuinely cannot be recovered — the page says so plainly rather
//      than letting someone find out later.
//
// Codes made here are remembered in localStorage as a convenience for finding
// them again. That is a notebook, not a login: the key still has to be typed.
(function () {
  "use strict";

  var UI = window.QodeUI;
  var MINE_KEY = "qode-my-codes";
  var JSQR_URL = "/js/vendor/jsqr.js";

  var el = function (id) { return document.getElementById(id); };

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
  var quota = el("quota");

  var keybox = el("keybox");
  var editTokenEl = el("edit-token");
  var copyToken = el("copy-token");
  var ackKey = el("ack-key");

  var dropzone = el("dropzone");
  var browseBtn = el("browse-btn");
  var qrFile = el("qr-file");
  var scanError = el("scan-error");

  var nameLookup = el("name-lookup");
  var lookupKey = el("lookup-key");

  var found = el("found");
  var foundName = el("found-name");
  var foundCurrent = el("found-current");
  var foundToken = el("found-token");
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

  // ---- Remembered codes ---------------------------------------------------

  function mine() {
    try {
      var raw = localStorage.getItem(MINE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function remember(entry) {
    try {
      var list = mine().filter(function (m) { return m.key !== entry.key; });
      list.unshift(entry);
      localStorage.setItem(MINE_KEY, JSON.stringify(list.slice(0, 50)));
    } catch (e) {
      /* private window, or storage full — the code still works */
    }
    renderMine();
  }

  function forget(key) {
    try {
      localStorage.setItem(MINE_KEY, JSON.stringify(
        mine().filter(function (m) { return m.key !== key; })
      ));
    } catch (e) {}
    renderMine();
  }

  function tokenFor(key) {
    var hit = mine().filter(function (m) { return m.key === key; })[0];
    return hit ? hit.token : "";
  }

  // ---- API ----------------------------------------------------------------

  function api(method, body, query) {
    var opts = { method: method, headers: {}, cache: "no-store" };
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
        remember({ key: data.link.key, token: data.editToken, url: data.link.url, createdAt: data.link.createdAt });
        showToken(data.editToken);
        setQuota(data.remaining);
        newKey.value = "";
        newUrl.value = "";
        return showCode(data.link.key, data.link.url);
      })
      .catch(function (err) {
        setError(createError, err.message);
        if (err.status === 429 && err.data && typeof err.data.used === "number") setQuota(0);
      })
      .then(function () {
        createBtn.textContent = "Generate code";
        createState();
      });
  });

  function setQuota(remaining) {
    if (remaining === null || remaining === undefined) { quota.textContent = ""; return; }
    quota.textContent = remaining > 0
      ? remaining + (remaining === 1 ? " code" : " codes") + " left today"
      : "No codes left today";
    quota.classList.toggle("is-out", remaining <= 0);
  }

  function showToken(token) {
    keybox.hidden = false;
    editTokenEl.textContent = token;
    ackKey.checked = false;
    keybox.classList.remove("is-acked");
  }

  ackKey.addEventListener("change", function () {
    keybox.classList.toggle("is-acked", ackKey.checked);
    if (ackKey.checked) editTokenEl.classList.add("is-dim");
    else editTokenEl.classList.remove("is-dim");
  });

  copyToken.addEventListener("click", function () {
    var text = editTokenEl.textContent;
    var done = function () {
      copyToken.textContent = "Copied";
      setTimeout(function () { copyToken.textContent = "Copy"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
    function fallback() {
      // execCommand is deprecated but is the only option on http:// origins
      // and in older in-app browsers.
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) {}
      ta.remove();
    }
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
    foundToken.value = tokenFor(link.key);
    foundState();
    (foundToken.value ? foundUrl : foundToken).focus();
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
    foundToken.value = "";
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
    foundSave.disabled = !!problem || !changed || !foundToken.value.trim();
    setError(foundError, url ? problem : null);
  }

  foundUrl.addEventListener("input", foundState);
  foundToken.addEventListener("input", foundState);

  foundSave.addEventListener("click", function () {
    if (!editingKey) return;
    var url = foundUrl.value.trim();
    var problem = urlProblem(url);
    if (problem) return setError(foundError, problem);

    foundSave.disabled = true;
    foundSave.textContent = "Saving…";
    setError(foundError, null);

    api("PATCH", { key: editingKey, url: url, editToken: foundToken.value.trim() })
      .then(function (data) {
        editingCurrent = data.link.url;
        foundCurrent.textContent = data.link.url;
        if (tokenFor(editingKey)) {
          remember({ key: editingKey, token: foundToken.value.trim(), url: data.link.url, createdAt: data.link.createdAt });
        }
        UI.message(statusEl, "ok",
          "Done. Every printed copy of /go/" + editingKey + " now opens " + data.link.url + ".");
      })
      .catch(function (err) { setError(foundError, err.message); })
      .then(function () {
        foundSave.textContent = "Save new destination";
        foundState();
      });
  });

  foundDelete.addEventListener("click", function () {
    if (!editingKey) return;
    if (!foundToken.value.trim()) {
      return setError(foundError, "Deleting needs the edit key too.");
    }
    var ok = window.confirm(
      'Delete "' + editingKey + '"?\n\n' +
      "Every QR code already printed with this name stops working immediately, and only " +
      "recreating the name exactly brings them back."
    );
    if (!ok) return;

    foundDelete.disabled = true;
    api("DELETE", { key: editingKey, editToken: foundToken.value.trim() })
      .then(function () {
        UI.message(statusEl, "info", '"' + editingKey + '" is gone.');
        forget(editingKey);
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

  function renderMine() {
    var list = mine();
    known.hidden = list.length === 0 || !found.hidden || !foreign.hidden || !nameLookup.hidden;
    rowsEl.innerHTML = "";

    list.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "link-row";
      row.innerHTML =
        '<div class="known-row">' +
          '<div class="known-main">' +
            '<span class="known-key mono">/go/' + UI.escapeHtml(entry.key) + "</span>" +
            '<span class="known-url">' + UI.escapeHtml(entry.url || "") + "</span>" +
          "</div>" +
          '<div class="known-side">' +
            '<button class="btn btn-secondary btn-sm known-edit" type="button">Change</button>' +
            '<button class="repeater-del known-forget" type="button" aria-label="Forget ' +
              UI.escapeHtml(entry.key) + '"><svg viewBox="0 0 22 22" aria-hidden="true"><use href="#i-trash" /></svg></button>' +
          "</div>" +
        "</div>";

      row.querySelector(".known-edit").addEventListener("click", function () {
        api("GET", null, "?key=" + encodeURIComponent(entry.key))
          .then(function (data) { showFound(data.link); })
          .catch(function (err) {
            if (err.status === 404) {
              UI.message(statusEl, "warn",
                '"' + entry.key + '" no longer exists on the server. Removing it from this list.');
              return forget(entry.key);
            }
            UI.message(statusEl, "bad", err.message);
          });
      });

      // Forgets the note, not the code. Worth being explicit about, since the
      // two are easy to confuse and one of them is irreversible.
      row.querySelector(".known-forget").addEventListener("click", function () {
        var ok = window.confirm(
          'Remove "' + entry.key + '" from this list?\n\n' +
          "The code keeps working and stays where it points. This only forgets it here, along " +
          "with the copy of the edit key kept in this browser — so make sure you have that saved."
        );
        if (ok) forget(entry.key);
      });

      rowsEl.appendChild(row);
    });
  }

  // ---- Boot ---------------------------------------------------------------

  createState();
  renderMine();
  setQuota(null);
})();
