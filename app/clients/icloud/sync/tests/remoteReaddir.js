const fetchPath =
  require.resolve("../../util/rateLimitedFetchWithRetriesAndTimeout");
const remoteReaddirPath = require.resolve("../util/remoteReaddir");

describe("icloud remoteReaddir", function () {
  const originalFetch = require.cache[fetchPath];
  let calls;

  const load = (fetchImpl) => {
    calls = [];
    require.cache[fetchPath] = {
      id: fetchPath,
      filename: fetchPath,
      loaded: true,
      exports: async (url, options) => {
        calls.push(options);
        return fetchImpl(calls.length);
      },
    };
    delete require.cache[remoteReaddirPath];
    const remoteReaddir = require(remoteReaddirPath);
    remoteReaddir.backoff = [1, 1, 1];
    return remoteReaddir;
  };

  afterEach(function () {
    if (originalFetch) require.cache[fetchPath] = originalFetch;
    else delete require.cache[fetchPath];
    delete require.cache[remoteReaddirPath];
  });

  it("gives up on a first reply sooner, then waits longer than the macserver's whole listing flow", async function () {
    const remoteReaddir = load(async (n) => {
      if (n < 3) throw new Error("The user aborted a request.");
      return Buffer.from("[]");
    });
    await remoteReaddir("blog_x", "/");
    expect(calls.length).toEqual(3);
    // A reply lost on the way back costs half a minute, not two
    expect(calls[0].timeout).toEqual(30 * 1000);
    // A retry joins a listing still running on the macserver, so it waits
    // as long as that can take
    expect(calls[1].timeout).toBeGreaterThan(95 * 1000);
    expect(calls[2].timeout).toBeGreaterThan(95 * 1000);
    calls.forEach((options) => expect(options.retries).toEqual(1));
  });

  it("retries a failed listing after a pause and returns the result", async function () {
    const remoteReaddir = load(async (n) => {
      if (n < 3) throw new Error("HTTP error: 503 - Service Unavailable");
      return Buffer.from('[{"name":"a.md"}]');
    });
    const result = await remoteReaddir("blog_x", "/Drafts");
    expect(result).toEqual([{ name: "a.md" }]);
    expect(calls.length).toEqual(3);
  });

  it("does not retry a permanent 4xx such as a directory that no longer exists", async function () {
    const remoteReaddir = load(async () => {
      throw new Error(
        "Request failed after 1 retries: HTTP error: 404 - Not Found http://x/readdir"
      );
    });
    let error;
    try {
      await remoteReaddir("blog_x", "/gone");
    } catch (e) {
      error = e;
    }
    expect(error.message).toContain("404");
    expect(calls.length).toEqual(1);
  });

  it("throws once every attempt has failed", async function () {
    const remoteReaddir = load(async () => {
      throw new Error("HTTP error: 503 - Service Unavailable");
    });
    let error;
    try {
      await remoteReaddir("blog_x", "/");
    } catch (e) {
      error = e;
    }
    expect(error.message).toContain("503");
    expect(calls.length).toEqual(4);
  });
});
