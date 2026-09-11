// Standalone, dependency-free resolver for r.html ONLY.
//
// This file never touches WASM or wasm_exec.js: a scan must resolve
// immediately, not wait on a multi-megabyte download. Everything it needs
// lives in the location fragment, which browsers never transmit to any
// server — so Qode has no way to see or record where its codes point, and
// the decode happens entirely in the scanner's own browser.
//
// Three payload shapes share the fragment, told apart by a prefix. The
// base64url alphabet has no ".", so the separator can never collide with
// payload data, and a bare payload (no prefix) stays valid forever —
// that's what every code printed before App and Social existed contains.
//
//   #<b64>      plain URL      → redirect
//   #a.<b64>    app dispatch   → pick a store from the platform, redirect
//   #s.<b64>    link list      → render the links
(function () {
  "use strict";

  // Grace period before offering a manual link. Most redirects fire long
  // before this; when one doesn't — a locked-down in-app webview, a blocked
  // navigation — the visitor gets a real, tappable way through instead of an
  // endless spinner. A printed code isn't something you can re-issue when it
  // dead-ends, so this fallback matters more than it looks.
  var MANUAL_FALLBACK_MS = 1200;

  function base64UrlDecode(str) {
    var s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    // atob yields Latin-1; re-decode as UTF-8 so non-ASCII payloads
    // (internationalised domains, unicode labels) survive the round trip.
    var binary = atob(s);
    try {
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (e) {
      return binary;
    }
  }

  function el(id) {
    return document.getElementById(id);
  }

  function showOnly(id) {
    ["state-redirecting", "state-links", "state-gallery", "state-error"].forEach(function (s) {
      var node = el(s);
      if (node) node.hidden = s !== id;
    });
  }

  function showError(title, detail) {
    showOnly("state-error");
    var t = el("error-title");
    var d = el("error-detail");
    if (t) t.textContent = title;
    if (d && detail) d.textContent = detail;
    document.title = title + " — Qode";
  }

  // Only http(s) is ever followed or rendered. Without this check a
  // hand-crafted fragment could aim a Qode /r link at javascript: or data:,
  // turning every code we generate into a delivery vehicle for someone
  // else's script.
  function safeUrl(raw) {
    var url;
    try {
      url = new URL(String(raw));
    } catch (e) {
      return null;
    }
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  }

  // ---- Mode: plain redirect ---------------------------------------------

  function redirectTo(url) {
    showOnly("state-redirecting");

    var skeleton = el("target-skeleton");
    var targetEl = el("target");
    if (skeleton) skeleton.hidden = true;
    if (targetEl) {
      targetEl.hidden = false;
      targetEl.textContent = url.href;
    }

    var manualPrompt = el("manual-prompt");
    var manualLink = el("manual-link");
    if (manualLink) manualLink.href = url.href;

    setTimeout(function () {
      if (manualPrompt) manualPrompt.hidden = false;
    }, MANUAL_FALLBACK_MS);

    // replace(), not assign(), so Back returns to whatever preceded the scan
    // rather than bouncing through this page again.
    try {
      window.location.replace(url.href);
    } catch (e) {
      if (manualPrompt) manualPrompt.hidden = false;
    }
  }

  // ---- Mode: app dispatch ------------------------------------------------

  // Deliberately coarse. The only question is which store to open, and the
  // cost of a wrong guess is a fallback link, not a broken page — so this
  // checks for the two platforms that have app stores and treats everything
  // else, including desktop, as "web".
  function detectPlatform() {
    var ua = navigator.userAgent || "";
    var isIOS =
      /iPad|iPhone|iPod/.test(ua) ||
      // iPadOS 13+ reports itself as a Mac; the touch points give it away.
      (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1);
    if (isIOS) return "i";
    if (/Android/i.test(ua)) return "a";
    return "w";
  }

  function dispatchApp(payload) {
    var platform = detectPlatform();
    // Fall back through the other entries rather than dead-ending when the
    // code only carries one store link.
    var order = platform === "i" ? ["i", "w", "a"]
      : platform === "a" ? ["a", "w", "i"]
      : ["w", "i", "a"];

    for (var i = 0; i < order.length; i++) {
      var url = safeUrl(payload[order[i]]);
      if (url) return redirectTo(url);
    }
    showError(
      "This app code has no usable link",
      "None of the store addresses in this code are valid http or https links."
    );
  }

  // ---- Mode: link list ---------------------------------------------------

  function renderLinks(payload) {
    var list = Array.isArray(payload.l) ? payload.l : [];
    var listEl = el("link-list");
    if (!listEl) return showError("This code couldn't be displayed", "");

    listEl.innerHTML = "";
    var shown = 0;

    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!Array.isArray(entry)) continue;
      var url = safeUrl(entry[1]);
      if (!url) continue;

      var li = document.createElement("li");
      var a = document.createElement("a");
      a.className = "link-item";
      a.href = url.href;
      a.rel = "noopener noreferrer";
      // textContent, never innerHTML: the label came out of a QR code that
      // anybody could have generated.
      a.textContent = String(entry[0] || url.hostname);

      var host = document.createElement("span");
      host.className = "link-item-host";
      host.textContent = url.hostname.replace(/^www\./, "");
      a.appendChild(host);

      li.appendChild(a);
      listEl.appendChild(li);
      shown++;
    }

    if (!shown) {
      return showError(
        "This code has no usable links",
        "None of the addresses in this code are valid http or https links."
      );
    }

    var title = payload.t ? String(payload.t) : "Links";
    var titleEl = el("links-title");
    if (titleEl) titleEl.textContent = title;
    document.title = title + " — Qode";
    showOnly("state-links");
  }

  // ---- Mode: image gallery -----------------------------------------------

  function renderGallery(payload) {
    var urls = Array.isArray(payload.i) ? payload.i : [];
    var grid = el("gallery-grid");
    if (!grid) return showError("This code couldn't be displayed", "");

    grid.innerHTML = "";
    var shown = 0;

    for (var i = 0; i < urls.length; i++) {
      var url = safeUrl(urls[i]);
      if (!url) continue;

      var a = document.createElement("a");
      a.className = "gallery-item";
      a.href = url.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";

      var img = document.createElement("img");
      img.src = url.href;
      img.loading = "lazy";
      img.alt = "Image " + (shown + 1);
      // A hosted file can vanish or be replaced; say so rather than leaving a
      // broken frame.
      img.onerror = function () {
        this.remove();
        this.parentNode && this.parentNode.classList.add("is-missing");
      };

      a.appendChild(img);
      grid.appendChild(a);
      shown++;
    }

    if (!shown) {
      return showError(
        "This code has no usable images",
        "None of the addresses in this code are valid http or https links."
      );
    }

    var title = payload.t ? String(payload.t) : "Images";
    var titleEl = el("gallery-title");
    if (titleEl) titleEl.textContent = title;
    document.title = title + " — Qode";
    showOnly("state-gallery");
  }

  // ---- Entry point -------------------------------------------------------

  function run() {
    var raw = window.location.hash.slice(1);

    if (!raw) {
      return showError(
        "This code doesn't carry a destination",
        "The link is missing the part after the # that holds the target. It may have been truncated " +
          "when it was copied."
      );
    }

    // Split an optional single-letter mode prefix off the front.
    var mode = "u";
    var body = raw;
    var dot = raw.indexOf(".");
    if (dot === 1) {
      mode = raw.slice(0, 1);
      body = raw.slice(2);
    }

    var decoded;
    try {
      decoded = base64UrlDecode(body);
    } catch (e) {
      return showError(
        "This code's destination looks malformed",
        "The data encoded in this code isn't readable. If you created it with Qode, generate it " +
          "again and reprint."
      );
    }

    if (mode === "a" || mode === "s" || mode === "g") {
      var payload;
      try {
        payload = JSON.parse(decoded);
      } catch (e) {
        payload = null;
      }
      if (!payload || typeof payload !== "object") {
        return showError(
          "This code's contents look malformed",
          "The data encoded in this code isn't readable. If you created it with Qode, generate it " +
            "again and reprint."
        );
      }
      if (mode === "a") return dispatchApp(payload);
      if (mode === "g") return renderGallery(payload);
      return renderLinks(payload);
    }

    var url = safeUrl(decoded);
    if (!url) {
      // Distinguish "not a URL at all" from "a URL we refuse to follow" —
      // the second is a security decision the visitor deserves to see named.
      var parsed = null;
      try {
        parsed = new URL(decoded);
      } catch (e) { /* not a URL */ }

      if (parsed) {
        return showError(
          "This code points somewhere unsafe",
          "Qode only follows http and https links. This code asked for “" + parsed.protocol +
            "”, which was blocked."
        );
      }
      return showError(
        "This code's destination looks malformed",
        "The address encoded in this code isn't a valid URL. If you created it with Qode, generate " +
          "it again and reprint."
      );
    }

    redirectTo(url);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }

  // A fragment-only change doesn't reload the document, so without this the
  // page would keep showing the previous destination if the hash is replaced
  // in place.
  window.addEventListener("hashchange", run);
})();
