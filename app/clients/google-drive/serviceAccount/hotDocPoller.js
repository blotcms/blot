/**
 * Hot doc poller: watches Google Docs that were changed recently and, when
 * one changes again, exports it and publishes it straight away.
 *
 * Why it exists: an edit to a Google Doc that is open in a browser doesn't
 * reach Drive's metadata for about 2 minutes. Its modifiedTime stays put,
 * changes.list lists nothing and no changes.watch webhook arrives, so a sync
 * walking the folder sees no change. The one thing that moves is the
 * revisionId docs.documents.get returns, about 1s after typing, and a
 * drive.files.export straight after already has the new text (5 of 5 tries
 * on production, 20 Nov 2026, the export taking about 450ms). So the only
 * fast way to publish a Doc edit is to poll docs.get, and the faster we poll
 * the sooner it goes live. See #2847 and, for what else was tried (files.get,
 * changes.watch, files.watch, revisions.list),
 * https://stackoverflow.com/questions/71772606
 *
 * Which Docs: any code that sees a Doc change calls enqueue(), which starts
 * watching it or, for a Doc already watched, moves it back to the fastest
 * poll. util/download.js does so after each export of a Doc edited in the
 * last half hour, and pollDriveActivity.js as soon as Drive Activity names a
 * Doc that was edited, as "unseen", so the first poll publishes that edit
 * rather than taking it as the baseline: a Doc nobody had touched for a
 * while is then live within seconds of its first edit, not once Drive's
 * modifiedTime moves. A Doc is polled
 * on a schedule that follows its last activity, the later of its last
 * enqueue and the last change this poller detected (SCHEDULE_TIERS): every
 * 500ms for 2 minutes, every 2s up to 10 minutes, every 5s up to 30 minutes,
 * and then it is no longer watched. Before, the schedule followed the first
 * enqueue only, so a Doc enqueued a minute earlier was polled every 5-10s
 * (5.5s behind a 2s poll, measured) and was dropped 10 minutes after its last
 * download, leaving later edits to wait for Drive's metadata.
 *
 * Rate limit: Google allows 5 docs.get() requests per service account per
 * second. We cap at 4 to keep a buffer, as one call per 250ms slot claimed
 * through Redis by every process (acquireDocsSlot). When the Docs watched on
 * one service account would need more than that, every Doc's interval is
 * stretched by the same factor (intervalFor), so they share the budget in
 * proportion to their tier rather than piling up on the slot.
 *
 * On a change: nothing is done if the post is already built at that
 * revision (database/docImages.js, recorded after the build; Docs API only),
 * which a sync may have done first. Otherwise the change goes through the
 * sync like any other (applyChange): the Doc is recorded as forced and its
 * directory as changed (database/dirty.js), and the sync applies just what is
 * recorded under the folder lock, listing that one directory rather than
 * walking the whole folder (about 10.5s on a 3,000-file blog), and
 * downloading the Doc whatever its modifiedTime says. So the export, the
 * write, the build and Drive's records are the sync's, and a rename, a move
 * or a name clash is handled as the sync handles it. A Doc not mapped yet
 * starts a full sync through a follow-up (clients/util/followUpSync). If the
 * folder lock is held, the sync holding it applies what was recorded if it
 * hasn't finished its directories, and the poll retries at most 500ms after
 * the lock is free.
 *
 * State lives in Redis so any number of processes can enqueue and poll:
 *   - each watched Doc is a hash (item:<id>) holding what a poll needs (blog,
 *     folder, first/last seen, last change, last known revision) that
 *     expires shortly after the Doc would be evicted anyway;
 *   - the poll schedule is a helper/alarm queue ("google-drive-hot-docs"): an
 *     alarm's due time is the Doc's next poll, and whichever process claims it
 *     polls the Doc, then re-arms the alarm for the next poll or lets it
 *     complete once the Doc has gone quiet;
 *   - the global and per-service-account caps are sorted sets of ids scored by
 *     last activity, from which the least recently active are evicted, and
 *     which intervalFor counts to share the rate limit;
 *   - the docs.get limit per service account is a set of 250ms slots, one call
 *     each, claimed through Redis by all processes.
 * The id of a Doc is <serviceAccountId>:<blogID>:<fileId>.
 */
const Bottleneck = require("bottleneck");
const { dirname } = require("path");
const client = require("models/client");
const alarm = require("helper/alarm");
const drain = require("helper/drain");
const clfdate = require("helper/clfdate");
const folderLock = require("sync/lock");
const followUpSync = require("clients/util/followUpSync");
const syncOrThrow = require("../sync/syncOrThrow");
const createDocsClient = require("./createDocsClient");
const database = require("../database");
const { isBuilt } = require("../util/fetchDoc");

const prefix = () => `${clfdate()} Google Drive hotDocPoller:`;

// docs.get() quota: 5/sec per service account; we use 4/sec for buffer, as one
// call per 250ms slot (a per-second counter would allow 8 calls across a
// second boundary).
const DOCS_GET_SLOT_MS = 250;
// How often each process logs what its poller did
const SUMMARY_EVERY_MS = 60 * 1000;
const DOCS_GET_PER_SECOND = 1000 / DOCS_GET_SLOT_MS;
// Slots tried before giving up on a rate-limit slot (about 10s)
const DOCS_GET_MAX_SLOT_ATTEMPTS = 40;

// How often each process looks for due polls. Small enough that the 500ms
// tier is polled every 500-750ms; each look is one Redis call.
const POLL_INTERVAL_MS = 250;
const MAX_ITEMS_GLOBAL = 500;
const MAX_ITEMS_PER_SERVICE_ACCOUNT = 150;
const RATE_LIMIT_BACKOFF_MS = 30000;
// After a poll or an apply fails for some other reason, so a lasting error
// isn't retried every 500ms
const ERROR_RETRY_MS = 5000;

// By time since the Doc's last activity (see activeAt). A Doc being edited
// changes every few seconds, so it stays in the first tier while it is.
const SCHEDULE_TIERS = [
  { maxAgeSeconds: 2 * 60, everyMs: 500 },
  { maxAgeSeconds: 10 * 60, everyMs: 2000 },
  { maxAgeSeconds: 30 * 60, everyMs: 5000 },
];
const EVICT_AFTER_SECONDS =
  SCHEDULE_TIERS[SCHEDULE_TIERS.length - 1].maxAgeSeconds;
// The last poll evicts a Doc nobody enqueued again at EVICT_AFTER_SECONDS;
// the hash only outlives that if the process died before cleaning up.
const ITEM_TTL_SECONDS = EVICT_AFTER_SECONDS + 120;
// Alarms handled per poll of the queue
const ALARM_BATCH = 20;

const REDIS_PREFIX = "blot:google-drive:hotdocs:";
const ITEM_PREFIX = REDIS_PREFIX + "item:";
const RATE_PREFIX = REDIS_PREFIX + "docs-slot:";
const ALL_KEY = REDIS_PREFIX + "all";
const serviceAccountKey = (serviceAccountId) =>
  REDIS_PREFIX + "by-service-account:" + serviceAccountId;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jitterMs = (baseMs) => {
  const spread = Math.max(1, Math.floor(baseMs * 0.2));
  return Math.floor(Math.random() * spread);
};

// The later of a Doc's last enqueue and its last detected change, in ms
const activeAt = ({ lastSeen, lastChanged }) =>
  Math.max(Number(lastSeen) || 0, Number(lastChanged) || 0);

// The tier's interval for a Doc last active ageSeconds ago, or null once it
// has been quiet for longer than the last tier
const tierIntervalMs = (ageSeconds) => {
  const tier = SCHEDULE_TIERS.find(
    (entry) => ageSeconds <= entry.maxAgeSeconds
  );
  return tier ? tier.everyMs : null;
};

// Stretches a tier's interval so the Docs on one service account, counted
// per tier, need no more than DOCS_GET_PER_SECOND calls between them. Every
// Doc is stretched by the same factor, so a Doc in the 500ms tier is still
// polled 10 times as often as one in the 5s tier. When all are in one tier
// this is max(tier interval, count x 250ms).
const fairIntervalMs = (tierMs, countsByTier) => {
  const demand = SCHEDULE_TIERS.reduce(
    (sum, tier, i) => sum + ((countsByTier[i] || 0) * 1000) / tier.everyMs,
    0
  );
  return Math.ceil(tierMs * Math.max(1, demand / DOCS_GET_PER_SECOND));
};

// A string for a Drive query, quoted

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

    // Due time = next poll of that Doc; see the comment at the top
    this.alarms = alarm("google-drive-hot-docs", (id) => this.handleAlarm(id), {
      pollMs: POLL_INTERVAL_MS,
      batch: ALARM_BATCH,
    });

    // A full sync for a change applyChange can't apply alone. Its own
    // follow-up queue (not the webhook's), so it runs once a sync already
    // running has finished, in any process.
    this.followUps = followUpSync("google-drive-hot-docs", (blogID) =>
      syncOrThrow(blogID, { trigger: "hotdoc" })
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
      appliedCount: 0,
      fullSyncCount: 0,
      evictions: 0,
      rateLimitEvents: 0,
    };

    // API clients are cached per process
    this.docsByServiceAccount = new Map();
  }

  start() {
    if (this.started || drain.isDraining()) return;
    this.started = true;
    this.alarms.start();
    this.stopOnDrain = drain.onStart(() => this.stop());
    // What this process's poller did, once a minute when it did anything
    this.summaryTimer = setInterval(() => this.logSummary(), SUMMARY_EVERY_MS);
    this.summaryTimer.unref?.();
  }

  logSummary() {
    const counts = { ...this.metrics };
    if (!Object.values(counts).some((n) => n > 0)) return;
    this.log("summary", counts);
    for (const name of Object.keys(this.metrics)) this.metrics[name] = 0;
  }

  // Waits for the Doc being polled, claims no more
  async stop() {
    if (!this.started) return;
    this.started = false;
    if (this.stopOnDrain) this.stopOnDrain();
    this.stopOnDrain = null;
    clearInterval(this.summaryTimer);
    this.logSummary();
    await this.alarms.stop();
  }

  idFor(serviceAccountId, blogID, fileId) {
    return `${serviceAccountId}:${blogID}:${fileId}`;
  }

  getPollIntervalMs(ageSeconds) {
    return tierIntervalMs(ageSeconds);
  }

  fairIntervalMs(tierMs, countsByTier) {
    return fairIntervalMs(tierMs, countsByTier);
  }

  // How long until the next poll of a Doc last active at `active`: its
  // tier's interval, stretched to share the service account's rate limit
  // with the other Docs it watches. Null once the Doc has gone quiet.
  async intervalFor(serviceAccountId, active, now = Date.now()) {
    const tierMs = tierIntervalMs((now - active) / 1000);
    if (tierMs === null) return null;

    const key = serviceAccountKey(serviceAccountId);
    const multi = client.multi();
    let upper = "+inf";
    for (const tier of SCHEDULE_TIERS) {
      const lower = now - tier.maxAgeSeconds * 1000;
      multi.zCount(key, String(lower), upper);
      upper = "(" + lower;
    }
    const counts = (await multi.exec()).map(Number);

    return fairIntervalMs(tierMs, counts);
  }

  log(event, context = {}, level = "info") {
    const payload = JSON.stringify({ event, ...context });
    if (level === "warn") {
      console.warn(prefix(), payload);
      return;
    }

    console.log(prefix(), payload);
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
    // An empty hash is a Doc that was evicted or expired; one without a file
    // is what a late write to an evicted Doc leaves behind.
    if (!fields || !fields.fileId) return null;

    return {
      id,
      blogID: fields.blogID,
      serviceAccountId: fields.serviceAccountId,
      fileId: fields.fileId,
      folderId: fields.folderId,
      firstSeen: Number(fields.firstSeen),
      lastSeen: Number(fields.lastSeen),
      lastChanged: Number(fields.lastChanged || 0),
      pollCount: Number(fields.pollCount || 0),
      lastKnownRevision: fields.lastKnownRevision || null,
    };
  }

  // Writes fields onto the item's hash and keeps it expiring
  async saveItem(id, fields) {
    const key = ITEM_PREFIX + id;
    await client.multi().hSet(key, fields).expire(key, ITEM_TTL_SECONDS).exec();
  }

  async saveRevision(item, revision) {
    item.lastKnownRevision = revision;
    if (revision == null) return;
    await this.saveItem(item.id, { lastKnownRevision: revision });
  }

  // Moves the Doc's place in the capped sets to its latest activity, which is
  // what intervalFor counts and what the caps evict by
  async touch(id, serviceAccountId, when) {
    await client
      .multi()
      .zAdd(ALL_KEY, { score: when, value: id })
      .zAdd(serviceAccountKey(serviceAccountId), { score: when, value: id })
      .exec();
  }

  // Waits to win the service account's docs.get slot for the current 250ms.
  // Each slot allows one call, claimed with SET NX by whichever process gets
  // there first, so the rate is at most 4 a second across all processes, also
  // across second boundaries. If no slot is won after DOCS_GET_MAX_SLOT_ATTEMPTS
  // we proceed anyway: Redis being busy or the account being saturated for
  // ten seconds shouldn't wedge the poll, and a real 429 is handled by the
  // caller's backoff. Resolves to the slot won (undefined if it gave up).
  async acquireDocsSlot(serviceAccountId) {
    for (let attempt = 0; attempt < DOCS_GET_MAX_SLOT_ATTEMPTS; attempt++) {
      const now = Date.now();
      const slot = Math.floor(now / DOCS_GET_SLOT_MS);
      const key = RATE_PREFIX + serviceAccountId + ":" + slot;
      const won = await client.set(key, "1", { NX: true, PX: 1000 });
      if (won !== null) return slot;
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

  // docs.documents.get is the only API that sees an edit to an open Doc
  // within seconds (see the comment at the top)
  async fetchLatestRevisionState(docs, fileId) {
    if (!docs) return { lastKnownRevision: null };

    // Only the revision: without a fields mask every poll downloads the
    // whole Doc (15-77 KB for small Docs, far more for long ones) to read
    // one field. The mask returns about 128 bytes (24 Nov 2026).
    const doc = await docs.documents.get({
      documentId: fileId,
      fields: "revisionId",
    });
    return { lastKnownRevision: doc?.data?.revisionId ?? null };
  }

  // A rate limit on one service account delays every Doc it polls
  async boostBackoffForServiceAccount(now, serviceAccountId) {
    const ids = await client.zRange(serviceAccountKey(serviceAccountId), 0, -1);

    for (const id of ids) {
      await this.alarms.set(id, now + RATE_LIMIT_BACKOFF_MS + jitterMs(5000));
    }
  }

  // Forgets a Doc: its hash, its place in the caps and its alarm
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

  // Evicts only if the Doc wasn't enqueued again since item was loaded.
  // Resolves false (nothing evicted) if it was. Another process could still
  // enqueue between the re-read and the delete; that window is tiny and we
  // accept it rather than lock every enqueue (a Doc that loses that race is
  // simply enqueued again by its next export). lastChanged needs no check:
  // only the poll of this Doc writes it, and that is us.
  async evictIfUnchanged(item, reason) {
    const stored = await client.hGet(ITEM_PREFIX + item.id, "lastSeen");
    if (stored !== String(item.lastSeen)) return false;
    await this.evict(item, reason);
    return true;
  }

  async evict(item, reason, level = "info", extra = {}) {
    await this.remove(item.id, item.serviceAccountId);
    this.log(
      "evicted",
      {
        reason,
        blogID: item.blogID,
        serviceAccountId: item.serviceAccountId,
        fileId: item.fileId,
        ...extra,
      },
      level
    );
  }

  // Evicts the least recently active Docs in a capped set beyond its limit
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
    await this.evictOldestBeyond(
      ALL_KEY,
      MAX_ITEMS_GLOBAL,
      "global-cap",
      "info"
    );
    await this.evictOldestBeyond(
      serviceAccountKey(serviceAccountId),
      MAX_ITEMS_PER_SERVICE_ACCOUNT,
      "service-account-cap",
      "warn"
    );
  }

  // Sets the Doc's next poll from now, at its interval: a Doc active now is
  // in the first tier
  async armFromNow(id, serviceAccountId, now) {
    const intervalMs = await this.intervalFor(serviceAccountId, now, now);
    await this.alarms.set(id, now + intervalMs + jitterMs(intervalMs));
  }

  // Starts watching a Doc, or moves a Doc already watched back to the fastest
  // poll. For any code that sees a Doc change (util/download.js after an
  // export, a Drive change listing). Resolves once the Doc is scheduled.
  //
  // unseen: the caller saw the Doc change but Blot hasn't exported that
  // change (Drive Activity, pollDriveActivity.js). The first poll then takes
  // whatever revision the Doc has as a change, rather than as its baseline.
  async enqueue({ blogID, serviceAccountId, fileId, folderId, unseen }) {
    if (!blogID || !serviceAccountId || !fileId || !folderId) return;

    this.start();

    const id = this.idFor(serviceAccountId, blogID, fileId);
    const now = Date.now();

    if (await client.exists(ITEM_PREFIX + id)) {
      await this.saveItem(id, {
        lastSeen: String(now),
        folderId,
        serviceAccountId,
      });
      await this.touch(id, serviceAccountId, now);
      await this.armFromNow(id, serviceAccountId, now);
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
    await this.touch(id, serviceAccountId, now);
    this.metrics.enqueueCount += 1;
    this.log("enqueued", { blogID, serviceAccountId, fileId, folderId });

    if (unseen) {
      await this.alarms.set(id, now);
      await this.enforceCaps(serviceAccountId);
      return;
    }

    // The first poll waits for the revision the Doc has now, so the poll
    // doesn't mistake it for a change.
    let rateLimited = false;
    try {
      const docs = await this.getDocs(serviceAccountId);
      const initial = await this.fetchRateLimited(
        serviceAccountId,
        docs,
        fileId
      );

      if (initial.lastKnownRevision != null) {
        await this.saveItem(id, {
          lastKnownRevision: initial.lastKnownRevision,
        });
      }
    } catch (err) {
      if (isRateLimitError(err)) {
        rateLimited = true;
        this.metrics.rateLimitEvents += 1;
        this.log(
          "rate-limit",
          {
            phase: "enqueue-initial-state",
            blogID,
            serviceAccountId,
            fileId,
            message: err?.message,
          },
          "warn"
        );
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
      // Includes this Doc, now that it is in the service account's set
      await this.alarms.set(id, now + RATE_LIMIT_BACKOFF_MS + jitterMs(5000));
      await this.boostBackoffForServiceAccount(now, serviceAccountId);
    } else {
      await this.armFromNow(id, serviceAccountId, Date.now());
    }

    await this.enforceCaps(serviceAccountId);
  }

  // Runs in whichever process claimed the Doc's alarm. Re-arms the alarm for
  // the next poll unless the Doc was evicted or the service account is
  // backing off (which sets its own due times).
  async handleAlarm(id) {
    const item = await this.loadItem(id);
    if (!item) {
      // Evicted or expired since it was armed: only its place in the sets
      // can be left, and the alarm completes
      await this.remove(id, id.split(":")[0]);
      return;
    }

    const startedAt = Date.now();
    const ageSeconds = (startedAt - activeAt(item)) / 1000;

    if (tierIntervalMs(ageSeconds) === null) {
      if (await this.evictIfUnchanged(item, "quiet")) return;
      // Enqueued again while we were looking: poll it from the first tier
      await this.rearm(id, item.serviceAccountId, Date.now());
      return;
    }

    let rearm = true;
    let atLeastMs = 0;

    try {
      await this.checkItem(item);
    } catch (err) {
      if (isRateLimitError(err)) {
        rearm = false;
        this.metrics.rateLimitEvents += 1;
        await this.boostBackoffForServiceAccount(
          startedAt,
          item.serviceAccountId
        );
        this.log(
          "rate-limit",
          {
            blogID: item.blogID,
            serviceAccountId: item.serviceAccountId,
            fileId: item.fileId,
            message: err?.message,
          },
          "warn"
        );
      } else {
        const terminalReason = getTerminalErrorReason(err);
        if (terminalReason) {
          rearm = false;
          await this.evict(item, terminalReason, "warn", {
            message: err?.message,
          });
        } else {
          atLeastMs = ERROR_RETRY_MS;
          this.log("poll-error", {
            blogID: item.blogID,
            serviceAccountId: item.serviceAccountId,
            fileId: item.fileId,
            message: err?.message,
          });
        }
      }
    }

    if (rearm)
      await this.rearm(id, item.serviceAccountId, startedAt, atLeastMs);
  }

  // Sets the next poll, counted from `from` (when this poll started). Reads
  // the Doc's activity afresh, so a change just detected or an enqueue()
  // during the poll puts it in the first tier. Setting the alarm only now
  // keeps the Doc claimed (not due for another process) while it is polled.
  async rearm(id, serviceAccountId, from, atLeastMs = 0) {
    const [lastSeen, lastChanged] = await client.hmGet(ITEM_PREFIX + id, [
      "lastSeen",
      "lastChanged",
    ]);
    // Evicted during the poll
    if (lastSeen == null) return;

    const intervalMs = await this.intervalFor(
      serviceAccountId,
      activeAt({ lastSeen, lastChanged }),
      Date.now()
    );

    // Went quiet during the poll: the next handleAlarm evicts it
    if (intervalMs === null) return this.alarms.set(id, Date.now());

    const delayMs = Math.max(intervalMs + jitterMs(intervalMs), atLeastMs);
    await this.alarms.set(id, from + delayMs);
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
    const revision = latest.lastKnownRevision;

    if (!revision || revision === item.lastKnownRevision) {
      // Keeps the hash from expiring while the Doc is polled
      await this.saveRevision(item, revision);
      return;
    }

    const detectedAt = Date.now();
    this.metrics.changeDetectedCount += 1;
    this.log("change-detected", {
      blogID: item.blogID,
      serviceAccountId: item.serviceAccountId,
      fileId: item.fileId,
      pollCount: item.pollCount,
    });

    // A change keeps the Doc in the fastest tier for another two minutes
    item.lastChanged = detectedAt;
    await this.saveItem(item.id, { lastChanged: String(detectedAt) });
    await this.touch(item.id, item.serviceAccountId, detectedAt);

    // For the live line: an open Doc's modifiedTime lags its edits, so for
    // a Doc the gaps between seen_ms, download_ms and lag_ms are what matter
    item.detectedAt = detectedAt;
    item.revision = revision;
    const outcome = await this.applyChange(item);

    this.log("change-handled", {
      outcome,
      blogID: item.blogID,
      serviceAccountId: item.serviceAccountId,
      fileId: item.fileId,
      ms: Date.now() - detectedAt,
    });

    // Recorded once it was applied or handed to a full sync, so the next
    // poll doesn't apply it again. A Doc edited again since the docs.get
    // above was exported with that edit too, and is exported once more at
    // the next poll, which is harmless. While the folder lock is held the
    // revision is left alone, so the next poll tries again.
    if (outcome !== "locked") await this.saveRevision(item, revision);
  }

  // Applies a detected change to the blog, through the sync like any other
  // change: the Doc is recorded as forced (downloaded whatever its lagging
  // modifiedTime says) and its directory as changed (database/dirty.js),
  // then the sync applies just what is recorded, under the folder lock, with
  // no walk (sync/index.js applyRecorded). So the export, the write, the
  // build and the records Drive keeps are the sync's own, and a rename, a
  // move or a name clash is handled as the sync handles it. Resolves to:
  //   "applied"     the sync applied it
  //   "full-sync"   the Doc isn't mapped yet, so a full sync was started
  //   "locked"      another sync holds the folder lock: it takes what is
  //                 recorded, and the next poll tries again if it didn't
  //   "unavailable" the blog can't sync (removed or disabled)
  //   "unchanged"   the post is already built at this revision
  // An apply that fails rejects, and the poll retries it.
  async applyChange(item) {
    // The post is already built at this revision: a sync published it
    // first, or an unseen enqueue's first poll found nothing new. Recorded
    // only for the Docs API's JSON and only after the build, so a zip export
    // or a write whose build never finished always goes on.
    if (item.revision && (await this.isBuilt(item))) return "unchanged";

    // The blog moved to another folder or service account, or its setup is
    // copying the site's files (which a sync must leave alone): the full
    // sync sorts it out, or waits
    const account = await database.blog.get(item.blogID);
    const folderDb = database.folder(item.folderId, item.blogID);
    const current =
      account?.folderId === item.folderId &&
      account?.serviceAccountId === item.serviceAccountId &&
      !account?.preparing;
    const path = current ? await folderDb.get(item.fileId) : null;
    const dirId = path
      ? dirname(path) === "/"
        ? item.folderId
        : await folderDb.getByPath(dirname(path))
      : null;
    if (!dirId) {
      this.metrics.fullSyncCount += 1;
      this.log("full-sync", {
        reason: current ? "unmapped" : "account-changed",
        blogID: item.blogID,
        serviceAccountId: item.serviceAccountId,
        fileId: item.fileId,
      });
      await this.fullSync(item.blogID);
      return "full-sync";
    }

    await database.dirty.force(item.blogID, item.fileId);
    await database.dirty.add(item.blogID, [dirId], "hotdoc");

    // establishSyncLock's own retries take over 5s when the lock is visibly
    // held: the next poll, 500ms on, is sooner
    if ((await this.isFolderLocked(item.blogID)) === true) return "locked";

    let summary;
    try {
      summary = await this.applyRecorded(item.blogID);
    } catch (err) {
      if (err?.message === "Failed to acquire folder lock") return "locked";
      if (err?.message?.startsWith("Cannot sync blog")) return "unavailable";
      throw err;
    }
    if (summary === false) throw new Error("Applying the Doc's change failed");

    // The sync clears the mark once the Doc's download succeeds. Still
    // marked: its download failed (counted, not thrown, by the sync), so the
    // poll retries; or the Doc wasn't in the directory listed (moved or
    // renamed meanwhile), which the full sync finds
    if ((await database.dirty.forced(item.blogID)).includes(item.fileId)) {
      if (summary?.failed) throw new Error("Exporting the Doc failed");
      this.metrics.fullSyncCount += 1;
      this.log("full-sync", {
        reason: "not-listed",
        blogID: item.blogID,
        serviceAccountId: item.serviceAccountId,
        fileId: item.fileId,
      });
      await this.fullSync(item.blogID);
      return "full-sync";
    }

    this.metrics.appliedCount += 1;
    return "applied";
  }

  async isBuilt(item) {
    const path = await database
      .folder(item.folderId, item.blogID)
      .get(item.fileId);
    return Boolean(
      path && (await isBuilt(item.blogID, item.fileId, path, item.revision))
    );
  }

  // Whether another sync holds the blog's folder lock
  async isFolderLocked(blogID) {
    return (await folderLock.inspect(blogID)).held;
  }

  // sync/index.js requires this module (through util/download.js), so it is
  // loaded when first used
  applyRecorded(blogID) {
    return require("../sync").applyRecorded(blogID);
  }

  // Starts the blog's full sync without waiting for it: arm() leaves the
  // follow-up in Redis first, so a process that dies before the sync has run
  // doesn't lose it, and run() takes it back once the sync has finished. A
  // sync already running gets a follow-up instead.
  async fullSync(blogID) {
    const armed = await this.followUps.arm(blogID);
    // Not awaited: this process goes back to polling other Docs meanwhile
    this.runFullSync(blogID, armed);
  }

  async runFullSync(blogID, armed) {
    try {
      await this.followUps.run(blogID, armed);
    } catch (err) {
      this.log("full-sync-failed", { blogID, message: err?.message }, "warn");
    }
  }
}

module.exports = new HotDocPoller();
