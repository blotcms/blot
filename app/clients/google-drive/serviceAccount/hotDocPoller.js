/**
 * Hot doc poller: tracks recently-edited Google Docs and triggers sync when
 * revisionId changes (via docs.documents.get).
 *
 * Rate limit: Google allows 5 docs.get() requests per service account per second.
 * We cap at 4 requests per service account per second to keep a buffer.
 *
 * State lives in Redis so any number of processes can enqueue and poll:
 *   - each tracked doc is a hash (item:<id>) holding what a poll needs (blog,
 *     folder, first/last seen, last known revision) that expires shortly after
 *     the doc would be evicted anyway;
 *   - the poll schedule is a helper/alarm queue ("google-drive-hot-docs"): an
 *     alarm's due time is the doc's next poll, and whichever process claims it
 *     polls the doc, then re-arms the alarm for the next tier or lets it
 *     complete once the doc has aged out;
 *   - the global and per-service-account caps are sorted sets of ids scored by
 *     first seen, from which the oldest are evicted;
 *   - the docs.get limit per service account is a set of 250ms slots, one call
 *     each, claimed through Redis by all processes, and the per-blog sync cooldown is a key with a TTL.
 * The id of a doc is <serviceAccountId>:<blogID>:<fileId>.
 */
const Bottleneck = require("bottleneck");
const client = require("models/client");
const alarm = require("helper/alarm");
const drain = require("helper/drain");
const clfdate = require("helper/clfdate");
const createDriveClient = require("./createDriveClient");
const createDocsClient = require("./createDocsClient");
const establishSyncLock = require("sync/establishSyncLock");
const database = require("../database");
const localPath = require("helper/localPath");
const localFingerprint = require("../util/localFingerprint");
const sync = require("../sync");

const prefix = () => `${clfdate()} Google Drive hotDocPoller:`;

// docs.get() quota: 5/sec per service account; we use 4/sec for buffer, as one
// call per 250ms slot (a per-second counter would allow 8 calls across a
// second boundary).
const DOCS_GET_SLOT_MS = 250;
// Slots tried before giving up on a rate-limit slot (about 10s)
const DOCS_GET_MAX_SLOT_ATTEMPTS = 40;

const POLL_INTERVAL_MS = 1000;
const BLOG_SYNC_COOLDOWN_MS = 10000;
const MAX_ITEMS_GLOBAL = 500;
const MAX_ITEMS_PER_SERVICE_ACCOUNT = 150;
const RATE_LIMIT_BACKOFF_MS = 30000;
const EVICT_AFTER_SECONDS = 600;
// The last poll evicts a doc nobody enqueued again at EVICT_AFTER_SECONDS;
// the hash only outlives that if the process died before cleaning up.
const ITEM_TTL_SECONDS = EVICT_AFTER_SECONDS + 120;
// Alarms handled per poll of the queue (one poll a second)
const ALARM_BATCH = 20;

const REDIS_PREFIX = "blot:google-drive:hotdocs:";
const ITEM_PREFIX = REDIS_PREFIX + "item:";
const COOLDOWN_PREFIX = REDIS_PREFIX + "cooldown:";
const RATE_PREFIX = REDIS_PREFIX + "docs-slot:";
const ALL_KEY = REDIS_PREFIX + "all";
const serviceAccountKey = (serviceAccountId) =>
  REDIS_PREFIX + "by-service-account:" + serviceAccountId;

const SCHEDULE_TIERS = [
  { maxAgeSeconds: 10, everyMs: 2000 },
  { maxAgeSeconds: 30, everyMs: 3000 },
  { maxAgeSeconds: 60, everyMs: 5000 },
  { maxAgeSeconds: 120, everyMs: 10000 },
  { maxAgeSeconds: 600, everyMs: 30000 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jitterMs = (baseMs) => {
  const spread = Math.max(1, Math.floor(baseMs * 0.2));
  return Math.floor(Math.random() * spread);
};

const isRateLimitError = (err) => {
  const code = err?.code || err?.status || err?.response?.status;

  if (code === 429) return true;
  if (code !== 403) return false;

  const reasons = [
    ...(err?.errors || []),
    ...(err?.response?.data?.error?.errors || []),
  ]
    .map((entry) => entry?.reason)
    .filter(Boolean);

  return reasons.some((reason) =>
    ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason)
  );
};

const isNotFoundError = (err) => {
  const code = err?.code || err?.status || err?.response?.status;
  return code === 404;
};

const isPermissionError = (err) => {
  const code = err?.code || err?.status || err?.response?.status;
  return code === 401 || code === 403;
};

const getTerminalErrorReason = (err) => {
  if (isNotFoundError(err)) return "not-found";
  if (isPermissionError(err) && !isRateLimitError(err)) return "permission";
  return null;
};

class HotDocPoller {
  constructor() {
    this.started = false;
    this.stopOnDrain = null;

    // Due time = next poll of that doc; see the comment at the top
    this.alarms = alarm(
      "google-drive-hot-docs",
      (id) => this.handleAlarm(id),
      { pollMs: POLL_INTERVAL_MS, batch: ALARM_BATCH }
    );

    // Caps this process's concurrent docs.get calls; the per service account
    // rate is shared between processes through Redis (acquireDocsSlot).
    this.globalLimiter = new Bottleneck({
      maxConcurrent: 2,
      minTime: 100,
    });

    // Per process, for logs only
    this.metrics = {
      enqueueCount: 0,
      pollAttempts: 0,
      changeDetectedCount: 0,
      syncTriggerCount: 0,
      evictions: 0,
      rateLimitEvents: 0,
    };

    // API clients are cached per process
    this.driveByServiceAccount = new Map();
    this.docsByServiceAccount = new Map();
  }

  start() {
    if (this.started || drain.isDraining()) return;
    this.started = true;
    this.alarms.start();
    this.stopOnDrain = drain.onStart(() => this.stop());
  }

  // Waits for the doc being polled, claims no more
  async stop() {
    if (!this.started) return;
    this.started = false;
    if (this.stopOnDrain) this.stopOnDrain();
    this.stopOnDrain = null;
    await this.alarms.stop();
  }

  idFor(serviceAccountId, blogID, fileId) {
    return `${serviceAccountId}:${blogID}:${fileId}`;
  }

  getPollIntervalMs(ageSeconds) {
    const tier = SCHEDULE_TIERS.find((entry) => ageSeconds <= entry.maxAgeSeconds);
    return tier ? tier.everyMs : null;
  }

  log(event, context = {}, level = "info") {
    const payload = JSON.stringify({ event, ...context });
    if (level === "warn") {
      console.warn(prefix(), payload);
      return;
    }

    console.log(prefix(), payload);
  }

  async getDrive(serviceAccountId) {
    if (this.driveByServiceAccount.has(serviceAccountId)) {
      return this.driveByServiceAccount.get(serviceAccountId);
    }

    const drive = await createDriveClient(serviceAccountId);
    this.driveByServiceAccount.set(serviceAccountId, drive);
    return drive;
  }

  async getDocs(serviceAccountId) {
    if (this.docsByServiceAccount.has(serviceAccountId)) {
      return this.docsByServiceAccount.get(serviceAccountId);
    }

    const docs = await createDocsClient(serviceAccountId);
    this.docsByServiceAccount.set(serviceAccountId, docs);
    return docs;
  }

  async loadItem(id) {
    const fields = await client.hGetAll(ITEM_PREFIX + id);
    // An empty hash is a doc that was evicted or expired; one without a file
    // is what a late write to an evicted doc leaves behind.
    if (!fields || !fields.fileId) return null;

    return {
      id,
      blogID: fields.blogID,
      serviceAccountId: fields.serviceAccountId,
      fileId: fields.fileId,
      folderId: fields.folderId,
      firstSeen: Number(fields.firstSeen),
      lastSeen: Number(fields.lastSeen),
      pollCount: Number(fields.pollCount || 0),
      lastKnownModifiedTime: null,
      lastKnownRevision: fields.lastKnownRevision || null,
    };
  }

  // Writes fields onto the item's hash and keeps it expiring
  async saveItem(id, fields) {
    const key = ITEM_PREFIX + id;
    await client.multi().hSet(key, fields).expire(key, ITEM_TTL_SECONDS).exec();
  }

  async saveRevision(item, latest) {
    item.lastKnownRevision = latest.lastKnownRevision;
    item.lastKnownModifiedTime = latest.lastKnownModifiedTime;
    if (latest.lastKnownRevision == null) return;
    await this.saveItem(item.id, { lastKnownRevision: latest.lastKnownRevision });
  }

  // Waits to win the service account's docs.get slot for the current 250ms.
  // Each slot allows one call, claimed with SET NX by whichever process gets
  // there first, so the rate is at most 4 a second across all processes, also
  // across second boundaries. If no slot is won after DOCS_GET_MAX_SLOT_ATTEMPTS
  // we proceed anyway: Redis being busy or the account being saturated for
  // ten seconds shouldn't wedge the poll, and a real 429 is handled by the
  // caller's backoff.
  async acquireDocsSlot(serviceAccountId) {
    for (let attempt = 0; attempt < DOCS_GET_MAX_SLOT_ATTEMPTS; attempt++) {
      const now = Date.now();
      const slot = Math.floor(now / DOCS_GET_SLOT_MS);
      const key = RATE_PREFIX + serviceAccountId + ":" + slot;
      const won = await client.set(key, "1", { NX: true, PX: 1000 });
      if (won !== null) return;
      const untilNextSlot = (slot + 1) * DOCS_GET_SLOT_MS - Date.now();
      await sleep(Math.max(0, untilNextSlot) + 1 + jitterMs(20));
    }
  }

  async fetchRateLimited(serviceAccountId, docs, fileId) {
    return this.globalLimiter.schedule(async () => {
      await this.acquireDocsSlot(serviceAccountId);
      return this.fetchLatestRevisionState(docs, fileId);
    });
  }

  // It's harder than you might think to track updates to a Google Doc
  // quickly and efficiently. See this:

  // https://stackoverflow.com/questions/71772606/google-drive-files-spreadsheets-rest-api-how-to-avoid-delay-when-tracking-file
  
  // We tried polling files.get, relying on changes.watch, and even files.watch
  // and revisions.list but the fastest and most reliable way to track updates
  // was to use docs.documents.get.
  async fetchLatestRevisionState(docs, fileId) {
    if (!docs) {
      return { lastKnownRevision: null, lastKnownModifiedTime: null };
    }

    const doc = await docs.documents.get({ documentId: fileId });
    const revisionId = doc?.data?.revisionId ?? null;

    this.log("fetchLatestRevisionState documents.get", {
      fileId,
      documentId: doc?.data?.documentId,
      title: doc?.data?.title,
      revisionId,
    });

    return {
      lastKnownRevision: revisionId,
      lastKnownModifiedTime: null,
    };
  }

  // A rate limit on one service account delays every doc it polls
  async boostBackoffForServiceAccount(now, serviceAccountId) {
    const ids = await client.zRange(serviceAccountKey(serviceAccountId), 0, -1);

    for (const id of ids) {
      await this.alarms.set(id, now + RATE_LIMIT_BACKOFF_MS + jitterMs(5000));
    }
  }

  // Forgets a doc: its hash, its place in the caps and its alarm
  async remove(id, serviceAccountId) {
    await client
      .multi()
      .del(ITEM_PREFIX + id)
      .zRem(ALL_KEY, id)
      .zRem(serviceAccountKey(serviceAccountId), id)
      .exec();
    await this.alarms.cancel(id);
    this.metrics.evictions += 1;
  }

  // Evicts only if the doc wasn't enqueued again since item was loaded.
  // Resolves false (nothing evicted) if it was. Another process could still
  // enqueue between the re-read and the delete; that window is tiny and we
  // accept it rather than lock every enqueue (a doc that loses that race is
  // simply enqueued again by its next edit).
  async evictIfUnchanged(item, reason) {
    const stored = await client.hGet(ITEM_PREFIX + item.id, "lastSeen");
    if (stored !== String(item.lastSeen)) return false;
    await this.evict(item, reason);
    return true;
  }

  async evict(item, reason, level = "info", extra = {}) {
    await this.remove(item.id, item.serviceAccountId);
    this.log("evicted", {
      reason,
      blogID: item.blogID,
      serviceAccountId: item.serviceAccountId,
      fileId: item.fileId,
      ...extra,
    }, level);
  }

  // Evicts the oldest docs (by first seen) in a capped set beyond its limit
  async evictOldestBeyond(setKey, max, reason, level) {
    const total = await client.zCard(setKey);
    if (total <= max) return;

    const ids = await client.zRange(setKey, 0, total - max - 1);
    for (const id of ids) {
      const item = await this.loadItem(id);
      if (item) {
        await this.evict(item, reason, level);
      } else {
        // Already expired; only its place in the sets (and alarm) is left
        await this.remove(id, id.split(":")[0]);
      }
    }
  }

  async enforceCaps(serviceAccountId) {
    await this.evictOldestBeyond(ALL_KEY, MAX_ITEMS_GLOBAL, "global-cap", "info");
    await this.evictOldestBeyond(
      serviceAccountKey(serviceAccountId),
      MAX_ITEMS_PER_SERVICE_ACCOUNT,
      "service-account-cap",
      "warn"
    );
  }

  async enqueue({ blogID, serviceAccountId, fileId, folderId }) {
    if (!blogID || !serviceAccountId || !fileId || !folderId) return;

    this.start();

    const id = this.idFor(serviceAccountId, blogID, fileId);
    const now = Date.now();
    const dueAt = now + 2000 + jitterMs(300);

    if (await client.exists(ITEM_PREFIX + id)) {
      await this.saveItem(id, {
        lastSeen: String(now),
        folderId,
        serviceAccountId,
      });
      await this.alarms.set(id, dueAt);
      this.metrics.enqueueCount += 1;
      this.log("re-enqueued", { blogID, serviceAccountId, fileId, folderId });
      await this.enforceCaps(serviceAccountId);
      return;
    }

    await this.saveItem(id, {
      blogID,
      serviceAccountId,
      fileId,
      folderId,
      firstSeen: String(now),
      lastSeen: String(now),
      pollCount: "0",
    });
    await client
      .multi()
      .zAdd(ALL_KEY, { score: now, value: id })
      .zAdd(serviceAccountKey(serviceAccountId), { score: now, value: id })
      .exec();
    this.metrics.enqueueCount += 1;
    this.log("enqueued", { blogID, serviceAccountId, fileId, folderId });

    // The first poll waits for the revision the doc has now, so the poll
    // doesn't mistake it for a change.
    let rateLimited = false;
    try {
      const docs = await this.getDocs(serviceAccountId);
      const initial = await this.fetchRateLimited(serviceAccountId, docs, fileId);

      if (initial.lastKnownRevision != null) {
        await this.saveItem(id, { lastKnownRevision: initial.lastKnownRevision });
      }
    } catch (err) {
      if (isRateLimitError(err)) {
        rateLimited = true;
        this.metrics.rateLimitEvents += 1;
        this.log("rate-limit", {
          phase: "enqueue-initial-state",
          blogID,
          serviceAccountId,
          fileId,
          message: err?.message,
        }, "warn");
      } else {
        this.log("enqueue-initial-state-failed", {
          blogID,
          serviceAccountId,
          fileId,
          message: err?.message,
        });
      }
    }

    if (rateLimited) {
      // Includes this doc, now that it is in the service account's set
      await this.alarms.set(id, now + RATE_LIMIT_BACKOFF_MS + jitterMs(5000));
      await this.boostBackoffForServiceAccount(now, serviceAccountId);
    } else {
      await this.alarms.set(id, dueAt);
    }

    await this.enforceCaps(serviceAccountId);
  }

  // Runs in whichever process claimed the doc's alarm. Re-arms the alarm for
  // the next poll unless the doc was evicted or the service account is
  // backing off (which sets its own due times).
  async handleAlarm(id) {
    const item = await this.loadItem(id);
    // Evicted or expired since it was armed: nothing to poll, alarm completes
    if (!item) return;

    const startedAt = Date.now();
    const ageSeconds = Math.floor((startedAt - item.lastSeen) / 1000);

    const evictReason =
      ageSeconds > EVICT_AFTER_SECONDS
        ? "age"
        : this.getPollIntervalMs(ageSeconds)
        ? null
        : "tier-ended";

    if (evictReason) {
      if (await this.evictIfUnchanged(item, evictReason)) return;
      // Enqueued again while we were looking: poll it from the first tier
      await this.alarms.set(id, Date.now() + 2000 + jitterMs(300));
      return;
    }

    const intervalMs = this.getPollIntervalMs(ageSeconds);

    let rearm = true;

    try {
      await this.checkItem(item);
    } catch (err) {
      if (isRateLimitError(err)) {
        rearm = false;
        this.metrics.rateLimitEvents += 1;
        await this.boostBackoffForServiceAccount(startedAt, item.serviceAccountId);
        this.log("rate-limit", {
          blogID: item.blogID,
          serviceAccountId: item.serviceAccountId,
          fileId: item.fileId,
          message: err?.message,
        }, "warn");
      } else {
        const terminalReason = getTerminalErrorReason(err);
        if (terminalReason) {
          rearm = false;
          await this.evict(item, terminalReason, "warn", { message: err?.message });
        } else {
          this.log("poll-error", {
            blogID: item.blogID,
            serviceAccountId: item.serviceAccountId,
            fileId: item.fileId,
            message: err?.message,
          });
        }
      }
    }

    // Counted from when the poll started, as before; setting it only now
    // keeps the doc claimed (not due for another process) while it runs.
    if (rearm) {
      // An enqueue() during the poll refreshes lastSeen and arms an early
      // alarm; re-arming from our stale tier would overwrite it. If lastSeen
      // moved, poll from the first tier instead. A small race remains if the
      // enqueue lands between this read and the set below.
      const stored = await client.hGet(ITEM_PREFIX + id, "lastSeen");
      if (stored != null && stored !== String(item.lastSeen)) {
        await this.alarms.set(id, Date.now() + 2000 + jitterMs(300));
      } else {
        await this.alarms.set(id, startedAt + intervalMs + jitterMs(intervalMs));
      }
    }
  }

  async checkItem(item) {
    this.metrics.pollAttempts += 1;
    item.pollCount += 1;
    await client.hIncrBy(ITEM_PREFIX + item.id, "pollCount", 1);

    const docs = await this.getDocs(item.serviceAccountId);
    const latest = await this.fetchRateLimited(
      item.serviceAccountId,
      docs,
      item.fileId
    );

    const changed =
      Boolean(latest.lastKnownRevision) &&
      (latest.lastKnownRevision !== item.lastKnownRevision ||
        latest.lastKnownModifiedTime !== item.lastKnownModifiedTime);

    if (!changed) {
      await this.saveRevision(item, latest);
      return;
    }

    this.metrics.changeDetectedCount += 1;
    this.log("change-detected", {
      blogID: item.blogID,
      serviceAccountId: item.serviceAccountId,
      fileId: item.fileId,
      pollCount: item.pollCount,
    });

    const outcome = await this.triggerDownloadAndSync(item);

    // When download reports no content change we still advance the polled
    // revision state so we don't repeatedly retry a known non-updating
    // revision on every poll. Otherwise (cooldown, missing path) the revision
    // is left alone so the next poll retries.
    if (outcome === "synced" || outcome === "download-no-update") {
      await this.saveRevision(item, latest);
    }
  }

  async triggerDownloadAndSync(item) {
    // Shared by all processes. Claimed before the work starts (not after) so
    // two processes handling different docs of one blog can't both sync. A
    // sync that outlasts the TTL is fine: the folder lock serialises the work.
    const cooldownKey = COOLDOWN_PREFIX + item.blogID;
    const claimed = await client.set(cooldownKey, "1", {
      NX: true,
      PX: BLOG_SYNC_COOLDOWN_MS,
    });

    if (!claimed) {
      this.log("sync-cooldown", {
        blogID: item.blogID,
        serviceAccountId: item.serviceAccountId,
        fileId: item.fileId,
      });
      return "sync-cooldown";
    }

    let outcome;
    try {
      outcome = await this.downloadAndSync(item);
    } catch (err) {
      // Release so a retry isn't blocked by a sync that never happened
      await client.del(cooldownKey);
      throw err;
    }

    if (outcome !== "synced") await client.del(cooldownKey);
    return outcome;
  }

  async downloadAndSync(item) {
    const { done, folder } = await establishSyncLock(item.blogID);
    try {
      const drive = await this.getDrive(item.serviceAccountId);
      const folderDb = database.folder(item.folderId, item.blogID);
      const path = await folderDb.get(item.fileId);

      if (!path) {
        this.log("missing-path", {
          blogID: item.blogID,
          serviceAccountId: item.serviceAccountId,
          fileId: item.fileId,
          folderId: item.folderId,
        });
        return "missing-path";
      } else {
        let file;
        try {
          file = await drive.files.get({
            fileId: item.fileId,
            fields: "id,mimeType,md5Checksum,modifiedTime",
            supportsAllDrives: true,
          });
        } catch (err) {
          const reason = getTerminalErrorReason(err);
          if (reason) {
            this.log("download-terminal-error", {
              reason,
              blogID: item.blogID,
              serviceAccountId: item.serviceAccountId,
              fileId: item.fileId,
              folderId: item.folderId,
              message: err?.message,
            }, "warn");
          }

          throw err;
        }

        const download = require("../util/download");
        const result = await download(
          item.blogID,
          drive,
          path,
          {
            id: file.data.id,
            mimeType: file.data.mimeType,
            md5Checksum: file.data.md5Checksum,
            modifiedTime: file.data.modifiedTime,
          },
          {
            serviceAccountId: item.serviceAccountId,
            folderId: item.folderId,
            skipHotEnqueue: true,
          }
        );

        if (result?.updated && folder?.update) {
          await folder.update(path);
        }

        if (result?.verifiedContent) {
          await folderDb.setVerifiedContent(file.data.id, {
            path,
            ...result.verifiedContent,
          });
        }

        // Record what we just wrote so the follow-up sync doesn't export
        // and rebuild the same document again.
        await folderDb.setApplied(file.data.id, {
          modifiedTime: file.data.modifiedTime,
          fingerprint: await localFingerprint(localPath(item.blogID, path)),
        });

        if (result?.updated !== true) {
          this.log("download-no-update", {
            blogID: item.blogID,
            serviceAccountId: item.serviceAccountId,
            fileId: item.fileId,
            folderId: item.folderId,
          });
          return "download-no-update";
        }
      }
    } finally {
      await done();
    }

    this.metrics.syncTriggerCount += 1;
    this.log("sync-trigger", {
      blogID: item.blogID,
      serviceAccountId: item.serviceAccountId,
      fileId: item.fileId,
    });

    await sync(item.blogID);
    return "synced";
  }

}

module.exports = new HotDocPoller();
