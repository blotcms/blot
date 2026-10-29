describe("listen", function () {
  const http = require("http");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const listen = require("helper/listen");

  let servers, socket;

  function start(options) {
    return new Promise((resolve) => {
      servers = listen(
        (req, res) => res.end("ok"),
        { port: 0, socket, ...options },
        resolve
      );
    });
  }

  function get(socketPath) {
    return new Promise((resolve, reject) => {
      http
        .get({ socketPath, agent: false }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        })
        .on("error", reject);
    });
  }

  function close(server) {
    return new Promise((resolve) => server.close(resolve));
  }

  beforeEach(function () {
    socket = path.join(os.tmpdir(), `blot-listen-${process.pid}.sock`);
    fs.rmSync(socket, { force: true });
  });

  afterEach(function () {
    for (const server of servers || []) if (server.listening) server.close();
    servers = null;
    fs.rmSync(socket, { force: true });
  });

  it("serves the handler on the socket and the port", async function () {
    await start();

    expect(servers.length).toBe(2);
    expect(await get(socket)).toBe("ok");
    expect(fs.statSync(socket).mode & 0o777).toBe(0o666);
  });

  it("only listens on the port without a socket", async function () {
    await start({ socket: "" });

    expect(servers.length).toBe(1);
    expect(fs.existsSync(socket)).toBe(false);
  });

  it("only listens on the socket without a port", async function () {
    await start({ port: null });

    expect(servers.length).toBe(1);
    expect(await get(socket)).toBe("ok");
  });

  it("applies configure to each server", async function () {
    const configure = jasmine.createSpy("configure");
    await start({ configure });

    expect(configure).toHaveBeenCalledTimes(2);
  });

  it("replaces a stale socket file", async function () {
    fs.writeFileSync(socket, "");

    await start();

    expect(await get(socket)).toBe("ok");
  });

  it("refuses connections once closed", async function () {
    await start();
    await close(servers[1]);

    // Node unlinks the socket file on close, so this is ENOENT; ECONNREFUSED
    // (a file left by a SIGKILL) is the same immediate failure for nginx,
    // which retries it on the backup.
    expect(fs.existsSync(socket)).toBe(false);
    const err = await get(socket).catch((err) => err);
    expect(["ECONNREFUSED", "ENOENT"]).toContain(err.code);
  });
});
