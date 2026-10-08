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
even a resync request. The daily full resync (`resyncAllConnected`) and the
startup resync stay unscheduled. The other active checks are
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
- prod: `ssh blot`, containers `blot-container-{blue,green,yellow}` (see
  `investigate-production-container-restarts`). Macserver HTTP requests can
  land on any container, so grep all three. Docker logs are lost when a
  deploy recreates a container, so if the alert is older than the
  container's `CreatedAt` the server side is gone — say so.
- macserver lines are prefixed with `clfdate()` (local time on the Mac);
  docker `--timestamps` are UTC. Note the offset when you line them up.

## Method

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
   ssh blot "for c in blue green yellow; do echo == \$c; docker logs blot-container-\$c --timestamps 2>&1 | grep '<blog12>' | tail -150; done"
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
