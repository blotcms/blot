const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const sandboxFetch = require("sandbox/fetch");
const download = require("../download");
const lifecycle = require("../../lifecycle");

const file = (body, headers = {}) => ({
  ok: true,
  status: 200,
  kind: "file",
  data: Buffer.from(body),
  headers,
});
const refused = (message, extra = {}) => ({
  ok: false,
  error: Object.assign(new Error(message), extra),
});

describe("bounded import downloads", function () {
  it("fetches in the sandbox's fetch job, with the import's limits and headers", async function () {
    spyOn(sandboxFetch, "many").and.callFake(async () => [file("abc")]);

    await download("https://example.com/small.pdf", {
      kind: "file",
      check: "pdf",
      timeout: 1234,
      maxBytes: 99,
      headers: {
        "User-Agent": "Blot",
        Referer: "https://www.are.na/",
        Accept: "image/*",
        Cookie: "no",
      },
    });

    expect(sandboxFetch.many.calls.argsFor(0)[0]).toEqual([
      {
        url: "https://example.com/small.pdf",
        kind: "file",
        check: "pdf",
        timeoutMs: 1234,
        maxBytes: 99,
        headers: {
          userAgent: "Blot",
          referer: "https://www.are.na/",
          accept: "image/*",
        },
      },
    ]);
  });

  it("preserves small bodies and the headers callers name files from", async function () {
    spyOn(sandboxFetch, "many").and.callFake(async () => [
      file("abc", {
        contentType: "application/pdf",
        contentDisposition: "inline",
        etag: '"x"',
      }),
    ]);
    const result = await download("https://example.com/small");
    expect(result.data.toString()).toBe("abc");
    expect(result.headers.get("content-type")).toBe("application/pdf");
    expect(result.headers.get("content-disposition")).toBe("inline");
    expect(result.headers.get("etag")).toBeUndefined();
  });

  it("returns an image's format and size from the jail", async function () {
    spyOn(sandboxFetch, "many").and.callFake(async () => [
      {
        ...file("png bytes"),
        kind: "image",
        format: "png",
        width: 3,
        height: 2,
      },
    ]);
    const result = await download("https://example.com/a", { kind: "image" });
    expect([result.format, result.width, result.height]).toEqual(["png", 3, 2]);
    expect(sandboxFetch.many.calls.argsFor(0)[0][0].maxBytes).toBeUndefined();
  });

  it("rejects with what the fetch gave for a URL that failed", async function () {
    spyOn(sandboxFetch, "many").and.callFake(async () => [
      refused("404", { status: 404 }),
    ]);
    let error;
    try {
      await download("https://example.com/missing");
    } catch (e) {
      error = e;
    }
    expect(error.message).toBe("404");
    expect(error.status).toBe(404);
  });

  it("never sends the sandbox a URL that isn't http(s)", async function () {
    spyOn(sandboxFetch, "many");
    for (const url of [
      "data:image/png;base64,AAAA",
      "ftp://example.com/a",
      "/relative.png",
      undefined,
      "http://",
    ]) {
      let error;
      try {
        await download(url);
      } catch (e) {
        error = e;
      }
      expect(error.message).toContain("Only HTTP(S) URLs");
    }
    expect(sandboxFetch.many).not.toHaveBeenCalled();
  });

  describe("prefetch", function () {
    const urls = [
      "https://example.com/a.pdf",
      "https://example.com/b.pdf",
      "https://example.com/c.pdf",
    ];
    const answer = (request) =>
      request.url.endsWith("b.pdf")
        ? refused("404", { status: 404 })
        : file(request.url);

    it("fetches the URLs in one batch when the first is asked for, and download takes them from it", async function () {
      spyOn(sandboxFetch, "batch").and.callFake(async (requests) =>
        requests.map(answer)
      );
      spyOn(sandboxFetch, "many");

      const prefetched = await download.prefetch(
        urls.concat(urls[0], "data:text/plain,hi", "/relative"),
        { kind: "file", check: "pdf", timeout: 777 }
      );
      expect(sandboxFetch.batch).not.toHaveBeenCalled();

      const options = { kind: "file", check: "pdf", prefetched };
      expect((await download(urls[0], options)).data.toString()).toBe(urls[0]);
      expect(sandboxFetch.batch).toHaveBeenCalledTimes(1);
      const sent = sandboxFetch.batch.calls.argsFor(0)[0];
      expect(sent.map((r) => r.url)).toEqual(urls);
      expect(sent.every((r) => r.check === "pdf" && r.timeoutMs === 777)).toBe(
        true
      );

      let error;
      try {
        await download(urls[1], options);
      } catch (e) {
        error = e;
      }
      expect(error.message).toBe("404");
      expect((await download(urls[2], options)).data.toString()).toBe(urls[2]);
      expect(sandboxFetch.batch).toHaveBeenCalledTimes(1);
      expect(sandboxFetch.many).not.toHaveBeenCalled();
    });

    it("fetches the next batch only when the import gets to it", async function () {
      const many = Array.from(
        { length: sandboxFetch.MAX_REQUESTS + 3 },
        (_, i) => `https://example.com/${i}.pdf`
      );
      spyOn(sandboxFetch, "batch").and.callFake(async (requests) =>
        requests.map((r) => file(r.url))
      );

      const prefetched = await download.prefetch(many, { kind: "file" });
      const options = { kind: "file", prefetched };

      await download(many[0], options);
      await download(many[sandboxFetch.MAX_REQUESTS - 1], options);
      expect(sandboxFetch.batch).toHaveBeenCalledTimes(1);
      expect(sandboxFetch.batch.calls.argsFor(0)[0].length).toBe(
        sandboxFetch.MAX_REQUESTS
      );

      await download(many[sandboxFetch.MAX_REQUESTS], options);
      expect(sandboxFetch.batch).toHaveBeenCalledTimes(2);
      expect(sandboxFetch.batch.calls.argsFor(1)[0].map((r) => r.url)).toEqual(
        many.slice(sandboxFetch.MAX_REQUESTS)
      );
    });

    it("stops fetching once the import's byte limit is reached", async function () {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "import-window-")
      );
      const state = lifecycle.create(directory);
      const many = Array.from(
        { length: sandboxFetch.MAX_REQUESTS + 1 },
        (_, i) => `https://example.com/${i}.pdf`
      );
      spyOn(sandboxFetch, "batch").and.callFake(async (requests) =>
        requests.map((r) => file(r.url))
      );
      try {
        await state.run(async () => {
          const prefetched = await download.prefetch(many, { kind: "file" });
          state.bytes = 1024 * 1024 * 1024 - 5;
          let error;
          try {
            await download(many[0], { kind: "file", prefetched });
          } catch (e) {
            error = e;
          }
          expect(error.code).toBe("IMPORT_BYTE_LIMIT");
          // the import is stopped: no second batch is fetched
          error = null;
          try {
            await download(many[sandboxFetch.MAX_REQUESTS], {
              kind: "file",
              prefetched,
            });
          } catch (e) {
            error = e;
          }
          expect(error.code).toBe("IMPORT_BYTE_LIMIT");
        });
        expect(sandboxFetch.batch).toHaveBeenCalledTimes(1);
      } finally {
        state.dispose();
        fs.removeSync(directory);
      }
    });

    it("leaves a URL put off for want of room in line for a batch of its own", async function () {
      spyOn(sandboxFetch, "batch").and.returnValues(
        Promise.resolve([file("a"), { deferred: true }, { deferred: true }]),
        Promise.resolve([file("b"), file("c")])
      );
      const prefetched = await download.prefetch(urls, { kind: "file" });
      const options = { kind: "file", prefetched };

      expect((await download(urls[0], options)).data.toString()).toBe("a");
      expect((await download(urls[1], options)).data.toString()).toBe("b");
      expect((await download(urls[2], options)).data.toString()).toBe("c");
      expect(sandboxFetch.batch.calls.argsFor(1)[0].map((r) => r.url)).toEqual(
        urls.slice(1)
      );
    });

    it("leaves one URL, or none, to download", async function () {
      spyOn(sandboxFetch, "batch");
      spyOn(sandboxFetch, "many").and.callFake(async () => [file("alone")]);
      const prefetched = await download.prefetch(urls.slice(0, 1));
      expect((await download(urls[0], { prefetched })).data.toString()).toBe(
        "alone"
      );
      await download.prefetch([]);
      expect(sandboxFetch.batch).not.toHaveBeenCalled();
    });

    it("leaves out what the sandbox itself failed on, so download tries it again", async function () {
      spyOn(sandboxFetch, "batch").and.returnValue(
        Promise.resolve(
          urls.map(() => refused("sandbox: busy", { code: "SANDBOX_BUSY" }))
        )
      );
      spyOn(sandboxFetch, "many").and.callFake(async () => [
        file("second try"),
      ]);

      const prefetched = await download.prefetch(urls, { kind: "file" });
      expect((await download(urls[0], { prefetched })).data.toString()).toBe(
        "second try"
      );
    });
  });

  it("stops at the cumulative job limit", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "import-limit-"));
    const state = lifecycle.create(directory);
    state.bytes = 1024 * 1024 * 1024 - 1;
    spyOn(sandboxFetch, "many").and.callFake(async () => [file("ab")]);
    try {
      let error;
      try {
        await state.run(() => download("https://example.com/asset"));
      } catch (e) {
        error = e;
      }
      expect(error.code).toBe("IMPORT_BYTE_LIMIT");
      expect(state.signal.aborted).toBe(true);
    } finally {
      state.dispose();
      fs.removeSync(directory);
    }
  });

  it("counts a download towards the job limit", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "import-count-"));
    const state = lifecycle.create(directory);
    spyOn(sandboxFetch, "many").and.callFake(async () => [file("abcd")]);
    try {
      await state.run(() => download("https://example.com/asset"));
      expect(state.bytes).toBe(4);
    } finally {
      state.dispose();
      fs.removeSync(directory);
    }
  });

  it("stops waiting when the import is cancelled, without waiting for the jail", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "import-cancel-"));
    const state = lifecycle.create(directory);
    spyOn(sandboxFetch, "many").and.callFake(async () => {
      await fs.outputFile(path.join(directory, "cancelled.txt"), "true");
      return new Promise(() => {});
    });
    try {
      let error;
      try {
        await state.run(() => download("https://example.com/asset"));
      } catch (e) {
        error = e;
      }
      expect(error.name).toBe("AbortError");
    } finally {
      state.dispose();
      fs.removeSync(directory);
    }
  });

  it("drops a download that finished after the import was cancelled", async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "import-late-"));
    const state = lifecycle.create(directory);
    spyOn(sandboxFetch, "many").and.callFake(async () => {
      state.abort();
      return [file("late")];
    });
    try {
      let error;
      try {
        await state.run(() => download("https://example.com/asset"));
      } catch (e) {
        error = e;
      }
      expect(error.name).toBe("AbortError");
      expect(state.bytes).toBe(0);
    } finally {
      state.dispose();
      fs.removeSync(directory);
    }
  });
});
