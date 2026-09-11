// Page logic for the Dynamic Link Wizard: helps the visitor pick and
// validate a free, self-editable destination (Notion, Google Docs/Forms/
// Sheets, Linktree, Carrd), then hands the validated URL to the Studio,
// which encodes it into a Qode /r link via the Go/WASM engine.
//
// A note on verification honesty: almost every provider here blocks
// cross-origin reads, so the browser genuinely cannot confirm a link is
// live. Rather than implying certainty we don't have, each provider
// declares whether a real check is possible, and the copy says exactly
// which kind of check ran.
(function () {
  "use strict";

  var UI = window.QodeUI;

  var PROVIDERS = [
    {
      key: "notion",
      name: "Notion page",
      icon: "i-note",
      placeholder: "https://yourname.notion.site/…",
      regex: /^https:\/\/[\w-]+\.notion\.site\/\S*$/i,
      verifiable: false,
      steps: [
        "Open the Notion page you want people to land on.",
        "Click <strong>Share</strong> at the top right, then turn on <strong>Share to web</strong>.",
        "Copy the public link — it looks like <code>https://yourname.notion.site/…</code>",
      ],
    },
    {
      key: "gdoc",
      name: "Google Doc",
      icon: "i-doc",
      placeholder: "https://docs.google.com/document/d/…/pub",
      regex: /^https:\/\/docs\.google\.com\/document\/d\/[^/]+\/pub/i,
      verifiable: false,
      steps: [
        "In Google Docs, choose <strong>File → Share → Publish to web</strong>.",
        "Click <strong>Publish</strong>, then copy the generated link.",
        "Later text edits appear at that same link automatically — no republishing needed.",
      ],
    },
    {
      key: "gform",
      name: "Google Form",
      icon: "i-form",
      placeholder: "https://docs.google.com/forms/d/e/…/viewform",
      regex: /^https:\/\/docs\.google\.com\/forms\/d\/e\/[^/]+\/viewform/i,
      verifiable: false,
      steps: [
        "Open your form, click <strong>Send</strong>, then choose the link icon.",
        "Copy the shareable link — it contains <code>/viewform</code>.",
        "Good for signage that collects responses; you can edit the questions any time.",
      ],
    },
    {
      key: "gsheet",
      name: "Google Sheet",
      icon: "i-sheet",
      placeholder: "https://docs.google.com/spreadsheets/d/…/pub?output=csv",
      regex: /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/pub\?output=csv/i,
      verifiable: true,
      steps: [
        "In Google Sheets, choose <strong>File → Share → Publish to web</strong>.",
        "Under <strong>Link</strong>, change the format to <strong>Comma-separated values (.csv)</strong>.",
        "Copy that link. This is the one provider we can genuinely verify live, because CSV publishing permits cross-origin reads.",
      ],
    },
    {
      key: "linktree",
      name: "Linktree",
      icon: "i-link",
      placeholder: "https://linktr.ee/yourname",
      regex: /^https:\/\/linktr\.ee\/[\w.-]+\/?$/i,
      verifiable: false,
      steps: [
        "Create or open your page at <code>linktr.ee</code>.",
        "Add or edit the links you want people to find.",
        "Copy your public profile URL, e.g. <code>https://linktr.ee/yourname</code>",
      ],
    },
    {
      key: "carrd",
      name: "Carrd site",
      icon: "i-page",
      placeholder: "https://yourname.carrd.co",
      regex: /^https:\/\/[\w-]+\.carrd\.co\/?\S*$/i,
      verifiable: false,
      steps: [
        "Build a free one-page site at <code>carrd.co</code>.",
        "Publish it on the free <code>*.carrd.co</code> subdomain.",
        "Copy the published URL.",
      ],
    },
    {
      // The mechanism works with ANY address the owner can edit later — the
      // six providers above exist to help someone who doesn't have one yet,
      // not to restrict someone who does. Without this option the wizard
      // rejects a perfectly good URL for no reason.
      key: "custom",
      name: "Any other link",
      stepTitle: "What makes a good destination",
      icon: "i-external",
      placeholder: "https://your-page.example.com",
      // Permissive on purpose: scheme, a host with a dot, no whitespace.
      // Anything more specific would start guessing at what a valid
      // destination looks like, which is the mistake being fixed here.
      regex: /^https?:\/\/[^\s/?#]+\.[^\s/?#]+(\/\S*)?$/i,
      verifiable: false,
      custom: true,
      steps: [
        "Use any page you'll still be able to edit after the code is printed — your own site, a CMS page, a hosted document, a link-in-bio profile.",
        "Check it opens publicly, with no login and no <em>request access</em> screen, in a private window.",
        "Make sure the address itself won't change. The code points at the address, so the page can change all it likes — the URL can't.",
      ],
    },
  ];

  var grid = document.getElementById("provider-grid");
  var step1 = document.getElementById("step-1");
  var step2 = document.getElementById("step-2");
  var step3 = document.getElementById("step-3");
  var step2Title = document.getElementById("step-2-title");
  var providerSteps = document.getElementById("provider-steps");
  var linkInput = document.getElementById("link-input");
  var validationMsg = document.getElementById("validation-msg");
  var openLink = document.getElementById("open-link");
  var useLinkBtn = document.getElementById("use-link");

  var selected = null;
  var validatedUrl = null;

  // ---- Provider picker ---------------------------------------------------

  PROVIDERS.forEach(function (p) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "provider";
    btn.dataset.key = p.key;
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML =
      '<svg viewBox="0 0 22 22" aria-hidden="true"><use href="#' + p.icon + '" /></svg>' +
      "<span>" +
      '<span class="provider-name">' + UI.escapeHtml(p.name) + "</span>" +
      (p.verifiable ? '<span class="provider-verify">Live check</span>' : "") +
      "</span>";
    btn.addEventListener("click", function () { select(p, btn); });
    grid.appendChild(btn);
  });

  function select(provider, btn) {
    selected = provider;
    validatedUrl = null;
    useLinkBtn.disabled = true;

    Array.prototype.forEach.call(grid.querySelectorAll(".provider"), function (b) {
      b.setAttribute("aria-pressed", String(b === btn));
    });

    step1.dataset.state = "done";

    step2.hidden = false;
    step2.dataset.state = "active";
    // "Set up your Notion page" reads well; "Set up your Any other link"
    // does not, so a provider may name its own step.
    step2Title.textContent = provider.stepTitle || "Set up your " + provider.name;
    providerSteps.innerHTML = provider.steps.map(function (s) { return "<li><span>" + s + "</span></li>"; }).join("");

    step3.hidden = false;
    step3.dataset.state = "active";
    linkInput.value = "";
    linkInput.placeholder = provider.placeholder;
    openLink.removeAttribute("href");
    UI.message(validationMsg, null);

    linkInput.focus();
  }

  // ---- Validation --------------------------------------------------------

  function validate() {
    var url = linkInput.value.trim();
    useLinkBtn.disabled = true;
    validatedUrl = null;

    if (!url) {
      UI.message(validationMsg, null);
      openLink.removeAttribute("href");
      return;
    }
    if (!selected) return;

    // Only ever expose an http(s) link to the "open in a new tab" button —
    // the value comes from a free-text field, so a javascript: URL typed
    // there must never end up in an href.
    var parsed = null;
    try {
      parsed = new URL(url);
    } catch (e) {
      parsed = null;
    }
    if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
      openLink.href = parsed.href;
    } else {
      openLink.removeAttribute("href");
    }

    if (!selected.regex.test(url)) {
      UI.message(
        validationMsg,
        "bad",
        selected.custom
          ? "That isn't a complete web address. It needs a scheme and a domain — for example " +
            "https://example.com/my-page."
          : "That doesn't look like a public " + selected.name + " link yet. Check you copied the " +
            "published or shared URL rather than the edit URL."
      );
      return;
    }

    // http:// works, but a printed code outlives the decision to use it, and
    // browsers get more hostile to plain http every year. Warn rather than
    // block — some intranet and device pages genuinely have no TLS.
    if (selected.custom && parsed && parsed.protocol === "http:") {
      UI.message(
        validationMsg,
        "warn",
        "That address uses http rather than https. It will work, but browsers increasingly warn on " +
          "insecure pages — use https if the host offers it, since you can't change the code later."
      );
      validatedUrl = url;
      useLinkBtn.disabled = false;
      return;
    }

    if (selected.verifiable) {
      UI.message(validationMsg, "info", "Checking the link is live…");
      fetch(url, { method: "GET" })
        .then(function (resp) {
          if (resp.ok) {
            UI.message(validationMsg, "ok", "Format is right and the link responded successfully. You're set.");
          } else {
            UI.message(
              validationMsg,
              "warn",
              "Format is right, but the link responded with HTTP " + resp.status + ". Check it's still published."
            );
          }
        })
        .catch(function () {
          UI.message(
            validationMsg,
            "warn",
            "Format is right, but we couldn't reach the link from here. That can happen even for valid " +
              "links — use “open in a new tab” to confirm."
          );
        });
    } else {
      // This provider blocks cross-origin reads, so no fetch from the browser
      // can tell a live page from a 404. Say so plainly instead of running a
      // no-cors request whose resolved promise proves nothing.
      UI.message(
        validationMsg,
        "ok",
        selected.custom
          ? "That's a valid address. A browser can't check someone else's site from here, so open it " +
            "in a new tab — ideally in a private window — to confirm it loads for the public."
          : "Format is right. " + selected.name + " blocks cross-origin checks, so we can't confirm it " +
            "loads from here — open it in a new tab to be sure before you print."
      );
    }

    validatedUrl = url;
    useLinkBtn.disabled = false;
  }

  linkInput.addEventListener("input", UI.debounce(validate, 350));
  linkInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !useLinkBtn.disabled) {
      e.preventDefault();
      useLinkBtn.click();
    }
  });

  // ---- Hand-off to the Studio -------------------------------------------

  useLinkBtn.addEventListener("click", function () {
    if (!validatedUrl) return;
    var original = useLinkBtn.innerHTML;
    useLinkBtn.disabled = true;
    useLinkBtn.textContent = "Encoding…";

    window.Qode.load().then(
      function () {
        var encoded = window.qrbitBase64UrlEncode(validatedUrl);
        var rUrl = window.location.origin + "/r#" + encoded;
        step3.dataset.state = "done";
        window.location.href = "/?data=" + encodeURIComponent(rUrl);
      },
      function (err) {
        useLinkBtn.innerHTML = original;
        useLinkBtn.disabled = false;
        UI.message(
          validationMsg,
          "bad",
          "The QR engine couldn't start: " +
            (err && err.message ? err.message : "check your connection and reload the page.")
        );
      }
    );
  });
})();
