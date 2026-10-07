const EventEmitter = require("events");

describe("redisSubscriber", function () {
  const { ClientOfflineError } = require("redis");
  const { isRedisUnavailableError } = require("helper/redisUnavailable");
  const subscriberPath = require.resolve("helper/redisSubscriber");
  const redisPath = require.resolve("models/redis");
  let originalRedis;
  let createRedisClient;

  function flush() {
    return new Promise(function (resolve) {
      setImmediate(resolve);
    });
  }

  // Stands in for a node-redis client. connect() leaves it connecting until
  // the test calls client.ready(), like a client whose server is down.
  function fakeClient() {
    const client = new EventEmitter();
    client.isOpen = false;
    client.isReady = false;
    client.options = {};
    client.connect = jasmine.createSpy("connect").and.callFake(function () {
      client.isOpen = true;
      return new Promise(function () {});
    });
    client.ready = function () {
      client.isReady = true;
      // models/redis switches off the offline queue once connected
      client.options.disableOfflineQueue = true;
      client.emit("ready");
    };
    client.down = function () {
      client.isReady = false;
    };
    client.listeners = {};
    client.subscribe = jasmine.createSpy("subscribe").and.callFake(async function (channel, listener) {
      client.listeners[channel] = listener;
    });
    client.unsubscribe = jasmine.createSpy("unsubscribe").and.callFake(async function (channel) {
      delete client.listeners[channel];
    });
    client.publish = function (channel, message) {
      if (client.listeners[channel]) client.listeners[channel](message, channel);
    };
    return client;
  }

  function load(client) {
    createRedisClient = jasmine.createSpy("createRedisClient").and.returnValue(client);
    createRedisClient.BOOT_QUEUE_MS = 10 * 1000;
    require.cache[redisPath] = { exports: createRedisClient };
    delete require.cache[subscriberPath];
    return require("helper/redisSubscriber");
  }

  async function rejection(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("expected a rejection");
  }

  beforeEach(function () {
    originalRedis = require.cache[redisPath];
  });

  afterEach(function () {
    delete require.cache[subscriberPath];
    if (originalRedis) require.cache[redisPath] = originalRedis;
    else delete require.cache[redisPath];
  });

  it("shares one connection and one subscription per channel", async function () {
    const client = fakeClient();
    const redisSubscriber = load(client);
    client.ready();

    const subscriptions = [];
    for (let i = 0; i < 100; i++) {
      subscriptions.push(redisSubscriber({ channel: "channel:" + (i % 3) }));
    }
    await Promise.all(subscriptions.map((s) => s.setupPromise));

    expect(createRedisClient).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.subscribe.calls.allArgs().map((args) => args[0]).sort()).toEqual([
      "channel:0",
      "channel:1",
      "channel:2",
    ]);
    subscriptions.forEach(function (subscription) {
      expect(subscription.client).toBe(client);
    });
  });

  it("delivers each message to every listener on its channel", async function () {
    const client = fakeClient();
    const redisSubscriber = load(client);
    client.ready();
    const a = jasmine.createSpy("a");
    const b = jasmine.createSpy("b");
    const other = jasmine.createSpy("other");

    const subscriptions = [
      redisSubscriber({ channel: "test", onMessage: a }),
      redisSubscriber({ channel: "test", onMessage: b }),
      redisSubscriber({ channel: "other", onMessage: other }),
    ];
    await Promise.all(subscriptions.map((s) => s.setupPromise));
    client.publish("test", "hello");

    expect(a).toHaveBeenCalledWith("hello", "test");
    expect(b).toHaveBeenCalledWith("hello", "test");
    expect(other).not.toHaveBeenCalled();
  });

  it("unsubscribes only when the last listener on a channel leaves", async function () {
    const client = fakeClient();
    const redisSubscriber = load(client);
    client.ready();
    const first = jasmine.createSpy("first");
    const second = jasmine.createSpy("second");

    const one = redisSubscriber({ channel: "test", onMessage: first });
    const two = redisSubscriber({ channel: "test", onMessage: second });
    await Promise.all([one.setupPromise, two.setupPromise]);

    const cleanup = one.cleanup();
    expect(one.cleanup()).toBe(cleanup);
    await cleanup;
    await flush();
    expect(client.unsubscribe).not.toHaveBeenCalled();

    client.publish("test", "late");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("late", "test");

    await two.cleanup();
    await flush();
    expect(client.unsubscribe).toHaveBeenCalledTimes(1);
    expect(client.unsubscribe.calls.mostRecent().args[0]).toBe("test");

    // The connection stays up for the next subscriber
    const three = redisSubscriber({ channel: "test" });
    await three.setupPromise;
    expect(createRedisClient).toHaveBeenCalledTimes(1);
    expect(client.subscribe).toHaveBeenCalledTimes(2);
  });

  it("rejects at once while Redis is down and keeps nothing behind", async function () {
    const client = fakeClient();
    const redisSubscriber = load(client);
    client.ready();
    const established = redisSubscriber({ channel: "existing" });
    await established.setupPromise;
    client.down();

    const onError = jasmine.createSpy("onError");
    const onNew = redisSubscriber({ channel: "new", onError });
    const onExisting = redisSubscriber({ channel: "existing", onError });

    const err = await rejection(onNew.setupPromise);
    expect(err instanceof ClientOfflineError).toBe(true);
    expect(isRedisUnavailableError(err)).toBe(true);
    await rejection(onExisting.setupPromise);
    await flush();

    expect(onError).toHaveBeenCalledTimes(2);
    expect(client.subscribe).toHaveBeenCalledTimes(1);
    expect(createRedisClient).toHaveBeenCalledTimes(1);

    // Once Redis is back the same channel subscribes normally
    client.ready();
    const retry = redisSubscriber({ channel: "new" });
    await retry.setupPromise;
    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(client.subscribe.calls.mostRecent().args[0]).toBe("new");
  });

  it("does not wait on Redis to clean up", async function () {
    const client = fakeClient();
    const redisSubscriber = load(client);
    client.ready();
    const subscription = redisSubscriber({ channel: "test" });
    await subscription.setupPromise;

    // While Redis is down node-redis holds an UNSUBSCRIBE until it reconnects
    client.down();
    client.unsubscribe.and.returnValue(new Promise(function () {}));

    await subscription.cleanup();
    await flush();
    expect(client.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("waits for the first connection, then gives up after the boot grace period", async function () {
    jasmine.clock().install();
    try {
      const client = fakeClient();
      const redisSubscriber = load(client);

      const waiting = redisSubscriber({ channel: "test", onError: function () {} });
      let settled = false;
      waiting.setupPromise.then(
        () => (settled = true),
        () => (settled = true)
      );
      jasmine.clock().tick(createRedisClient.BOOT_QUEUE_MS - 1);
      await Promise.resolve();
      expect(settled).toBe(false);

      jasmine.clock().tick(1);
      const err = await rejection(waiting.setupPromise);
      expect(err instanceof ClientOfflineError).toBe(true);
      expect(client.subscribe).not.toHaveBeenCalled();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it("subscribes once connected, unless every listener left first", async function () {
    const client = fakeClient();
    const redisSubscriber = load(client);

    const left = redisSubscriber({ channel: "left" });
    const stayed = redisSubscriber({ channel: "stayed" });
    await left.cleanup();
    client.ready();
    await stayed.setupPromise;
    await left.setupPromise;
    await flush();

    expect(client.subscribe.calls.allArgs().map((args) => args[0])).toEqual(["stayed"]);
    expect(client.unsubscribe).not.toHaveBeenCalled();
  });

  it("retries an unsubscribe lost to a disconnect once reconnected", async function () {
    const client = fakeClient();
    const redisSubscriber = load(client);
    client.ready();
    const subscription = redisSubscriber({ channel: "test" });
    await subscription.setupPromise;

    client.unsubscribe.and.returnValue(Promise.reject(new Error("Socket closed")));
    await subscription.cleanup();
    await flush();
    expect(client.unsubscribe).toHaveBeenCalledTimes(1);

    client.unsubscribe.and.returnValue(Promise.resolve());
    client.ready();
    await flush();
    expect(client.unsubscribe).toHaveBeenCalledTimes(2);
    expect(client.unsubscribe.calls.mostRecent().args[0]).toBe("test");

    // Only once
    client.ready();
    await flush();
    expect(client.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("starts a new connection if the shared one was closed", async function () {
    const first = fakeClient();
    const redisSubscriber = load(first);
    first.ready();
    await redisSubscriber({ channel: "test" }).setupPromise;

    first.isOpen = false;
    const second = fakeClient();
    createRedisClient.and.returnValue(second);
    const subscription = redisSubscriber({ channel: "test" });
    second.ready();
    await subscription.setupPromise;

    expect(subscription.client).toBe(second);
    expect(second.subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering if a handler throws, even if onError throws too", async function () {
    const client = fakeClient();
    const redisSubscriber = load(client);
    client.ready();
    const after = jasmine.createSpy("after");
    const logger = { log: jasmine.createSpy("log") };

    const throwing = redisSubscriber({
      channel: "test",
      logger,
      onMessage: function () {
        throw new Error("handler exploded");
      },
      onError: function () {
        throw new Error("onError exploded");
      },
    });
    const fine = redisSubscriber({ channel: "test", onMessage: after });
    await Promise.all([throwing.setupPromise, fine.setupPromise]);
    client.publish("test", "hello");

    expect(after).toHaveBeenCalledWith("hello", "test");
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
