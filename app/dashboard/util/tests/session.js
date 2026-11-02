describe("dashboard session store", function () {
  const session = require("dashboard/util/session");
  const client = require("models/client");
  const { store, MAX_AGE_MS } = session;

  it("is on the shared client, with its client-side cache", function () {
    expect(store.client).toBe(client);
  });

  it("does not touch the session in Redis", function (done) {
    spyOn(client, "expire").and.callThrough();
    const sess = { cookie: { expires: new Date(Date.now() + MAX_AGE_MS) } };
    store.touch("touchspec", sess, function (err) {
      expect(err).toBeNull();
      expect(client.expire).not.toHaveBeenCalled();
      done();
    });
  });

  // A req.session.save() made before the response still holds the old
  // cookie expiry, while the cookie sent goes out with a fresh maxAge
  it("keeps a session saved with an old expiry for the full maxAge", async function () {
    const sid = "sessionspec" + Date.now();
    const sess = {
      cookie: { expires: new Date(Date.now() + 60 * 60 * 1000), originalMaxAge: MAX_AGE_MS },
      uid: "user_spec",
    };
    try {
      await new Promise((resolve, reject) =>
        store.set(sid, sess, (err) => (err ? reject(err) : resolve()))
      );
      const ttl = await client.ttl("sess:" + sid);
      expect(ttl).toBeGreaterThan(MAX_AGE_MS / 1000 - 60);
      expect(ttl).toBeLessThanOrEqual(MAX_AGE_MS / 1000);
    } finally {
      await client.del(["sess:" + sid]);
    }
  });

  it("reads a session back, and sees a write to it", async function () {
    const sid = "sessionspec-read" + Date.now();
    const get = () =>
      new Promise((resolve, reject) =>
        store.get(sid, (err, data) => (err ? reject(err) : resolve(data)))
      );
    const set = (sess) =>
      new Promise((resolve, reject) =>
        store.set(sid, sess, (err) => (err ? reject(err) : resolve()))
      );
    const cookie = { expires: new Date(Date.now() + MAX_AGE_MS) };
    try {
      await set({ cookie, uid: "a" });
      expect((await get()).uid).toBe("a");
      expect((await get()).uid).toBe("a");
      await set({ cookie, uid: "b" });
      expect((await get()).uid).toBe("b");
      await new Promise((resolve, reject) =>
        store.destroy(sid, (err) => (err ? reject(err) : resolve()))
      );
      expect(await get()).toBeNull();
    } finally {
      await client.del(["sess:" + sid]);
    }
  });

  // Sessions are written and read back by different requests that can follow
  // each other closely (log in, then the redirect). Even if Redis's
  // invalidation arrives after the write's reply, the client has already
  // dropped the key it wrote (models/redis).
  it("reads its own session writes with the server's invalidations late", async function () {
    const { RedisStore } = require("connect-redis");
    const createRedisClient = require("models/redis");
    const lateClient = createRedisClient();
    await lateClient.connect();
    lateClient.clientSideCache.invalidate = function () {};
    const lateStore = new RedisStore({ client: lateClient, disableTouch: true, ttl: () => MAX_AGE_MS / 1000 });
    const sid = "sessionspec-late" + Date.now();
    const call = (method, ...args) =>
      new Promise((resolve, reject) =>
        lateStore[method](sid, ...args, (err, data) => (err ? reject(err) : resolve(data)))
      );
    const cookie = { expires: new Date(Date.now() + MAX_AGE_MS) };
    try {
      expect(await call("get")).toBeNull();
      await call("set", { cookie, uid: "a" });
      expect((await call("get")).uid).toBe("a");
      await call("set", { cookie, uid: "b" });
      expect((await call("get")).uid).toBe("b");
      await call("destroy");
      expect(await call("get")).toBeNull();
    } finally {
      await lateClient.del(["sess:" + sid]);
      await lateClient.quit();
    }
  });
});
