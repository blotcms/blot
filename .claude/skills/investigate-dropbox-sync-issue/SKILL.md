---
name: investigate-dropbox-sync-issue
description: Investigate a "Dropbox sync issue" alert email from Blot's hourly Dropbox sync validation (each flagged blog lists unsynced changes, Fix() repairs, errors and/or a stuck folder lock; the changes line is what this skill investigates. For Fix() repairs use `triage-sync-fix-repair`). Uses the production log helpers to work out whether the flagged blog had a genuinely missed/dropped webhook sync, a race with a live edit, or a real bug, then appends a short entry to this skill's incident log. Use when the user pastes or forwards one of these alerts, or asks to look into a Dropbox sync validation issue.
---

# Investigate a Dropbox sync issue alert

## What the alert means

`app/clients/dropbox/init.js` (`validateAllBlogs`) runs at minute 0 of every
hour in the **green** container. For each Dropbox blog with a `last_sync`
in the last hour it takes the folder lock, does a full resync of the folder
from Dropbox (`resetToBlotWithLock`), and counts how many files it had to
change. If the count is > 0 the blog goes in the email
(`app/helper/email/admin/DROPBOX_SYNC_ISSUE.txt`, built by
`app/clients/util/syncReport.js`, "N unsynced changes (downloaded, removed,
created dirs)") — meaning "a full listing
of Dropbox disagreed with Blot's copy, so the normal delta/webhook sync
missed something (or hadn't caught up yet)". After the resync it runs
`fixBlog` and a `catchUpSync`. The same email also lists a blog whose Fix()
repaired anything, whose walk / Fix() / catch-up sync threw ("error during
<phase>: …"), or whose folder lock is busy and has been held for over an hour
("folder lock held for Xh Ym - sync may be hung"; a hung sync inside a live
process, on whichever container holds it).

Changes made in Dropbox during the walk, or in the 30s before it, are not
counted: the walk logs `N change(s) were made in Dropbox during or just before
the walk`. Downloads are excused by `server_modified`. A removal or created
folder has no timestamp in a folder listing, so it is excused if Dropbox lists
it as changed since the pre-walk cursor, or, failing that, if its revision
history dates it: `files/list_revisions` gives a deleted file's
`server_deleted` (for a removed folder, one of the files that were in it), and a
created folder is dated by a recently modified file downloaded into it. So a
flagged change was made earlier than that, or had no date to check (an empty
removed folder, a failed lookup).

The email is sent right after the run finishes, so its timestamp ≈ the
`Sync validation complete checked=N issues=M` log line (email times are the
user's local time; **logs are UTC**). The email's two backtick commands are
the starting point:

```
logs green | grep "<first 12 chars of blog id> sync_"
access <handle>
```

**Always confirm with the user before running anything against production,
and stick to read-only commands** (see `investigate-production-container-restarts`
for the SSH host/architecture background: host `blot`, helpers in the
remote `~/.bashrc`, containers `blot-container-{blue,green,yellow}`).
Sync/validation logs are in **green** only.

## Method

Run everything as `ssh blot "docker logs blot-container-green --timestamps 2>&1 | …"`.
(`logs green` is a bashrc function and lacks `--timestamps`; use `docker logs`
directly so you can window by time.) Docker logs are lost when the container
is recreated by a deploy, so investigate promptly and say so if the window is
gone.

1. **Find the validation run that sent the alert.** The run's `issues=` is
   the number of blogs flagged.
   ```
   … | grep -i 'hourly sync validation\|Sync validation complete\|Error validating' | awk '$1>"<UTC day>T<hour-2>"'
   ```
   The run whose `complete` line is ~the email time and has `issues>=1` is
   yours. `Error validating sync for blog … 401/409` lines from *other* blogs
   in the same run are disconnected/revoked Dropbox accounts — noise, not
   related unless the flagged blog appears.
2. **Isolate the validation's own resync of the flagged blog.** It logs
   under a `sync_<id>` that immediately says `Syncing folder from Dropbox to
   Blot` followed by `(n/total) Checking /path …` lines. Filter the noise and
   keep only the actions:
   ```
   … | grep '<blog12>' | grep -v 'Checking /\|Delta' | awk '$1>"…" && $1<"…"'
   ```
   Look for `Removing /…`, `Downloading /…`, `Updating`, `Uploading` lines
   from the validation's `sync_` id — those *are* the "changes". Note the
   file(s) involved.
3. **Look at what happened to those file(s) just before.** grep the file
   name over the previous hour. Questions to answer:
   - Did a normal sync handle the file a few seconds/minutes earlier
     (`Fetched N changes` … `Finished sync`)? Was it a move/rename/draft
     toggle (`Removing from folder` + `Downloading <new path>` in the same sync)?
   - Did the total in `(n/total)` change mid-run (e.g. `n/T` then `m/T+1`)? A growing total means the user was editing Dropbox *while*
     validation walked the folder → race, not a missed webhook.
   - Was a webhook sync dropped? `Failed to acquire lock on folder` while
     validation held the lock is **by design** (the `catchUpSync` covers it).
     A removal or folder is excused if its deletion (or a file in it) is
     dated within 30s before the walk, so a flagged one was made earlier, or
     had no date to check (an empty folder, a failed lookup), or a webhook
     that lagged more than 30s is the likely cause.
   - Was a sync still running / stuck when validation started (`Starting sync`
     with no `Finished sync`)? Any slow steps (`Saving file in database`
     taking many seconds)?
   - Any `Error`, `Failed`, 401/409, `ETIMEDOUT`, container restart
     (`Scheduling hourly sync validation` appearing again = process restart)
     near the file's last change? Cross-check with the restart skill.
4. **Confirm convergence.** Look at the syncs right after (`Folder in sync
   with Dropbox`) and the next hourly runs (`issues=0` for that blog). If it
   stays flagged hour after hour, it's a real persistent divergence, not a race.
5. **Check request-level context if useful:** `access <handle>` /
   `req <pattern>` (bashrc helpers) for dashboard/webhook traffic around the
   time.
6. **Classify** as one of:
   - **Race with a live edit** — file moved/edited in Dropbox during the
     validation window, webhook sync dropped or not yet run, converged
     within seconds. Benign, expected occasionally.
   - **Missed/dropped webhook** — Dropbox changed with no corresponding
     `Starting sync` at all (webhook never arrived / process was down / listBlogs
     failed after the 200 ack — see root `TODO`). Real, needs follow-up.
   - **Sync bug** — a sync ran and finished but left Blot differing from
     Dropbox (rename/case/move handling, stuck lock, error mid-sync).
   - **Account/auth problem** — 401/409, revoked token, folder moved.
7. **Report** to the user in chat (identifying details are fine here, never in
   the committed log): blog/handle, run time (UTC + local), the file(s),
   the timeline, the classification and whether anything needs fixing. Don't
   change code unless asked; if a fix is warranted, add a compact line under
   "Improve Dropbox sync" in the root `TODO` (or note it for a PR).
8. **Append an entry to the Incident log below** (newest last), following
   the privacy rules there. Keep it to ~5 lines. Update the Method above if
   you learned a better query.

## Incident log

Read this first: a repeated pattern changes the classification. Newest
entries last.

**Privacy: this file is committed to the repo, so entries must contain no
customer information.** Do not write blog IDs, blog handles, domains, file
names, folder/file paths, post titles, or anything else that identifies a
customer or their content. Describe things generically ("a draft file was
moved out of and back into a drafts folder"). Also keep out userbase/infra
size numbers (e.g. how many blogs were checked).

Instead, give a **precise UTC timestamp** (to the second) for the validation
run start, the `complete` line and the key events, plus which container and
the `sync_` IDs involved (random per-sync tokens, not customer data). A future
agent can use those to re-find the incident in the logs (while the container's
logs still exist) without the entry itself exposing who or what it was about.

Entry template:

```
### <date> <HH:MM:SS> UTC validation run — <classification>
- Alert / trigger: …
- Key events (UTC, to the second): …
- Cause: …
- Follow-up: …
```

### 2026-09-19 19:00:00 UTC validation run — race with a live edit (benign)

- Alert: 1 change for 1 blog, sent after the run completed at 19:05:43 UTC
  (green container; run started 19:00:00).
- Key events (UTC): 19:02:17–19:02:23 a normal sync (`sync_aa1cebb`) applied
  a user moving a draft post file out of its drafts folder. 19:02:44.954
  validation (`sync_c79c5d9`) took the folder lock and began its full
  listing. While it walked, its running file total grew by one because
  the user had moved the file back into the drafts folder; validation
  removed the moved copy from Blot, downloaded the drafts copy and
  re-uploaded its preview file (the 1 "change"), finishing 19:03:14.714.
- The user's webhook sync (`sync_1d0485e`, 19:03:05.679) logged `Failed to
  acquire lock on folder` because validation held the lock — by design. The
  catch-up sync (`sync_43caa8d`, 19:03:14.002) re-fetched the same changes as
  a no-op. Blot matched Dropbox by 19:03:18; every later hourly run had
  `issues=0`.
- Cause: not a missed webhook. Validation counts any diff as an issue, even
  one a queued webhook sync would deliver seconds later, and the user was
  actively editing (syncs every few seconds that hour).
- Follow-up (not done): skip/defer blogs that synced within ~1 minute, or only
  alert if the diff persists on the next hourly run. Unrelated 401/409
  `Error validating` lines for other blogs appeared in the same run
  (revoked/moved Dropbox accounts).

### 2026-09-21 15:00:00 UTC validation run — race with a live edit (benign)

- Alert: 1 change for 1 blog, sent after the run completed at 15:08:49 UTC
  (green container; run started 15:00:00).
- Key events (UTC): 15:01:18 and 15:01:27 a normal sync (`sync_61eeebe`)
  applied two draft-toggle renames (file renamed with a leading underscore).
  15:01:41.629 validation (`sync_e6eb1b0`) took the folder lock; its running
  total grew 1614→1615→1616 mid-walk as the user kept editing. It removed one
  file and re-downloaded/saved another (the 1 "change"), finishing 15:03:11.617.
- The user's webhook sync (`sync_76144f8`, 15:02:12) logged `Failed to acquire
  lock on folder` (by design). Catch-up sync (`sync_d28563b`, 15:03:13) re-applied
  the same two changes (hash matched, no re-download); in sync by 15:03:17.
  Further edits synced normally (15:04:12, 15:04:36). Later hourly runs
  completed with `issues=0` (16:00, 17:00, 19:00).
- Cause: not a missed webhook; user editing during the validation walk.
- Follow-up: same as the 2026-09-19 entry (defer/skip recently-synced blogs).
  Separately, the 18:00 and 20:00 runs never logged `complete`: the process
  restarted (`Scheduling hourly sync validation` at 18:03:16 and 20:01:50), so
  those runs were cut short — worth checking with the restart skill.

### 2026-09-24 15:00:00 and 16:00:00 UTC validation runs — container crash (green), root-caused

- Trigger: the restart skill was asked to investigate why green's
  `RestartCount` had gone from 0 to 2; both restarts turned out to be
  `[LOCK COMPROMISED]` process crashes (by design, per `app/sync/README`)
  during the hourly validation run, not deploy activity.
- Key events (UTC): 15:00:00 run - a blog's folder lock (held by an
  unrelated, real-time webhook-triggered sync, not by validation itself)
  went compromised at 15:04:34, ~8s after validation's own walk finished for
  a *different* blog and moved into that blog's `fixBlog`/`Fix()` stage.
  16:00:00 run - same shape: a lock (held by a different unrelated live
  sync) went compromised at 16:01:08, ~13s into validation's `Fix()` stage
  for the blog with by far the longest walk of the run (repeated across
  both runs). Both crashes aborted their validation run mid-way (no
  `Sync validation complete` line either hour).
- Cause: `[LOCK] slow heartbeat` logging (added for exactly this
  investigation) showed `tickDelay≈0ms` with `roundTrip` up to 11s at crash
  time - ruling out event-loop blocking and matching Redis's own SLOWLOG
  staying clean (no single slow command). `Fix()`'s `entry-ghosts` check
  (and its four siblings) reads every entry of a blog with one sequential
  Redis round trip each, over the single shared connection
  (`app/models/client.js`) that the lock heartbeat also uses - a blog with
  several hundred posts going through `Fix()` is enough to starve an
  unrelated blog's heartbeat past its 10s TTL. The crashed blogs were not
  themselves unusually large; they were just live syncs unlucky enough to
  have a heartbeat due while `Fix()` was busy on someone else's Redis
  traffic.
- Follow-up: added `[LOCK] slow heartbeat`/`heartbeat error` roundTrip vs
  tickDelay logging (`app/sync/lock.js`), per-check timing in `Fix()`, an
  `entries=N` field on the `validation lag` log line, and a `runningFixCheck`
  field on `[LOCK COMPROMISED]` diagnostics (previously invisible there,
  since `Fix()` doesn't hold the folder lock) - see the PR for this entry.
  Also fixed `[LOCK COMPROMISED]`'s diagnostics logging, which was silently
  truncating `pendingSyncs`/`pendingUpdates` to `[Object]` via
  `console.error`'s default inspection depth. Not yet fixed: giving the lock
  heartbeat its own dedicated Redis connection so `Fix()` traffic can't
  queue ahead of it, or batching `Fix()`'s per-entry reads.

### 2026-09-27 11:00:00 UTC validation run — dropped webhook (real bug)

- Alert: 1 change for 1 blog; run complete at 11:01:46 UTC (green).
- Key events (UTC): the user was writing many small files into a template
  folder (one sync every ~10-60s). `sync_f20972f` did its last delta check at
  10:49:28.98, then spent until 10:49:34.64 building templates while it held
  the lock. A new file landed in Dropbox ~10:49:31; its webhook arrived
  10:49:33.49 (200 ack) but no sync started and no `Failed to acquire lock`
  was logged. No further edits, so nothing else triggered a sync until
  validation (`sync_634d20c`, 11:00:25) downloaded the file. Catch-up
  `sync_68fdba5` was a no-op.
- Cause: the webhook route skips blogs in its in-process `ongoingSyncs` set
  without logging or queueing a re-run. A change that arrives after a sync's
  final delta check but before it finishes is lost until the next webhook.
  Unlike the earlier race entries, it would not have converged on its own.
- Follow-up: fixed in the PR for this entry — the webhook route now logs
  `Webhook received mid-sync, queueing follow-up sync` and re-runs the sync
  once the current one finishes (`Running follow-up sync …`). Tip: grep `clients/dropbox/webhook` around
  the missed file's time to see webhooks that got no `Starting sync`.

### 2026-09-28 14:00:00 UTC validation run — race with a live edit (benign)

- Alert: 3 changes for 1 blog; run complete at 14:04:13 UTC (green).
- Key events (UTC): the user (apparently an automated browser tool writing
  scratch files into a hidden subfolder of a template folder) was syncing
  every ~15-60s. Normal syncs downloaded three such scratch files at
  13:57:50, 13:57:51 and 14:00:09 (`sync_46e5232`, `sync_78b1f38`).
  Validation (`sync_ea6b9ea`) took the lock at 14:00:58.715; the files were
  deleted in Dropbox right after, and the 14:01:06 webhook's sync
  (`sync_42cc4ca`) logged `Failed to acquire lock on folder` (by design).
  Validation reached them at 14:01:25 and removed all three (the 3
  "changes"). The walk total stayed fixed (895) because deletions don't grow it.
- Catch-up `sync_e2a148e` (14:01:39) fetched the same 3 deletions as a
  no-op, and it was in sync by 14:01:43. Every later hourly run had `issues=0`.
- Cause: not a missed webhook. The deletions landed during the validation walk.
- Follow-up: this is the third race of this kind. A lock can't prevent it
  (validation already holds it, and it can't freeze Dropbox), and downloads
  were already excused by `server_modified` plus a 30s grace, but removals and
  new folders have no timestamp. Fixed in the PR for this entry: after the walk,
  `resetToBlot` lists what Dropbox changed since its pre-walk cursor and
  doesn't count those changes (`changedDuringWalk`; it logs `N change(s) were
  made in Dropbox during the walk`).

### 2026-10-08 15:00:00 UTC validation run — race with a live edit (benign)

- Alert: 1 removal for 1 blog; run complete at 15:02:38 UTC (green).
- Key events (UTC): the user's tooling was rewriting files in a template folder
  (syncs every few seconds, many `Webhook received mid-sync`). Last normal sync
  `sync_d8a98e7` finished in sync at 14:59:59. A generated cache directory was
  deleted in Dropbox shortly before validation `sync_0f8a25a` took the lock and
  fetched its pre-walk cursor at 15:01:09.48. That change's webhook arrived
  15:01:10.2. Its sync (`sync_116b8ad`) and the follow-up (`sync_3ea890d`) both hit
  `Failed to acquire lock` (by design). Validation removed the directory at
  15:01:29. Catch-up `sync_b933cb4` (15:01:43) fetched 0 changes. The 14:00 run
  was clean.
- Cause: the deletion landed just *before* the pre-walk cursor, so
  `changedDuringWalk` (added 2026-09-28) didn't excuse it. Dropbox's webhook lag
  is about 1s, so this edge remains.
- Follow-up: fixed in the PR for this entry. Removals that would still be
  counted are dated through `files/list_revisions` (a removed folder via the
  files that were in it) and excused if deleted within the 30s grace before
  the walk; a created folder is excused if a file downloaded into it was
  modified within the grace. An empty folder, or a failed lookup, is still counted.
  Tip: use `sync_` ids, not webhook lines, to tell which webhooks were for this
  blog. Webhook POSTs are shared across all Dropbox accounts.
