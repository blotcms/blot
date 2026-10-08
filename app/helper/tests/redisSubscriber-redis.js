// Runs against the test Redis server, see redisSubscriber.js for the unit tests
describe("redisSubscriber with Redis", function () {
  const client = require("models/client");
  const subscriberPath = require.resolve("helper/redisSubscriber");
  const redisPath = require.resolve("models/redis");
  let originalRedis;
  let originalSubscriber;
  let created;
  let redisSubscriber;

  async function until(check) {
    const deadline = Date.now() + 5000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  beforeEach(function () {
    originalRedis = require.cache[redisPath];
    originalSubscriber = require.cache[subscriberPath];

    const createRedisClient = require("models/redis");
    created = [];
    const counting = Object.assign(function () {
      const redisClient = createRedisClient();
      created.push(redisClient);
      return redisClient;
    }, createRedisClient);
    require.cache[redisPath] = { exports: counting };
    delete require.cache[subscriberPath];
    redisSubscriber = require("helper/redisSubscriber");
  });

  afterEach(async function () {
    for (const redisClient of created) {
      if (redisClient.isOpen) await redisClient.quit();
    }
    if (originalRedis) require.cache[redisPath] = originalRedis;
    else delete require.cache[redisPath];
    if (originalSubscriber) require.cache[subscriberPath] = originalSubscriber;
    else delete require.cache[subscriberPath];
  });

  it("serves many streams from one connection and releases each channel", async function () {
    const prefix = "test:redisSubscriber:" + process.pid + ":" + Date.now() + ":";
    const channels = [prefix + "a", prefix + "b", prefix + "c"];
    const received = [];

    const subscriptions = [];
    for (let i = 0; i < 30; i++) {
      const channel = channels[i % channels.length];
      subscriptions.push(
        redisSubscriber({
          channel,
          onMessage: function (message, subscribedChannel) {
            received.push([i, message, subscribedChannel]);
          },
        })
      );
    }
    await Promise.all(subscriptions.map((s) => s.setupPromise));

    expect(created.length).toBe(1);
    expect(await client.pubSubNumSub(channels)).toEqual({
      [channels[0]]: 1,
      [channels[1]]: 1,
      [channels[2]]: 1,
    });

    await client.publish(channels[0], "hello");
    await until(() => received.length === 10);
    received.forEach(function ([i, message, channel]) {
      expect(i % channels.length).toBe(0);
      expect(message).toBe("hello");
      expect(channel).toBe(channels[0]);
    });

    // Channel a keeps one listener, b and c lose all of theirs
    await Promise.all(subscriptions.slice(1).map((s) => s.cleanup()));
    await until(async function () {
      const numsub = await client.pubSubNumSub(channels);
      return numsub[channels[1]] === 0 && numsub[channels[2]] === 0;
    });
    expect((await client.pubSubNumSub(channels[0]))[channels[0]]).toBe(1);

    await subscriptions[0].cleanup();
    await until(async function () {
      return (await client.pubSubNumSub(channels[0]))[channels[0]] === 0;
    });
    expect(created.length).toBe(1);
  });
});
