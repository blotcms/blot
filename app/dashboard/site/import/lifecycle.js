const { AsyncLocalStorage } = require("async_hooks");
const fs = require("fs-extra");
const { join } = require("path");
const { randomUUID } = require("crypto");
const LEASE_MS = 30000;
const context = new AsyncLocalStorage();
const active = new Map();

function cancelled() {
  const error = new Error("Import cancelled");
  error.name = "AbortError";
  return error;
}

function create(directory) {
  const controller = new AbortController();
  const marker = join(directory, "cancelled.txt");
  const leaseFile = join(directory, "running.txt");
  const owner = randomUUID();
  const lease = () => ({ owner, expiresAt: Date.now() + LEASE_MS });
  fs.writeFileSync(leaseFile, JSON.stringify(lease()));
  const state = {
    signal: controller.signal,
    stagingDirectory: join(directory, "staging"),
    ownsLease() {
      try { return fs.readJsonSync(leaseFile).owner === owner; } catch (_) { return false; }
    },
    bytes: 0,
    assets: new Set(),
    check() {
      if (fs.existsSync(marker) || fs.existsSync(join(directory, "deleted.txt"))) controller.abort(cancelled());
      if (!controller.signal.aborted) {
        try {
          const current = fs.readJsonSync(leaseFile);
          if (current.owner !== owner || current.expiresAt <= Date.now()) {
            throw new Error("Import worker lease expired");
          }
        } catch (error) {
          controller.abort(error);
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
    },
    abort: (error = cancelled()) => controller.abort(error),
  };
  // Workers share the job directory. Leases expire after a crash; a resumed
  // worker must stop rather than renew an expired or revoked ownership claim.
  const timer = setInterval(() => {
    try {
      state.check();
      // r+ never recreates a lease or directory removed by cleanup.
      const current = fs.readJsonSync(leaseFile);
      if (current.expiresAt - Date.now() < LEASE_MS / 2) {
        fs.writeFileSync(leaseFile, JSON.stringify(lease()), { flag: "r+" });
      }
    } catch (error) {
      controller.abort(error);
    }
  }, 250);
  timer.unref();
  active.set(directory, state);
  state.dispose = () => {
    clearInterval(timer);
    if (active.get(directory) === state) active.delete(directory);
  };
  state.run = (fn) => context.run(state, fn);
  return state;
}

async function cancel(directory) {
  await fs.outputFile(join(directory, "cancelled.txt"), "true");
  if (active.has(directory)) active.get(directory).abort();
}

function leaseExpiry(directory) {
  const leaseFile = join(directory, "running.txt");
  try {
    const stat = fs.statSync(leaseFile);
    let expiresAt;
    try { expiresAt = fs.readJsonSync(leaseFile).expiresAt; } catch (_) {}
    // Also recover markers left by the previous non-leased implementation.
    return Number.isFinite(expiresAt) ? expiresAt : stat.mtimeMs + LEASE_MS;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function remove(directory) {
  await cancel(directory);
  const expiresAt = leaseExpiry(directory);
  if (expiresAt > Date.now()) return false;
  if (expiresAt !== undefined) {
    // Retain a small permanent tombstone for an expired owner. In-flight I/O
    // may still return in a paused process, so removing its cancellation marker
    // would let that process mistake the deleted job for a live one.
    await fs.writeFile(join(directory, "deleted.txt"), "true");
    await Promise.all(["output", "staging", "result.zip", "result.zip.part"].map(
      name => fs.remove(join(directory, name))
    ));
  } else {
    await fs.remove(directory);
  }
  return true;
}

function check() {
  const state = context.getStore();
  if (state) state.check();
}

function guard(step) {
  return function (...args) {
    const next = args[args.length - 1];
    try {
      check();
      step(...args);
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { create, cancel, remove, leaseExpiry, check, guard, current: () => context.getStore(), cancelled };
