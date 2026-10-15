// The hot doc poller keeps its state in Redis and its poll schedule in a
// helper/alarm queue, so any process can poll a doc another one enqueued.
// These specs use the real Redis: enqueue, make the alarm due, let the poll
// claim it, and check what it re-armed.
describe("google drive hotDocPoller", function () {
  const { randomUUID } = require("crypto");
  const client = require("models/client");
  const alarm = require("helper/alarm");
  const poller = require("../hotDocPoller");

  const ITEM_PREFIX = "blot:google-drive:hotdocs:item:";

  let serviceAccountId, blogID, fileId, folderId, id, revision;
  let originalAlarms, queueName;

  beforeEach(function () {
    serviceAccountId = "test-sa-" + randomUUID();
    blogID = "blog_" + randomUUID();
    fileId = "file-" + randomUUID();
    folderId = "folder-" + randomUUID();
    id = [serviceAccountId, blogID, fileId].join(":");
    revision = "rev-1";

    // Each spec polls its own alarm queue, so alarms left in the shared one
    // (by other specs, processes or earlier runs) are never claimed here.
    // Nothing polls on a timer: specs drive alarms.poll() themselves.
    originalAlarms = poller.alarms;
    queueName = "google-drive-hot-docs-test-" + randomUUID();
    poller.alarms = alarm(queueName, (each) => poller.handleAlarm(each), {
      pollMs: 1000,
      batch: 20,
    });
    spyOn(poller, "start");

    spyOn(console, "log");
    spyOn(console, "warn");
    spyOn(poller, "getDocs").and.callFake(async () => ({
      documents: {
        get: async () => ({
          data: { documentId: fileId, title: "Doc", revisionId: revision },
        }),
      },
    }));
    // Skip the shared rate limiter (4 docs.get a second per service account),
    // which would make the cap spec take over half a minute
    spyOn(poller, "fetchRateLimited").and.callFake((sa, docs, each) =>
      poller.fetchLatestRevisionState(docs, each)
    );
    spyOn(poller, "triggerDownloadAndSync").and.returnValue(
      Promise.resolve("synced")
    );
  });

  afterEach(async function () {
    await poller.stop();
    await poller.remove(id, serviceAccountId);
    await client.del(["alarm:due:" + queueName, "alarm:claims:" + queueName]);
    poller.alarms = originalAlarms;
  });

  const makeDue = (when = Date.now() - 1) => poller.alarms.set(id, when);
  const field = (name) => client.hGet(ITEM_PREFIX + id, name);

  it("arms an alarm at the first tier's interval when a doc is enqueued", async function () {
    const before = Date.now();
    await poller.enqueue({ blogID, serviceAccountId, fileId, folderId });

    const due = await poller.alarms.when(id);
    expect(due).toBeGreaterThanOrEqual(before + 2000);
    expect(due).toBeLessThan(Date.now() + 2000 + 300 + 1);
    expect(await field("lastKnownRevision")).toEqual("rev-1");
    expect(await field("folderId")).toEqual(folderId);
  });

  it("polls a due doc and re-arms the alarm for the next poll when nothing changed", async function () {
    await poller.enqueue({ blogID, serviceAccountId, fileId, folderId });
    await makeDue();

    await poller.alarms.poll();

    expect(poller.triggerDownloadAndSync).not.toHaveBeenCalled();
    expect(await field("pollCount")).toEqual("1");
    // Seen a moment ago, so still the 2s tier (plus up to 20% jitter)
    const due = await poller.alarms.when(id);
    expect(due).toBeGreaterThan(Date.now());
    expect(due).toBeLessThanOrEqual(Date.now() + 2000 + 400);
  });

  it("syncs when the revision changed, records it and keeps polling", async function () {
    await poller.enqueue({ blogID, serviceAccountId, fileId, folderId });
    revision = "rev-2";
    await makeDue();

    await poller.alarms.poll();

    expect(poller.triggerDownloadAndSync).toHaveBeenCalledTimes(1);
    expect(poller.triggerDownloadAndSync.calls.argsFor(0)[0].blogID).toEqual(blogID);
    expect(await field("lastKnownRevision")).toEqual("rev-2");
    expect(await poller.alarms.when(id)).toBeGreaterThan(Date.now());
  });

  it("starts one sync when two docs of the same blog change at once", async function () {
    const otherFileId = fileId + "-other";
    const otherId = [serviceAccountId, blogID, otherFileId].join(":");
    const cooldownKey = "blot:google-drive:hotdocs:cooldown:" + blogID;
    try {
      await poller.enqueue({ blogID, serviceAccountId, fileId, folderId });
      await poller.enqueue({ blogID, serviceAccountId, fileId: otherFileId, folderId });
      revision = "rev-2";

      poller.triggerDownloadAndSync.and.callThrough();
      spyOn(poller, "downloadAndSync").and.callFake(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "synced";
      });

      await Promise.all([poller.handleAlarm(id), poller.handleAlarm(otherId)]);

      expect(poller.downloadAndSync).toHaveBeenCalledTimes(1);
    } finally {
      await poller.remove(otherId, serviceAccountId);
      await client.del(cooldownKey);
    }
  });

  it("releases the blog's sync cooldown when the sync fails", async function () {
    const cooldownKey = "blot:google-drive:hotdocs:cooldown:" + blogID;
    await poller.enqueue({ blogID, serviceAccountId, fileId, folderId });
    revision = "rev-2";

    poller.triggerDownloadAndSync.and.callThrough();
    spyOn(poller, "downloadAndSync").and.callFake(async () => {
      throw new Error("boom");
    });

    await poller.handleAlarm(id);

    expect(await client.exists(cooldownKey)).toEqual(0);
  });

  it("re-arms at the first tier when the doc was enqueued again during the poll", async function () {
    await poller.enqueue({ blogID, serviceAccountId, fileId, folderId });
    // Old enough for the 10s tier
    await client.hSet(ITEM_PREFIX + id, "lastSeen", String(Date.now() - 90 * 1000));
    poller.fetchRateLimited.and.callFake(async (sa, docs, each) => {
      await client.hSet(ITEM_PREFIX + id, "lastSeen", String(Date.now()));
      return poller.fetchLatestRevisionState(docs, each);
    });

    await poller.handleAlarm(id);

    const due = await poller.alarms.when(id);
    expect(due).toBeGreaterThan(Date.now());
    expect(due).toBeLessThanOrEqual(Date.now() + 2000 + 300 + 1);
  });

  it("lengthens the interval as the doc ages and stops polling it after ten minutes", async function () {
    await poller.enqueue({ blogID, serviceAccountId, fileId, folderId });

    // 90 seconds since the doc was last seen: the 10s tier
    await client.hSet(ITEM_PREFIX + id, "lastSeen", String(Date.now() - 90 * 1000));
    await makeDue();
    await poller.alarms.poll();
    const due = await poller.alarms.when(id);
    expect(due).toBeGreaterThanOrEqual(Date.now() + 9000);
    expect(due).toBeLessThanOrEqual(Date.now() + 10000 + 2000);

    // Past the last tier: evicted, nothing left to poll
    await client.hSet(ITEM_PREFIX + id, "lastSeen", String(Date.now() - 11 * 60 * 1000));
    await makeDue();
    await poller.alarms.poll();
    expect(await poller.alarms.when(id)).toBeNull();
    expect(await client.exists(ITEM_PREFIX + id)).toEqual(0);
  });

  it("does not evict a doc that was enqueued again after the poll read it", async function () {
    await poller.enqueue({ blogID, serviceAccountId, fileId, folderId });
    const stale = await poller.loadItem(id);
    // Another process re-enqueues it after our snapshot
    const refreshed = String(Date.now());
    await client.hSet(ITEM_PREFIX + id, "lastSeen", refreshed);

    expect(await poller.evictIfUnchanged(stale, "age")).toBe(false);
    expect(await field("lastSeen")).toEqual(refreshed);

    expect(await poller.evictIfUnchanged(await poller.loadItem(id), "age")).toBe(true);
    expect(await client.exists(ITEM_PREFIX + id)).toEqual(0);
  });

  it("spaces docs.get slots 250ms apart for a service account", async function () {
    poller.fetchRateLimited.and.callThrough();
    const times = [];
    for (let i = 0; i < 3; i++) {
      await poller.acquireDocsSlot(serviceAccountId);
      times.push(Date.now());
    }
    // Three slots need at least two slot boundaries between them
    expect(times[2] - times[0]).toBeGreaterThanOrEqual(250);
    const slots = new Set(times.map((t) => Math.floor(t / 250)));
    expect(slots.size).toEqual(3);
  });

  it("evicts the oldest docs beyond the per service account cap", async function () {
    const ids = [];
    // Enough to pass the per service account cap of 150 without polling
    // (enqueue's own docs.get is the stub above)
    for (let i = 0; i < 152; i++) {
      await poller.enqueue({
        blogID,
        serviceAccountId,
        fileId: fileId + "-" + i,
        folderId,
      });
      ids.push([serviceAccountId, blogID, fileId + "-" + i].join(":"));
    }

    try {
      // Docs enqueued in the same millisecond tie on first seen, so which two
      // went isn't fixed; the cap is what matters.
      const setKey = "blot:google-drive:hotdocs:by-service-account:" + serviceAccountId;
      expect(await client.zCard(setKey)).toEqual(150);
      let remaining = 0;
      for (const each of ids) {
        remaining += await client.exists(ITEM_PREFIX + each);
        if (!(await client.exists(ITEM_PREFIX + each))) {
          expect(await poller.alarms.when(each)).toBeNull();
        }
      }
      expect(remaining).toEqual(150);
    } finally {
      for (const each of ids) await poller.remove(each, serviceAccountId);
    }
  }, 30000);
});
