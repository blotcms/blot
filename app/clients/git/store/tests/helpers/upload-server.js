// A small HTTP server which speaks git's smart protocol for a clone out of the
// store, so a real `git` client can be pointed at it. It is what a host does
// with advertise.js and clone.js. Not a spec itself.
//
//   const server = await startServer({ store, manifest: () => manifest });
//   await runGit(["clone", server.url, dir]);
//   server.results, server.errors   what serve() resolved and threw
//   await server.close();
const http = require("http");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { advertise, CONTENT_TYPE } = require("../../advertise");
const { serve, CONTENT_TYPE: RESULT_TYPE } = require("../../clone");
const manifestModule = require("../../manifest");

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Options: store, manifest (a function returning the manifest to serve, or a
// promise of it), cache, limiter, chunkSize, walkLimit and historyLimit (passed
// to serve)
async function startServer({ store, cache, manifest, limiter, chunkSize, keepaliveAfter, walkLimit, historyLimit }) {
  const results = [];
  const errors = [];
  const requests = [];

  const server = http.createServer(async (req, res) => {
    requests.push(req.method + " " + req.url + (req.headers["git-protocol"] ? " [" + req.headers["git-protocol"] + "]" : ""));

    try {
      if (req.method === "GET" && req.url.startsWith("/repo.git/info/refs?service=git-upload-pack")) {
        res.setHeader("content-type", CONTENT_TYPE);
        return res.end(advertise(await manifest()));
      }

      if (req.method === "POST" && req.url === "/repo.git/git-upload-pack") {
        let body = await collect(req);
        if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);

        res.setHeader("content-type", RESULT_TYPE);
        results.push(await serve({ store, cache, manifest: await manifest(), body, out: res, limiter, chunkSize, keepaliveAfter, walkLimit, historyLimit }));
        return;
      }

      res.statusCode = 404;
      res.end();
    } catch (err) {
      errors.push(err);
      if (res.headersSent) return res.destroy();
      res.statusCode = err.code === "BUSY" ? 503 : err.code === "PROTOCOL" ? 400 : 500;
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: "http://127.0.0.1:" + server.address().port + "/repo.git",
    results,
    errors,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// Runs git without blocking (the server is in this process). Resolves
// { code, stdout, stderr }; it never rejects.
function runGit(args, { cwd } = {}) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };

  return new Promise((resolve) => {
    execFile("git", args, { cwd, env, maxBuffer: 1 << 28 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// The manifest of a repository whose packs are `packs` (manifest entries) and
// whose branch master is `head`, with `tags` (name -> oid)
function manifestOf(packs, head, tags = {}) {
  const refs = head ? { "refs/heads/master": head } : {};
  for (const [name, oid] of Object.entries(tags)) refs["refs/tags/" + name] = oid;
  return { ...manifestModule.empty(), seq: 1, writer: "test", head: head ? "refs/heads/master" : null, refs, packs };
}

module.exports = { startServer, runGit, manifestOf, collect };
