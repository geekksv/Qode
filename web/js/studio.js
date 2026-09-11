// Page logic for the QR Studio (index.html): fifteen content types wired to
// the WASM-backed encoder and the qrRenderer styling layer, plus the live
// readout that reports encode time and code geometry.
//
// Two kinds of type live here:
//
//   Self-contained — the payload IS the QR content. A phone decodes it with
//   no network at all: mailto:, tel:, sms:, WIFI:, vCard, iCalendar, geo:,
//   upi://, bitcoin:, and plain URLs. These work forever, offline, with
//   nothing hosted anywhere.
//
//   Dispatched — App and Social need a page to make a decision (which store
//   to send this phone to; render a list of links). Both encode a Qode /r
//   address with the whole payload packed into the URL fragment, which
//   browsers never transmit to a server. So they behave like the paid
//   "dynamic" codes competitors sell, while Qode still stores nothing and
//   has no idea where any code points.
//
// The preview has four states and every path lands in exactly one:
// loading (engine downloading), empty (nothing entered), error (engine
// failed, or content won't fit), ready.
(function () {
  "use strict";

  var UI = window.QodeUI;

  var contentForm = document.getElementById("content-form");
  var output = document.getElementById("qr-output");
  var readout = document.getElementById("readout");
  var readoutText = document.getElementById("readout-text");
  var exportPng = document.getElementById("export-png");
  var exportSvg = document.getElementById("export-svg");
  var contrastWarning = document.getElementById("contrast-warning");

  var esc = UI.escapeHtml;

  // ---- Small field helpers ----------------------------------------------

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
  }
  function trimmed(id) {
    return val(id).trim();
  }
  function checked(id) {
    var el = document.getElementById(id);
    return !!(el && el.checked);
  }

  // Backslash-escapes the characters that terminate fields in the WIFI:
  // and vCard/iCalendar grammars, so a password containing ';' or a name
  // containing ',' can't truncate or corrupt the payload.
  function wifiEscape(s) {
    return String(s || "").replace(/([\\;,:"])/g, "\\$1");
  }
  function icalEscape(s) {
    return String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }

  // Phone numbers reach dial/chat URLs as digits only (plus a leading +
  // where the scheme allows it); spaces, dashes and parentheses break
  // wa.me and confuse some dialers.
  function digits(s) {
    return String(s || "").replace(/[^\d]/g, "");
  }

  // "2026-09-14T18:30" (the datetime-local format) -> "20260914T183000",
  // iCalendar's floating local time. Floating is deliberate: an event QR is
  // scanned where the event happens, so the wall-clock time is what's meant.
  function icalDate(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ""));
    if (!m) return "";
    return m[1] + m[2] + m[3] + "T" + m[4] + m[5] + "00";
  }

  function field(label, inputHtml, hint) {
    return (
      '<div class="field">' + label + inputHtml +
      (hint ? '<p class="field-hint">' + hint + "</p>" : "") +
      "</div>"
    );
  }

  // Absolute /r address for a dispatched code. Uses the live origin so a
  // code built on a preview deployment points back at that deployment.
  function rLink(prefix, payload) {
    return window.location.origin + "/r#" + prefix + "." + UI.b64url(JSON.stringify(payload));
  }

  // ---- Image hosting (ImgBB) ---------------------------------------------
  //
  // The Image type is the one place Qode sends anything off the device: a
  // QR code cannot carry a photo (2,953 bytes at absolute maximum), so the
  // file has to live somewhere with an address the code can point at.
  //
  // The upload key is public — see js/config.js for why that is unavoidable
  // in a site with no backend, and what to do about it.

  var imageUploads = []; // {name, status, url, deleteUrl, thumb, error}

  function imgbbKey() {
    return (window.QodeConfig && window.QodeConfig.imgbbKey) || "";
  }

  function uploadOne(file) {
    var key = imgbbKey();
    if (!key) return Promise.reject(new Error("No ImgBB key is configured in js/config.js."));

    var endpoint = "https://api.imgbb.com/1/upload?key=" + encodeURIComponent(key);
    var expiry = window.QodeConfig && window.QodeConfig.imgbbExpirySeconds;
    if (expiry) endpoint += "&expiration=" + encodeURIComponent(expiry);

    var body = new FormData();
    body.append("image", file);

    return fetch(endpoint, { method: "POST", body: body })
      .then(
        function (r) { return r.json(); },
        function () { throw new Error("Couldn't reach the image host. Check your connection."); }
      )
      .then(function (json) {
        if (!json || !json.success || !json.data || !json.data.url) {
          // ImgBB reports failures in the body with a 200, so the error text
          // has to come from the payload rather than the status code.
          var msg = json && json.error && json.error.message ? json.error.message : "the host rejected the upload";
          throw new Error("Upload failed — " + msg + ".");
        }
        return {
          url: json.data.url,
          deleteUrl: json.data.delete_url || null,
          thumb: (json.data.thumb && json.data.thumb.url) || json.data.url,
        };
      });
  }

  function uploadImages(files, onChange) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var msg = document.getElementById("ct-img-msg");

    list.forEach(function (file) {
      if (!file.type || file.type.indexOf("image/") !== 0) {
        UI.message(msg, "bad", '"' + file.name + '" isn\'t an image.');
        return;
      }
      // ImgBB's own ceiling; catching it here saves a slow round trip that
      // would only fail at the far end.
      if (file.size > 32 * 1024 * 1024) {
        UI.message(msg, "bad", '"' + file.name + '" is over 32 MB, which the host won\'t accept.');
        return;
      }

      var entry = { name: file.name, status: "uploading", url: null, deleteUrl: null, thumb: null, error: null };
      imageUploads.push(entry);
      renderImageList(onChange);
      UI.message(msg, null);

      uploadOne(file).then(
        function (res) {
          entry.status = "done";
          entry.url = res.url;
          entry.deleteUrl = res.deleteUrl;
          entry.thumb = res.thumb;
          renderImageList(onChange);
          onChange();
        },
        function (err) {
          entry.status = "failed";
          entry.error = err.message;
          renderImageList(onChange);
          UI.message(msg, "bad", err.message);
        }
      );
    });
  }

  function renderImageList(onChange) {
    var list = document.getElementById("ct-img-list");
    if (!list) return;

    list.innerHTML = "";
    imageUploads.forEach(function (entry, i) {
      var row = document.createElement("div");
      row.className = "upload-row";

      var thumb = entry.thumb
        ? '<img class="upload-thumb" src="' + esc(entry.thumb) + '" alt="" />'
        : '<span class="upload-thumb is-empty"></span>';

      var state =
        entry.status === "uploading" ? '<span class="pill">Uploading…</span>'
        : entry.status === "failed" ? '<span class="pill bad">Failed</span>'
        : '<span class="pill ok">Hosted</span>';

      row.innerHTML =
        thumb +
        '<span class="upload-meta">' +
          '<span class="upload-name">' + esc(entry.name) + "</span>" +
          (entry.url ? '<span class="upload-url mono">' + esc(entry.url) + "</span>"
                     : entry.error ? '<span class="upload-url">' + esc(entry.error) + "</span>" : "") +
        "</span>" +
        state +
        '<button class="repeater-del" type="button" aria-label="Remove ' + esc(entry.name) + '">' +
          '<svg viewBox="0 0 22 22" aria-hidden="true"><use href="#i-trash" /></svg></button>';

      row.querySelector(".repeater-del").addEventListener("click", function () {
        // The file stays on the host; this only drops it from the code. The
        // host's own delete link is surfaced below so it can be removed for
        // real, which we can't do on the user's behalf without their session.
        imageUploads.splice(i, 1);
        renderImageList(onChange);
        onChange();
      });

      list.appendChild(row);
    });

    // A gallery heading only means anything once there's more than one image.
    var titleField = document.getElementById("ct-img-title-field");
    if (titleField) titleField.hidden = imageUploads.filter(function (u) { return u.url; }).length < 2;

    var deletable = imageUploads.filter(function (u) { return u.deleteUrl; });
    if (deletable.length) {
      var note = document.createElement("p");
      note.className = "field-hint";
      note.innerHTML =
        "Remove a file from the host itself: " +
        deletable
          .map(function (u) {
            return '<a href="' + esc(u.deleteUrl) + '" target="_blank" rel="noopener noreferrer">' +
                   esc(u.name) + "</a>";
          })
          .join(", ");
      list.appendChild(note);
    }
  }

  // ---- Content types -----------------------------------------------------
  // Each owns a form (rendered into #content-form) and a build() that turns
  // the current values into the exact string handed to the encoder. build()
  // returns "" while the fields that actually matter are empty, giving
  // regenerate() one rule across every type: no data, no code.

  var TYPES = {
    link: {
      empty: "Enter a URL to generate a code.",
      render: function (prefill) {
        return field(
          '<label for="ct-url">Destination URL</label>',
          '<input type="url" id="ct-url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://example.com" value="' +
            esc(prefill || window.location.origin) + '" />',
          "Shorter URLs produce a lower version — chunkier modules that scan from further away."
        );
      },
      build: function () { return trimmed("ct-url"); },
    },

    text: {
      empty: "Type something to generate a code.",
      render: function () {
        return field(
          '<label for="ct-text">Text</label>',
          '<textarea id="ct-text" placeholder="A note, a quote, a serial number…">Hello from Qode</textarea>',
          "Stored inside the code itself — it works with no internet connection at all."
        );
      },
      build: function () { return val("ct-text"); },
    },

    email: {
      empty: "Enter a recipient address to generate a code.",
      render: function () {
        return (
          field('<label for="ct-email-to">To</label>',
            '<input type="email" id="ct-email-to" autocomplete="email" spellcheck="false" placeholder="someone@example.com" />') +
          field('<label for="ct-email-subject">Subject</label>',
            '<input type="text" id="ct-email-subject" placeholder="Optional" />') +
          field('<label for="ct-email-body">Message</label>',
            '<textarea id="ct-email-body" placeholder="Optional"></textarea>')
        );
      },
      build: function () {
        var to = trimmed("ct-email-to");
        if (!to) return "";
        var params = [];
        var subject = trimmed("ct-email-subject");
        var body = trimmed("ct-email-body");
        if (subject) params.push("subject=" + encodeURIComponent(subject));
        if (body) params.push("body=" + encodeURIComponent(body));
        return "mailto:" + to + (params.length ? "?" + params.join("&") : "");
      },
    },

    phone: {
      empty: "Enter a phone number to generate a code.",
      render: function () {
        return field(
          '<label for="ct-phone">Phone number</label>',
          '<input type="tel" id="ct-phone" inputmode="tel" autocomplete="tel" placeholder="+1 555 123 4567" />',
          "Include the country code so the code works wherever it's scanned."
        );
      },
      build: function () {
        var p = trimmed("ct-phone");
        return p ? "tel:" + p.replace(/[^\d+]/g, "") : "";
      },
    },

    sms: {
      empty: "Enter a phone number to generate a code.",
      render: function () {
        return (
          field('<label for="ct-sms-phone">Phone number</label>',
            '<input type="tel" id="ct-sms-phone" inputmode="tel" placeholder="+1 555 123 4567" />') +
          field('<label for="ct-sms-body">Pre-filled message</label>',
            '<textarea id="ct-sms-body" placeholder="Optional"></textarea>')
        );
      },
      build: function () {
        var phone = trimmed("ct-sms-phone");
        if (!phone) return "";
        var body = trimmed("ct-sms-body");
        return "sms:" + phone.replace(/[^\d+]/g, "") + (body ? "?body=" + encodeURIComponent(body) : "");
      },
    },

    whatsapp: {
      empty: "Enter a WhatsApp number to generate a code.",
      render: function () {
        return (
          field('<label for="ct-wa-phone">WhatsApp number</label>',
            '<input type="tel" id="ct-wa-phone" inputmode="tel" placeholder="+91 98765 43210" />',
            "Country code required. Spaces and dashes are stripped automatically.") +
          field('<label for="ct-wa-msg">Pre-filled message</label>',
            '<textarea id="ct-wa-msg" placeholder="Optional — e.g. Hi, I&#39;d like to order…"></textarea>')
        );
      },
      build: function () {
        // wa.me requires a bare international number: no +, no separators.
        var num = digits(trimmed("ct-wa-phone"));
        if (!num) return "";
        var msg = trimmed("ct-wa-msg");
        return "https://wa.me/" + num + (msg ? "?text=" + encodeURIComponent(msg) : "");
      },
    },

    wifi: {
      empty: "Enter a network name to generate a code.",
      render: function () {
        return (
          field('<label for="ct-wifi-ssid">Network name (SSID)</label>',
            '<input type="text" id="ct-wifi-ssid" spellcheck="false" placeholder="My Network" />') +
          '<div class="field-row">' +
            field('<label for="ct-wifi-pass">Password</label>',
              '<input type="text" id="ct-wifi-pass" spellcheck="false" placeholder="Leave blank if open" />') +
            field('<label for="ct-wifi-enc">Security</label>',
              '<select id="ct-wifi-enc">' +
              '<option value="WPA" selected>WPA / WPA2 / WPA3</option>' +
              '<option value="WEP">WEP</option>' +
              '<option value="nopass">None (open)</option></select>') +
          "</div>" +
          field('<label class="check"><input type="checkbox" id="ct-wifi-hidden" /> Hidden network</label>', "",
            "Anyone who scans this joins the network — print it only where you'd share the password anyway.")
        );
      },
      build: function () {
        var ssidRaw = trimmed("ct-wifi-ssid");
        if (!ssidRaw) return "";
        var enc = val("ct-wifi-enc") || "WPA";
        return (
          "WIFI:T:" + enc + ";S:" + wifiEscape(ssidRaw) + ";" +
          (enc !== "nopass" ? "P:" + wifiEscape(trimmed("ct-wifi-pass")) + ";" : "") +
          "H:" + (checked("ct-wifi-hidden") ? "true" : "false") + ";;"
        );
      },
    },

    vcard: {
      empty: "Enter a name to generate a code.",
      render: function () {
        return (
          '<div class="field-row">' +
            field('<label for="ct-vc-first">First name</label>',
              '<input type="text" id="ct-vc-first" autocomplete="given-name" placeholder="Jane" />') +
            field('<label for="ct-vc-last">Last name</label>',
              '<input type="text" id="ct-vc-last" autocomplete="family-name" placeholder="Doe" />') +
          "</div>" +
          '<div class="field-row">' +
            field('<label for="ct-vc-phone">Phone</label>',
              '<input type="tel" id="ct-vc-phone" inputmode="tel" placeholder="+1 555 123 4567" />') +
            field('<label for="ct-vc-email">Email</label>',
              '<input type="email" id="ct-vc-email" spellcheck="false" placeholder="jane@example.com" />') +
          "</div>" +
          '<div class="field-row">' +
            field('<label for="ct-vc-org">Organization</label>',
              '<input type="text" id="ct-vc-org" placeholder="Optional" />') +
            field('<label for="ct-vc-title">Job title</label>',
              '<input type="text" id="ct-vc-title" placeholder="Optional" />') +
          "</div>" +
          field('<label for="ct-vc-url">Website</label>',
            '<input type="url" id="ct-vc-url" spellcheck="false" placeholder="Optional" />',
            "Every extra field grows the code. Trim what you don't need if it's getting dense.")
        );
      },
      build: function () {
        var first = trimmed("ct-vc-first");
        var last = trimmed("ct-vc-last");
        if (!first && !last) return "";
        var full = (first + " " + last).trim();
        var lines = [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "N:" + icalEscape(last) + ";" + icalEscape(first) + ";;;",
          "FN:" + icalEscape(full),
        ];
        var org = trimmed("ct-vc-org");
        var title = trimmed("ct-vc-title");
        var phone = trimmed("ct-vc-phone");
        var email = trimmed("ct-vc-email");
        var url = trimmed("ct-vc-url");
        if (org) lines.push("ORG:" + icalEscape(org));
        if (title) lines.push("TITLE:" + icalEscape(title));
        if (phone) lines.push("TEL;TYPE=CELL:" + phone);
        if (email) lines.push("EMAIL:" + email);
        if (url) lines.push("URL:" + url);
        lines.push("END:VCARD");
        return lines.join("\n");
      },
    },

    event: {
      empty: "Enter an event title to generate a code.",
      render: function () {
        return (
          field('<label for="ct-ev-title">Event title</label>',
            '<input type="text" id="ct-ev-title" placeholder="Product launch" />') +
          '<div class="field-row">' +
            field('<label for="ct-ev-start">Starts</label>',
              '<input type="datetime-local" id="ct-ev-start" />') +
            field('<label for="ct-ev-end">Ends</label>',
              '<input type="datetime-local" id="ct-ev-end" />') +
          "</div>" +
          field('<label for="ct-ev-loc">Location</label>',
            '<input type="text" id="ct-ev-loc" placeholder="Optional" />') +
          field('<label for="ct-ev-desc">Description</label>',
            '<textarea id="ct-ev-desc" placeholder="Optional"></textarea>',
            "Scanning adds the event straight to the phone's calendar — no app or internet needed.")
        );
      },
      build: function () {
        var title = trimmed("ct-ev-title");
        if (!title) return "";
        var lines = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          "SUMMARY:" + icalEscape(title),
        ];
        var start = icalDate(val("ct-ev-start"));
        var end = icalDate(val("ct-ev-end"));
        var loc = trimmed("ct-ev-loc");
        var desc = trimmed("ct-ev-desc");
        if (start) lines.push("DTSTART:" + start);
        if (end) lines.push("DTEND:" + end);
        if (loc) lines.push("LOCATION:" + icalEscape(loc));
        if (desc) lines.push("DESCRIPTION:" + icalEscape(desc));
        lines.push("END:VEVENT", "END:VCALENDAR");
        return lines.join("\n");
      },
    },

    location: {
      empty: "Enter a latitude and longitude to generate a code.",
      render: function () {
        return (
          '<div class="field-row">' +
            field('<label for="ct-loc-lat">Latitude</label>',
              '<input type="text" id="ct-loc-lat" inputmode="decimal" placeholder="28.6139" />') +
            field('<label for="ct-loc-lng">Longitude</label>',
              '<input type="text" id="ct-loc-lng" inputmode="decimal" placeholder="77.2090" />') +
          "</div>" +
          '<div class="field">' +
            '<span class="field-label" id="lbl-loc-mode">Open with</span>' +
            '<div class="seg" id="ct-loc-mode" role="radiogroup" aria-labelledby="lbl-loc-mode" data-value="geo">' +
              '<button type="button" role="radio" data-val="geo" aria-checked="true" tabindex="0">Default map app</button>' +
              '<button type="button" role="radio" data-val="maps" aria-checked="false" tabindex="-1">Google Maps link</button>' +
            "</div>" +
            '<p class="field-hint">The <code>geo:</code> scheme opens whichever map app the phone prefers, but iOS support is patchy — pick the Maps link if the code is going to print.</p>' +
          "</div>"
        );
      },
      build: function () {
        var lat = trimmed("ct-loc-lat");
        var lng = trimmed("ct-loc-lng");
        if (!lat || !lng || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) return "";
        var mode = (document.getElementById("ct-loc-mode") || {}).dataset;
        if (mode && mode.value === "maps") {
          return "https://www.google.com/maps/search/?api=1&query=" +
            encodeURIComponent(lat + "," + lng);
        }
        return "geo:" + lat + "," + lng;
      },
      // A segmented control isn't an <input>, so it needs wiring of its own
      // after the form is injected.
      wire: function (onChange) {
        UI.segmented(document.getElementById("ct-loc-mode"), onChange);
      },
    },

    app: {
      empty: "Enter at least one store link to generate a code.",
      render: function () {
        return (
          field('<label for="ct-app-ios">App Store URL (iOS)</label>',
            '<input type="url" id="ct-app-ios" spellcheck="false" placeholder="https://apps.apple.com/app/id…" />') +
          field('<label for="ct-app-android">Play Store URL (Android)</label>',
            '<input type="url" id="ct-app-android" spellcheck="false" placeholder="https://play.google.com/store/apps/details?id=…" />') +
          field('<label for="ct-app-other">Fallback URL (desktop, everything else)</label>',
            '<input type="url" id="ct-app-other" spellcheck="false" placeholder="https://yourapp.com" />',
            "One code, both stores: the scanning phone picks the right one. The choice happens in the visitor's browser — Qode stores nothing.")
        );
      },
      build: function () {
        var ios = trimmed("ct-app-ios");
        var android = trimmed("ct-app-android");
        var other = trimmed("ct-app-other");
        if (!ios && !android && !other) return "";
        var payload = {};
        if (ios) payload.i = ios;
        if (android) payload.a = android;
        if (other) payload.w = other;
        return rLink("a", payload);
      },
    },

    social: {
      empty: "Add at least one link to generate a code.",
      render: function () {
        return (
          field('<label for="ct-soc-title">Page heading</label>',
            '<input type="text" id="ct-soc-title" placeholder="Follow us" />') +
          '<div class="field">' +
            '<span class="field-label">Links</span>' +
            '<div class="repeater" id="ct-soc-rows"></div>' +
            '<button class="btn btn-secondary btn-sm repeater-add" type="button" id="ct-soc-add">' +
              '<svg viewBox="0 0 22 22" aria-hidden="true"><use href="#i-plus" /></svg>Add link</button>' +
            '<p class="field-hint">Scanning opens a small page listing these links. The list travels inside the QR code itself, so there is nothing hosted and nothing to expire.</p>' +
          "</div>"
        );
      },
      build: function () {
        var rows = document.querySelectorAll("#ct-soc-rows .repeater-row");
        var links = [];
        for (var i = 0; i < rows.length; i++) {
          var label = rows[i].querySelector(".r-label").value.trim();
          var url = rows[i].querySelector(".r-url").value.trim();
          if (url) links.push([label || url, url]);
        }
        if (!links.length) return "";
        var payload = { l: links };
        var title = trimmed("ct-soc-title");
        if (title) payload.t = title;
        return rLink("s", payload);
      },
      wire: function (onChange) {
        var rows = document.getElementById("ct-soc-rows");
        var SUGGESTIONS = ["Instagram", "YouTube", "X", "LinkedIn"];

        function addRow(label) {
          var row = document.createElement("div");
          row.className = "repeater-row";
          row.innerHTML =
            '<input type="text" class="r-label" placeholder="Label" value="' + esc(label || "") + '" />' +
            '<input type="url" class="r-url" spellcheck="false" placeholder="https://…" />' +
            '<button class="repeater-del" type="button" aria-label="Remove this link">' +
              '<svg viewBox="0 0 22 22" aria-hidden="true"><use href="#i-trash" /></svg></button>';
          row.querySelector(".repeater-del").addEventListener("click", function () {
            row.remove();
            // Never leave the list empty — an empty repeater looks broken.
            if (!rows.querySelector(".repeater-row")) addRow("");
            onChange();
          });
          Array.prototype.forEach.call(row.querySelectorAll("input"), function (el) {
            el.addEventListener("input", onChange);
          });
          rows.appendChild(row);
          return row;
        }

        addRow(SUGGESTIONS[0]);
        addRow(SUGGESTIONS[1]);

        document.getElementById("ct-soc-add").addEventListener("click", function () {
          var n = rows.querySelectorAll(".repeater-row").length;
          var row = addRow(SUGGESTIONS[n] || "");
          row.querySelector(".r-url").focus();
        });
      },
    },

    image: {
      empty: "Add an image to generate a code.",
      render: function () {
        return (
          '<div class="field">' +
            '<button class="dropzone-mini" type="button" id="ct-img-drop">' +
              '<strong id="ct-img-label">Drop images here, or click to choose</strong>' +
              '<span class="hint">JPG, PNG, GIF or WebP · up to 32 MB each</span>' +
            "</button>" +
            '<input type="file" id="ct-img-file" accept="image/*" multiple hidden />' +
          "</div>" +
          '<div class="upload-list" id="ct-img-list"></div>' +
          '<div class="msg" id="ct-img-msg" role="status"><span></span></div>' +
          '<div class="field" id="ct-img-title-field" hidden>' +
            '<label for="ct-img-title">Gallery heading</label>' +
            '<input type="text" id="ct-img-title" placeholder="Optional" />' +
          "</div>" +
          '<p class="field-hint">' +
            "Unlike every other type here, this one <strong>does</strong> leave your device: the file " +
            "is uploaded to ImgBB, which hosts it publicly, and the code points at that address. " +
            "Don't use it for anything private." +
          "</p>"
        );
      },
      build: function () {
        var ok = imageUploads.filter(function (u) { return u.url; });
        if (!ok.length) return "";
        // One image is just a link to it. Several need a page to lay them
        // out, so they ride in a fragment the same way Social does.
        if (ok.length === 1) return ok[0].url;
        var payload = { i: ok.map(function (u) { return u.url; }) };
        var title = trimmed("ct-img-title");
        if (title) payload.t = title;
        return rLink("g", payload);
      },
      wire: function (onChange) {
        var drop = document.getElementById("ct-img-drop");
        var input = document.getElementById("ct-img-file");
        renderImageList(onChange);
        drop.addEventListener("click", function () { input.click(); });
        input.addEventListener("change", function () {
          uploadImages(input.files, onChange);
          input.value = "";
        });
        UI.dropTarget(drop, function (file) { uploadImages([file], onChange); });
      },
    },

    video: {
      empty: "Paste a video link to generate a code.",
      render: function () {
        return field(
          '<label for="ct-video">Video URL</label>',
          '<input type="url" id="ct-video" spellcheck="false" placeholder="https://youtube.com/watch?v=…" />',
          '<span id="ct-video-note">YouTube, Vimeo, or any direct link. The URL is encoded as-is, so it keeps working as long as the video does.</span>'
        );
      },
      build: function () { return trimmed("ct-video"); },
      wire: function () {
        // Name the detected platform back to the user — cheap reassurance
        // that the link was understood.
        var input = document.getElementById("ct-video");
        var note = document.getElementById("ct-video-note");
        var base = note.textContent;
        input.addEventListener("input", function () {
          var v = input.value;
          var platform =
            /youtube\.com|youtu\.be/i.test(v) ? "YouTube"
            : /vimeo\.com/i.test(v) ? "Vimeo"
            : /tiktok\.com/i.test(v) ? "TikTok"
            : /instagram\.com/i.test(v) ? "Instagram"
            : null;
          note.textContent = platform ? "Detected a " + platform + " link." : base;
        });
      },
    },

    upi: {
      empty: "Enter a UPI ID to generate a code.",
      render: function () {
        return (
          '<div class="field-row">' +
            field('<label for="ct-upi-vpa">UPI ID (VPA)</label>',
              '<input type="text" id="ct-upi-vpa" spellcheck="false" placeholder="name@bank" />') +
            field('<label for="ct-upi-name">Payee name</label>',
              '<input type="text" id="ct-upi-name" placeholder="Acme Store" />') +
          "</div>" +
          '<div class="field-row">' +
            field('<label for="ct-upi-amount">Amount (₹)</label>',
              '<input type="text" id="ct-upi-amount" inputmode="decimal" placeholder="Leave blank for any amount" />') +
            field('<label for="ct-upi-note">Note</label>',
              '<input type="text" id="ct-upi-note" placeholder="Optional" />') +
          "</div>" +
          '<p class="field-hint">Works with GPay, PhonePe, Paytm and any other UPI app. Leaving the amount blank lets the payer type their own — the usual choice for a counter sticker.</p>'
        );
      },
      build: function () {
        var vpa = trimmed("ct-upi-vpa");
        if (!vpa || vpa.indexOf("@") === -1) return "";
        var params = ["pa=" + encodeURIComponent(vpa)];
        var name = trimmed("ct-upi-name");
        var amount = trimmed("ct-upi-amount");
        var note = trimmed("ct-upi-note");
        if (name) params.push("pn=" + encodeURIComponent(name));
        if (amount && !isNaN(parseFloat(amount))) {
          params.push("am=" + encodeURIComponent(parseFloat(amount).toFixed(2)));
        }
        if (note) params.push("tn=" + encodeURIComponent(note));
        params.push("cu=INR");
        return "upi://pay?" + params.join("&");
      },
    },

    crypto: {
      empty: "Enter a wallet address to generate a code.",
      render: function () {
        return (
          '<div class="field-row">' +
            field('<label for="ct-cx-coin">Coin</label>',
              '<select id="ct-cx-coin">' +
              '<option value="bitcoin" selected>Bitcoin</option>' +
              '<option value="ethereum">Ethereum</option>' +
              '<option value="litecoin">Litecoin</option>' +
              '<option value="dogecoin">Dogecoin</option></select>') +
            field('<label for="ct-cx-amount">Amount</label>',
              '<input type="text" id="ct-cx-amount" inputmode="decimal" placeholder="Optional" />') +
          "</div>" +
          field('<label for="ct-cx-addr">Wallet address</label>',
            '<input type="text" id="ct-cx-addr" spellcheck="false" autocapitalize="off" placeholder="bc1q…" />',
            "Check the address character by character against your wallet before printing — a payment sent to a wrong address cannot be recovered.")
        );
      },
      build: function () {
        var addr = trimmed("ct-cx-addr");
        if (!addr) return "";
        var coin = val("ct-cx-coin") || "bitcoin";
        var amount = trimmed("ct-cx-amount");
        var out = coin + ":" + addr;
        if (amount && !isNaN(parseFloat(amount))) {
          // BIP-21 uses "amount"; Ethereum's EIP-681 uses "value".
          out += (coin === "ethereum" ? "?value=" : "?amount=") + parseFloat(amount);
        }
        return out;
      },
    },
  };

  // ---- State -------------------------------------------------------------
  // Dark-modules-on-light-background is the default on purpose: it is the
  // only polarity real-world scanners are guaranteed to read. Inverted codes
  // can look striking but fail on most phone cameras and on libraries like
  // zbar — verified against pyzbar during development.
  var state = {
    type: "link",
    ecc: "M",
    moduleShape: "square",
    eyeShape: "rounded",
    fgColor: "#0a0a0a",
    fgColor2: null,
    bgColor: "#ffffff",
    // ISO/IEC 18004's minimum quiet zone. Below 4 scanning breaks outright,
    // especially with rounded or dot module shapes, so min="4" on the range
    // input enforces it as a hard floor.
    quietZone: 4,
    // A logo is either an uploaded file (logoDataUrl) or one of the built-in
    // samples (logoSample). Never both — picking one clears the other.
    logoDataUrl: null,
    logoSample: null,
    logoRatio: 0.25,
    logoAspect: 1,
    logoAnimation: "none",
  };

  var currentCode = null;
  var engineFailed = false;

  function currentOptions() {
    return {
      moduleShape: state.moduleShape,
      eyeShape: state.eyeShape,
      fgColor: state.fgColor,
      fgColor2: state.fgColor2,
      bgColor: state.bgColor,
      quietZone: state.quietZone,
      cellPx: 10,
      // A built-in mark is handed over as geometry, not as an image: that is
      // what lets it animate, re-tint with the foreground colour, and stay
      // real vector in the SVG export.
      logoGlyph: state.logoSample
        ? { d: state.logoSample.d, tile: state.logoSample.tile, color: state.fgColor }
        : null,
      logoDataUrl: state.logoSample ? null : state.logoDataUrl,
      logoRatio: state.logoRatio,
      logoAspect: state.logoSample ? 1 : state.logoAspect,
      logoAnimation: state.logoAnimation,
    };
  }

  // ---- Preview state machine --------------------------------------------

  function setReadout(kind, text) {
    readout.dataset.state = kind;
    readoutText.textContent = text;
  }

  function setExportsEnabled(on) {
    exportPng.disabled = !on;
    exportSvg.disabled = !on;
  }

  function showLoading() {
    output.innerHTML = '<div class="qr-skeleton"></div>';
    setExportsEnabled(false);
  }

  function showEmpty(reason) {
    output.innerHTML = '<p class="qr-empty">' + esc(reason) + "</p>";
    setReadout("idle", "Waiting for content");
    setExportsEnabled(false);
    currentCode = null;
  }

  function showError(title, detail) {
    output.innerHTML =
      '<div class="qr-error"><strong>' + esc(title) + "</strong>" + esc(detail || "") + "</div>";
    setReadout("error", title);
    setExportsEnabled(false);
    currentCode = null;
  }

  // ---- Contrast check ----------------------------------------------------
  // Relative luminance (WCAG-style), used to warn when foreground and
  // background are too close for a scanner to tell dark from light modules.

  function relativeLuminance(hex) {
    var c = String(hex).replace("#", "");
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var r = parseInt(c.slice(0, 2), 16) / 255;
    var g = parseInt(c.slice(2, 4), 16) / 255;
    var b = parseInt(c.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function updateContrastWarning() {
    var diff = Math.abs(relativeLuminance(state.fgColor) - relativeLuminance(state.bgColor));
    contrastWarning.classList.toggle("is-visible", diff < 0.35);
  }

  // ---- Render + encode ---------------------------------------------------

  function paint(svg) {
    output.innerHTML = '<div class="qr-frame">' + svg + "</div>";
    setExportsEnabled(true);
  }

  // Re-draws the existing module grid with current styling. Cheap — no
  // re-encode — so every colour and shape control calls this directly.
  function render() {
    if (!currentCode) return;
    updateContrastWarning();
    var t0 = performance.now();
    var svg = QRRenderer.renderSVG(currentCode, currentOptions());
    paint(svg);
    var t1 = performance.now();
    setReadout(
      "ready",
      "Redrawn in " + (t1 - t0).toFixed(2) + " ms · v" + currentCode.version + " · " +
        currentCode.size + "×" + currentCode.size + " modules · on-device"
    );
  }

  // Full pass: rebuild the payload, re-encode in Go/WASM, redraw.
  var token = 0;
  function regenerate() {
    if (engineFailed) return;

    var data = "";
    try {
      data = (TYPES[state.type].build() || "").trim();
    } catch (e) {
      data = "";
    }

    if (!data) {
      showEmpty(TYPES[state.type].empty);
      return;
    }

    var mine = ++token;
    if (window.Qode.state !== "ready") showLoading();

    window.Qode.load().then(
      function () {
        if (mine !== token) return; // a newer keystroke superseded this run

        var t0 = performance.now();
        var result = window.qrbitGenerate(data, state.ecc);
        var t1 = performance.now();

        if (!result || !result.ok) {
          showError(
            "That content won't fit in a QR code",
            result && result.error ? " " + result.error
              : " Try shortening it, or lowering the error-correction level."
          );
          return;
        }

        currentCode = {
          version: result.version,
          size: result.size,
          mask: result.mask,
          modules: new Uint8Array(result.modules),
        };

        updateContrastWarning();
        paint(QRRenderer.renderSVG(currentCode, currentOptions()));
        setReadout(
          "ready",
          "Encoded in " + (t1 - t0).toFixed(2) + " ms by Go/WASM · v" + currentCode.version +
            " · " + currentCode.size + "×" + currentCode.size + " · mask " + currentCode.mask +
            " · zero network calls"
        );
      },
      function (err) {
        if (mine !== token) return;
        engineFailed = true;
        showError(
          "The QR engine couldn't start",
          " " + (err && err.message ? err.message : "Check your connection and reload the page.")
        );
      }
    );
  }

  var debouncedRegenerate = UI.debounce(regenerate, 160);

  // ---- Content type + form wiring ---------------------------------------

  function renderContentForm(prefill) {
    var type = TYPES[state.type];
    contentForm.innerHTML = type.render(prefill);
    Array.prototype.forEach.call(contentForm.querySelectorAll("input, textarea, select"), function (el) {
      el.addEventListener("input", debouncedRegenerate);
      el.addEventListener("change", debouncedRegenerate);
    });
    // Types with controls that aren't plain form fields (segmented groups,
    // repeaters) attach their own listeners here.
    if (type.wire) type.wire(debouncedRegenerate);
    return contentForm.querySelector("input, textarea, select");
  }

  UI.tablist(document.getElementById("type-grid"), function (type) {
    state.type = type;
    var first = renderContentForm();
    if (first) first.focus();
    regenerate();
  });

  UI.panelTabs(document.getElementById("design-tabs"));

  // ---- Styling controls --------------------------------------------------

  var eccSeg = UI.segmented(document.getElementById("ecc-seg"), function (v) {
    state.ecc = v;
    regenerate();
  });
  UI.segmented(document.getElementById("module-seg"), function (v) {
    state.moduleShape = v;
    render();
  });
  UI.segmented(document.getElementById("eye-seg"), function (v) {
    state.eyeShape = v;
    render();
  });

  function wireColor(inputId, labelId, apply) {
    var input = document.getElementById(inputId);
    var label = document.getElementById(labelId);
    input.addEventListener("input", function () {
      label.textContent = input.value;
      apply(input.value);
      clearPresetSelection();
      render();
    });
    return input;
  }
  var fgInput = wireColor("fg-color", "fg-color-label", function (v) { state.fgColor = v; });
  var fg2Input = wireColor("fg2-color", "fg2-color-label", function (v) { state.fgColor2 = v; });
  var bgInput = wireColor("bg-color", "bg-color-label", function (v) { state.bgColor = v; });

  // Every preset pair clears the contrast threshold, so they double as a
  // known-good escape hatch from a combination that doesn't.
  var PRESETS = [
    { name: "Ink on white", fg: "#0a0a0a", bg: "#ffffff" },
    { name: "Electric blue", fg: "#3b5bff", bg: "#ffffff" },
    { name: "Forest", fg: "#12513a", bg: "#f4f8f5" },
    { name: "Oxblood", fg: "#7a1220", bg: "#fdf7f5" },
    { name: "Deep purple", fg: "#3b1a6b", bg: "#f8f5ff" },
    { name: "Slate on sand", fg: "#1f2933", bg: "#f6f1e7" },
  ];

  var presetRow = document.getElementById("preset-row");
  PRESETS.forEach(function (p) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset";
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", p.name + " colour preset");
    btn.title = p.name;
    btn.style.background = "linear-gradient(135deg, " + p.fg + " 0 50%, " + p.bg + " 50% 100%)";
    btn.addEventListener("click", function () {
      state.fgColor = p.fg;
      state.bgColor = p.bg;
      state.fgColor2 = null;
      fgInput.value = p.fg;
      bgInput.value = p.bg;
      document.getElementById("fg-color-label").textContent = p.fg;
      document.getElementById("bg-color-label").textContent = p.bg;
      gradientToggle.checked = false;
      fg2Field.hidden = true;
      clearPresetSelection();
      btn.setAttribute("aria-pressed", "true");
      render();
    });
    presetRow.appendChild(btn);
  });

  function clearPresetSelection() {
    Array.prototype.forEach.call(presetRow.querySelectorAll(".preset"), function (b) {
      b.setAttribute("aria-pressed", "false");
    });
  }

  var gradientToggle = document.getElementById("gradient-toggle");
  var fg2Field = document.getElementById("fg2-field");
  gradientToggle.addEventListener("change", function () {
    fg2Field.hidden = !gradientToggle.checked;
    state.fgColor2 = gradientToggle.checked ? fg2Input.value : null;
    render();
  });

  var quietRange = document.getElementById("quiet-range");
  var quietVal = document.getElementById("quiet-val");
  quietRange.addEventListener("input", function () {
    state.quietZone = parseInt(quietRange.value, 10);
    quietVal.textContent = quietRange.value;
    render();
  });

  // ---- Built-in logo samples --------------------------------------------
  //
  // Full-colour marks: a coloured tile with a white glyph on it, in the
  // vein of an app icon. Colour is what makes these readable at 60-odd
  // pixels in the middle of a dense code — a thin monochrome line drawing
  // disappears into the modules around it.
  //
  // They are original artwork, not brand marks. Bundling real logos —
  // Instagram, WhatsApp, YouTube — into a tool that hands people
  // downloadable, printable files means redistributing trademarks under
  // terms we cannot honour on the user's behalf, so the set covers the same
  // situations generically: the thing the code is FOR, rather than the
  // platform it points at.
  //
  // Each is a 24×24 path plus a tile colour, inlined as real geometry so it
  // can animate and stays true vector all the way through the SVG export.

  var SAMPLE_LOGOS = [
    { key: "portfolio", name: "Portfolio", tile: "#6366f1", d: "M3 8.5h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-10Z M8.5 8.5V5.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v3 M3 13h18" },
    { key: "wifi", name: "Wi-Fi", tile: "#0ea5e9", d: "M2 8.5a15 15 0 0 1 20 0 M5.5 12.2a10 10 0 0 1 13 0 M9 15.9a5 5 0 0 1 6 0 M12 19.4h.01" },
    { key: "contact", name: "Contact", tile: "#8b5cf6", d: "M3 4.5h18v15H3z M8.5 11.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z M5 16.6a3.8 3.8 0 0 1 7 0 M14.5 9.5h4 M14.5 13.5h4" },
    { key: "location", name: "Location", tile: "#ef4444", d: "M12 21.5s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11Z M12 12.8a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z" },
    { key: "menu", name: "Menu", tile: "#f59e0b", d: "M7 3v8 M4.5 3v4a2.5 2.5 0 0 0 5 0V3 M7 11v10 M17 3c-1.5 0-2.5 2-2.5 5s1 4 2.5 4 2.5-1 2.5-4-1-5-2.5-5Z M17 12v9" },
    { key: "shop", name: "Shop", tile: "#ec4899", d: "M4.5 7.5h15l-1 12a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8l-1-12Z M8.5 10V6a3.5 3.5 0 0 1 7 0v4" },
    { key: "cafe", name: "Café", tile: "#b45309", d: "M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z M17 9.5h1.5a2.5 2.5 0 0 1 0 5H17 M7.5 2v2.5 M11.5 2v2.5" },
    { key: "camera", name: "Photography", tile: "#14b8a6", d: "M4 7.5h3l1.5-2.5h7L17 7.5h3a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5Z M12 16.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z" },
    { key: "music", name: "Music", tile: "#a855f7", d: "M9 18.5V5l10-2v13 M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z M19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" },
    { key: "video", name: "Video", tile: "#dc2626", d: "M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19Z M10 8.5l6 3.5-6 3.5v-7Z" },
    { key: "chat", name: "Chat", tile: "#22c55e", d: "M21 12a8.5 8.5 0 0 1-8.5 8.5H4l2-3.5A8.5 8.5 0 1 1 21 12Z" },
    { key: "mail", name: "Mail", tile: "#3b82f6", d: "M2.5 5.5h19v13h-19z M3.5 6.5l7.4 5.2a2 2 0 0 0 2.2 0l7.4-5.2" },
    { key: "event", name: "Event", tile: "#f43f5e", d: "M3.5 5.5h17v15h-17z M3.5 10h17 M8 2.5v4 M16 2.5v4" },
    { key: "pay", name: "Payment", tile: "#16a34a", d: "M7 4h10 M7 8h10 M14 4c2.6 0 4 1.4 4 3.4 0 2.3-1.8 3.8-4.6 3.8H7l8 9" },
    { key: "star", name: "Reviews", tile: "#eab308", d: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3Z" },
    { key: "heart", name: "Favourite", tile: "#e11d48", d: "M12 20.5S3.5 15.3 3.5 9.2a4.7 4.7 0 0 1 8.5-2.8 4.7 4.7 0 0 1 8.5 2.8c0 6.1-8.5 11.3-8.5 11.3Z" },
  ];

  // ---- Logo --------------------------------------------------------------

  var logoDrop = document.getElementById("logo-drop");
  var logoFile = document.getElementById("logo-file");
  var logoControls = document.getElementById("logo-controls");
  var logoDropLabel = document.getElementById("logo-drop-label");
  var logoSize = document.getElementById("logo-size");
  var logoSizeVal = document.getElementById("logo-size-val");
  var logoSamples = document.getElementById("logo-samples");

  SAMPLE_LOGOS.forEach(function (sample) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "logo-sample";
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", sample.name + " logo");
    btn.title = sample.name;
    // The swatch shows the mark exactly as it will appear in the code.
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect width="24" height="24" rx="6" fill="' + sample.tile + '"/>' +
      '<g transform="translate(3.6 3.6) scale(0.7)"><path d="' + sample.d +
      '" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g></svg>';
    btn.addEventListener("click", function () { selectSample(sample, btn); });
    logoSamples.appendChild(btn);
  });

  // Shared tail for both ways of attaching a logo.
  function afterLogoChange() {
    logoControls.hidden = false;
    syncAnimAvailability();
    // A logo covers real data and EC modules, so bump error correction to H
    // (the highest recovery level) unless the user already chose it.
    if (state.ecc !== "H") {
      state.ecc = "H";
      eccSeg.set("H"); // silent: regenerate() is called directly below
      regenerate();
    } else {
      render();
    }
  }

  function setLogo(dataUrl, filename, aspect) {
    state.logoDataUrl = dataUrl;
    state.logoSample = null;
    state.logoAspect = aspect || 1;
    clearSampleSelection();
    logoDropLabel.textContent = filename ? "✓ " + filename : "Logo attached";
    afterLogoChange();
  }

  function clearSampleSelection() {
    Array.prototype.forEach.call(logoSamples.querySelectorAll(".logo-sample"), function (b) {
      b.setAttribute("aria-pressed", "false");
    });
  }

  function selectSample(sample, btn) {
    state.logoSample = sample;
    state.logoDataUrl = null;
    state.logoAspect = 1;
    logoFile.value = "";
    logoDropLabel.textContent = "Drop an image, or click to upload";
    clearSampleSelection();
    btn.setAttribute("aria-pressed", "true");
    afterLogoChange();
  }

  // Measures the image before drawing it, so the renderer can shape the logo
  // box to the artwork instead of squashing every logo into a square. An SVG
  // with only a viewBox (no width/height) reports 0 in some browsers, hence
  // the fallback to a 1:1 box.
  function measureAspect(dataUrl) {
    return new Promise(function (resolve) {
      var probe = new Image();
      var done = false;
      var finish = function (a) {
        if (done) return;
        done = true;
        resolve(a);
      };
      probe.onload = function () {
        finish(probe.naturalWidth > 0 && probe.naturalHeight > 0
          ? probe.naturalWidth / probe.naturalHeight
          : 1);
      };
      probe.onerror = function () { finish(1); };
      setTimeout(function () { finish(1); }, 4000);
      probe.src = dataUrl;
    });
  }

  function handleLogoFile(file) {
    if (!file) return;
    if (!file.type || file.type.indexOf("image/") !== 0) {
      logoDropLabel.textContent = "That file isn't an image — try a PNG or SVG";
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      logoDropLabel.textContent = "That image is over 2 MB — try a smaller one";
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      measureAspect(reader.result).then(function (aspect) {
        setLogo(reader.result, file.name, aspect);
      });
    };
    reader.onerror = function () { logoDropLabel.textContent = "Couldn't read that file"; };
    reader.readAsDataURL(file);
  }

  logoDrop.addEventListener("click", function () { logoFile.click(); });
  logoFile.addEventListener("change", function () { handleLogoFile(logoFile.files[0]); });
  UI.dropTarget(logoDrop, handleLogoFile);

  logoSize.addEventListener("input", function () {
    state.logoRatio = parseInt(logoSize.value, 10) / 100;
    logoSizeVal.textContent = logoSize.value + "%";
    render();
  });

  // ---- Logo animation ----------------------------------------------------

  var animSegEl = document.getElementById("logo-anim-seg");
  var animHint = document.getElementById("logo-anim-hint");
  var drawBtn = animSegEl.querySelector('[data-val="draw"]');
  var animSeg = UI.segmented(animSegEl, function (v) {
    state.logoAnimation = v;
    render();
  });

  // "Draw" retraces an outline, which only exists for the built-in marks —
  // an uploaded PNG has no path to follow. Rather than silently doing
  // nothing, the option is disabled and says why.
  function syncAnimAvailability() {
    var canDraw = !!state.logoSample;
    drawBtn.disabled = !canDraw;
    drawBtn.title = canDraw ? "" : "Draw retraces an outline — available for the built-in marks";
    if (!canDraw && state.logoAnimation === "draw") {
      state.logoAnimation = "pulse";
      animSeg.set("pulse");
    }
    animHint.textContent = state.logoSample
      ? "Animation lives in the SVG, so it plays on a website, in a slide, and on any screen. A PNG is a single still frame."
      : "Uploaded images can move, but only the built-in marks can retrace their own outline.";
  }

  document.getElementById("logo-clear").addEventListener("click", function () {
    state.logoDataUrl = null;
    state.logoSample = null;
    state.logoAspect = 1;
    clearSampleSelection();
    logoDropLabel.textContent = "Drop an image, or click to upload";
    logoControls.hidden = true;
    logoFile.value = "";
    render();
    logoDrop.focus();
  });

  // ---- Export ------------------------------------------------------------

  function exportName(ext) {
    return "qode-" + state.type + "." + ext;
  }

  // A raster export is a single frame, and the frame a rasteriser captures is
  // the animation's FIRST one — which for "draw" is the outline before any of
  // it has been drawn, i.e. an empty plate. So a PNG is always rendered from
  // the finished, un-animated artwork. The SVG keeps the animation.
  function stillOptions() {
    var o = currentOptions();
    o.logoAnimation = "none";
    return o;
  }

  exportSvg.addEventListener("click", function () {
    if (!currentCode) return;
    var svg = QRRenderer.renderSVG(currentCode, currentOptions());
    UI.download(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), exportName("svg"));
  });

  exportPng.addEventListener("click", function () {
    if (!currentCode) return;
    var original = exportPng.innerHTML;
    exportPng.disabled = true;
    exportPng.textContent = "Rendering…";
    QRRenderer.svgToPngBlob(QRRenderer.renderSVG(currentCode, stillOptions()), 1200)
      .then(function (blob) { UI.download(blob, exportName("png")); })
      .catch(function () {
        setReadout("error", "PNG export failed — the SVG download still works.");
      })
      .then(function () {
        exportPng.innerHTML = original;
        exportPng.disabled = false;
      });
  });

  // ---- Engine status feedback -------------------------------------------

  window.Qode.onProgress(function (engineState, err) {
    if (engineState === "loading" && !currentCode) {
      setReadout("idle", "Downloading the Go/WASM engine (~3 MB, once per visit)…");
    } else if (engineState === "failed") {
      engineFailed = true;
      showError(
        "The QR engine couldn't start",
        " " + (err && err.message ? err.message : "Check your connection and reload the page.")
      );
    }
  });

  // ---- Boot --------------------------------------------------------------
  // A `?data=` parameter is the hand-off from the Dynamic Link Wizard.

  var deepLinkData = new URLSearchParams(window.location.search).get("data");
  renderContentForm(deepLinkData);
  showLoading();
  regenerate();
})();
