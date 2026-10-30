---
name: investigate-macserver-sync-issue
description: Investigate an "iCloud resync found changes" admin email (the ICLOUD_RESYNC_ISSUE email a macserver-requested resync sends when it found changes, Fix() repairs or errors, with the macserver's reason), an "iCloud sync issue" hourly digest, or any other iCloud / macserver sync problem. Reads the macserver's pm2 logs over `ssh macserver` to find which watcher action (upload/remove/mkdir) failed and why, cross-checks the production container logs and the blog's iCloud account state, classifies the cause, then appends a short entry to this skill's incident log. Use when the user pastes or forwards one of these alerts, or asks to look into iCloud / macserver sync.
---

# Investigate a macserver (iCloud) sync issue

## What the alert means

Blot's iCloud client is two halves:

- **macserver** (`app/clients/icloud/macserver/`, ESM, pm2 process
  `macserver`, Express on port 3000) runs on a Mac signed into iCloud Drive.
  It watches `<ICLOUD_DRIVE_DIRECTORY>/<blogID>/` with chokidar plus an
  `fs.watch` reconciler (`watcher/`) and pushes every change to Blot over
  HTTP (`httpClient/{upload,remove,mkdir}.js` → `POST /clients/icloud/{upload,delete,mkdir}`).
- **Server** (`app/clients/icloud/routes/site/`) applies those changes, and
  pushes dashboard edits the other way via the macserver's own routes
  (`app/clients/icloud/write.js`, `sync/util/remote*.js`).

A resync can be requested by exactly one thing: a watcher action on the
macserver failed even after retrying
(`macserver/watcher/actions.js` — `withRetries`, 4 attempts, each `fetch`
itself retried 3× with a 10s timeout, 60s for uploads). The macserver then
calls `httpClient/resync.js`, which POSTs
`{resyncRequested:true, reason}` to `/clients/icloud/status`, where `reason`
is e.g. `upload for Posts/x.md failed after retries`. The server
(`routes/site/status.js`) dedups for 10s, takes the folder sync lock
(replying **423** if it's held, so the macserver retries up to 20× with
backoff ≤5 min), re-checks the account, and runs the same walk and Fix() as
the hourly validation (`sync/validateBlog.js`) with **iCloud as the source of
truth** (can clobber files that only existed on Blot's side, e.g. dashboard
template edits).

**`ICLOUD_RESYNC_ISSUE` ("iCloud resync found changes")** is sent straight
after that resync, and only if it found something: changes that only reached
Blot because of the resync (the push that failed, or others dropped with it),
Fix() repairs, or a walk or Fix() error. A resync that finds nothing sends no
email. It is capped at one per blog per hour (`Resync report suppressed` on
the server), so one email can stand for a whole burst of requests. It
carries the macserver's `reason` ("No reason was given" means an older
macserver), the same per-blog change, Fix() and error lines as the hourly
digest, and the `logs green | grep "<blog12> sync_"` helper. The old
`ICLOUD_RESYNC_REQUESTED` email ("A resync was requested for site …", sent
on every request) is gone; older incident entries below refer to it. For a
Fix() repair in the email use `triage-sync-fix-repair`.

The hourly validation is separate: `validateAllBlogs` in
`app/clients/icloud/init.js`, scheduled at :45, walks every blog the
macserver pushed to in the last hour and emails one `ICLOUD_SYNC_ISSUE`
("iCloud sync issue") digest of unsynced changes, Fix() repairs, errors and
stuck folder locks. Changes there mean a macserver push was missed without
even a resync request. Removals and created directories are excluded as live
edits when their parent directory's mtime (returned by the macserver's
`/readdir`) falls within the grace period before the walk or after it started;
changes directly in the root aren't covered. The daily full resync
(`resyncAllConnected`) and the startup resync stay unscheduled. The other active checks are
`monitorMacServerStats` (minutely `GET /stats`: down/recovered/disk/quota
emails). A manual full resync of one or all blogs is
`scripts/icloud/resync.js` (writes; never run without approval).

## Access and safety

**Ask the user before every command against production or the macserver,
even read-only ones**, and stick to read-only commands (log reads,
`pm2 describe`/`pm2 jlist`, `ls`, Redis reads). Never `pm2 restart`, edit
`.env`, touch the iCloud folders, or run `scripts/icloud/resync.js` unless
explicitly asked.

- macserver: `ssh macserver` (user `admin`, repo at `/Users/admin/blot`,
  app in `app/clients/icloud/macserver`, config in its `.env`, key
  `~/Projects/macserver.pem`). If it fails with `Load key …: Operation not
  permitted`, the key is being read from iCloud Drive, which macOS privacy
  controls (TCC) block for the Claude app; ask the user to point
  `~/.ssh/config` at a copy outside `~/Library/Mobile Documents`.
  Check with `ssh -o BatchMode=yes macserver true`.
- `pm2` isn't on the PATH for non-interactive ssh (`command not found:
  pm2`). Read the log files directly: `~/.pm2/logs/macserver-out.log` and
  `macserver-error.log`, rotated at midnight Mac time into
  `macserver-{out,error}__<date>_00-00-01.log`. A rotated file holds the
  day *before* its date. If you need pm2 itself, use `zsh -lc 'pm2 …'`.
- `brctl monitor event` lines name the iCloud users who own or edited a
  shared item. That is personal data: fine in chat, never in the log below.
- prod: `ssh blot`, containers `blot-{blue,green}` (see
  `investigate-production-container-restarts`). Macserver HTTP requests can
  land on any container, so grep all three. Docker logs are lost when a
  deploy recreates a container, so if the alert is older than the
  container's `CreatedAt` the server side is gone — say so.
- macserver lines are prefixed with `clfdate()` (local time on the Mac);
  docker `--timestamps` are UTC. Note the offset when you line them up.

## Method

**A read-only freeze explains delays, not failures.** While the data volume is
being resized (or anyone ran `scripts/read-only.js on`), syncs deliberately
wait and client writes get 503s; the dashboard shows "Sync paused". If the
alert window overlaps one, look for `[READ ONLY] waiting to write` in the
container logs and see the `data-volume` skill's incident log before
classifying anything as a bug.

1. **Find the resync request(s) on the macserver.** The email's `Reason:`
   line says which action failed; the macserver log has the rest and the
   timing. The email is capped at one per blog per hour (`Resync report
   suppressed` on the server), so one email can stand for a whole burst of
   requests, and a request whose resync found nothing sends none.
   ```
   ssh macserver "grep -h 'Requesting resync for blogID\|Resync acknowledged\|Failed to request resync\|Deduplicating resync' ~/.pm2/logs/macserver-*.log | tail -60"
   ```
   The `(… failed after retries)` suffix names the action and path. Note
   the time, and whether this blog (or many blogs at once) keeps doing it.
2. **Get the failure itself.** Take the blog's lines around that time,
   dropping the raw watcher events:
   ```
   ssh macserver "grep -h '<blog12>' ~/.pm2/logs/macserver-*.log | grep -v 'Chokidar Event\|FS Watch Event' | tail -300"
   ```
   Then read the `error` log from the start of the window. Its multi-line
   stack traces don't carry timestamps, so take a line range rather than
   grepping:
   ```
   ssh macserver "f=~/.pm2/logs/<error log file>; n=\$(grep -n '<dd/Mon/yyyy:HH:M>' \$f | head -1 | cut -d: -f1); sed -n \"\${n},\$((n+250))p\" \$f | cut -c1-300"
   ```
   To see what the user did just before, read the raw watcher events,
   including `Chokidar Event`, `FS Watch Event` and `brctl monitor event`
   (adds, renames, deletes):
   ```
   ssh macserver "grep -h '<blog12>' ~/.pm2/logs/macserver-out*.log | grep '<dd/Mon/yyyy:HH>:' | grep -v 'Preparing to upload' | head -150 | cut -c1-250"
   ```
   Things to look for: `failed on attempt N/4`, `failed after 4 attempts`,
   `Request failed:`, `Request timed out`, the HTTP status, and macserver-side
   errors from the upload client (`Stat failed:`, `Download failed:` — the
   `brctl download` of an evicted file — or `Failed to read file:`).
3. **Check the server side** for the same window:
   ```
   ssh blot "for c in blue green; do echo == \$c; docker logs blot-\$c --timestamps 2>&1 | grep '<blog12>' | tail -150; done"
   ```
   Several server lines don't carry the blog ID (`Error in /upload:`,
   `Syncing folder:`, `Failed to sync folder tree`), so also grep those
   strings over a time window (`awk '$1>"<UTC start>" && $1<"<UTC end>"'`).
   Look for `Error in /upload` (and delete/mkdir), `[ICLOUD SYNC LOCK]`
   (423: a dashboard write or another sync held the lock), `Resync requested
   from iCloud`, `Resync request deduplicated`, `Error in requestResync`,
   `Failed to sync folder tree`, and the resync's own `Syncing folder:` /
   `Resync complete` status. Many failing blogs at once points to the
   server, so check for a deploy or restart at that time
   (`docker ps -a`, restart skill).
4. **Check the account state** if the failure suggests it (409 setup
   incomplete, 403, error codes): the Redis hash
   `blot:clients:icloud-drive:blogs:<blogID>` (fields `setupComplete`,
   `transferringToiCloud`, `error`, `errorCode`, `errorSince`, …; see
   `app/clients/icloud/database.js`, `error.js`). Read it with a one-off
   read-only `node -e` inside a container (pattern in
   `investigate-template-tags-in-content`), with approval.
5. **Classify** as one of:
   - **Local file race (benign but noisy).** The file was deleted, renamed
     or evicted between the watcher event and the upload (`Stat failed`
     ENOENT, a `brctl` download failure for a path that's gone), and the
     resync converged. Typical trigger: a whole folder dropped into the
     blog folder, then renamed or deleted, while its uploads were still
     queued. The server's resync then holds the lock, so the next queued
     `mkdir`/upload calls get `423 Locked`, fail, and request yet another
     resync. Those 423 requests are kept on purpose: the server ignores a
     resync request while one is in flight, and a 423 from an unrelated
     lock holder must still lead to a resync, or the change is lost.
   - **Server unavailable or slow (transient).** 5xx, timeout or connection
     reset during a deploy, restart or overload window. Usually many blogs
     at once.
   - **Lock contention.** Repeated 423s because another sync or a dashboard
     write held the folder lock for longer than the retries.
   - **Account/setup state.** 409 (`setupComplete` false), 403, or a stored
     error code. The blog isn't fully connected.
   - **Bug.** The server rejected a valid request (`Error in /upload` with a
     stack, bad path encoding, size or placeholder handling), or the same
     path fails every time.
6. **Report** to the user in chat (identifying details are fine here, never
   in the committed log). Include the blog, the times (Mac local and UTC),
   the action and path, the timeline, the classification, and whether
   anything needs fixing. Don't change code unless asked. If a fix is
   warranted, add a compact line to the root `TODO`.
7. **Append an entry to the Incident log below** (newest last), following
   its privacy rules, ~5 lines. Update the Method if you found a better
   query.

## Incident log

Read this first: a repeated pattern changes the classification. Newest
entries last.

**Privacy: this file is committed to the repo, so entries must contain no
customer information.** Do not write blog IDs, handles, domains, file
names, folder/file paths, post titles or anything else identifying a
customer or their content; describe things generically ("an image in a
subfolder was replaced while it was being uploaded"). Keep out
userbase/infra size numbers too. Do give **precise timestamps** (Mac local
and UTC, to the second) for the resync request and key events, plus the
container name, so a future agent can re-find the incident while the logs
still exist.

Entry template:

```
### <date> <HH:MM:SS> UTC resync request — <classification>
- Alert / trigger: …
- Key events (UTC, to the second): …
- Cause: …
- Follow-up: …
```

### 2026-10-07 06:08:15 UTC resync burst — local file race (benign, noisy)

- Alert: one of a burst of `ICLOUD_RESYNC_REQUESTED` emails for one blog.
  The macserver sent at least 20 resync requests, roughly one every 10s,
  from 06:08:15 to 06:11:46 UTC (23:08–23:11 Mac time, -0700). Each was
  acknowledged on the first attempt.
- Key events (UTC): 06:05:24, a collaborator on the shared iCloud folder
  added a whole code project (with `.git`, which is ignored, and `.claude`)
  into the blog folder. It was then renamed between an underscore and a
  plain name, and the folder was deleted at 06:12:09. From 06:05:55,
  queued uploads failed with `Stat failed: ENOENT` (file already moved)
  four times each, half a second apart, and each requested a resync. Some
  queued `mkdir`s also got `423 Locked`, because the server's resync held
  the folder lock.
- Server-side logs were gone: a deploy recreated all three containers at
  08:16 UTC.
- Cause: nothing broken on Blot's side. ENOENT on a queued upload is
  treated as a failure that needs a full resync, when it means "the file
  moved; a delete or rename event will follow". The 10s dedup on each side
  turns one folder move into one email per 10s.
- Follow-up: fixed in the PR for this entry. A queued upload whose file is
  gone now logs `Skipping upload: file no longer exists` and requests no
  resync. The admin email is capped at one per blog per hour (`Resync email
  suppressed`, `app/clients/icloud/util/notificationCap.js`).

### 2026-10-08 12:13:54 UTC resync request — account/setup state (reconnect churn), plus a bug

- Alert: one `ICLOUD_RESYNC_REQUESTED` email, sent 12:14:11 UTC. The macserver
  requested at 12:13:54 UTC (05:13:54 Mac, -0700): an upload got `409` (setup
  not complete) after retries. Further requests at 12:14:24, 12:15:00, 12:15:33,
  12:16:38 and 12:19:03 hit `400` (not connected), `409` and `423`. The email
  cap suppressed the later emails. Container green.
- Key events (UTC): the owner connected, disconnected and reconnected three
  times (10:05–10:57, 11:53–11:56, 12:13–12:16). The first share was
  read-only, so the 10:52 disconnect hit `EPERM`. While the blog was
  disconnected, the owner moved every post into year subfolders. The
  macserver logs `Dropping … event for inactive blogID` for those changes, so
  they were never pushed. 12:13:36 reconnect: `sync_720af62` Blot→iCloud
  transfer. 12:14:04 disconnect; the transfer aborts at 12:14:08. 12:14:11
  the queued resync `sync_0263946` takes the lock and removes every local
  post (0 downloaded). 12:15:43 reconnect. 12:16:07 the dashboard Reset
  `sync_c16e43d` downloads the year folders (the `RESYNC_FOUND_CHANGES` email).
- Cause: changes made while disconnected are dropped by design, and the Reset
  is what picked them up. Bug: a resync request waiting on the folder lock
  outlived the disconnect. `stampLastSync` (`hSet`) recreated a stub account
  hash after `database.delete`, so `checkWeCanContinue` passed. The walk then
  read an empty remote folder and wiped Blot's copy of a disconnected blog.
- Follow-up: fixed in the PR for this entry. After taking the lock,
  `status.js` re-checks the account and logs `Resync skipped: blog no longer
  connected` (400) or `Resync skipped: blog setup not complete` (409, a
  reconnect still transferring). `stampLastSync` no longer creates a
  missing hash.

### 2026-10-09 04:45:00 UTC hourly digest — rename during the validation walk (benign false positive)

- Alert: `ICLOUD_SYNC_ISSUE` digest at 04:45 UTC, one blog: 2 unsynced changes
  (removed: 1, created dirs: 1, downloaded: 0). No resync requested. Container green.
- Key events (UTC; Mac is -0700): the owner was reorganising a subfolder. 04:44:58
  the macserver pushed a mkdir for a new "untitled folder" (200). 04:45:00 the
  folder was renamed in iCloud, the same second the validation started (04:45:00.015).
  04:45:01.18 the macserver's delete arrived and waited on the walk's lock.
  04:45:03.05 the walk removed the old folder, and at 04:45:03.29 it created the renamed one.
  04:45:06.44 the delete returned 204 (`File not found (locked)`), and at 04:45:06.57
  the mkdir returned 200 (`Directory already exists`).
- Cause: the walk applied a live rename before the macserver's pushes, which were
  waiting on the lock. The digest counted that as unsynced. Live edits are only excluded
  for downloads (by mtime). Removals and created dirs are never excluded.
- Follow-up: fixed in the PR for this entry: the macserver's /readdir now returns directory mtimes, and removals and created dirs in a directory modified around the walk count as excluded.

### 2026-10-16 20:45:00 and 22:12:49 UTC — watcher miss on folder rename (bug)

- Alert: an `ICLOUD_SYNC_ISSUE` digest at 20:45 UTC (one blog, ~150 downloads, nothing excluded) and a dashboard Reset `RESYNC_FOUND_CHANGES` at 22:12:49 UTC (another blog, under 20 downloads). No resync was requested. The containers were recreated at 20:14 UTC, before both.
- Key events (UTC; Mac -0700): 20:05:15–20:05:26, the first blog's owner made case-only renames of four sibling subfolders. 22:04:35, the second blog's owner renamed a subfolder to drop a leading underscore. In both cases the macserver logged only `FS Watch Event: mkdir` for the new directory and `remove` for the old one. It sent no upload for any child, though `brctl monitor` saw every file.
- Cause: a renamed directory reaches the watcher as a single new directory. `reconcileFsWatchEvent` (and chokidar `addDir`) pushes only a `mkdir` and never lists the children. The old path's delete removes them from Blot, and they stay missing until a walk.
- Follow-up: fixed in the PR for this entry. When Blot reports it created a directory (`directory-created` header on /mkdir), the watcher walks it and pushes its contents.

### 2026-10-16 22:47:16 UTC resync request — lock contention from a bulk rename, then a hung resync (bug)

- Alert: an `ICLOUD_SYNC_ISSUE` digest at 22:45 UTC, an `ICLOUD_RESYNC_ISSUE` at 23:05 UTC (reason: a remove failed after retries, plus 26 download failures in the walk), and a stuck lock in the 00:45 digest. Same blog each time: newly connected at 21:36:59 UTC, setup done at 21:50:28.
- Key events (UTC): 22:41:38, a folder-mirroring tool renamed the blog's top-level folders, a burst of several hundred adds and removes. 22:45:15–22:47:22, the hourly walk held the lock, so the deletes got 423. 22:47:16, the first resync request. 22:47:22–23:05:23, resync on green (downloads of evicted PDFs timed out). 23:08:04, second resync on green. Its last line is 23:20:43 (`Downloading …`) and it never released the lock: still held at 06:15:56 on 17 Oct. Hourly walks logged `Skipping busy blog`. The macserver re-requested a resync about every 67s (~390 by 06:15) and every request was deduplicated.
- Cause: (1) `sync/util/download.js` awaits `res.arrayBuffer()` after `rateLimitedFetchWithRetriesAndTimeout` has cleared its timer, so a stalled body hangs the sync forever while the lock heartbeat keeps it alive. (2) Blot's 10s fetch timeout is shorter than the macserver's 15s `brctl download` timeout, so evicted files are abandoned and re-requested.
- Follow-up: green was restarted at 06:24:59 UTC on 17 Oct, which freed the lock; the blog synced again within a minute. Fixed in the PR for this entry: the fetch helper's `readBody` keeps the timeout armed through the body read, and /download gets 60s.

### 2026-10-22 15:40:35 UTC — initial transfer to iCloud aborted by a slow /readdir (bug)

- Alert / trigger: a customer email, "error moving to iCloud Drive", sent 15:47 UTC. No admin email. The blog (~800 files, many images) had just been switched to iCloud; containers green.
- Key events (UTC; Mac -0700): 15:39:12 setup started, macserver accepted the sharing link at 15:39:18. 15:39:19 `Transferring files to iCloud` (first pass of `initialTransfer`, which swallows errors). 15:40:35 the macserver's own 30s directory listing timed out (`Refusing to serve unconfirmed (possibly partial) listing`) and Blot's `/readdir` fetch gave up after 3 tries of 10s: the first pass logged `Sync failed` and ended early, partially transferred. 15:40:35 `Verifying transfer` (second pass, `abortOnError`) resumed uploading, then hit another failed `/readdir` at 15:41:24: `Error in initialTransfer`. The account was marked `TRANSFER_INCOMPLETE` and the watcher's uploads got 409s (setup incomplete) from 15:41:37. 15:53:25 the blog was disconnected (the customer's retry or cancel), leaving the account record deleted.
- Cause: during the burst of uploaded files (thousands of `brctl monitor` events per minute) the macserver's plain `ls` on freshly created directories stalled for ~35-40s and then answered by itself, both times just after Blot had given up (3 x 10s, with the retries stacking duplicate `ls` calls on the same directory). The first stall exceeded the macserver's own 30s exec timeout (503, `Refusing to serve unconfirmed listing`); the second ended without one. Folder size was not the factor. That was the only `Command timed out` in ~4 weeks of retained macserver logs, the iCloud daemons were idle afterwards, and the unified log had nothing for the window. The first pass swallowed the first failure; the verify pass aborts on the first failed listing. A Blot wait over ~40s would have succeeded.
- Follow-up: line added to the root `TODO`.


### 2026-10-29 04:29:32 UTC resync request — iCloud replaced a fresh write with an empty cloud version (bug)

- Alert: one `ICLOUD_RESYNC_ISSUE` email (1 download), reason: an upload of a draft `.preview.html` failed after retries. Mac time is -0700, container green.
- Key events (UTC): 04:27:40 the owner pressed Rebuild; the rebuild held the folder lock until 04:35:35. 04:28:14 Blot wrote one draft preview to the Mac (the other previews were fine). 04:28:16 `brctl` showed a `Zero KB … not downloaded` cloud entry for it, then `server edit to download`. 04:28:23 the watcher's echo found the file not downloaded, ran `brctl download`, and got a 0-byte file. From then every echo upload differed from Blot's good copy, so it needed the lock and got 423 until the resync (first request 04:29:32, acknowledged 04:35:59). The resync, with iCloud as source of truth, downloaded the empty file over Blot's good copy.
- Cause: the macserver's `fs.outputFile` creates the file empty before the contents land (about 2s for this one). iCloud registered that empty file as a cloud version that won over the local write. The lock contention was only the symptom.
- Follow-up: fixed in the PR for this entry: `routes/upload.js` writes to a temp file on the same volume and renames it into place, then checks the size. The affected file stays empty on both sides until it is rewritten (re-save the draft or rebuild).

### 2026-10-29 15:00:00 UTC iCloud server down — transient quota failure reported as an outage (bug)

- Alert: one `ICLOUD_SERVER_DOWN` email for the 15:00 UTC (08:00:00 Mac, -0700) minutely `/stats` check. No recovery was needed: the 15:01 check passed. Mac up 57 days, pm2 process healthy.
- Key events (Mac time): 08:00:00 `GET /stats` answered, but `brctl.quota()` failed with a CloudKit `Network Failure` (NSURLErrorDomain -1005, "The network connection was lost"), so the reply carried `icloud_bytes_available: null`. 08:01:00 and every check after: normal. First quota error in the retained macserver error logs.
- Cause: not an outage. `monitorMacServerStats.check` throws "No stats returned" when `icloud_bytes_available` is falsy, and treats that as the server being down.
- Follow-up: fixed in the PR for this entry: a null quota is logged (`Mac server could not report iCloud quota`) and skips the quota checks; only a failed `/stats` or one without disk space counts as down.

### 2026-10-30 06:04:20 UTC iCloud server down — slow quota lookup blocked /stats (bug)

- Alert: one `ICLOUD_SERVER_DOWN` email for the minutely `/stats` check (23:04 Mac, -0700, on 29 Oct). Mac up 58 days, no error or restart, the next check (06:05:00 UTC) passed. Prod container logs not read (the read was declined).
- Key events (Mac time): 23:04:20 `GET /stats` arrived (the earlier tries of that check are not in the log). The `brctl` quota call hung until the macserver's own 30s exec timeout, killed at 23:04:50, and only then did `/stats` reply (quota null). Blot's fetch gives up after 3 tries of 10s, so the check had already failed. Every other minute that day was served. Second quota failure in the retained logs besides yesterday's CloudKit one (the 12-13 Oct "Unexpected iCloud Drive quota output" runs were different).
- Cause: `routes/stats.js` awaits `brctl.quota()` before replying, so a hung quota lookup (30s) makes the whole endpoint slower than Blot's 30s retry budget. The 29 Oct fix handled a quick null quota, not a slow one.
- Follow-up: fixed in the PR for this entry: `/stats` replies at once with the last known quota (null until the first lookup finishes) and refreshes it in the background, one lookup at a time.
