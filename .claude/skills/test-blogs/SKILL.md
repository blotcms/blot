---
name: test-blogs
description: Write content into Blot's production test blogs (gittest, dbtest, drivetest, icloudtest - one per sync client) the way a real user would, wait for Blot to sync and build it, then verify it end to end - the published page, CDN and /_assets responses, the generated assets on production disk, and their copy in S3 once the storage bucket exists - and clean up. Use when asked to write to, exercise or test the production test blogs, to check a sync client (Git, Dropbox, Google Drive, iCloud) after a change or deploy, to verify a post, image, thumbnail, document conversion or generated asset end to end, to check the S3 migration of generated assets, or to smoke-test a read-only freeze or deploy with real syncs.
---

# Test blogs

Four production blogs, one per sync client, at `https://{handle}.blot.im`:

| handle | client | write content by |
| --- | --- | --- |
| `dbtest` | Dropbox | copying files into `~/Library/CloudStorage/Dropbox/Apps/Blogs/dbtest/` |
| `drivetest` | Google Drive | copying into `~/Library/CloudStorage/GoogleDrive-*/My Drive/Sites/drivetest/` (glob the account part) |
| `icloudtest` | iCloud | copying into `~/Library/Mobile Documents/com~apple~CloudDocs/Sites/Test/` |
| `gittest` | Git | clone, commit, push (below) |

Related: `investigate-dropbox-sync-issue`, `investigate-macserver-sync-issue`,
`data-volume` (read-only freeze). Design of the asset move: `app/storage/README`,
`app/storage/assets.js`.

## Rules

1. **Ask the operator before every production command**: `ssh blot`,
   `ssh macserver`, `docker exec`. State the exact command; approval covers
   that command only. List the planned commands together so they can be
   approved in one go. If the harness blocks a prod read, do not retry or
   rephrase: give the operator the command to run and paste back.
2. **Only write to these four blogs' folders/repos.** Never touch any other blog.
3. Writing into the four synced folders and pushing to gittest need no
   per-action approval once the operator has invoked this skill (they are
   their own test blogs), but say what you are writing and where.
4. Public repo: no credentials, account IDs, email addresses or ssh details
   here or in `scripts/test-blogs/`, and no production sizes or counts.
5. Read-only AWS calls (`AWS_PROFILE=blot AWS_REGION=us-west-2 aws s3api head-object ...`)
   are fine without asking; say what you ran.
6. Hand mechanical polling and verification (curl loops, header checks) to a
   cheaper subagent (sonnet/haiku) when it helps; judge the results yourself.
7. End every run by appending an entry to the run log below.

## Test content

Names must be unique and recognisable: prefix everything `skilltest-{unix timestamp}`
(e.g. `skilltest-1760000000/post.md`) so cleanup is a glob. Keep it small and
write only what the question needs:

- Markdown post: fastest; exercises sync, build, render. Put `Title: Skilltest {ts}`
  and `Link: skilltest-{ts}` metadata lines at the top so the post is at a
  known URL, `/skilltest-{ts}`.
- Post with a JPEG/PNG (from anywhere on disk, copied in beside the post and
  referenced `![alt](photo.jpg)`): exercises `_image_cache` and `_thumbnails`
  (thumbnails need the image in the post body or a `Thumbnail:` metadata line).
- `.docx` / `.odt` / `.epub`: exercises the converters and `_assets`.
- A second file edit or a delete + re-add: exercises update/removal paths.

Use one blog for a quick check; all four when checking the sync clients or a
deploy. Always note which blog(s) and file names you used for the log.

## Writing

Dropbox, Drive, iCloud: `mkdir -p` a `skilltest-{ts}` folder in the blog's
folder above and copy the files in.

If a copy fails with "Operation not permitted", macOS privacy controls (TCC)
are blocking the shell from the cloud folder. Do not work around it. The
process macOS holds responsible is not Claude.app but the Claude Code binary
it bundles (a `disclaimer` helper starts it), at a versioned path; find it
with `ps -o pid=,ppid=,comm= -p <pid>` up the chain from `$$`, e.g.
`~/Library/Application Support/Claude/claude-code/<version>/<hash>/claude.app`.
Ask the operator to add that `claude.app` under System Settings → Privacy &
Security → Full Disk Access (⌘⇧G to paste the path) and restart Claude. The
grant follows the version, so it needs redoing after a Claude Code update.

Git: the remote URL, with credentials, is the single line of
`~/.config/blot/test-blogs/gittest-remote` (mode 600, outside every checkout so
any worktree's session finds it; the email in the URL is written `%40`). The
operator creates it once.
If the file is missing, tell the operator to create it; never ask for
credentials in chat. Never print, log or echo the URL.

```
R=~/.config/blot/test-blogs/gittest-remote
git clone -q "$(cat $R)" "$SCRATCH/gittest" >/dev/null 2>&1   # SCRATCH = session scratchpad
cd "$SCRATCH/gittest"
# add skilltest-{ts}/..., then:
git add -A && git -c user.name=skilltest -c user.email=skilltest@localhost commit -qm "skilltest-{ts}"
git -c credential.helper= push -q "$(cat $R)" HEAD 2>&1 | sed -E 's#https?://[^ ]*#<remote>#g'
git ls-remote "$(cat $R)" HEAD 2>&1 | sed -E 's#https?://[^ ]*#<remote>#g' | cut -c1-12   # matches `git rev-parse HEAD`?
```

Redirect or redact all git output, since errors can echo the remote URL. Do
not run `git remote -v`, `git config --list` or `set -x`.

## Verification

1. **Public page.** Poll `https://{handle}.blot.im/{post-url}` (or the homepage,
   or `/search?q={ts}`) every few seconds with a timeout until the title appears.
   Seen 10 Oct 2026: Dropbox ~6s, iCloud ~8s, Drive ~20s, git within
   seconds of the push (removals similar). No result within a few minutes is a finding;
   check the sync client rather than waiting longer.
2. **Asset URLs.** From the HTML, extract CDN URLs (`https://cdn.blot.im/blog_.../...`)
   and blog-domain `/_assets/`, `/_image_cache/`, `/_thumbnails/` URLs. `curl -sI`
   each: status, `content-type`, `cache-control` (CDN assets are expected to
   be 200 with a long `max-age`). Compare with the S3 numbers below.
3. **Production disk and bucket**, one approved command (read-only, exits when done):
   `ssh blot docker exec blot-green node scripts/test-blogs/inspect.js <handle> [path-in-folder]`
   The path is the file's path in the blog folder, e.g. `skilltest-1760000000/post.md`;
   without one it takes the most recent entries (`-n N`, default 3). Output:
   ```
   blog blog_<id> handle=dbtest client=dropbox s3=not configured
   entry /skilltest-1760000000/post.md url=/skilltest-post updated=2026-10-10T12:00:00.000Z deleted=false draft=false
     thumb small https://cdn.blot.im/blog_<id>/_thumbnails/<uuid>/small.jpg
     asset via=cdn disk=yes  _thumbnails/<uuid>/small.jpg
     asset via=blog disk=missing  _assets/<uuid>/post.docx
   (with a bucket configured, each asset line also carries:)
     asset via=cdn disk=yes  s3=yes 18342B image/jpeg cache-control="public, max-age=31536000"  _image_cache/<uuid>/photo.jpg
   ```
   `disk=` is `storage/assets.exists`, which since #2111 asks the bucket
   (there is no `data/static` any more), so it agrees with `s3=`; either
   being `missing` is a failure. The blog ID is the `blog_...` segment of any
   CDN URL on the page.
4. **S3 from the Mac** (once the bucket exists). Ask the operator for the
   bucket name; do not read the production env file:
   `AWS_PROFILE=blot AWS_REGION=us-west-2 aws s3api head-object --bucket <bucket> --key <blogID>/<relPath>`
   Keys are the CDN path (`{blogID}/_image_cache/...`). Check ContentType and
   CacheControl against the curl headers from step 2.
5. Report per blog: appeared after N seconds; each asset's HTTP status, disk,
   S3; anything odd.

## Cleanup

Delete the `skilltest-{ts}` folder(s) from each folder (or `git rm -r` and
push for gittest) and poll until the post is gone from the public site. Generated
assets are not deleted when an entry is deleted (by design); expected, not a
finding. Delete the scratchpad clone too.

## Run log

Newest last. Add one dated entry per run.

```
### <date> — <what was tested>
- Blogs / content: …
- Result: …
- Odd: …
```

### 2026-10-10 — first run: image post on all four blogs (after PR #2109)
- Blogs / content: `skilltest-1791618418/post.md` + `photo.png` (a 1024×768 PNG) on dbtest, drivetest, icloudtest, gittest.
- Result: live after dbtest 6s, icloudtest 8s, drivetest 20s, gittest <15s. Each post's `_image_cache` image and `large` thumbnail returned 200 `image/png` `max-age=31536000` from cdn.blot.im. `ls` on prod found the cached image and all four thumbnail sizes in `data/static/<blogID>/`. Cleanup: gone after 5-28s.
- Odd: TCC needed Full Disk Access on the bundled, versioned Claude Code `claude.app`, not Claude.app. The zsh shell has no `PIPESTATUS`, so push success is checked with `ls-remote`. `inspect.js` is not deployed yet, so verification used the `ls` fallback.

### 2026-10-15 — image post served by Bunny straight from S3 (edge rules live)
- Blogs / content: `skilltest-1792053452/post.md` + `photo.png` (492×507 PNG) on gittest.
- Result: live after ~3s. The `_image_cache` image and `large` thumbnail returned 200 `image/png`, `public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`, with `x-amz-request-id` and `perma-cache: MISS` / `cdn-cache: MISS` on first fetch, so Bunny pulled them from the bucket. `head-object` matched (uploaded 10s before the fetch). The proxy access log had no line for either asset. Cleanup: gone after ~3s.
- Odd: none.

### 2026-10-31 — cache purge after an edit, following the move to loopback (#2277)
- Blogs / content: one `post.md`, then an edit, on gittest and dbtest; the same on icloudtest.
- Result: gittest live after 1s, and with the page cached, the edit showed after 3s. dbtest live after 8s, edit after 8s. Cleanup: gittest gone after 1s. icloudtest had not synced after more than 10 minutes, which the operator says is normal iCloud slowness, so the iCloud lock fix (`31dc193e0`) is unverified.
- Odd: a delete in a `bash -c` script is stopped by Claude Code's safety check, so the dbtest and icloudtest folders were left for the operator to delete. A 404 from a post that never went live looks the same as a successful removal, so check it was live first.

### 2026-11-01 — git client after #2309, #2317 and #2258 Phase A
- Blogs / content: `skilltest-1793543864/post.md` + `photo.png` (a small PNG) on gittest, on `0acc301c6`.
- Result: live after 14s. The `_image_cache` image and `large` thumbnail returned 200 `image/png` with a long `max-age` from cdn.blot.im, and `inspect.js` found every asset on `disk=yes s3=yes`. Folder routes behaved: an uppercased path found the file by case, a missing file and `/100%25` gave 404, and the app stayed up. Cleanup: gone after 2s.
- Odd: 14s is slower than the 1-3s of earlier gittest runs; this post had an image and it was the first push after a deploy, and one run can't say more. `/wp-admin/...` returned no HTTP status (curl 000), which is the proxy's scanner block, not the app.

### 2026-11-01 — request readers, dashboard and models moved onto storage/folder (#2328, #2331, #2332)
- Blogs / content: `skilltest-1793558985/` on gittest and dbtest, on `7dabccdbc`: `post.md`, `photo.png`, `big.png` (over 256 KB), `small.txt`, `a b.txt`, `Mixed.txt`, `_hidden.html`, `site/index.html`.
- Result: live after gittest 15s, dbtest 38s; edit after 1s and 9s; gone 9-10s after removal. Small files, a name with a space, a wrong-case URL and the `_name.html` fallback all 200. `big.png` gave a 302 to `/folder/v-…` with a stable token, then 200 from the CDN, 206 for a range and 416 for an unsatisfiable one. A directory under `/folder/v-…` gave 301 to its trailing slash, then 200. `inspect.js` found every asset on disk and in S3.
- Dashboard, on dbtest in the built-in browser (already signed in): name, date and size sorts and paging; download, with 404 for a missing file and a dotfile; upload with a dry run, then remove; a zip export holding `blog.json`, `folder/`, `static/` and `templates/`; a copy of Blog moved to the folder; an edit to its `style.css` in Dropbox, picked up after 9s; and deleting the copy.
- Odd: a blog whose root names are all lowercase gets `templates/`, though the dashboard says `Templates/`. Writes and deletes from the server took minutes to reach Dropbox on the Mac, and a delete had not arrived after 6 minutes, so the Mac copy is not a good check of a server-side change. A cleanup `rm` with a shell variable in the path is stopped by the safety check; use a literal absolute path. Bunny answers a `..%2f` path with its own 403, before the origin.

### 2026-11-01 — sync core and build moved onto storage/folder (#2335, #2336)
- Blogs / content: `skilltest-1793565243/` on gittest, dbtest, drivetest and icloudtest, on `bec642fc2`: `post.md`, `photo.png`, `other.md`, `wiki.md` (a wikilink and a wrong-case image), `doc.docx`, `multi+/a.md` and `b.md`. Then `real.docx` on gittest.
- Result: post live after gittest 13s, dbtest 20s, drivetest 27s; folder post after 15s, 21s, 36s; edit after 1s, 9s, 13s. Wikilinks resolved, and the wrong-case image reached `_image_cache`. `real.docx` went through pandoc with its image processed. `inspect.js` showed the post on all three.
- Odd: on gittest the folder post stayed live after its files were removed, because Git reports only the files, not the folder: #2342. On drivetest the image can arrive after the post, so the first build has no `_image_cache` until the rebuild. `empty.docx` has no page, so use a fixture with text. Skipped icloudtest at the operator's request after it had not synced within about 8 minutes.

### 2026-11-01 — git client after native receive (#2327) and the materializer (#2329)
- Blogs / content: `skilltest-1793557573/post.md` and a non-ASCII name in a folder with a space, on gittest, on `f12cfad6a`.
- Result: add, edit, rename and delete each showed within 1s of the push. A push to another branch was refused with Blot's message, not `HTTP 400`, and made no ref. Cleanup: gone after 1s. Public pages only: `inspect.js` was not run.
- Odd: none.

### 2026-11-02 — Blot's own writes as plumbing on the bare repo (#2333), after the host cycle
- Blogs / content: `skilltest-1793606175/post.md` and a non-ASCII name in a folder with a space, then a draft at `skilltest-1793606217/drafts/post.md`, on gittest, on `4a505d627`.
- Result: add, edit, rename and delete each showed within 1s, and a branch push was refused with Blot's message and made no ref. The draft made Blot commit `drafts/post.md.preview.html` 2s after the push, on top of the push, with the usual identity and "Updated ..." message; a pull brought it, and `git fsck --strict` passed. Cleanup of both left nothing.
- Odd: the redaction `sed 's#https\?://...'` is GNU syntax and does nothing in macOS's sed, so remote URLs were never redacted; switched to `sed -E 's#https?://...'`. Git strips the credentials from the URLs it prints, so nothing secret was shown.
