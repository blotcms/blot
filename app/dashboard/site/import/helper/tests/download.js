const { PassThrough, Readable } = require("stream");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const airlock = require("helper/airlock");
const download = require("../download");
const lifecycle = require("../../lifecycle");

function response(body, headers = {}) {
  return { ok: true, body, headers: { get: name => headers[name] || null } };
}

describe("bounded import downloads", function () {
  it("aborts a stalled body at its deadline", async function () {
    const body = new PassThrough();
    let signal;
    spyOn(airlock, "fetch").and.callFake(async (url, options) => {
      signal = options.signal;
      return response(body);
    });
    let error;
    try { await download("https://example.com/slow", { timeout: 10 }); } catch (e) { error = e; }
    expect(error.name).toBe("AbortError");
    expect(signal.aborted).toBe(true);
    expect(body.destroyed).toBe(true);
  });

  it("aborts before headers arrive", async function () {
    let signal;
    spyOn(airlock, "fetch").and.callFake((url, options) => {
      signal = options.signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(lifecycle.cancelled()));
      });
    });
    let error;
    try { await download("https://example.com/slow", { timeout: 10 }); } catch (e) { error = e; }
    expect(error.name).toBe("AbortError");
    expect(signal.aborted).toBe(true);
  });

  it("enforces actual bytes without Content-Length", async function () {
    const body = Readable.from([Buffer.from("123"), Buffer.from("456")]);
    spyOn(airlock, "fetch").and.returnValue(Promise.resolve(response(body)));
    let error;
    try { await download("https://example.com/large", { maxBytes: 5 }); } catch (e) { error = e; }
    expect(error.message).toContain("byte limit");
    expect(body.destroyed).toBe(true);
  });

  it("preserves small bodies and headers", async function () {
    spyOn(airlock, "fetch").and.returnValue(Promise.resolve(response(
      Readable.from([Buffer.from("abc")]), { "content-type": "application/pdf" }
    )));
    const result = await download("https://example.com/small");
    expect(result.data.toString()).toBe("abc");
    expect(result.headers.get("content-type")).toBe("application/pdf");
  });

  it("stops at the cumulative job limit", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "import-limit-"));
    const state = lifecycle.create(directory);
    state.bytes = 1024 * 1024 * 1024 - 1;
    spyOn(airlock, "fetch").and.callFake(async () => response(Readable.from([Buffer.from("ab")])));
    try {
      let error;
      try { await state.run(() => download("https://example.com/asset")); } catch (e) { error = e; }
      expect(error.code).toBe("IMPORT_BYTE_LIMIT");
      expect(state.signal.aborted).toBe(true);
    } finally {
      state.dispose();
      fs.removeSync(directory);
    }
  });

  it("interrupts active I/O when another worker creates the cancellation marker", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "import-cancel-"));
    const state = lifecycle.create(directory);
    const body = new PassThrough();
    spyOn(airlock, "fetch").and.callFake(async () => {
      await fs.outputFile(path.join(directory, "cancelled.txt"), "true");
      return response(body);
    });
    try {
      let error;
      try { await state.run(() => download("https://example.com/asset")); } catch (e) { error = e; }
      expect(error.name).toBe("AbortError");
      expect(body.destroyed).toBe(true);
    } finally {
      state.dispose();
      fs.removeSync(directory);
    }
  });
});
