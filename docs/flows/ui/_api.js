/* ============================================================
   Adaptive UI flows — real API client (docs/flows/02-architecture.md)
   Vanilla JS, no dependencies, no build step. Mirrors the semantics
   of web/src/sync/api.ts (see that file for the authoritative
   contract this is a functional-preview subset of).

   Auth is cookie-based (be_access/be_refresh HttpOnly + be_csrf
   readable) — there is no bearer token to store. Every request:
     - credentials: "include"
     - X-Workspace: <localStorage "bible-editor.workspace" || "default">
     - non-GET/HEAD: X-CSRF-Token from the be_csrf cookie

   Exposes window.flowApi. Must load BEFORE _shell.js.
   ============================================================ */

(function () {
  "use strict";

  var CSRF_COOKIE_NAME = "be_csrf";
  var WORKSPACE_STORAGE_KEY = "bible-editor.workspace";
  var DEFAULT_REQUEST_TIMEOUT_MS = 30000;

  function readCookie(name) {
    if (typeof document === "undefined") return null;
    var prefix = name + "=";
    var parts = document.cookie.split(";");
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (t.indexOf(prefix) === 0) {
        var raw = t.slice(prefix.length);
        try {
          return decodeURIComponent(raw);
        } catch (e) {
          return raw;
        }
      }
    }
    return null;
  }

  function getCsrfToken() {
    return readCookie(CSRF_COOKIE_NAME);
  }

  // The workspace the SERVER resolved this session to, read from
  // GET /api/auth/me. This must win over any local guess: the server compares
  // X-Workspace against the be_ws cookie and 409s `workspace_mismatch` on
  // disagreement, so a hardcoded "default" fails every write on a deployment
  // whose fallback workspace is named something else (here it is "bsoj").
  var serverWorkspace = null;

  function getWorkspaceSlug() {
    if (serverWorkspace) return serverWorkspace;
    try {
      var v = window.localStorage ? window.localStorage.getItem(WORKSPACE_STORAGE_KEY) : null;
      return v || "default";
    } catch (e) {
      return "default";
    }
  }

  function adoptWorkspace(slug) {
    if (!slug || slug === serverWorkspace) return false;
    serverWorkspace = slug;
    try {
      if (window.localStorage) window.localStorage.setItem(WORKSPACE_STORAGE_KEY, slug);
    } catch (e) {
      /* private mode — in-memory value is enough */
    }
    return true;
  }

  // ---- version registry ----------------------------------------------
  var versions = {};
  function setVersion(key, n) {
    versions[key] = n;
  }
  function getVersion(key) {
    return Object.prototype.hasOwnProperty.call(versions, key) ? versions[key] : undefined;
  }

  // Pull a `version` off a row/verse-shaped object in a response body and
  // record it under `key`, if present. Best-effort — never throws.
  function captureVersionFromData(key, data) {
    if (!key || !data || typeof data !== "object") return;
    if (typeof data.version === "number") {
      setVersion(key, data.version);
    }
    if (data.current && typeof data.current === "object" && typeof data.current.version === "number") {
      setVersion(key, data.current.version);
    }
  }

  // ---- classification ---------------------------------------------------
  function classify(status, body) {
    if (status === 401) return "unauthorized";
    if (status === 403) return "forbidden";
    if (status === 404) return "not_found";
    if (status === 400) return "bad_request";
    if (status === 428) return "precondition_required";
    if (status === 409) {
      var err = body && typeof body === "object" ? body.error : undefined;
      if (err === "version_mismatch") return "version_conflict";
      if (err === "chapter_locked") return "chapter_locked";
      if (err === "source_generation_mismatch") return "generation_conflict";
      if (err === "workspace_mismatch") return "workspace_mismatch";
      return "conflict";
    }
    // A 503 whose body names a *_disabled feature is not a fault — it is the
    // documented "AI not configured" state (BT_API_TOKEN absent). Screens must
    // be able to tell it apart from a real outage so they render a calm
    // explanatory state rather than an error.
    if (status === 503) {
      var derr = body && typeof body === "object" ? body.error : undefined;
      if (typeof derr === "string" && /_disabled$/.test(derr)) return "feature_disabled";
    }
    if (status >= 500) return "server_error";
    return "conflict";
  }

  // ---- refresh coalescing -----------------------------------------------
  var refreshInFlight = null;

  function refreshAuthOnce() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    })
      .then(function (res) {
        return res.ok;
      })
      .catch(function () {
        return false;
      })
      .then(function (ok) {
        setTimeout(function () {
          refreshInFlight = null;
        }, 0);
        return ok;
      });
    return refreshInFlight;
  }

  var devSignInInFlight = null;
  function devSignInOnce() {
    if (devSignInInFlight) return devSignInInFlight;
    devSignInInFlight = fetch("/api/auth/dev", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dev" }),
    })
      .then(function (res) {
        return res.ok;
      })
      .catch(function () {
        return false;
      })
      .then(function (ok) {
        setTimeout(function () {
          devSignInInFlight = null;
        }, 0);
        return ok;
      });
    return devSignInInFlight;
  }

  // ---- core request ------------------------------------------------------
  // request(method, path, {body, headers, ifMatch, sourceGeneration, query})
  // -> Promise<{ok:true,status,data} | {ok:false,status,error,body,kind}>
  function request(method, path, opts) {
    opts = opts || {};
    method = (method || "GET").toUpperCase();

    var url = path;
    if (opts.query) {
      var qs = [];
      for (var k in opts.query) {
        if (!Object.prototype.hasOwnProperty.call(opts.query, k)) continue;
        var v = opts.query[k];
        if (v === undefined || v === null) continue;
        qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
      }
      if (qs.length) {
        url += (url.indexOf("?") === -1 ? "?" : "&") + qs.join("&");
      }
    }

    function doFetch(retriedAfterRefresh) {
      var headers = {};
      if (opts.headers) {
        for (var hk in opts.headers) {
          if (Object.prototype.hasOwnProperty.call(opts.headers, hk)) headers[hk] = opts.headers[hk];
        }
      }
      if (opts.body !== undefined && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      headers["X-Workspace"] = getWorkspaceSlug();
      if (method !== "GET" && method !== "HEAD") {
        if (!headers["X-CSRF-Token"]) {
          var csrf = getCsrfToken();
          if (csrf) headers["X-CSRF-Token"] = csrf;
        }
        if (opts.ifMatch !== undefined && opts.ifMatch !== null) {
          headers["If-Match"] = String(opts.ifMatch);
        }
        if (opts.sourceGeneration !== undefined && opts.sourceGeneration !== null) {
          headers["X-Source-Generation"] = String(opts.sourceGeneration);
        }
      }

      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = null;
      if (ctrl) {
        timer = setTimeout(function () {
          ctrl.abort();
        }, DEFAULT_REQUEST_TIMEOUT_MS);
      }

      var fetchInit = {
        method: method,
        headers: headers,
        credentials: "include",
      };
      if (ctrl) fetchInit.signal = ctrl.signal;
      if (opts.body !== undefined) {
        fetchInit.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      }

      return fetch(url, fetchInit)
        .then(function (res) {
          if (timer) clearTimeout(timer);

          if (res.status === 401 && !retriedAfterRefresh) {
            return refreshAuthOnce().then(function (refreshed) {
              if (refreshed) return doFetch(true);
              // Local dev preview fallback: re-mint a dev session.
              return devSignInOnce().then(function (minted) {
                if (minted) return doFetch(true);
                return res.json().catch(function () {
                  return null;
                }).then(function (body) {
                  return {
                    ok: false,
                    status: 401,
                    error: (body && body.error) || "unauthorized",
                    body: body,
                    kind: "unauthorized",
                  };
                });
              });
            });
          }

          if (!res.ok) {
            return res
              .json()
              .catch(function () {
                return null;
              })
              .then(function (body) {
                // workspace_mismatch: our X-Workspace disagreed with the
                // session's be_ws cookie. The server tells us which slug it
                // actually resolved; adopt it and retry once. The real client
                // reloads the tab here — a preview only needs the header fixed.
                if (
                  res.status === 409 &&
                  body &&
                  body.error === "workspace_mismatch" &&
                  !retriedAfterRefresh &&
                  adoptWorkspace(body.expected)
                ) {
                  return doFetch(true);
                }
                return {
                  ok: false,
                  status: res.status,
                  error: (body && body.error) || ("HTTP " + res.status),
                  body: body,
                  kind: classify(res.status, body),
                };
              });
          }

          if (res.status === 204) {
            return { ok: true, status: res.status, data: null };
          }
          return res
            .json()
            .catch(function () {
              return null;
            })
            .then(function (data) {
              return { ok: true, status: res.status, data: data };
            });
        })
        .catch(function (err) {
          if (timer) clearTimeout(timer);
          return {
            ok: false,
            status: 0,
            error: (err && err.message) || "network error",
            body: null,
            kind: "network",
          };
        });
    }

    return doFetch(false);
  }

  function get(path, query) {
    return request("GET", path, { query: query });
  }
  function post(path, body, opts) {
    opts = opts || {};
    return request("POST", path, {
      body: body !== undefined ? body : {},
      headers: opts.headers,
      ifMatch: opts.ifMatch,
      sourceGeneration: opts.sourceGeneration,
      query: opts.query,
    });
  }
  function patch(path, body, opts) {
    opts = opts || {};
    return request("PATCH", path, {
      body: body !== undefined ? body : {},
      headers: opts.headers,
      ifMatch: opts.ifMatch,
      sourceGeneration: opts.sourceGeneration,
      query: opts.query,
    });
  }
  function del(path, opts) {
    opts = opts || {};
    return request("DELETE", path, {
      headers: opts.headers,
      ifMatch: opts.ifMatch,
      sourceGeneration: opts.sourceGeneration,
      query: opts.query,
    });
  }
  function chapter(book, ch) {
    return get("/api/chapters/" + encodeURIComponent(book) + "/" + ch);
  }

  // ---- identity -----------------------------------------------------------
  var flowApi = {
    request: function (method, path, opts) {
      return request(method, path, opts).then(function (result) {
        captureVersionFromData(opts && opts.versionKey, result && result.data);
        return result;
      });
    },
    get: get,
    post: post,
    patch: patch,
    del: del,
    chapter: chapter,
    versions: versions,
    setVersion: setVersion,
    getVersion: getVersion,
    me: null,
    ready: null,
  };

  function fetchMe() {
    return fetch("/api/auth/me", { credentials: "include" }).then(function (res) {
      if (!res.ok) return null;
      return res.json().catch(function () {
        return null;
      });
    });
  }

  flowApi.ready = fetchMe()
    .then(function (me) {
      if (me) return me;
      return fetch("/api/auth/dev", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "dev" }),
      })
        .then(function () {
          return fetchMe();
        })
        .catch(function () {
          return null;
        });
    })
    .then(function (me) {
      flowApi.me = me;
      // Adopt the server's own slug before any write goes out.
      if (me && me.workspace) adoptWorkspace(me.workspace);
      return me;
    })
    .catch(function () {
      return null;
    });

  window.flowApi = flowApi;
})();
