---
name: triage-sync-fix-repair
description: Triage a "sync/fix repaired <handle>" admin email ("Fix() found and repaired issues for blog_… (handle, client: …)"), sent whenever sync/fix (Fix()) changes anything for a blog. Works out from the report rows and, if needed, production logs whether the repair was expected housekeeping (e.g. expired deleted entries pruned from lists), the trace of a live edit, or evidence of a real bug that is corrupting blog state, then appends a short entry to this skill's incident log. Use when the user pastes or forwards one of these emails, or asks why Fix() repaired a blog.
---

# Triage a sync/fix repair email

## What the email means

`app/sync/fix/index.js` runs five checks in series against one blog's Redis
state and the blog's local folder. If any check returns rows, `notifyAdmin`
sends `app/helper/email/admin/SYNC_FIX_REPAIRED.txt` (first 10 rows per
check, `JSON.stringify`d) and bumps the blog's `cacheID`. Fix() doesn't hold
the folder lock and repairs as it goes, so the email reports what **was**
wrong; it's already been changed by the time you read it.

Fix() is called from:

- Dropbox hourly validation, minute 0, **green** (`app/clients/dropbox/init.js`,
  blogs with `last_sync` in the past hour, after the resync)
- iCloud validation (`app/clients/icloud/init.js`)
- Google Drive hourly fix, minute 30 (`app/clients/google-drive/hourlyFix.js`)
- Local client setup (`app/clients/local/setup.js`)
- Dashboard "rebuild"/fix of a site (`app/dashboard/site/client.js`)
- Template folder installs (`app/templates/folders/index.js`)

The `client:` in the email tells you which hourly job probably ran it. Each
check logs `Fix: <blogID> <check> duration=Nms`, so the email time gives you
the run: `grep 'Fix: <blogID>'` to find it.

**Fix() repairs often have benign, by-design causes.** Work out which of
those applies before you look for a bug.

## Reading the report: check by check

Row shapes come straight from each check's `report.push`.

### `entry-ghosts` (`["MISSING", {id, path}]`, `["CASE", {oldPath, path}]`)

Walks every entry (`Entries.each`, the `all` list) and checks its file
exists on disk (`localPath`), with case-insensitive fallbacks.

- `MISSING`: the entry isn't deleted but no file backs it, so it's
  `Entry.drop`ped. That means a sync missed a delete/rename, or the local
  folder was lost or reset. **Usually a real sync bug.** Check whether the
  path was renamed or moved recently (grep the path in green's logs).
- `CASE`: the file exists with different casing. Entry path rewritten.
  Common after case-only renames on Dropbox/macOS. Mostly benign, but if
  you see it repeatedly for one blog, case handling is broken.

### `list-ghosts` (`[list, "MISSING", id]`, `[list, "MISMATCH", id]`)

- `MISSING` rows come from `Entries.pruneMissing` (`app/models/entries/index.js`):
  a member of one of the lists `all, created, entries, drafts, scheduled,
  pages, deleted, entries:lex` has no `blog:<id>:entry:<id>` key.
  **Known benign cause: expired deleted entries.** `Entry.drop` doesn't
  delete an entry. It re-saves it with `deleted: true`, and
  `models/entry/set.js` puts a **24h TTL** on that key, while
  `_assign.js` keeps the id in `all` (and adds it to `deleted`). Once the
  key expires, the id lingers in `all`/`deleted` until the next Fix()
  prunes it. **Rows only in `all` and `deleted` for files the user deleted
  (or renamed away) more than 24h ago are this housekeeping, not
  corruption.** Expect roughly one `all` row plus one `deleted` row per
  deleted file, so the count is about 2× the number of files. Only the
  first 10 rows are quoted, and `all` is listed first, so `deleted` rows are
  often cut off.
  **Since `Entries.sweepExpiredDeleted` landed**, every entry save on the
  blog and the start of list-ghosts silently clear these ids using the
  `deleted` scores, so expired deleted entries should no longer appear in
  the email. If `MISSING` rows in `all`/`deleted` turn up after that
  deploy, a deleted entry's key disappeared before its 24h was up. That
  needs investigating.
  It becomes suspicious if a `MISSING` id is in `entries`, `drafts`,
  `pages`, `scheduled` or `created`, because live lists should never point
  at an absent key.
- `MISMATCH`: the key exists but the JSON's `id` ≠ the list member
  (an entry stored under the wrong key). It's re-saved under its real id
  and the stale member is removed. **Real corruption.** Find out how the
  entry got there (rename handling, path normalization).

### `tag-ghosts` (`["EMPTY TAG", tag]`, `["MISSING", id]`, `["MISMATCH", staleId, realId]`)

- `EMPTY TAG`: tag set with no members, deleted. Benign leftover.
- `MISSING`: a tag points at an entry key that doesn't exist. This is
  usually the same TTL expiry as above, when the deleted entry's tags
  weren't cleared. Check it against the `list-ghosts` rows.
- `MISMATCH`: same as list-ghosts `MISMATCH`. Real corruption.

### `menu-ghosts` (`["Delete", item]`, `["Delete duplicate", item]`, `["Changed label/metadata/URL of", item]`)

Syncs `blog.menu` page links with their entries. `Delete` = page entry now
deleted; `Changed …` = page title/URL changed. These are normal side-effects
of editing pages, unless the same item flips back and forth every run.
The row holds a reference to the menu item, which is mutated after the push,
so every row shows the **post-repair** values (a "Changed label of" row
already carries the new label and metadata). **Known benign cause: demo
template folders** (`client:` empty, handles from
`app/templates/folders/config.js`). On every app boot `setupBlogs.js` resets
the blog's menu to the bare config menu (no metadata, config labels), then
`folders/index.js` calls Fix(), which copies titles/metadata back from the
page entries. This sent the email after every deploy until `setupBlogs`
started keeping the entry-derived label/url/metadata from the existing menu;
if it recurs, check that merge.

### `entries-path-index` (`["MISMATCH", {entries, pathIndex}]`, `["BACKFILLED", n]`)

`entries:lex` cardinality ≠ `entries`, rebuilt. A small diff can be
a race with a sync writing entries mid-check. A persistent or large diff
means a code path updates `entries` without `pathIndex`.

## Method

1. **Read the incident log below first.** If you've seen the pattern
   before, say so and keep it short.
2. **Classify from the email alone where you can.** Group the rows by
   check and reason. Look at the file names and list names. Deleted-looking
   drafts or renamed duplicates (`… 1.md`, `Untitled.md`) that only appear
   in `all` point to TTL housekeeping.
3. **Confirm on production if the email isn't conclusive, or to settle a
   first-of-its-kind case.** **Ask the user before every production command,
   even read-only ones**, and stick to read-only commands. Host
   `blot`, containers `blot-container-{blue,green,yellow}`, helpers in
   remote `~/.bashrc` (see `investigate-production-container-restarts`).
   Use `docker logs blot-container-green --timestamps 2>&1 | …` so you can
   window by time. Logs disappear when a deploy recreates the container.
   - Find the Fix() run: `grep 'Fix: <blogID>'` (per-check `duration=` lines).
   - Find what happened to a reported path earlier: `grep '<blog12>' | grep -F '<path>'`.
     `models/entry/set.js` logs `<blog12> delete <path>` and
     `<blog12> update <path>`. A `delete` >24h before the Fix() run
     confirms TTL expiry. If a reported path doesn't appear at all, that
     still points to TTL expiry when the logs cover the 24h or so before
     the run. Sync lines (`sync_…`, `Removing`, `Downloading`)
     show renames and moves.
   - Read-only Redis check, if needed (ask first): `TTL`/`EXISTS
     blog:<id>:entry:<path>`, `ZSCORE blog:<id>:<list> <path>` to see
     which lists still hold an id.
4. **Classify** as one of:
   - **Expected housekeeping**: TTL-expired deleted entries, empty tags,
     menu label or URL updates after page edits. No bug. Consider
     whether the email should be filtered (see follow-ups).
   - **Race with a live edit**: the user changed files while Fix() ran.
     Converges on the next run.
   - **Sync bug**: entry-ghosts `MISSING`/`CASE` repeatedly, or a
     missed delete or rename. Cross-check with
     `investigate-dropbox-sync-issue` for Dropbox blogs.
   - **Data-model bug**: any `MISMATCH`, live-list `MISSING`, or
     persistent path-index drift. Find the write path that produced it.
5. **Report** to the user in chat (blog and path details are fine here):
   the checks, the cause, the evidence and whether code needs to change.
   Don't change code unless asked. If a fix is warranted, add a compact line
   to the root `TODO` or note it for a PR.
6. **Append an entry to the Incident log** (newest last), following the
   privacy rules. Keep it to about 5 lines. If you learned a better query
   or a new benign cause, update the check notes above as well.

## Incident log

Read this first. A repeated pattern changes the classification. Newest
entries last.

**Privacy: this file is committed to the repo, so entries must contain no
customer information.** Leave out blog IDs, handles, domains, file and folder
names or paths, post titles, and anything else that identifies a customer
or their content. Describe things generically ("several draft files deleted
over a day earlier"). Also leave out userbase or infra size numbers.

Include a **precise UTC timestamp** for the Fix() run (from the
`Fix: … duration=` lines), the container, the triggering caller (e.g.
Dropbox hourly validation) and any `sync_` IDs, so a future agent can
re-find it in the logs while they exist.

Entry template:

```
### <date> <HH:MM:SS> UTC Fix() run — <classification>
- Email: <checks and row counts / reasons>, client: <client>
- Key events (UTC, to the second): …
- Cause: …
- Follow-up: …
```

### 2026-10-05 06:01:59 UTC Fix() run — expected housekeeping (expired deleted entries)

- Email: list-ghosts, 30 rows, all `MISSING`. The quoted 10 were all in the
  `all` list and were draft files in the drafts folder, several of them
  numbered-duplicate copies. Client: dropbox (hourly validation, green).
- Key events (UTC): green was created 2026-10-04 14:06:11. Fix() ran for the
  blog at 03:01:28, 06:01:59 (list-ghosts `duration=1454ms`, noticeably
  slower than the other runs, which fits it being the run that pruned) and
  07:01:09. None of the reported paths appear anywhere in green's logs, so
  they were last touched before 14:06 the previous day. The user was busy
  renaming and deleting sibling drafts throughout (many `delete` lines),
  which will produce the same email again about 24h later.
- Cause: the drafts had
  been deleted or renamed away. `Entry.drop` keeps the deleted entry with a
  24h key TTL, but the id stays in `all`/`deleted`. After expiry,
  `pruneMissing` reports each one, which explains the 30 rows (about 15
  files × 2 lists). This was the first email of this kind, sent soon after
  the repair email was introduced (PR adding `SYNC_FIX_REPAIRED`).
- Follow-up: fixed in the PR adding `Entries.sweepExpiredDeleted` (option
  "use the `deleted` scores to clean up after the expiry"). Original notes:
  list-ghosts `MISSING` rows confined to `all`/`deleted` are
  expected. Suggest leaving them out of the email (or out of the report
  count used for `notifyAdmin`), and only alerting when a live list
  (`entries`, `drafts`, `pages`, `scheduled`, `created`) loses its key.
  Alternatively, remove deleted ids from `all`/`deleted` when the TTL is
  set, or let a scheduled sweep do the pruning instead of Fix().

### 2026-10-05 Fix() run — expected housekeeping (demo folder rebuild on boot)

- Email: menu-ghosts, 5 rows (4× `Changed metadata of`, 1× `Changed label of`),
  client: empty. No timestamp checked on prod; the code path fully explains it.
- Cause: a demo blog from `app/templates/folders`. `app/setup.js` builds the
  demo folders on every boot; `setupBlogs.js` writes the config `menu`
  (no `metadata`, one label differs from the page title) and
  `applyChanges` then runs Fix(), which restores metadata/labels from the
  page entries. A menu item whose id is a folder (no entry) is left alone.
- Follow-up: fixed by having `setupBlogs` keep each existing menu item's
  entry-derived label/url/metadata instead of resetting them from config
  (the email itself was left on, so real demo-blog repairs still surface).
