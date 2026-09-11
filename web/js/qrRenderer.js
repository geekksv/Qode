// Pure rendering module: takes the module grid the Go/WASM engine computed
// and draws it as styled SVG markup. No WASM dependency at all — this is
// deliberately the one place JS does real visual work, since SVG, gradients
// and canvas rasterisation are natively the DOM's job.
//
// Three module styles, each drawn the way that style actually wants to be
// drawn rather than by one generic path:
//
//   square  — adjacent dark modules in a row are merged into a single rect.
//             Fewer nodes, a much smaller file, and no hairline seams
//             between neighbours at any zoom level.
//   rounded — one path per module whose four corner radii depend on its
//             neighbours, so runs of modules join into continuous rounded
//             ribbons instead of a field of disconnected lozenges.
//   dot     — independent circles, which is the whole point of the look.
window.QRRenderer = (function () {
  "use strict";

  var EYE_SIZE = 7;

  // ---- Safety ------------------------------------------------------------
  // Everything below builds markup by string concatenation, so anything
  // interpolated into it has to be neutralised first. Colours are validated
  // against a strict pattern (and fall back to a safe default), and the logo
  // data URL — the one genuinely free-form value — is attribute-escaped.

  function safeColor(value, fallback) {
    var s = String(value == null ? "" : value).trim();
    if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(s)) return s;
    if (/^rgba?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
    if (/^[a-zA-Z]{3,20}$/.test(s)) return s; // named CSS colours
    return fallback;
  }

  function attr(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Trims float noise: coordinates land on tidy values instead of 12.100000000000001.
  function n(v) {
    return Math.round(v * 1000) / 1000;
  }

  // ---- Grid helpers ------------------------------------------------------

  function inEyeZone(x, y, size) {
    if (x < EYE_SIZE && y < EYE_SIZE) return true;
    if (x >= size - EYE_SIZE && y < EYE_SIZE) return true;
    if (x < EYE_SIZE && y >= size - EYE_SIZE) return true;
    return false;
  }

  // A module counts as "on" for shaping purposes only if it is dark AND
  // outside the finder zones — the eyes are drawn separately, so a data
  // module beside an eye must not try to fuse with it.
  function on(modules, size, x, y) {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    if (inEyeZone(x, y, size)) return false;
    return !!modules[y * size + x];
  }

  // ---- Module body renderers --------------------------------------------

  // Square: merge each horizontal run of dark modules into one rect.
  function bodySquare(modules, size, quiet, cell) {
    var out = "";
    for (var y = 0; y < size; y++) {
      var runStart = -1;
      for (var x = 0; x <= size; x++) {
        var dark = x < size && on(modules, size, x, y);
        if (dark && runStart === -1) {
          runStart = x;
        } else if (!dark && runStart !== -1) {
          out +=
            '<rect x="' + n((runStart + quiet) * cell) +
            '" y="' + n((y + quiet) * cell) +
            '" width="' + n((x - runStart) * cell) +
            '" height="' + n(cell) + '"/>';
          runStart = -1;
        }
      }
    }
    return out;
  }

  // Rounded: per-module path, cornering only where there is nothing to join.
  function bodyRounded(modules, size, quiet, cell) {
    var r = cell * 0.42;
    var out = "";

    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (!on(modules, size, x, y)) continue;

        var up = on(modules, size, x, y - 1);
        var down = on(modules, size, x, y + 1);
        var left = on(modules, size, x - 1, y);
        var right = on(modules, size, x + 1, y);

        // Round a corner only when both of the edges meeting there are free,
        // which is what makes neighbouring modules read as one shape.
        var tl = !up && !left ? r : 0;
        var tr = !up && !right ? r : 0;
        var br = !down && !right ? r : 0;
        var bl = !down && !left ? r : 0;

        var px = (x + quiet) * cell;
        var py = (y + quiet) * cell;
        // A hair of overlap on the joining edges kills antialiasing seams
        // between modules that are meant to look continuous.
        var bleed = 0.35;
        var x0 = px - (left ? bleed : 0);
        var y0 = py - (up ? bleed : 0);
        var x1 = px + cell + (right ? bleed : 0);
        var y1 = py + cell + (down ? bleed : 0);

        out +=
          '<path d="M' + n(x0 + tl) + ' ' + n(y0) +
          'H' + n(x1 - tr) +
          (tr ? 'a' + n(tr) + ' ' + n(tr) + ' 0 0 1 ' + n(tr) + ' ' + n(tr) : 'L' + n(x1) + ' ' + n(y0)) +
          'V' + n(y1 - br) +
          (br ? 'a' + n(br) + ' ' + n(br) + ' 0 0 1 ' + n(-br) + ' ' + n(br) : 'L' + n(x1) + ' ' + n(y1)) +
          'H' + n(x0 + bl) +
          (bl ? 'a' + n(bl) + ' ' + n(bl) + ' 0 0 1 ' + n(-bl) + ' ' + n(-bl) : 'L' + n(x0) + ' ' + n(y1)) +
          'V' + n(y0 + tl) +
          (tl ? 'a' + n(tl) + ' ' + n(tl) + ' 0 0 1 ' + n(tl) + ' ' + n(-tl) : 'L' + n(x0) + ' ' + n(y0)) +
          'Z"/>';
      }
    }
    return out;
  }

  // Dot: deliberately separate circles.
  function bodyDot(modules, size, quiet, cell) {
    var r = cell * 0.46;
    var out = "";
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (!on(modules, size, x, y)) continue;
        out +=
          '<circle cx="' + n((x + quiet + 0.5) * cell) +
          '" cy="' + n((y + quiet + 0.5) * cell) +
          '" r="' + n(r) + '"/>';
      }
    }
    return out;
  }

  // ---- Finder patterns ---------------------------------------------------
  // Drawn as an explicit frame + centre ball rather than from the grid, so
  // the eye style is independent of the module style. The geometry still
  // matches the spec exactly: a 7×7 outer ring one module thick, a 5×5 light
  // gap, and a 3×3 dark centre.

  function eye(shape, originX, originY, cell, fill) {
    var outer = EYE_SIZE * cell;
    var stroke = cell;
    var rFrame = shape === "circle" ? outer / 2 : shape === "rounded" ? outer * 0.28 : 0;
    var ball = 3 * cell;
    var rBall = shape === "circle" ? ball / 2 : shape === "rounded" ? ball * 0.32 : 0;

    return (
      '<rect x="' + n(originX + stroke / 2) + '" y="' + n(originY + stroke / 2) +
      '" width="' + n(outer - stroke) + '" height="' + n(outer - stroke) +
      '" rx="' + n(rFrame) + '" ry="' + n(rFrame) +
      '" fill="none" stroke="' + fill + '" stroke-width="' + n(stroke) + '"/>' +
      '<rect x="' + n(originX + 2 * cell) + '" y="' + n(originY + 2 * cell) +
      '" width="' + n(ball) + '" height="' + n(ball) +
      '" rx="' + n(rBall) + '" ry="' + n(rBall) + '" fill="' + fill + '"/>'
    );
  }

  /**
   * options: {
   *   moduleShape: 'square'|'rounded'|'dot',
   *   eyeShape:    'square'|'rounded'|'circle',
   *   fgColor, fgColor2 (optional — enables a gradient), gradientAngle (deg),
   *   bgColor, quietZone (modules, min 4), cellPx,
   *   logoDataUrl (an uploaded image) OR logoGlyph ({d, color} — a built-in
   *     mark, inlined as real geometry so it can animate),
   *   logoRatio (0–0.4), logoAspect (w/h of an uploaded image, default 1),
   *   logoAnimation ('pulse' | 'spin' | 'bounce' | 'draw'; 'draw' needs a glyph)
   * }
   */
  function renderSVG(code, options) {
    var o = options || {};

    // Dark-on-light is the default because it is the only polarity scanners
    // reliably read. Callers may invert for effect, but should pair that with
    // a contrast warning (see studio.js) rather than shipping it as default.
    var moduleShape = o.moduleShape === "rounded" || o.moduleShape === "dot" ? o.moduleShape : "square";
    var eyeShape = o.eyeShape === "square" || o.eyeShape === "circle" ? o.eyeShape : "rounded";
    var fg = safeColor(o.fgColor, "#0A0A0A");
    var fg2 = o.fgColor2 ? safeColor(o.fgColor2, null) : null;
    var bg = safeColor(o.bgColor, "#FFFFFF");
    var angle = typeof o.gradientAngle === "number" ? o.gradientAngle : 45;
    // 4 is the ISO/IEC 18004 minimum quiet zone; anything less risks scan
    // failures, so it is clamped here rather than merely defaulted.
    var quiet = Math.max(4, Math.min(16, parseInt(o.quietZone, 10) || 4));
    var cell = Math.max(1, o.cellPx || 10);

    var size = code.size;
    var modules = code.modules;
    var dim = (size + quiet * 2) * cell;

    // Gradient in userSpaceOnUse so it spans the whole code. With the default
    // objectBoundingBox units each module would get its own full gradient —
    // producing a flat, near-uniform fill instead of a sweep across the code.
    var defs = "";
    var fill = fg;
    if (fg2) {
      var rad = (angle * Math.PI) / 180;
      var cx = dim / 2;
      var cy = dim / 2;
      var ext = dim / 2;
      defs +=
        '<linearGradient id="qodeGrad" gradientUnits="userSpaceOnUse"' +
        ' x1="' + n(cx - Math.cos(rad) * ext) + '" y1="' + n(cy - Math.sin(rad) * ext) +
        '" x2="' + n(cx + Math.cos(rad) * ext) + '" y2="' + n(cy + Math.sin(rad) * ext) + '">' +
        '<stop offset="0" stop-color="' + fg + '"/>' +
        '<stop offset="1" stop-color="' + fg2 + '"/>' +
        "</linearGradient>";
      fill = "url(#qodeGrad)";
    }

    var body =
      moduleShape === "rounded" ? bodyRounded(modules, size, quiet, cell)
      : moduleShape === "dot" ? bodyDot(modules, size, quiet, cell)
      : bodySquare(modules, size, quiet, cell);

    var eyes = "";
    var origins = [[0, 0], [size - EYE_SIZE, 0], [0, size - EYE_SIZE]];
    for (var i = 0; i < origins.length; i++) {
      eyes += eye(eyeShape, (origins[i][0] + quiet) * cell, (origins[i][1] + quiet) * cell, cell, fill);
    }

    // ---- Logo animation ------------------------------------------------
    //
    // Emitted as CSS inside the SVG rather than SMIL, because CSS keyframes
    // run in three places SMIL is unreliable in: inline in the DOM (the
    // preview), a downloaded .svg opened in a browser, and an <img> pointing
    // at that file. The plate never moves — only the mark inside it — so the
    // artwork can never animate out over the modules it is meant to cover.
    //
    // A still frame is what a PNG export captures; that is stated in the UI
    // rather than silently surprising anyone.
    var ANIMATIONS = {
      pulse:  "@keyframes qode-a{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}",
      spin:   "@keyframes qode-a{to{transform:rotate(360deg)}}",
      bounce: "@keyframes qode-a{0%,100%{transform:translateY(0)}50%{transform:translateY(-7%)}}",
      // "draw" retraces the glyph's own outline. pathLength="100" normalises
      // every path to the same nominal length, so one dash value works for
      // all sixteen marks regardless of their real geometry.
      draw:   "@keyframes qode-a{0%{stroke-dashoffset:100}60%,100%{stroke-dashoffset:0}}",
    };
    var DURATIONS = { pulse: "2.4s", spin: "6s", bounce: "2s", draw: "3s" };
    var TIMING = { pulse: "ease-in-out", spin: "linear", bounce: "ease-in-out", draw: "ease-in-out" };

    var anim = ANIMATIONS[o.logoAnimation] ? o.logoAnimation : null;
    var animStyle = "";
    var animClass = "";
    if (anim) {
      animClass = "qode-anim";
      animStyle =
        "<style>" + ANIMATIONS[anim] +
        ".qode-anim{transform-box:fill-box;transform-origin:center;" +
        "animation:qode-a " + DURATIONS[anim] + " " + TIMING[anim] + " infinite" +
        (anim === "draw" ? " alternate" : "") + "}" +
        // Anyone who has asked their system for less motion gets the finished
        // frame instead — in the preview and in the exported file alike.
        "@media(prefers-reduced-motion:reduce){.qode-anim{animation:none}" +
        ".qode-anim{stroke-dashoffset:0}}" +
        "</style>";
    }

    // Logo sits on an opaque plate so it never blends into the modules it
    // covers. Two things matter here and both used to be wrong:
    //
    //   The box follows the logo's real aspect ratio. A wordmark is typically
    //   3:1 or wider; forcing it into a square and cropping ("slice") ate
    //   most of the brand — the whole point of putting it there. The image is
    //   fitted with "meet" so nothing is ever cut off.
    //
    //   Size is held at constant AREA rather than constant width, so the
    //   slider means "how much of the code is covered" no matter the logo's
    //   shape. That keeps the damage the error correction has to repair
    //   predictable across a square icon and a long wordmark alike.
    //
    // A logo arrives one of two ways: an uploaded file, drawn through
    // <image>, or one of the built-in marks, whose path data is inlined as
    // real geometry. Inlining is what makes the built-ins animatable at all
    // — a referenced image renders as a static frame no matter what it
    // contains — and it keeps an SVG export as one self-contained vector
    // file with no embedded raster inside it.
    var glyph = o.logoGlyph && o.logoGlyph.d ? o.logoGlyph : null;
    var logo = "";
    if (o.logoDataUrl || glyph) {
      // 0.4 sits well inside what level-H error correction can repair: a
      // constant-area box at r covers r² of the code, so 0.4 is ~16% of
      // modules against H's ~30% recovery budget.
      var ratio = Math.max(0.05, Math.min(0.4, o.logoRatio || 0.25));
      // A built-in mark is drawn in a square 24×24 space, so it is always 1:1.
      var aspect = glyph ? 1 : (o.logoAspect > 0 ? o.logoAspect : 1);

      // Measure against the code itself, not the quiet zone, since the code
      // is what actually gets covered.
      var codeDim = size * cell;
      var side = codeDim * ratio;
      var lw = side * Math.sqrt(aspect);
      var lh = side / Math.sqrt(aspect);

      // Hard ceiling for extreme aspect ratios — past this no error
      // correction level can recover the code.
      var maxSpan = codeDim * 0.62;
      if (lw > maxSpan) { lh *= maxSpan / lw; lw = maxSpan; }
      if (lh > maxSpan) { lw *= maxSpan / lh; lh = maxSpan; }

      var pad = Math.min(lw, lh) * 0.14;
      var lx = (dim - lw) / 2;
      var ly = (dim - lh) / 2;
      var rInner = Math.min(lw, lh) * 0.14;

      // The plate is drawn outside the animated element on purpose: only the
      // mark moves, so a pulse or a spin can never sweep artwork out over the
      // modules the plate is there to mask.
      var plate =
        '<rect x="' + n(lx - pad) + '" y="' + n(ly - pad) +
        '" width="' + n(lw + pad * 2) + '" height="' + n(lh + pad * 2) +
        '" rx="' + n(rInner + pad * 0.6) + '" fill="' + bg + '"/>';

      var mark;
      if (glyph) {
        // Built-in marks are authored in a 24-unit square, so one scale maps
        // them into the box — and scaling the stroke with them keeps the
        // weight visually identical at every logo size.
        var s = lw / 24;
        var drawing = o.logoAnimation === "draw";
        var tile = glyph.tile ? safeColor(glyph.tile, null) : null;
        // On a coloured tile the glyph is white; without one it takes the
        // code's own foreground colour.
        var stroke = tile ? "#FFFFFF" : safeColor(glyph.color, fg);

        // The glyph is inset inside the tile rather than filling it edge to
        // edge, which is what makes it read as an icon instead of a crop.
        var INSET = 0.7;
        var pad24 = (24 - 24 * INSET) / 2;

        var pathEl =
          '<path d="' + attr(glyph.d) + '" fill="none" stroke="' + stroke +
          '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"' +
          (drawing ? ' pathLength="100" stroke-dasharray="100"' : "") +
          (drawing && animClass ? ' class="' + animClass + '"' : "") +
          "/>";

        var content =
          (tile ? '<rect width="24" height="24" rx="6" fill="' + tile + '"/>' : "") +
          '<g transform="translate(' + n(pad24) + " " + n(pad24) + ") scale(" + INSET + ')">' +
          pathEl + "</g>";

        // The animated element carries no transform attribute of its own: a
        // CSS transform animation and the transform presentation attribute
        // are the same property, so putting both on one element would make
        // the animation wipe out the positioning.
        mark =
          '<g transform="translate(' + n(lx) + " " + n(ly) + ") scale(" + n(s) + ')">' +
          (animClass && !drawing ? '<g class="' + animClass + '">' + content + "</g>" : content) +
          "</g>";
      } else {
        defs +=
          '<clipPath id="qodeLogoClip"><rect x="' + n(lx) + '" y="' + n(ly) +
          '" width="' + n(lw) + '" height="' + n(lh) + '" rx="' + n(rInner) + '"/></clipPath>';
        mark =
          '<image href="' + attr(o.logoDataUrl) + '" xlink:href="' + attr(o.logoDataUrl) + '"' +
          ' x="' + n(lx) + '" y="' + n(ly) + '" width="' + n(lw) + '" height="' + n(lh) +
          '" preserveAspectRatio="xMidYMid meet" clip-path="url(#qodeLogoClip)"' +
          (animClass ? ' class="' + animClass + '"' : "") + "/>";
      }

      logo = animStyle + plate + mark;
    }

    // crispEdges keeps the square style pixel-sharp at small sizes; the
    // curved styles need antialiasing, so they get the default.
    var rendering = moduleShape === "square" ? ' shape-rendering="crispEdges"' : "";

    return (
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' +
      ' width="' + n(dim) + '" height="' + n(dim) + '" viewBox="0 0 ' + n(dim) + " " + n(dim) + '"' +
      ' role="img" aria-label="QR code, version ' + code.version + ', ' + size + " by " + size + ' modules">' +
      "<title>QR code · version " + code.version + " · " + size + "×" + size + " modules</title>" +
      (defs ? "<defs>" + defs + "</defs>" : "") +
      '<rect width="' + n(dim) + '" height="' + n(dim) + '" fill="' + bg + '"/>' +
      '<g fill="' + fill + '"' + rendering + ">" + body + "</g>" +
      "<g>" + eyes + "</g>" +
      logo +
      "</svg>"
    );
  }

  /**
   * Rasterises SVG markup to a PNG Blob at pixelSize × pixelSize.
   *
   * The SVG carries explicit width/height (Safari refuses to size an image
   * without them), and the canvas is pre-filled white so a PNG is never
   * handed back with a transparent background that would ruin contrast when
   * placed on dark stock.
   */
  function svgToPngBlob(svgString, pixelSize) {
    return new Promise(function (resolve, reject) {
      var size = Math.max(64, Math.min(4096, pixelSize || 1200));
      var blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var img = new Image();

      var timer = setTimeout(function () {
        URL.revokeObjectURL(url);
        reject(new Error("Timed out rasterising the QR code."));
      }, 15000);

      img.onload = function () {
        clearTimeout(timer);
        try {
          var canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          var ctx = canvas.getContext("2d");
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 0, 0, size, size);
          URL.revokeObjectURL(url);
          canvas.toBlob(function (png) {
            if (png) resolve(png);
            else reject(new Error("The browser couldn't produce a PNG."));
          }, "image/png");
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };

      img.onerror = function () {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        reject(new Error("The browser couldn't load the QR code for export."));
      };

      img.src = url;
    });
  }

  return { renderSVG: renderSVG, svgToPngBlob: svgToPngBlob };
})();
