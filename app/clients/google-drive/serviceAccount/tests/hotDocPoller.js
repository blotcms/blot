// The hot doc poller keeps its state in Redis and its poll schedule in a
// helper/alarm queue, so any process can poll a Doc another one enqueued.
// These specs use the real Redis: enqueue, make the alarm due, let the poll
// claim it, and check what it re-armed. Drive, Docs, the folder lock and the
// export are fakes.
describe("google drive hotDocPoller", function () {
  const { randomUUID } = require("crypto");
  const client = require("models/client");
  const alarm = require("helper/alarm");
  const database = require("clients/google-drive/database");
  const poller = require("../hotDocPoller");

  const ITEM_PREFIX = "blot:google-drive:hotdocs:item:";
  const GOOGLE_DOC = "application/vnd.google-apps.document";
  const MINUTE = 60 * 1000;

  let serviceAccountId, blogID, fileId, folderId, id, revision;
  let originalAlarms, queueName, extraIds;

  beforeEach(function () {
    serviceAccountId = "test-sa-" + randomUUID();
    blogID = "blog_" + randomUUID();
    fileId = "file-" + randomUUID();
    folderId = "folder-" + randomUUID();
    id = [serviceAccountId, blogID, fileId].join(":");
    revision = "rev-1";
    extraIds = [];

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
    spyOn(poller, "applyChange").and.returnValue(Promise.resolve("applied"));
  });

  afterEach(async function () {
    await poller.stop();
    await poller.remove(id, serviceAccountId);
    for (const each of extraIds) await poller.remove(each, serviceAccountId);
    await client.del(["alarm:due:" + queueName, "alarm:claims:" + queueName]);
    poller.alarms = originalAlarms;
  });

  const makeDue = (when = Date.now() - 1) => poller.alarms.set(id, when);
  const field = (name) => client.hGet(ITEM_PREFIX + id, name);
  const setField = (name, value) =>
    client.hSet(ITEM_PREFIX + id, name, String(value));
  const enqueue = (extra = {}) =>
    poller.enqueue({ blogID, serviceAccountId, fileId, folderId, ...extra });

  // Polls the Doc once and resolves how long until its next poll
  const pollOnce = async () => {
    await makeDue();
    await poller.alarms.poll();
    const due = await poller.alarms.when(id);
    return due === null ? null : due - Date.now();
  };

  describe("schedule", function () {
    it("arms an alarm at the 500ms tier when a Doc is enqueued", async function () {
      const before = Date.now();
      await enqueue();

      const due = await poller.alarms.when(id);
      expect(due).toBeGreaterThanOrEqual(before + 500);
      expect(due).toBeLessThanOrEqual(Date.now() + 500 + 100);
      expect(await field("lastKnownRevision")).toEqual("rev-1");
      expect(await field("folderId")).toEqual(folderId);
    });

    it("polls a due Doc and re-arms it at 500ms when nothing changed", async function () {
      await enqueue();

      const untilNext = await pollOnce();

      expect(poller.applyChange).not.toHaveBeenCalled();
      expect(await field("pollCount")).toEqual("1");
      expect(untilNext).toBeGreaterThan(0);
      expect(untilNext).toBeLessThanOrEqual(500 + 100);
    });

    it("follows the last detected change, not the first enqueue", async function () {
      await enqueue();
      // Enqueued 25 minutes ago: the 5s tier
      await setField("lastSeen", Date.now() - 25 * MINUTE);
      let untilNext = await pollOnce();
      expect(untilNext).toBeGreaterThan(4000);
      expect(untilNext).toBeLessThanOrEqual(5000 + 1000);

      // Changed 5 minutes ago: the 2s tier
      await setField("lastChanged", Date.now() - 5 * MINUTE);
      untilNext = await pollOnce();
      expect(untilNext).toBeGreaterThan(1500);
      expect(untilNext).toBeLessThanOrEqual(2000 + 400);

      // Changed now: back to 500ms, and the change is recorded
      revision = "rev-2";
      untilNext = await pollOnce();
      expect(poller.applyChange).toHaveBeenCalledTimes(1);
      expect(untilNext).toBeLessThanOrEqual(500 + 100);
      expect(Number(await field("lastChanged"))).toBeGreaterThan(
        Date.now() - 5000
      );
    });

    it("moves a watched Doc back to the 500ms tier when it is enqueued again", async function () {
      await enqueue();
      await setField("lastSeen", Date.now() - 20 * MINUTE);
      await poller.alarms.set(id, Date.now() + 5000);

      await enqueue();

      const due = await poller.alarms.when(id);
      expect(due).toBeLessThanOrEqual(Date.now() + 500 + 100);
      expect(Number(await field("lastSeen"))).toBeGreaterThan(
        Date.now() - 5000
      );
      // The revision it already had is kept, so this isn't taken for a change
      expect(await field("lastKnownRevision")).toEqual("rev-1");
    });

    it("re-arms at the first tier when the Doc was enqueued again during the poll", async function () {
      await enqueue();
      await setField("lastSeen", Date.now() - 15 * MINUTE);
      poller.fetchRateLimited.and.callFake(async (sa, docs, each) => {
        await setField("lastSeen", Date.now());
        return poller.fetchLatestRevisionState(docs, each);
      });

      await poller.handleAlarm(id);

      const due = await poller.alarms.when(id);
      expect(due).toBeLessThanOrEqual(Date.now() + 500 + 100);
    });

    it("keeps watching a Doc for 30 minutes after its last activity, then evicts it", async function () {
      await enqueue();

      await setField("lastSeen", Date.now() - 29 * MINUTE);
      await setField("lastChanged", Date.now() - 29 * MINUTE);
      expect(await pollOnce()).toBeGreaterThan(4000);
      expect(await client.exists(ITEM_PREFIX + id)).toEqual(1);

      await setField("lastSeen", Date.now() - 31 * MINUTE);
      await setField("lastChanged", Date.now() - 31 * MINUTE);
      expect(await pollOnce()).toBeNull();
      expect(await client.exists(ITEM_PREFIX + id)).toEqual(0);
    });

    it("does not evict a Doc that was enqueued again after the poll read it", async function () {
      await enqueue();
      const stale = await poller.loadItem(id);
      // Another process re-enqueues it after our snapshot. Not Date.now():
      // on a fast run that is the same millisecond as the snapshot's
      // lastSeen, so the poll could not tell the two apart.
      const refreshed = String(stale.lastSeen + 1);
      await setField("lastSeen", refreshed);

      expect(await poller.evictIfUnchanged(stale, "quiet")).toBe(false);
      expect(await field("lastSeen")).toEqual(refreshed);

      expect(
        await poller.evictIfUnchanged(await poller.loadItem(id), "quiet")
      ).toBe(true);
      expect(await client.exists(ITEM_PREFIX + id)).toEqual(0);
    });

    it("waits longer after a poll fails", async function () {
      await enqueue();
      poller.fetchRateLimited.and.callFake(async () => {
        throw new Error("socket hang up");
      });

      const untilNext = await pollOnce();

      expect(untilNext).toBeGreaterThan(4000);
      expect(await client.exists(ITEM_PREFIX + id)).toEqual(1);
    });
  });

  describe("sharing the rate limit", function () {
    it("stretches every interval by the same factor once a service account's Docs need more than 4 calls a second", function () {
      // One Doc in the 500ms tier: 2 calls a second, within the budget
      expect(poller.fairIntervalMs(500, [1, 0, 0])).toEqual(500);
      // Four: 8 a second, so each every second (4 x 250ms)
      expect(poller.fairIntervalMs(500, [4, 0, 0])).toEqual(1000);
      // Twenty in the 5s tier: 4 a second, within the budget
      expect(poller.fairIntervalMs(5000, [0, 0, 20])).toEqual(5000);
      // Two at 500ms and ten at 5s: 6 a second, so all half as often again
      expect(poller.fairIntervalMs(500, [2, 0, 10])).toEqual(750);
      expect(poller.fairIntervalMs(5000, [2, 0, 10])).toEqual(7500);
    });

    it("counts the Docs watched on the service account by tier", async function () {
      await enqueue();
      // Three more Docs on the account, active just now
      for (let i = 0; i < 3; i++) {
        await poller.enqueue({
          blogID,
          serviceAccountId,
          fileId: fileId + "-" + i,
          folderId,
        });
        extraIds.push([serviceAccountId, blogID, fileId + "-" + i].join(":"));
      }

      expect(await poller.intervalFor(serviceAccountId, Date.now())).toEqual(
        1000
      );

      const untilNext = await pollOnce();
      expect(untilNext).toBeGreaterThan(900);
      expect(untilNext).toBeLessThanOrEqual(1000 + 200);
    });
  });

  describe("on a change", function () {
    it("applies it, records the revision and keeps polling fast", async function () {
      await enqueue();
      revision = "rev-2";

      const untilNext = await pollOnce();

      expect(poller.applyChange).toHaveBeenCalledTimes(1);
      expect(poller.applyChange.calls.argsFor(0)[0].blogID).toEqual(blogID);
      expect(await field("lastKnownRevision")).toEqual("rev-2");
      expect(untilNext).toBeLessThanOrEqual(500 + 100);
    });

    it("applies a second change straight after the first, with no cooldown", async function () {
      await enqueue();

      revision = "rev-2";
      await poller.handleAlarm(id);
      revision = "rev-3";
      await poller.handleAlarm(id);

      expect(poller.applyChange).toHaveBeenCalledTimes(2);
      expect(await field("lastKnownRevision")).toEqual("rev-3");
    });

    it("tries again at the next poll while another sync holds the folder lock", async function () {
      await enqueue();
      revision = "rev-2";
      poller.applyChange.and.returnValue(Promise.resolve("locked"));

      const untilNext = await pollOnce();

      expect(await field("lastKnownRevision")).toEqual("rev-1");
      expect(untilNext).toBeLessThanOrEqual(500 + 100);

      poller.applyChange.and.returnValue(Promise.resolve("applied"));
      await pollOnce();

      expect(poller.applyChange).toHaveBeenCalledTimes(2);
      expect(await field("lastKnownRevision")).toEqual("rev-2");
    });

    it("retries a change whose export failed", async function () {
      await enqueue();
      revision = "rev-2";
      poller.applyChange.and.callFake(async () => {
        throw new Error("export failed");
      });

      const untilNext = await pollOnce();

      expect(await field("lastKnownRevision")).toEqual("rev-1");
      expect(untilNext).toBeGreaterThan(4000);
      expect(await client.exists(ITEM_PREFIX + id)).toEqual(1);
    });
  });

  describe("applyChange", function () {
    const modifiedTime = "2026-11-20T10:00:00.000Z";
    let item, driveFile, siblings, lock, drive;

    beforeEach(async function () {
      poller.applyChange.and.callThrough();

      const folderDb = database.folder(folderId, blogID);
      await folderDb.set(folderId, "/", { isDirectory: true });
      await folderDb.set(fileId, "/Post.gdoc", {});

      driveFile = {
        id: fileId,
        name: "Post",
        parents: [folderId],
        trashed: false,
        mimeType: GOOGLE_DOC,
        modifiedTime,
      };
      siblings = [{ id: fileId, name: "Post", mimeType: GOOGLE_DOC }];
      drive = {
        files: {
          get: jasmine
            .createSpy("files.get")
            .and.callFake(async () => ({ data: driveFile })),
          list: jasmine
            .createSpy("files.list")
            .and.callFake(async () => ({ data: { files: siblings } })),
        },
      };
      spyOn(poller, "getDrive").and.returnValue(Promise.resolve(drive));

      spyOn(database.blog, "get").and.returnValue(
        Promise.resolve({ folderId, serviceAccountId })
      );
      spyOn(database.blog, "update").and.returnValue(Promise.resolve(true));

      lock = {
        folder: {
          update: jasmine
            .createSpy("update")
            .and.returnValue(Promise.resolve()),
          status: jasmine.createSpy("status"),
        },
        done: jasmine.createSpy("done").and.returnValue(Promise.resolve()),
      };
      spyOn(poller, "isFolderLocked").and.returnValue(Promise.resolve(false));
      spyOn(poller, "lockFolder").and.returnValue(Promise.resolve(lock));
      spyOn(poller, "download").and.returnValue(
        Promise.resolve({ updated: true })
      );
      spyOn(poller, "fullSync").and.returnValue(Promise.resolve());

      item = {
        id,
        blogID,
        serviceAccountId,
        fileId,
        folderId,
      };
    });

    afterEach(async function () {
      await database.folder(folderId, blogID).reset();
    });

    const expectFullSync = async (reason) => {
      expect(await poller.applyChange(item)).toEqual("full-sync");
      expect(poller.download).not.toHaveBeenCalled();
      expect(lock.done).toHaveBeenCalledTimes(1);
      expect(poller.fullSync).toHaveBeenCalledWith(blogID);
      const logged = console.log.calls
        .allArgs()
        .map((args) => args[1])
        .filter((line) => typeof line === "string" && line.startsWith("{"))
        .map((line) => JSON.parse(line))
        .find((line) => line.event === "full-sync");
      expect(logged.reason).toEqual(reason);
    };

    it("exports and publishes just that Doc under the folder lock", async function () {
      expect(await poller.applyChange(item)).toEqual("applied");

      expect(poller.lockFolder).toHaveBeenCalledWith(blogID);
      expect(poller.download).toHaveBeenCalledTimes(1);
      const [downloadBlogID, , path, file, options] =
        poller.download.calls.argsFor(0);
      expect(downloadBlogID).toEqual(blogID);
      expect(path).toEqual("/Post.gdoc");
      expect(file).toEqual({ id: fileId, mimeType: GOOGLE_DOC, modifiedTime });
      expect(options.skipHotEnqueue).toBe(true);

      expect(lock.folder.update).toHaveBeenCalledWith(
        "/Post.gdoc",
        jasmine.objectContaining({
          modified: modifiedTime,
          since: "drive-modified",
          seenBy: "hotdoc",
        })
      );
      const applied = await database
        .folder(folderId, blogID)
        .getApplied(fileId);
      expect(applied.modifiedTime).toEqual(modifiedTime);
      expect(lock.done).toHaveBeenCalledTimes(1);
      expect(poller.fullSync).not.toHaveBeenCalled();
      expect(database.blog.update).toHaveBeenCalledWith(blogID, {
        lastSync: jasmine.any(Number),
      });
    });

    it("exports the Doc even though Drive's modifiedTime hasn't moved", async function () {
      await database
        .folder(folderId, blogID)
        .setApplied(fileId, { modifiedTime });

      expect(await poller.applyChange(item)).toEqual("applied");
      expect(poller.download).toHaveBeenCalledTimes(1);
    });

    it("does not rebuild when the export changed nothing", async function () {
      poller.download.and.returnValue(Promise.resolve({ updated: false }));

      expect(await poller.applyChange(item)).toEqual("applied");
      expect(lock.folder.update).not.toHaveBeenCalled();
    });

    it("releases the lock and rejects when the export fails", async function () {
      poller.download.and.callFake(async () => {
        throw new Error("boom");
      });

      await expectAsync(poller.applyChange(item)).toBeRejected();
      expect(lock.done).toHaveBeenCalledTimes(1);
      expect(poller.fullSync).not.toHaveBeenCalled();
    });

    it("waits for the next poll while the folder lock is held", async function () {
      poller.isFolderLocked.and.returnValue(Promise.resolve(true));

      expect(await poller.applyChange(item)).toEqual("locked");
      expect(poller.lockFolder).not.toHaveBeenCalled();
      expect(poller.fullSync).not.toHaveBeenCalled();
    });

    it("waits for the next poll when another sync takes the lock first", async function () {
      poller.lockFolder.and.callFake(async () => {
        throw new Error("Failed to acquire folder lock");
      });

      expect(await poller.applyChange(item)).toEqual("locked");
      expect(poller.fullSync).not.toHaveBeenCalled();
    });

    it("falls back to a full sync for a Doc that isn't mapped yet", async function () {
      await database.folder(folderId, blogID).remove(fileId);
      await expectFullSync("unmapped");
    });

    it("falls back to a full sync for a trashed Doc", async function () {
      driveFile.trashed = true;
      await expectFullSync("trashed");
    });

    it("falls back to a full sync for a renamed Doc", async function () {
      driveFile.name = "New title";
      await expectFullSync("renamed");
    });

    it("falls back to a full sync for a Doc moved to another folder", async function () {
      driveFile.parents = ["another-folder"];
      await expectFullSync("moved");
    });

    it("falls back to a full sync when a sibling would share the Doc's name", async function () {
      siblings.push({ id: "other", name: "Post.gdoc", mimeType: "text/html" });
      await expectFullSync("duplicate-name");
    });

    it("ignores siblings whose names don't clash", async function () {
      // A file called Post (no .gdoc), a Doc called Post.gdoc (which becomes
      // Post.gdoc.gdoc) and a shortcut
      siblings.push(
        { id: "a", name: "Post", mimeType: "text/plain" },
        { id: "b", name: "Post.gdoc", mimeType: GOOGLE_DOC },
        {
          id: "c",
          name: "Post",
          mimeType: "application/vnd.google-apps.shortcut",
        }
      );

      expect(await poller.applyChange(item)).toEqual("applied");
    });

    it("falls back to a full sync for a path the walk may have suffixed", async function () {
      await database.folder(folderId, blogID).set(fileId, "/Post (1).gdoc", {});
      driveFile.name = "Post (1)";
      await expectFullSync("suffixed-name");
    });

    it("falls back to a full sync when Drive no longer has the Doc", async function () {
      drive.files.get.and.callFake(async () => {
        throw Object.assign(new Error("Not found"), { code: 404 });
      });
      await expectFullSync("not-found");
    });

    it("falls back to a full sync when the blog moved to another folder", async function () {
      database.blog.get.and.returnValue(
        Promise.resolve({ folderId: "elsewhere", serviceAccountId })
      );
      await expectFullSync("account-changed");
    });

    it("doesn't stamp lastSync while setup copies the site's files", async function () {
      database.blog.get.and.returnValue(
        Promise.resolve({ folderId, serviceAccountId, preparing: true })
      );
      await expectFullSync("account-changed");
      expect(database.blog.update).not.toHaveBeenCalledWith(blogID, {
        lastSync: jasmine.any(Number),
      });
    });
  });

  it("spaces docs.get slots 250ms apart for a service account", async function () {
    poller.fetchRateLimited.and.callThrough();
    // Compare the slots the calls won, not the clock after they return: a
    // slow runner can stall between winning a slot and reading the time.
    const slots = [];
    for (let i = 0; i < 3; i++) {
      slots.push(await poller.acquireDocsSlot(serviceAccountId));
    }
    expect(new Set(slots).size).toEqual(3);
    expect(slots[0]).toBeLessThan(slots[1]);
    expect(slots[1]).toBeLessThan(slots[2]);
  });

  it("evicts the least recently active Docs beyond the per service account cap", async function () {
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
      // Docs enqueued in the same millisecond tie on activity, so which two
      // went isn't fixed; the cap is what matters.
      const setKey =
        "blot:google-drive:hotdocs:by-service-account:" + serviceAccountId;
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
