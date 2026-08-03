/* ============================================================
   Adaptive UI flows — shared shell script (docs/flows/02-architecture.md)
   Vanilla JS, no dependencies. Do not modify per-screen — extend
   with a local <script> in the screen itself.

   Responsibilities:
   - Intercept every click on [data-handle]: never call the network,
     show a toast naming the handle it would call instead.
   - data-theme toggle helper.
   - data-mode ("authoring" | "translation") preview toggle.
   - window.flowShell.toast(text, opts) for screens' own local state.
   ============================================================ */

(function () {
  "use strict";

  var MAX_TOASTS = 3;
  var TOAST_MS = 4000;

  function ensureStack() {
    var stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      stack.setAttribute("aria-live", "polite");
      document.body.appendChild(stack);
    }
    return stack;
  }

  function toast(text, opts) {
    opts = opts || {};
    var stack = ensureStack();

    // Cap at MAX_TOASTS: drop the oldest (first child, since we render
    // newest-at-bottom via column-reverse + appendChild).
    while (stack.children.length >= MAX_TOASTS) {
      stack.removeChild(stack.firstElementChild);
    }

    var item = document.createElement("div");
    item.className = "toast-item" + (opts.nudge ? " nudge" : "");

    var msg = document.createElement("span");
    msg.className = "toast-msg";
    msg.textContent = text;
    item.appendChild(msg);

    if (opts.headers) {
      var hdr = document.createElement("span");
      hdr.className = "toast-handle";
      hdr.textContent = "(" + opts.headers + ")";
      item.appendChild(hdr);
    }

    if (opts.bundle) {
      var badge = document.createElement("span");
      badge.className = "toast-bundle";
      badge.textContent = opts.bundle;
      item.appendChild(badge);
    }

    stack.appendChild(item);
    // Force layout before adding .show so the transition runs.
    void item.offsetWidth;
    item.classList.add("show");

    var dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      item.classList.remove("show");
      setTimeout(function () {
        if (item.parentNode) item.parentNode.removeChild(item);
      }, 250);
    }
    setTimeout(dismiss, TOAST_MS);

    return { dismiss: dismiss };
  }

  function handleClickTarget(el) {
    var handle = el.getAttribute("data-handle");
    if (!handle) return;

    var headers = el.getAttribute("data-headers");
    var bundle = el.getAttribute("data-bundle");
    var isTodo = handle.indexOf("TODO:") === 0;

    var text = isTodo ? "no backend yet" : "→ " + handle;
    toast(text, { headers: headers, bundle: bundle, nudge: isTodo });
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest("[data-handle]") : null;
    if (!el) return;
    ev.preventDefault();
    handleClickTarget(el);
  });

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-action="toggle-theme"]') : null;
    if (!el) return;
    var root = document.documentElement;
    var current = root.dataset.theme;
    root.dataset.theme = current === "dark" ? "light" : "dark";
  });

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-action="toggle-mode"]') : null;
    if (!el) return;
    var body = document.body;
    body.dataset.mode = body.dataset.mode === "translation" ? "authoring" : "translation";
  });

  window.flowShell = { toast: toast };
})();
