describe("entry.getByUrl", function () {
  async function withMocks(redisImpl, getImpl, run) {
    const modulePath = require.resolve("../getByUrl");
    const redisPath = require.resolve("models/client");
    const getPath = require.resolve("../get");

    const oldGetByUrl = require.cache[modulePath];
    const oldRedis = require.cache[redisPath];
    const oldGet = require.cache[getPath];

    require.cache[redisPath] = {
      id: redisPath,
      filename: redisPath,
      loaded: true,
      exports: redisImpl,
    };

    require.cache[getPath] = {
      id: getPath,
      filename: getPath,
      loaded: true,
      exports: getImpl,
    };

    delete require.cache[modulePath];

    try {
      const getByUrl = require("../getByUrl");
      await run(getByUrl);
    } finally {
      delete require.cache[modulePath];

      if (oldRedis) require.cache[redisPath] = oldRedis;
      else delete require.cache[redisPath];

      if (oldGet) require.cache[getPath] = oldGet;
      else delete require.cache[getPath];

      if (oldGetByUrl) require.cache[modulePath] = oldGetByUrl;
      else delete require.cache[modulePath];
    }
  }

  it("decodes encoded unicode input and resolves the decoded key", async function () {
    const calls = [];

    await withMocks(
      {
        get: (key) => {
          calls.push(key);
          return Promise.resolve("/entry.txt");
        },
      },
      async (blogID, entryID) => {
        expect(blogID).toEqual("blog-id");
        expect(entryID).toEqual("/entry.txt");
        return { id: entryID, title: "ok" };
      },
      async (getByUrl) => {
        const entry = await getByUrl("blog-id", "/gr%C3%BC%C3%9Fe");

        expect(calls.length).toEqual(1);
        expect(calls[0]).toContain("/grüße");
        expect(entry.title).toEqual("ok");
      }
    );
  });

  it("does not throw on malformed percent input and falls back to raw key", async function () {
    const calls = [];

    await withMocks(
      {
        get: (key) => {
          calls.push(key);
          return Promise.resolve("/entry.txt");
        },
      },
      async () => ({ id: "/entry.txt" }),
      async (getByUrl) => {
        const entry = await getByUrl("blog-id", "/bad%2");

        expect(calls.length).toEqual(1);
        expect(calls[0]).toContain("/bad%2");
        expect(entry.id).toEqual("/entry.txt");
      }
    );
  });

  it("resolves undefined for a URL with no entry, without reading one", async function () {
    await withMocks(
      { get: () => Promise.resolve(null) },
      () => {
        throw new Error("get should not be called when there is no ID");
      },
      async (getByUrl) => {
        expect(await getByUrl("blog-id", "/missing")).toBeUndefined();
      }
    );
  });

  it("rejects with the error when redis rejects", async function () {
    const rejection = new Error("redis get failed");
    const consoleErrorSpy = spyOn(console, "error");

    await withMocks(
      {
        get: () => Promise.reject(rejection),
      },
      () => {
        throw new Error("get should not be called when redis.get rejects");
      },
      async (getByUrl) => {
        let error;

        try {
          await getByUrl("blog-id", "/entry");
        } catch (err) {
          error = err;
        }

        expect(error).toBe(rejection);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "entry.getByUrl: failed to resolve URL",
          rejection
        );
      }
    );
  });

  it("rejects with the error when reading the entry fails", async function () {
    const rejection = new Error("mget failed");

    await withMocks(
      { get: () => Promise.resolve("/entry.txt") },
      async () => {
        throw rejection;
      },
      async (getByUrl) => {
        let error;

        try {
          await getByUrl("blog-id", "/entry");
        } catch (err) {
          error = err;
        }

        expect(error).toBe(rejection);
      }
    );
  });

  it("keeps already-decoded input stable", async function () {
    const calls = [];

    await withMocks(
      {
        get: (key) => {
          calls.push(key);
          return Promise.resolve("/entry.txt");
        },
      },
      async () => ({ id: "/entry.txt" }),
      async (getByUrl) => {
        const entry = await getByUrl("blog-id", "/already-decoded");

        expect(calls.length).toEqual(1);
        expect(calls[0]).toContain("/already-decoded");
        expect(entry.id).toEqual("/entry.txt");
      }
    );
  });
});
