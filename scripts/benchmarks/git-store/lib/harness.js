// Starts the harness server as a child process and talks to it.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

async function startServer({ blogID, via = "proxied", cacheDir, cacheBytes = 1024 ** 3, attempts = 3, env = {}, nodeArgs = [] }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const child = spawn(process.execPath, [...nodeArgs, path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      SPIKE_BLOG: blogID,
      SPIKE_VIA: via,
      SPIKE_CACHE_DIR: cacheDir,
      SPIKE_CACHE_BYTES: String(cacheBytes),
      SPIKE_ATTEMPTS: String(attempts),
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (data) => {
      buffer += data;
      const line = buffer.split("\n").find((l) => l.startsWith("{"));
      if (line) resolve(JSON.parse(line).listening);
    });
    child.on("exit", (code) => reject(new Error("server exited with " + code)));
  });
  child.stdout.resume();

  const base = "http://127.0.0.1:" + port;
  const call = async (pathname, body, method = "POST") => {
    // The server closes idle connections after a few seconds, which fetch
    // may reuse just as it does; a reset is retried once
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(base + pathname, { method, body: body === undefined ? undefined : JSON.stringify(body) });
        break;
      } catch (err) {
        if (attempt) throw err;
      }
    }
    const text = await res.text();
    if (!res.ok) throw new Error(pathname + " " + res.status + " " + text);
    return text ? JSON.parse(text) : {};
  };

  return {
    port,
    base,
    gitUrl: base + "/" + blogID + ".git",
    pid: child.pid,
    take: () => call("/__take", undefined, "GET"),
    clearCache: () => call("/__cache/clear"),
    config: (body) => call("/__config", body),
    op: (name, body = {}) => call("/__op/" + name, body),
    async stop() {
      child.removeAllListeners("exit");
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

module.exports = { startServer };
