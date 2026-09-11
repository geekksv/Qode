// Shared WASM loader. Lazily fetches + instantiates the Go/WASM module and
// resolves once qrbitGenerate() and friends are callable on `window`. Every
// page that needs the engine (Studio, Bulk) awaits this; r.html deliberately
// never imports this file at all, so a scan redirects instantly instead of
// waiting on a multi-megabyte download.
//
// The module is ~3MB, which on a slow connection is several seconds of
// nothing. Callers therefore get two things beyond the ready promise:
//   Qode.onProgress(fn)  -> "still downloading" / "failed" notifications, so
//                            the UI can show a skeleton instead of a blank box
//   Qode.state           -> "idle" | "loading" | "ready" | "failed"
// and load() rejects (rather than hanging) on a network or instantiation
// failure, so pages can render a real error state.
window.Qode = (function () {
  var readyPromise = null;
  var listeners = [];

  var api = {
    state: "idle",
    error: null,
    load: load,
    onProgress: onProgress,
    retry: retry,
  };

  function onProgress(fn) {
    listeners.push(fn);
    // Late subscribers still get the current state immediately.
    fn(api.state, api.error);
    return function () {
      listeners = listeners.filter(function (l) { return l !== fn; });
    };
  }

  function emit(state, error) {
    api.state = state;
    api.error = error || null;
    listeners.slice().forEach(function (fn) {
      try { fn(state, api.error); } catch (e) { /* a bad listener must not break loading */ }
    });
  }

  function load() {
    if (readyPromise) return readyPromise;

    emit("loading");

    readyPromise = new Promise(function (resolve, reject) {
      if (typeof Go !== "function") {
        return reject(new Error("wasm_exec.js did not load, so the QR engine can't start."));
      }
      if (!window.WebAssembly) {
        return reject(new Error("This browser doesn't support WebAssembly, which Qode needs to encode codes on-device."));
      }

      window.qrbitOnReady = function () { resolve(); };

      var go = new Go();
      var wasmUrl = "/wasm/main.wasm";

      // instantiateStreaming needs the server to send application/wasm; the
      // ArrayBuffer path is the fallback for both old browsers and hosts that
      // get the MIME type wrong.
      function viaBuffer() {
        return fetch(wasmUrl)
          .then(
            function (r) {
              if (!r.ok) throw new Error("The engine file returned HTTP " + r.status + ".");
              return r.arrayBuffer();
            },
            function () {
              // A rejected fetch is a network-layer failure, whose native
              // message ("Failed to fetch") tells a visitor nothing.
              throw new Error("The download was interrupted — check your connection and reload.");
            }
          )
          .then(function (bytes) { return WebAssembly.instantiate(bytes, go.importObject); });
      }

      var instantiate = WebAssembly.instantiateStreaming
        ? WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject).catch(viaBuffer)
        : viaBuffer();

      instantiate
        .then(function (result) {
          go.run(result.instance);
          // Safety net: if main() already fired qrbitOnReady synchronously
          // inside go.run() before this handler attached, resolve anyway.
          if (window.qrbitReady) resolve();
        })
        .catch(reject);
    });

    readyPromise.then(
      function () { emit("ready"); },
      function (err) {
        emit("failed", err);
        // Allow a later retry() to start over from scratch.
        readyPromise = null;
      }
    );

    return readyPromise;
  }

  function retry() {
    readyPromise = null;
    api.error = null;
    return load();
  }

  return api;
})();
