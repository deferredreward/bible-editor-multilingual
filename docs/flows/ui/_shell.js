/* ============================================================
   Adaptive UI flows — shared shell script (docs/flows/02-architecture.md)
   Vanilla JS, no dependencies. Do not modify per-screen — extend
   with a local <script> in the screen itself.

   Requires _api.js to be loaded first (window.flowApi).

   Responsibilities:
   - Intercept every click on [data-handle]:
       - "local:name"      -> dispatch DOM CustomEvent "flow:local", no network.
       - "TODO:no-backend" -> nudge toast, no network (kept from the static mock).
       - "METHOD /api/..." -> resolve :params from context, build headers,
                              make the real call via flowApi, toast the
                              outcome, dispatch "flow:handled".
   - data-theme toggle helper.
   - data-mode ("authoring" | "translation") preview toggle.
   - window.flowShell.toast(text, opts) for screens' own local state.
   - window.flowShell.context / setContext(obj) — page-level param source.
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

  // ---- page-level context (screens set this) ----------------------------
  var context = {};
  function setContext(obj) {
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) context[k] = obj[k];
    }
  }

  // ---- :param resolution --------------------------------------------------
  function resolveParam(name, el) {
    var attr = "data-param-" + name;
    var host = el.closest ? el.closest("[" + attr + "]") : null;
    if (host) return host.getAttribute(attr);
    if (Object.prototype.hasOwnProperty.call(context, name) && context[name] !== undefined && context[name] !== null) {
      return context[name];
    }
    return undefined;
  }

  function resolvePath(path, el) {
    var missing = null;
    var resolved = path.replace(/:([a-zA-Z_]+)/g, function (whole, name) {
      if (missing) return whole;
      var v = resolveParam(name, el);
      if (v === undefined) {
        missing = name;
        return whole;
      }
      return encodeURIComponent(v);
    });
    if (missing) return { error: missing };
    return { path: resolved };
  }

  // ---- body resolution ------------------------------------------------------
  function resolveBody(el) {
    var raw = el.getAttribute("data-body");
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (e) {
        return undefined;
      }
    }
    var fromSel = el.getAttribute("data-body-from");
    if (fromSel) {
      var target = document.querySelector(fromSel);
      var field = el.getAttribute("data-body-field") || "value";
      if (target) {
        var body = {};
        body[field] = target.value;
        return body;
      }
    }
    return undefined;
  }

  // ---- header resolution ------------------------------------------------------
  function resolveHeaders(el, headersSpec) {
    var out = {};
    if (!headersSpec) return out;
    if (headersSpec.indexOf("If-Match") !== -1) {
      var versionAttr = el.closest ? el.closest("[data-version]") : null;
      var version;
      if (versionAttr) {
        version = versionAttr.getAttribute("data-version");
      } else {
        var keyHost = el.closest ? el.closest("[data-version-key]") : null;
        var key = keyHost ? keyHost.getAttribute("data-version-key") : null;
        if (key && window.flowApi) version = window.flowApi.getVersion(key);
      }
      if (version !== undefined && version !== null) out.ifMatch = version;
    }
    if (headersSpec.indexOf("X-Source-Generation") !== -1) {
      // X-Source-Generation exists so the client can PROVE which generation it
      // loaded the verse under (api/src/verses.ts:283). Defaulting to a literal
      // 1 would manufacture that proof — and on any deployment whose active
      // generation happens to be 1 the gate would silently pass for a client
      // that never read the row. So: use a real value if the screen supplied
      // one, otherwise send nothing and let the server answer 428
      // source_generation_required. Failing closed is the point of the header.
      var sgHost = el.closest ? el.closest("[data-source-generation]") : null;
      var sg = sgHost ? sgHost.getAttribute("data-source-generation") : undefined;
      if (sg === undefined || sg === null) sg = context.sourceGeneration;
      if (sg !== undefined && sg !== null && sg !== "") out.sourceGeneration = sg;
    }
    return out;
  }

  function fireHandled(el, detail) {
    var ev;
    try {
      ev = new CustomEvent("flow:handled", { bubbles: true, detail: detail });
    } catch (e) {
      ev = document.createEvent("CustomEvent");
      ev.initCustomEvent("flow:handled", true, false, detail);
    }
    el.dispatchEvent(ev);
  }

  function fireLocal(el, detail) {
    var ev;
    try {
      ev = new CustomEvent("flow:local", { bubbles: true, detail: detail });
    } catch (e) {
      ev = document.createEvent("CustomEvent");
      ev.initCustomEvent("flow:local", true, false, detail);
    }
    el.dispatchEvent(ev);
  }

  function handleClickTarget(el) {
    var handle = el.getAttribute("data-handle");
    if (!handle) return;

    var headersSpec = el.getAttribute("data-headers");
    var bundle = el.getAttribute("data-bundle");

    // local: — no network, just a DOM event screens can listen for.
    if (handle.indexOf("local:") === 0) {
      var name = handle.slice("local:".length);
      toast("→ " + handle, { headers: headersSpec, bundle: bundle });
      fireLocal(el, { name: name, el: el });
      return;
    }

    // TODO:no-backend — keep the original nudge behavior, no network.
    if (handle.indexOf("TODO:") === 0) {
      toast("no backend yet", { headers: headersSpec, bundle: bundle, nudge: true });
      return;
    }

    // Screens that want to handle the network call themselves.
    if (el.hasAttribute("data-handle-manual")) {
      fireHandled(el, { handle: handle, method: null, path: null, result: null });
      return;
    }

    // "METHOD /api/path"
    var spaceIdx = handle.indexOf(" ");
    if (spaceIdx === -1) {
      toast("malformed handle: " + handle, { nudge: true });
      return;
    }
    var method = handle.slice(0, spaceIdx).toUpperCase();
    var rawPath = handle.slice(spaceIdx + 1).trim();

    var resolvedPath = resolvePath(rawPath, el);
    if (resolvedPath.error) {
      toast("missing param :" + resolvedPath.error, { headers: headersSpec, bundle: bundle, nudge: true });
      return;
    }
    var path = resolvedPath.path;

    // Row writes require ?book=<book>.
    if (/\/api\/rows\//.test(path) && method !== "GET") {
      var bookVal = resolveParam("book", el);
      if (bookVal === undefined) {
        toast("missing param :book (required for /api/rows/*)", { headers: headersSpec, bundle: bundle, nudge: true });
        return;
      }
      path += (path.indexOf("?") === -1 ? "?" : "&") + "book=" + encodeURIComponent(bookVal);
    }

    var reqHeaders = resolveHeaders(el, headersSpec);
    var body = resolveBody(el);
    if (body === undefined && (method === "POST" || method === "PATCH")) {
      body = {};
    }

    if (!window.flowApi) {
      toast("flowApi not loaded — is _api.js included before _shell.js?", { nudge: true });
      return;
    }

    window.flowApi
      .request(method, path, {
        body: body,
        ifMatch: reqHeaders.ifMatch,
        sourceGeneration: reqHeaders.sourceGeneration,
      })
      .then(function (result) {
        if (result.ok) {
          toast("✓ " + result.status + " " + method + " " + rawPath, {
            headers: headersSpec,
            bundle: bundle,
          });
        } else {
          toast("✗ " + result.status + " " + result.kind, {
            headers: headersSpec,
            bundle: bundle,
            nudge: true,
          });
        }
        fireHandled(el, { handle: handle, method: method, path: path, result: result });
      });
  }

  // Controls whose DEFAULT ACTION is the state change itself. Calling
  // preventDefault() on these cancels the native toggle, so the box the user
  // just clicked springs back while the request goes out — the UI and the
  // server end up disagreeing. Only suppress the default for controls whose
  // default is navigation or form submission.
  function defaultIsTheStateChange(el) {
    var tag = el.tagName;
    if (tag === "SELECT" || tag === "TEXTAREA") return true;
    if (tag !== "INPUT") return false;
    var type = (el.getAttribute("type") || "text").toLowerCase();
    return type === "checkbox" || type === "radio" || type === "range" || type === "file";
  }

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest("[data-handle]") : null;
    if (!el) return;
    // The clicked node matters, not just the [data-handle] host: a checkbox
    // nested inside a handle-bearing <label> must keep its native toggle.
    var clicked = ev.target && ev.target.nodeType === 1 ? ev.target : el;
    if (!defaultIsTheStateChange(clicked) && !defaultIsTheStateChange(el)) {
      ev.preventDefault();
    }
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

  window.flowShell = { toast: toast, context: context, setContext: setContext };
})();
