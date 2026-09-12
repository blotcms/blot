/**
 * Hot doc poller: tracks recently-edited Google Docs and triggers sync when
 * revisionId changes (via docs.documents.get).
 *
 * Rate limit: Google allows 5 docs.get() requests per service account per second.
 * We cap at 4 requests per service account per second to keep a buffer.
 */
const Bottleneck = require("bottleneck");
const clfdate = require("helper/clfdate");
const createDriveClient = require("./createDriveClient");
const createDocsClient = require("./createDocsClient");
const establishSyncLock = require("sync/establishSyncLock");
const database = require("../database");
const sync = require("../sync");

const prefix = () => `${clfdate()} Google Drive hotDocPoller:`;

// docs.get() quota: 5/sec per service account; we use 4/sec for buffer
const DOCS_GET_MAX_PER_SERVICE_ACCOUNT_PER_SEC = 4;
const DOCS_GET_MIN_TIME_MS = 1000 / DOCS_GET_MAX_PER_SERVICE_ACCOUNT_PER_SEC;

const POLL_INTERVAL_MS = 1000;
const BLOG_SYNC_COOLDOWN_MS = 10000;
const MAX_ITEMS_GLOBAL = 500;
const MAX_ITEMS_PER_SERVICE_ACCOUNT = 150;
const RATE_LIMIT_BACKOFF_MS = 30000;
const EVICT_AFTER_SECONDS = 600;

const SCHEDULE_TIERS = [
  { maxAgeSeconds: 10, everyMs: 2000 },
  { maxAgeSeconds: 30, everyMs: 3000 },
  { maxAgeSeconds: 60, everyMs: 5000 },
  { maxAgeSeconds: 120, everyMs: 10000 },
  { maxAgeSeconds: 600, everyMs: 30000 },
];

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
    this.items = new Map();
    this.started = false;
    this.timer = null;
    this.tickInProgress = false;

    this.globalLimiter = new Bottleneck({
      maxConcurrent: 2,
      minTime: 100,
    });

    this.perServiceAccountLimiter = new Bottleneck.Group({
      maxConcurrent: 1,
      minTime: DOCS_GET_MIN_TIME_MS,
    });

    this.metrics = {
      enqueueCount: 0,
      pollAttempts: 0,
      changeDetectedCount: 0,
      syncTriggerCount: 0,
      evictions: 0,
      rateLimitEvents: 0,
    };

    this.lastSyncByBlog = new Map();
    this.driveByServiceAccount = new Map();
    this.docsByServiceAccount = new Map();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      if (this.tickInProgress) {
        this.log("tick-skipped", { reason: "already-running" });
        return;
      }

      this.tickInProgress = true;
      this.tick().catch((err) => {
        console.error(prefix(), "tick-error", err?.message || err);
      }).finally(() => {
        this.tickInProgress = false;
      });
    }, POLL_INTERVAL_MS);
  }

  stop() {
    if (!this.started) return;
    clearInterval(this.timer);
    this.started = false;
    this.timer = null;
  }

  keyFor(blogID, fileId) {
    return `${blogID}:${fileId}`;
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

  boostBackoffForServiceAccount(now, serviceAccountId) {
    for (const item of this.items.values()) {
      if (item.serviceAccountId !== serviceAccountId) {
        continue;
      }

      item.nextDueAt = now + RATE_LIMIT_BACKOFF_MS + jitterMs(5000);
      item.state = "backoff";
    }
  }

  evictOldest(reason = "cap") {
    let oldestKey = null;
    let oldestSeen = Number.POSITIVE_INFINITY;

    for (const [key, item] of this.items.entries()) {
      if (item.firstSeen < oldestSeen) {
        oldestSeen = item.firstSeen;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const item = this.items.get(oldestKey);
      this.items.delete(oldestKey);
      this.metrics.evictions += 1;
      this.log("evicted", {
        reason,
        blogID: item.blogID,
        serviceAccountId: item.serviceAccountId,
        fileId: item.fileId,
      });
    }
  }

  enforceCaps(serviceAccountId) {
    while (this.items.size > MAX_ITEMS_GLOBAL) {
      this.evictOldest("global-cap");
    }

    const sameServiceAccount = [...this.items.values()].filter(
      (item) => item.serviceAccountId === serviceAccountId
    );

    if (sameServiceAccount.length <= MAX_ITEMS_PER_SERVICE_ACCOUNT) return;

    const toEvict = sameServiceAccount
      .sort((a, b) => a.firstSeen - b.firstSeen)
      .slice(0, sameServiceAccount.length - MAX_ITEMS_PER_SERVICE_ACCOUNT);

    for (const item of toEvict) {
      this.items.delete(this.keyFor(item.blogID, item.fileId));
      this.metrics.evictions += 1;
      this.log("evicted", {
        reason: "service-account-cap",
        blogID: item.blogID,
        serviceAccountId: item.serviceAccountId,
        fileId: item.fileId,
      }, "warn");
    }
  }

  async enqueue({ blogID, serviceAccountId, fileId, folderId }) {
    if (!blogID || !serviceAccountId || !fileId || !folderId) return;

    this.start();

    const key = this.keyFor(blogID, fileId);
    const now = Date.now();

    if (this.items.has(key)) {
      const existing = this.items.get(key);
      existing.lastSeen = now;
      existing.folderId = folderId;
      existing.serviceAccountId = serviceAccountId;
      existing.nextDueAt = now + 2000 + jitterMs(300);
      existing.state = "active";
      this.metrics.enqueueCount += 1;
      this.log("re-enqueued", { blogID, serviceAccountId, fileId, folderId });
      this.enforceCaps(serviceAccountId);
      return;
    }

    const item = {
      blogID,
      serviceAccountId,
      fileId,
      folderId,
      firstSeen: now,
      lastSeen: now,
      lastPolledAt: null,
      pollCount: 0,
      nextDueAt: now + 2000 + jitterMs(300),
      lastKnownModifiedTime: null,
      lastKnownRevision: null,
      state: "new",
    };

    this.items.set(key, item);
    this.metrics.enqueueCount += 1;
    this.log("enqueued", { blogID, serviceAccountId, fileId, folderId });

    try {
      const docs = await this.getDocs(serviceAccountId);
      const limiter = this.perServiceAccountLimiter
        .key(serviceAccountId)
        .chain(this.globalLimiter);

      const initial = await limiter.schedule(async () => {
        return this.fetchLatestRevisionState(docs, fileId);
      });

      if (initial.lastKnownRevision != null) {
        item.lastKnownRevision = initial.lastKnownRevision;
        item.lastKnownModifiedTime = initial.lastKnownModifiedTime;
      }
      item.state = "active";
    } catch (err) {
      if (isRateLimitError(err)) {
        this.metrics.rateLimitEvents += 1;
        this.boostBackoffForServiceAccount(now, serviceAccountId);
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

    this.enforceCaps(serviceAccountId);
  }

  async checkItem(item) {
    const now = Date.now();
    const ageSeconds = Math.floor((now - item.lastSeen) / 1000);

    if (ageSeconds > EVICT_AFTER_SECONDS) {
      this.items.delete(this.keyFor(item.blogID, item.fileId));
      this.metrics.evictions += 1;
      this.log("evicted", {
        reason: "age",
        blogID: item.blogID,
        serviceAccountId: item.serviceAccountId,
        fileId: item.fileId,
      });
      return;
    }

    const intervalMs = this.getPollIntervalMs(ageSeconds);
    if (!intervalMs) {
      this.items.delete(this.keyFor(item.blogID, item.fileId));
      this.metrics.evictions += 1;
      this.log("evicted", {
        reason: "tier-ended",
        blogID: item.blogID,
        serviceAccountId: item.serviceAccountId,
        fileId: item.fileId,
      });
      return;
    }

    item.state = "polling";
    item.lastPolledAt = now;
    item.pollCount += 1;
    item.nextDueAt = now + intervalMs + jitterMs(intervalMs);
    this.metrics.pollAttempts += 1;

    const docs = await this.getDocs(item.serviceAccountId);
    const limiter = this.perServiceAccountLimiter
      .key(item.serviceAccountId)
      .chain(this.globalLimiter);

    const latest = await limiter.schedule(async () => {
      return this.fetchLatestRevisionState(docs, item.fileId);
    });

    const changed =
      Boolean(latest.lastKnownRevision) &&
      (latest.lastKnownRevision !== item.lastKnownRevision ||
        latest.lastKnownModifiedTime !== item.lastKnownModifiedTime);
    item.state = "active";

    if (!changed) {
      if (latest.lastKnownRevision != null) {
        item.lastKnownRevision = latest.lastKnownRevision;
        item.lastKnownModifiedTime = latest.lastKnownModifiedTime;
      }
      return;
    }

    this.metrics.changeDetectedCount += 1;
    this.log("change-detected", {
      blogID: item.blogID,
      serviceAccountId: item.serviceAccountId,
      fileId: item.fileId,
      pollCount: item.pollCount,
    });

    const didSync = await this.triggerDownloadAndSync(item);
    if (!didSync) {
      // When download reports no content change (`updated !== true`), we still
      // advance the polled revision state so we don't repeatedly retry a known
      // non-updating revision on every poll tick.
      if (item.lastTriggerOutcome === "download-no-update") {
        item.lastKnownRevision = latest.lastKnownRevision;
        item.lastKnownModifiedTime = latest.lastKnownModifiedTime;
      }

      return;
    }

    item.lastKnownRevision = latest.lastKnownRevision;
    item.lastKnownModifiedTime = latest.lastKnownModifiedTime;
  }

  async triggerDownloadAndSync(item) {
    item.lastTriggerOutcome = null;
    const now = Date.now();
    const lastSync = this.lastSyncByBlog.get(item.blogID);

    if (lastSync && now - lastSync < BLOG_SYNC_COOLDOWN_MS) {
      this.log("sync-cooldown", {
        blogID: item.blogID,
        serviceAccountId: item.serviceAccountId,
        fileId: item.fileId,
      });
      item.lastTriggerOutcome = "sync-cooldown";
      return false;
    }

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
        item.lastTriggerOutcome = "missing-path";
        return false;
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

        if (result?.updated !== true) {
          this.log("download-no-update", {
            blogID: item.blogID,
            serviceAccountId: item.serviceAccountId,
            fileId: item.fileId,
            folderId: item.folderId,
          });
          item.lastTriggerOutcome = "download-no-update";
          return false;
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
    this.lastSyncByBlog.set(item.blogID, Date.now());
    item.lastTriggerOutcome = "synced";
    return true;
  }

  async tick() {
    const now = Date.now();
    const dueItems = [...this.items.values()].filter((item) => item.nextDueAt <= now);

    for (const item of dueItems) {
      try {
        await this.checkItem(item);
      } catch (err) {
        if (isRateLimitError(err)) {
          this.metrics.rateLimitEvents += 1;
          this.boostBackoffForServiceAccount(now, item.serviceAccountId);
          this.log("rate-limit", {
            blogID: item.blogID,
            serviceAccountId: item.serviceAccountId,
            fileId: item.fileId,
            message: err?.message,
          }, "warn");
          continue;
        }

        const terminalReason = getTerminalErrorReason(err);
        if (terminalReason) {
          this.items.delete(this.keyFor(item.blogID, item.fileId));
          this.metrics.evictions += 1;
          this.log("evicted", {
            reason: terminalReason,
            blogID: item.blogID,
            serviceAccountId: item.serviceAccountId,
            fileId: item.fileId,
            message: err?.message,
          }, "warn");
          continue;
        }

        this.log("poll-error", {
          blogID: item.blogID,
          serviceAccountId: item.serviceAccountId,
          fileId: item.fileId,
          message: err?.message,
        });
      }
    }
  }
}

module.exports = new HotDocPoller();
