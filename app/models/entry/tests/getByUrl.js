describe("entry.getByUrl", function () {
  function withMocks(redisImpl, getImpl, run) {
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
      run(getByUrl);
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

  it("decodes encoded unicode input and resolves the decoded key", function (done) {
    const calls = [];

    withMocks(
      {
        get: key => {
          calls.push(key);
          return Promise.resolve("/entry.txt");
        },
      },
      (blogID, entryID, callback) => {
        expect(blogID).toEqual("blog-id");
        expect(entryID).toEqual("/entry.txt");
        callback({ id: entryID, title: "ok" });
      },
      getByUrl => {
        getByUrl("blog-id", "/gr%C3%BC%C3%9Fe", entry => {
          expect(calls.length).toEqual(1);
          expect(calls[0]).toContain("/grüße");
          expect(entry.title).toEqual("ok");
          done();
        });
      }
    );
  });

  it("does not throw on malformed percent input and falls back to raw key", function (done) {
    const calls = [];

    withMocks(
      {
        get: key => {
          calls.push(key);
          return Promise.resolve("/entry.txt");
        },
      },
      (_blogID, _entryID, callback) => callback({ id: "/entry.txt" }),
      getByUrl => {
        expect(function () {
          getByUrl("blog-id", "/bad%2", entry => {
            expect(calls.length).toEqual(1);
            expect(calls[0]).toContain("/bad%2");
            expect(entry.id).toEqual("/entry.txt");
            done();
          });
        }).not.toThrow();
      }
    );
  });


  it("handles redis rejection without throwing asynchronously", function (done) {
    const rejection = new Error("redis get failed");
    const uncaughtHandler = jasmine.createSpy("uncaughtHandler");
    const unhandledRejectionHandler = jasmine.createSpy("unhandledRejectionHandler");
    const originalConsoleError = console.error;
    const consoleErrorSpy = jasmine.createSpy("console.error");

    process.once("uncaughtException", uncaughtHandler);
    process.once("unhandledRejection", unhandledRejectionHandler);
    console.error = consoleErrorSpy;

    withMocks(
      {
        get: () => Promise.reject(rejection),
      },
      () => {
        throw new Error("get should not be called when redis.get rejects");
      },
      getByUrl => {
        expect(function () {
          getByUrl("blog-id", "/entry", function (entry, error) {
            expect(entry).toBeUndefined();
            expect(error).toBe(rejection);
          });
        }).not.toThrow();

        setTimeout(function () {
          console.error = originalConsoleError;

          expect(uncaughtHandler).not.toHaveBeenCalled();
          expect(unhandledRejectionHandler).not.toHaveBeenCalled();
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            "entry.getByUrl: failed to resolve URL",
            rejection
          );
          done();
        }, 10);
      }
    );
  });
  it("keeps already-decoded input stable", function (done) {
    const calls = [];

    withMocks(
      {
        get: key => {
          calls.push(key);
          return Promise.resolve("/entry.txt");
        },
      },
      (_blogID, _entryID, callback) => callback({ id: "/entry.txt" }),
      getByUrl => {
        getByUrl("blog-id", "/already-decoded", entry => {
          expect(calls.length).toEqual(1);
          expect(calls[0]).toContain("/already-decoded");
          expect(entry.id).toEqual("/entry.txt");
          done();
        });
      }
    );
  });
});
