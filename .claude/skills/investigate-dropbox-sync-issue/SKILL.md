---
name: investigate-dropbox-sync-issue
description: Investigate a "Dropbox sync issue" alert email from Blot's hourly Dropbox sync validation ("detected previously unsynced changes from Dropbox for the following sites"). Uses the production log helpers to work out whether the flagged blog had a genuinely missed/dropped webhook sync, a race with a live edit, or a real bug, then appends a short entry to this skill's incident log. Use when the user pastes or forwards one of these alerts, or asks to look into a Dropbox sync validation issue.
---

# Investigate a Dropbox sync issue alert

## What the alert means

`app/clients/dropbox/init.js` (`validateAllBlogs`) runs at minute 0 of every
hour in the **green** container. For each Dropbox blog with a `last_sync`
in the last hour it takes the folder lock, does a full resync of the folder
from Dropbox (`resetToBlotWithLock`), and counts how many files it had to
change. If the count is > 0 the blog goes in the email
(`app/helper/email/admin/DROPBOX_SYNC_ISSUE.txt`) — meaning "a full listing
of Dropbox disagreed with Blot's copy, so the normal delta/webhook sync
missed something (or hadn't caught up yet)". After the resync it runs
`fixBlog` and a `catchUpSync`.

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
