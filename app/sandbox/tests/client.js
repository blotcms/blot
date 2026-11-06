describe("sandbox client", function () {
  const net = require("net");
  const fs = require("fs-extra");
  const os = require("os");
  const path = require("path");
  const config = require("config");
  const sandbox = require("../");

  let directory, server, socket;

  beforeEach(async function () {
    socket = config.sandbox.socket;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-client-"));
  });

  afterEach(async function () {
    config.sandbox.socket = socket;
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    await fs.remove(directory);
  });

  // A broker that reads the whole request, then calls answer(conn, request)
  async function broker(answer) {
    if (server) await new Promise((resolve) => server.close(resolve));
    const file = path.join(directory, "broker.sock");
    await fs.remove(file);
    server = net.createServer({ allowHalfOpen: true }, (conn) => {
      const chunks = [];
      conn.on("data", (chunk) => chunks.push(chunk));
      conn.on("end", () => answer(conn, Buffer.concat(chunks)));
      conn.on("error", () => {});
    });
    await new Promise((resolve) => server.listen(file, resolve));
    config.sandbox.socket = file;
  }

  async function code(promise) {
    try {
      await promise;
    } catch (err) {
      return err.code;
    }
    return null;
  }

  const jobLine = (meta, outputs) =>
    Buffer.concat([
      Buffer.from(
        JSON.stringify({ meta, lengths: outputs.map((o) => o.length) }) + "\n"
      ),
      ...outputs,
    ]);

  const okReply = (body) =>
    Buffer.concat([
      Buffer.from(JSON.stringify({ ok: true, length: body.length }) + "\n"),
      body,
    ]);

  it("sends the job, arguments and input, and returns meta and outputs", async function () {
    let request;
    await broker((conn, received) => {
      request = received.toString();
      conn.end(
        okReply(jobLine({ width: 3 }, [Buffer.from("ab"), Buffer.from("cde")]))
      );
    });

    const result = await sandbox.run(
      "metadata",
      { a: 1 },
      Buffer.from("INPUT")
    );

    expect(request).toEqual('{"job":"metadata"}\n{"a":1}\nINPUT');
    expect(result.meta).toEqual({ width: 3 });
    expect(result.outputs.map(String)).toEqual(["ab", "cde"]);
  });

  it("streams input from a path", async function () {
    let request;
    const file = path.join(directory, "input");
    await fs.outputFile(file, "FROM DISK");
    await broker((conn, received) => {
      request = received.toString();
      conn.end(okReply(jobLine({}, [])));
    });

    await sandbox.run("metadata", {}, { path: file });

    expect(request.endsWith("\nFROM DISK")).toBe(true);
  });

  it("fails closed when the socket is missing", async function () {
    config.sandbox.socket = path.join(directory, "missing.sock");
    expect(await code(sandbox.run("metadata", {}, Buffer.alloc(1)))).toEqual(
      "SANDBOX_UNAVAILABLE"
    );
  });

  it("fails closed when the broker says ok:false", async function () {
    await broker((conn) => conn.end('{"ok":false,"error":"busy"}\n'));
    expect(await code(sandbox.run("metadata", {}, Buffer.alloc(1)))).toEqual(
      "SANDBOX_BUSY"
    );

    await broker((conn) =>
      conn.end('{"ok":false,"error":"input-too-large"}\n')
    );
    expect(await code(sandbox.run("metadata", {}, Buffer.alloc(1)))).toEqual(
      "SANDBOX_INPUT_TOO_LARGE"
    );
  });

  it("fails closed on a malformed reply", async function () {
    for (const reply of [
      "not json\n",
      "[]\n",
      '{"ok":true}\n',
      '{"ok":true,"length":-1}\n',
      '{"ok":false,"error":"something-else"}\n',
      "",
      okReply(Buffer.from("not json\n")),
      okReply(Buffer.from('{"meta":{},"lengths":[5]}\nabc')),
    ]) {
      await broker((conn) => conn.end(reply));
      expect(await code(sandbox.run("metadata", {}, Buffer.alloc(1)))).toMatch(
        /^SANDBOX_(BAD_REPLY|TRUNCATED)$/
      );
    }
  });

  it("fails closed on a truncated reply", async function () {
    const body = jobLine({ a: 1 }, [Buffer.from("abcdef")]);
    await broker((conn) => conn.end(okReply(body).subarray(0, -3)));
    expect(await code(sandbox.run("metadata", {}, Buffer.alloc(1)))).toEqual(
      "SANDBOX_TRUNCATED"
    );
  });

  it("rejects a job name it can't send", async function () {
    config.sandbox.socket = path.join(directory, "unused.sock");
    expect(await code(sandbox.run("../x", {}, Buffer.alloc(1)))).toEqual(
      "SANDBOX_UNKNOWN_JOB"
    );
  });
});
