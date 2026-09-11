// Page logic for Bulk generation: CSV parsing (Go/WASM's encoding/csv),
// per-row QR generation (Go/WASM), preview rendering (qrRenderer.js), and
// ZIP bundling (Go/WASM's archive/zip) — all client-side, nothing uploaded.
//
// Bundling is the slow part: each PNG round-trips through an <img> and a
// canvas, so a few hundred rows takes real seconds. It therefore runs as an
// async loop that yields to the event loop between rows and reports progress,
// rather than freezing the tab behind a synchronous burst.
(function () {
  "use strict";

  var UI = window.QodeUI;

  var dropzone = document.getElementById("dropzone");
  var csvFile = document.getElementById("csv-file");
  var results = document.getElementById("results");
  var resultsBody = document.getElementById("results-body");
  var resultsStats = document.getElementById("results-stats");
  var downloadZipBtn = document.getElementById("download-zip");
  var zipProgress = document.getElementById("zip-progress");
  var zipProgressBar = zipProgress.querySelector("span");
  var bulkError = document.getElementById("bulk-error");

  var ecc = "M";
  var format = "png";
  var rows = [];
  var lastCsvText = "";

  UI.segmented(document.getElementById("ecc-seg"), function (v) {
    ecc = v;
    if (lastCsvText) processCsvText(lastCsvText);
  });

  UI.segmented(document.getElementById("format-seg"), function (v) {
    format = v;
  });

  // Thumbnails are decorative and appear hundreds at a time, so they use a
  // minimal quiet zone and a small cell to keep the DOM light. The exported
  // files below use the full ISO quiet zone.
  var PREVIEW_OPTS = {
    moduleShape: "square",
    eyeShape: "rounded",
    fgColor: "#0a0a0a",
    bgColor: "#ffffff",
    quietZone: 4,
    cellPx: 3,
  };
  var EXPORT_OPTS = {
    moduleShape: "square",
    eyeShape: "rounded",
    fgColor: "#000000",
    bgColor: "#ffffff",
    quietZone: 4,
    cellPx: 10,
  };

  function toCode(r) {
    return { version: r.version, size: r.size, mask: r.mask, modules: new Uint8Array(r.modules) };
  }

  // ---- Parse + generate --------------------------------------------------

  function processCsvText(text) {
    lastCsvText = text;
    UI.message(bulkError, null);
    dropzone.classList.add("is-busy");

    window.Qode.load().then(
      function () {
        var result;
        try {
          result = window.qrbitBulkGenerate(text, ecc);
        } catch (e) {
          result = { ok: false, error: String(e && e.message ? e.message : e) };
        }
        dropzone.classList.remove("is-busy");

        if (!result || !result.ok) {
          rows = [];
          results.hidden = true;
          UI.message(
            bulkError,
            "bad",
            "Couldn't parse that CSV: " + (result && result.error ? result.error : "unknown error") +
              " — check every row has the same number of columns."
          );
          return;
        }

        if (!result.rows || !result.rows.length) {
          rows = [];
          results.hidden = true;
          UI.message(bulkError, "bad", "That file had no rows with any data in the first column.");
          return;
        }

        rows = result.rows;
        renderResults();
      },
      function (err) {
        dropzone.classList.remove("is-busy");
        UI.message(
          bulkError,
          "bad",
          "The QR engine couldn't start: " +
            (err && err.message ? err.message : "check your connection and reload the page.")
        );
      }
    );
  }

  function renderResults() {
    var ok = rows.filter(function (r) { return r.ok; }).length;
    var failed = rows.length - ok;

    results.hidden = false;
    resultsStats.innerHTML =
      "<span><b>" + rows.length + "</b> rows</span>" +
      "<span><b>" + ok + "</b> generated</span>" +
      (failed ? "<span><b>" + failed + "</b> failed</span>" : "");

    downloadZipBtn.disabled = ok === 0;

    // One detached fragment, one reflow — a few hundred rows appended
    // individually is visibly slow.
    var frag = document.createDocumentFragment();

    rows.forEach(function (r) {
      var tr = document.createElement("tr");

      if (r.ok) {
        tr.innerHTML =
          '<td><div class="mini-qr">' + QRRenderer.renderSVG(toCode(r), PREVIEW_OPTS) + "</div></td>" +
          "<td>" + UI.escapeHtml(r.label) + "</td>" +
          '<td class="cell-data" title="' + UI.escapeHtml(r.data) + '">' + UI.escapeHtml(r.data) + "</td>" +
          '<td class="cell-ver">v' + r.version + "</td>" +
          '<td><span class="pill ok">OK</span></td>';
      } else {
        tr.innerHTML =
          "<td></td>" +
          "<td>" + UI.escapeHtml(r.label) + "</td>" +
          '<td class="cell-data" title="' + UI.escapeHtml(r.data) + '">' + UI.escapeHtml(r.data) + "</td>" +
          '<td class="cell-ver">—</td>' +
          '<td><span class="pill bad" title="' + UI.escapeHtml(r.error) + '">Failed</span></td>';
      }

      frag.appendChild(tr);
    });

    resultsBody.innerHTML = "";
    resultsBody.appendChild(frag);
    results.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---- ZIP export --------------------------------------------------------

  function safeFilename(label, index, ext) {
    var base = String(label || "")
      .replace(/[^a-z0-9\-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return (base || "code-" + (index + 1)) + "." + ext;
  }

  // Lets the browser paint the progress bar between rows.
  function yieldToBrowser() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  downloadZipBtn.addEventListener("click", function () {
    var okRows = rows.filter(function (r) { return r.ok; });
    if (!okRows.length) return;

    var original = downloadZipBtn.innerHTML;
    downloadZipBtn.disabled = true;
    zipProgress.hidden = false;
    zipProgressBar.style.width = "0%";
    UI.message(bulkError, null);

    var usedNames = Object.create(null);
    var entries = [];
    var encoder = new TextEncoder();

    function uniqueName(label, index, ext) {
      var name = safeFilename(label, index, ext);
      if (!usedNames[name]) {
        usedNames[name] = 1;
        return name;
      }
      // Deterministic de-duplication beats a random suffix: re-running the
      // same CSV produces the same filenames.
      var stem = name.slice(0, -(ext.length + 1));
      var i = 2;
      while (usedNames[stem + "-" + i + "." + ext]) i++;
      var out = stem + "-" + i + "." + ext;
      usedNames[out] = 1;
      return out;
    }

    function step(i) {
      if (i >= okRows.length) return Promise.resolve();

      var r = okRows[i];
      var svg = QRRenderer.renderSVG(toCode(r), EXPORT_OPTS);

      downloadZipBtn.textContent = "Bundling " + (i + 1) + " / " + okRows.length + "…";
      zipProgressBar.style.width = ((i / okRows.length) * 100).toFixed(1) + "%";

      var work;
      if (format === "svg") {
        // No rasterisation needed — the vector text is the file.
        entries.push({ name: uniqueName(r.label, i, "svg"), bytes: encoder.encode(svg) });
        work = Promise.resolve();
      } else {
        work = QRRenderer.svgToPngBlob(svg, 800)
          .then(function (blob) { return blob.arrayBuffer(); })
          .then(function (buf) {
            entries.push({ name: uniqueName(r.label, i, "png"), bytes: new Uint8Array(buf) });
          });
      }

      // Yield every few rows so the progress bar actually moves; yielding on
      // every single row would roughly double the wall-clock time.
      return work.then(function () {
        return i % 8 === 7 ? yieldToBrowser().then(function () { return step(i + 1); }) : step(i + 1);
      });
    }

    step(0)
      .then(function () {
        zipProgressBar.style.width = "100%";
        var zipBytes = window.qrbitZip(entries);
        if (!zipBytes) throw new Error("The ZIP builder returned nothing.");
        UI.download(new Blob([zipBytes], { type: "application/zip" }), "qode-bulk.zip");
      })
      .catch(function (err) {
        UI.message(
          bulkError,
          "bad",
          "Couldn't build the ZIP: " + (err && err.message ? err.message : "unknown error.")
        );
      })
      .then(function () {
        downloadZipBtn.innerHTML = original;
        downloadZipBtn.disabled = false;
        zipProgress.hidden = true;
      });
  });

  // ---- File input --------------------------------------------------------

  function handleFile(file) {
    if (!file) return;
    // Guard against someone dropping a 500MB file and freezing the tab.
    if (file.size > 20 * 1024 * 1024) {
      UI.message(bulkError, "bad", "That file is over 20 MB. Split it into smaller CSVs and run them separately.");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { processCsvText(String(reader.result)); };
    reader.onerror = function () { UI.message(bulkError, "bad", "Couldn't read that file."); };
    reader.readAsText(file);
  }

  // The whole zone is clickable as a convenience for mouse users; the
  // button inside it is the real, keyboard-reachable control.
  document.getElementById("browse-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    csvFile.click();
  });
  dropzone.addEventListener("click", function () { csvFile.click(); });

  csvFile.addEventListener("change", function () {
    handleFile(csvFile.files[0]);
    // Reset so re-selecting the same file still fires a change event.
    csvFile.value = "";
  });
  UI.dropTarget(dropzone, handleFile);
})();
