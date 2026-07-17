// Dev launcher that keeps parallel git worktrees from clobbering each other.
//
// The problem it solves: `wrangler dev` binds a fixed port (8787 from
// wrangler.toml) and the Vite dev server proxies /api → 127.0.0.1:8787. Run
// two worktrees' `npm run dev` at once and both Workers bind 8787; on Windows
// the OS then hands requests to whichever bound last, so a frontend can hit the
// *other* worktree's Worker — a different D1 database and a different auth
// config. Symptoms are intermittent 401/500s and "stuck" state that flip
// depending on which server won the port.
//
// Fix: pick the first free API port starting at 8787, launch the Worker on it
// (--port overrides the toml default), and tell Vite to proxy there via
// VITE_API_PROXY. A lone worktree still gets 8787/5173 exactly as before (so
// Playwright's webServer, which expects :5173, is unaffected); a second
// concurrent worktree slides to 8788, 8789, … with its Vite proxy following.
//
// Override the starting API port with DEV_API_PORT if you want a fixed one.

import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Is something already accepting connections on this port? We probe by
// connecting rather than by binding: a plain bind test can report "free" for a
// port another Worker holds with SO_REUSEADDR, which is exactly the false
// negative that caused the collision. A successful connect means "in use".
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false)); // ECONNREFUSED → nothing there
  });
}

// Momentarily grab the port with an exclusive bind. This serializes two
// launchers that start at the same instant and both saw the port as free: the
// OS grants the exclusive bind to only one, so the loser moves on and the two
// pick different ports instead of colliding. We close it right away and let
// Wrangler take it — the sub-millisecond gap is not worth a cross-process lock.
function claimPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false)); // EADDRINUSE → a racer won it
    srv.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function firstFreePort(start) {
  for (let port = start; port < start + 50; port++) {
    if (await portInUse(port)) continue; // an established server is already there
    if (await claimPort(port)) return port; // and we won the race for it
  }
  throw new Error(`No free port found in [${start}, ${start + 50}).`);
}

const startPort = Number(process.env.DEV_API_PORT) || 8787;
const apiPort = await firstFreePort(startPort);
const apiTarget = `http://127.0.0.1:${apiPort}`;

if (apiPort !== startPort) {
  console.log(
    `[dev] port ${startPort} is busy (another worktree?) — using API port ${apiPort}. ` +
      `Vite will proxy /api → ${apiTarget}.`,
  );
} else {
  console.log(`[dev] API on ${apiTarget}; Vite proxies /api there.`);
}

// npm is npm.cmd on Windows; spawn through a shell so the launcher is
// cross-platform. stdio inherited so both servers' logs stream as before.
const spawnOpts = { cwd: repoRoot, stdio: "inherit", shell: true };

const api = spawn(
  "npm",
  ["--workspace", "api", "run", "dev", "--", "--port", String(apiPort), "--ip", "127.0.0.1"],
  spawnOpts,
);
const web = spawn("npm", ["--workspace", "web", "run", "dev"], {
  ...spawnOpts,
  env: { ...process.env, VITE_API_PROXY: apiTarget },
});

// Kill a child and everything it spawned. child.kill() only signals the top
// process — and on Windows that's the cmd.exe shell (shell: true), leaving the
// real workerd/vite alive still holding the port. Orphaned port-holders are the
// exact failure this launcher exists to prevent, so tear down the whole tree.
function killTree(child) {
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
}

// If either server dies, tear down the other and exit with its code so the
// failure is visible. (Unlike `npm-run-all --parallel`, which leaves the
// surviving server running, we fail fast — a half-up dev stack is a trap.)
let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(api);
  killTree(web);
  process.exit(code ?? 0);
}

api.on("exit", (code) => shutdown(code ?? 0));
web.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
