describe("sync/seize", function () {
  const sync = require("../index");
  const seize = require("../seize");
  const hold = require("../hold");
  const lock = require("../lock");
  const client = require("models/client");
  const storage = require("storage/folder");
  const readOnly = require("helper/readOnly");

  global.test.timeout(60 * 1000);

  global.test.blog();

  beforeEach(async function () {
    await readOnly.disable();
    spyOn(console, "error").and.callThrough();
  });

  afterEach(async function () {
    await client.del([
      lock.cancelKey(this.blog.id),
      lock.seizedKey(this.blog.id),
    ]);
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function aborted(signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(signal.reason);
      signal.addEventListener("abort", () => resolve(signal.reason));
    });
  }

  function logged(label) {
    return console.error.calls
      .allArgs()
      .some((args) => args.some((arg) => String(arg).includes(label)));
  }

  async function settle(promise) {
    try {
      return { value: await promise };
    } catch (error) {
      return { error };
    }
  }

  it("aborts a sync's signal once the cancel key is set", async function () {
    const blogID = this.blog.id;
    let reason;

    const { error } = await settle(
      sync(blogID, async function (folder) {
        await client.set(lock.cancelKey(blogID), "disconnect", { PX: 30000 });
        reason = await aborted(folder.signal);
        folder.signal.throwIfAborted();
      })
    );

    expect(reason.code).toEqual("ECANCELED");
    expect(reason.reason).toEqual("disconnect");
    expect(error).toBe(reason);
    expect((await lock.inspect(blogID)).held).toBe(false);
  });

  it("waits for a sync that stops, then runs fn with the lock", async function () {
    const blogID = this.blog.id;
    let started;
    const startedSync = new Promise((resolve) => (started = resolve));

    const running = settle(
      sync(blogID, async function (folder) {
        started();
        await aborted(folder.signal);
        folder.signal.throwIfAborted();
      })
    );

    await startedSync;

    const result = await seize(blogID, async function ({ signal }) {
      expect(signal.aborted).toBe(false);
      expect((await lock.inspect(blogID)).held).toBe(true);
      return "disconnected";
    });

    const { error } = await running;

    expect(result).toEqual("disconnected");
    expect(error && error.code).toEqual("ECANCELED");
    expect(logged("[LOCK] forced seize")).toBe(false);
    expect(await client.exists(lock.cancelKey(blogID))).toEqual(0);
    expect((await lock.inspect(blogID)).held).toBe(false);
  });

  it("forces a holder that doesn't stop, which then stops without crashing", async function () {
    const blogID = this.blog.id;
    let started;
    let finish;
    const startedHold = new Promise((resolve) => (started = resolve));
    const holderMayFinish = new Promise((resolve) => (finish = resolve));
    let holderSignal;

    // Ignores its signal, and stays busy past a heartbeat after the seize
    const running = settle(
      hold(blogID, async function ({ signal }) {
        holderSignal = signal;
        started();
        await holderMayFinish;
      })
    );

    await startedHold;

    let ranWhileHolderBusy = false;

    await seize(
      blogID,
      async function () {
        ranWhileHolderBusy = true;
        // Long enough for the holder's heartbeat to find its lock gone
        await sleep(4000);
      },
      { wait: 1000 }
    );

    finish();
    await running;

    expect(ranWhileHolderBusy).toBe(true);
    expect(logged("[LOCK] forced seize")).toBe(true);
    expect(logged("[LOCK COMPROMISED]")).toBe(false);
    expect(holderSignal.aborted).toBe(true);
    expect(holderSignal.reason.code).toEqual("ECANCELED");
    expect(await client.exists(lock.seizedKey(blogID))).toEqual(1);
  });

  it("refuses the cancelled sync's writes to the folder, but not seize's", async function () {
    const blogID = this.blog.id;
    let writeError;
    let updateError;

    await settle(
      sync(blogID, async function (folder) {
        await client.set(lock.cancelKey(blogID), "disconnect", { PX: 30000 });
        await aborted(folder.signal);

        try {
          await storage.write(blogID, "/after-cancel.txt", "late");
        } catch (e) {
          writeError = e;
        }

        try {
          await folder.update("/after-cancel.txt");
        } catch (e) {
          updateError = e;
        }
      })
    );

    await client.del(lock.cancelKey(blogID));

    expect(writeError && writeError.code).toEqual("ECANCELED");
    expect(updateError && updateError.code).toEqual("ECANCELED");
    expect(await storage.exists(blogID, "/after-cancel.txt")).toBe(false);

    await seize(blogID, async function () {
      await storage.write(blogID, "/by-seize.txt", "ok");
    });

    expect(await storage.exists(blogID, "/by-seize.txt")).toBe(true);
  });

  it("keeps a new sync from taking the lock while the cancel key is set", async function () {
    const blogID = this.blog.id;

    await client.set(lock.cancelKey(blogID), "disconnect", { PX: 30000 });

    const { error } = await settle(sync(blogID, async function () {}));

    expect(error && error.message).toEqual("Failed to acquire folder lock");
    expect(error.cause && error.cause.code).toEqual("ELOCKED");
    expect((await lock.inspect(blogID)).held).toBe(false);
  });

  it("runs two seizes of a blog one after the other, forcing neither", async function () {
    const blogID = this.blog.id;
    const order = [];

    await Promise.all([
      seize(blogID, async function () {
        order.push("first");
        await sleep(1500);
        order.push("first done");
      }),
      sleep(100).then(() =>
        seize(
          blogID,
          async function () {
            order.push("second");
          },
          { wait: 500 }
        )
      ),
    ]);

    expect(order).toEqual(["first", "first done", "second"]);
    expect(logged("[LOCK] forced seize")).toBe(false);
  });

  it("only counts a lost lock as seized while a marker is set", async function () {
    const blogID = this.blog.id;

    expect(await lock.wasSeized(blogID)).toBe(false);

    await client.set(lock.seizedKey(blogID), "1", { PX: 30000 });
    expect(await lock.wasSeized(blogID)).toBe(true);

    await client.del(lock.seizedKey(blogID));
    await client.set(lock.cancelKey(blogID), "disconnect", { PX: 30000 });
    expect(await lock.wasSeized(blogID)).toBe(true);
  });
});
