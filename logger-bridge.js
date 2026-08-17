/* ---------------------------------------------------------------
   logger-bridge.js  -  loaded inside each iframe tool.
   Forwards #log / #output / #status text to the parent shell's
   shared log via postMessage, and hides the per-tool log boxes.
   --------------------------------------------------------------- */
(function () {
  const path = (location.pathname || "").toLowerCase();
  let source = "tool";
  let label = "Tool";
  if (path.includes("media-converter")) { source = "media"; label = "Converter"; }
  else if (path.includes("piano")) { source = "piano"; label = "Piano"; }
  else if (path.includes("analyzer")) { source = "analyzer"; label = "Analyzer"; }
  else if (path.includes("extractor")) { source = "extract"; label = "Extract"; }
  else if (path.includes("transformer")) { source = "transform"; label = "Transform"; }

  function send(message) {
    if (!message) return;
    const text = String(message).trim();
    if (!text) return;
    try {
      window.parent.postMessage({ type: "lg-log", source, label, message: text }, "*");
    } catch (e) { /* ignore */ }
  }

  function flushDiff(prev, now) {
    if (now.length > prev.length && now.startsWith(prev)) {
      return now.slice(prev.length);
    }
    return now;
  }

  function observeAppend(el) {
    if (!el) return;
    let prev = el.textContent || "";
    if (prev.trim()) prev.split(/\r?\n/).forEach((l) => send(l));
    const mo = new MutationObserver(() => {
      const now = el.textContent || "";
      if (now === prev) return;
      const diff = flushDiff(prev, now);
      prev = now;
      diff.split(/\r?\n/).forEach((l) => send(l));
    });
    mo.observe(el, { childList: true, characterData: true, subtree: true });
  }

  function observeReplace(el) {
    if (!el) return;
    let prev = el.textContent || "";
    if (prev.trim()) send(prev);
    const mo = new MutationObserver(() => {
      const now = el.textContent || "";
      if (now === prev) return;
      prev = now;
      if (now.trim()) send(now);
    });
    mo.observe(el, { childList: true, characterData: true, subtree: true });
  }

  function init() {
    const logEl = document.getElementById("log");
    const outputEl = document.getElementById("output");
    const statusEl = document.getElementById("status");

    observeAppend(logEl);
    observeAppend(outputEl);
    observeReplace(statusEl);

    function hideElementAndPrecedingTitle(el) {
      if (!el) return;
      el.style.display = "none";
      const prev = el.previousElementSibling;
      if (prev && prev.classList && prev.classList.contains("section-title")) {
        prev.style.display = "none";
      }
    }
    hideElementAndPrecedingTitle(logEl);
    hideElementAndPrecedingTitle(outputEl);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // -------------------------------------------------------------
  // Scroll chaining: when this iframe's own scroll hits its top/
  // bottom boundary, forward further wheel deltas to the parent
  // window so the outer page continues scrolling in the same
  // gesture. Only active when actually embedded.
  // -------------------------------------------------------------
  if (window.parent && window.parent !== window) {
    const getScrollEl = () =>
      document.scrollingElement || document.documentElement || document.body;

    window.addEventListener(
      "wheel",
      (e) => {
        const el = getScrollEl();
        if (!el) return;
        const max = el.scrollHeight - el.clientHeight;
        const atTop = el.scrollTop <= 0;
        const atBottom = el.scrollTop >= max - 1;
        const dy = e.deltaY;
        if ((dy < 0 && atTop) || (dy > 0 && atBottom)) {
          e.preventDefault();
          try {
            window.parent.postMessage(
              { type: "lg-scroll", deltaX: e.deltaX, deltaY: dy, deltaMode: e.deltaMode },
              "*"
            );
          } catch (_) { /* ignore */ }
        }
      },
      { passive: false }
    );

    // Touch chaining (mobile / touch trackpads).
    let lastTouchY = null;
    window.addEventListener(
      "touchstart",
      (e) => {
        lastTouchY = e.touches.length === 1 ? e.touches[0].clientY : null;
      },
      { passive: true }
    );
    window.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 1 || lastTouchY == null) return;
        const y = e.touches[0].clientY;
        const dy = lastTouchY - y;
        lastTouchY = y;
        const el = getScrollEl();
        if (!el) return;
        const max = el.scrollHeight - el.clientHeight;
        const atTop = el.scrollTop <= 0;
        const atBottom = el.scrollTop >= max - 1;
        if ((dy < 0 && atTop) || (dy > 0 && atBottom)) {
          try {
            window.parent.postMessage(
              { type: "lg-scroll", deltaX: 0, deltaY: dy, deltaMode: 0 },
              "*"
            );
          } catch (_) { /* ignore */ }
        }
      },
      { passive: true }
    );
  }
})();
