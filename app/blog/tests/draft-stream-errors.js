const EventEmitter = require("events");

describe("draft stream route", function () {
  const routePath = require.resolve("../routes/draft");
  const subscriberPath = require.resolve("helper/redisSubscriber");
  const drafts = require("sync/update/drafts");
  let originalSubscriber;

  beforeEach(function () {
    originalSubscriber = require.cache[subscriberPath];
  });

  afterEach(function () {
    delete require.cache[routePath];
    if (originalSubscriber) require.cache[subscriberPath] = originalSubscriber;
    else delete require.cache[subscriberPath];
  });

  it("does not forward Redis errors to Express next", async function () {
    let captured;
    require.cache[subscriberPath] = {
      exports: function (options) {
        captured = options;
        return { cleanup: jasmine.createSpy("cleanup"), setupPromise: Promise.resolve() };
      },
    };
    delete require.cache[routePath];

    const routes = {};
    require("../routes/draft")({
      get: function (path, handler) {
        routes[path] = handler;
      },
    });

    const next = jasmine.createSpy("next");
    const req = new EventEmitter();
    req.blog = { id: "blog" };
    req.url = "/draft/stream/Drafts/index.txt";
    req.socket = { setTimeout: jasmine.createSpy("setTimeout") };
    const res = new EventEmitter();
    res.writeHead = jasmine.createSpy("writeHead");
    res.write = jasmine.createSpy("write");
    res.end = jasmine.createSpy("end");

    await routes[drafts.streamRoute](req, res, next);

    expect(captured.onError).not.toBe(next);
    captured.onError(new Error("boom"));
    expect(next).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("ends the stream when Redis setup fails", async function () {
    let rejectSetup;
    const setupPromise = new Promise(function (_, reject) {
      rejectSetup = reject;
    });
    require.cache[subscriberPath] = {
      exports: function () {
        return { cleanup: jasmine.createSpy("cleanup"), setupPromise };
      },
    };
    delete require.cache[routePath];

    const routes = {};
    require("../routes/draft")({
      get: function (path, handler) {
        routes[path] = handler;
      },
    });

    const next = jasmine.createSpy("next");
    const req = new EventEmitter();
    req.blog = { id: "blog" };
    req.url = "/draft/stream/Drafts/index.txt";
    req.socket = { setTimeout: jasmine.createSpy("setTimeout") };
    const res = new EventEmitter();
    res.writeHead = jasmine.createSpy("writeHead");
    res.write = jasmine.createSpy("write");
    res.end = jasmine.createSpy("end");

    await routes[drafts.streamRoute](req, res, next);

    rejectSetup(new Error("connect failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});
