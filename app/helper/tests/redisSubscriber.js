const EventEmitter = require("events");

describe("redisSubscriber", function () {
  const subscriberPath = require.resolve("helper/redisSubscriber");
  const redisPath = require.resolve("models/redis");
  let originalRedis;

  function stubRedis(client) {
    require.cache[redisPath] = { exports: function () { return client; } };
    delete require.cache[subscriberPath];
  }

  function openClient() {
    const client = new EventEmitter();
    client.isOpen = false;
    client.connect = jasmine.createSpy("connect").and.callFake(async function () {
      client.isOpen = true;
    });
    client.subscribe = jasmine.createSpy("subscribe");
    client.unsubscribe = jasmine.createSpy("unsubscribe").and.callFake(function () {
      return Promise.resolve();
    });
    client.quit = jasmine.createSpy("quit").and.callFake(function () {
      client.isOpen = false;
      return Promise.resolve();
    });
    return client;
  }

  beforeEach(function () {
    originalRedis = require.cache[redisPath];
  });

  afterEach(function () {
    delete require.cache[subscriberPath];
    if (originalRedis) require.cache[redisPath] = originalRedis;
    else delete require.cache[redisPath];
  });

  it("closes a client when cleanup happens while connect is pending", async function () {
    let finishConnect;
    const client = openClient();
    client.connect = jasmine.createSpy("connect").and.callFake(function () {
      return new Promise(function (resolve) {
        finishConnect = function () {
          client.isOpen = true;
          resolve();
        };
      });
    });

    stubRedis(client);
    const subscription = require("helper/redisSubscriber")({ channel: "test" });

    const firstCleanup = subscription.cleanup();
    expect(subscription.cleanup()).toBe(firstCleanup);
    await Promise.resolve();
    finishConnect();
    await firstCleanup;

    expect(client.subscribe).not.toHaveBeenCalled();
    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.isOpen).toBe(false);
  });

  it("suppresses messages after cleanup", async function () {
    let redisMessage;
    const onMessage = jasmine.createSpy("onMessage");
    const client = openClient();
    client.subscribe = async function (_channel, callback) { redisMessage = callback; };

    stubRedis(client);
    const subscription = require("helper/redisSubscriber")({
      channel: "test",
      onMessage,
    });
    await subscription.setupPromise;
    await subscription.cleanup();
    redisMessage("late");

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("quits once when setup fails and cleanup is also called", async function () {
    const onError = jasmine.createSpy("onError");
    const client = openClient();
    client.connect = jasmine.createSpy("connect").and.callFake(async function () {
      client.isOpen = true;
      throw new Error("connect failed");
    });

    stubRedis(client);
    const subscription = require("helper/redisSubscriber")({
      channel: "test",
      onError,
    });

    await subscription.setupPromise.then(
      function () {
        throw new Error("expected setup to fail");
      },
      function () {}
    );
    await subscription.cleanup();
    await subscription.cleanup();

    expect(client.subscribe).not.toHaveBeenCalled();
    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("still quits if onError throws during disconnect", async function () {
    const client = openClient();
    client.unsubscribe = jasmine.createSpy("unsubscribe").and.callFake(function () {
      return Promise.reject(new Error("unsubscribe failed"));
    });

    stubRedis(client);
    const subscription = require("helper/redisSubscriber")({
      channel: "test",
      onError: function () {
        throw new Error("onError exploded");
      },
    });

    await subscription.setupPromise;
    await subscription.cleanup();

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.isOpen).toBe(false);
  });
});
