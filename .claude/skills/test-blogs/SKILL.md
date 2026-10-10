---
name: test-blogs
description: Write content into Blot's production test blogs (gittest, dbtest, drivetest, icloudtest - one per sync client) the way a real user would, wait for Blot to sync and build it, then verify it end to end - the published page, CDN and /_assets responses, the generated assets on production disk, and their copy in S3 once the assets bucket exists - and clean up. Use when asked to write to, exercise or test the production test blogs, to check a sync client (Git, Dropbox, Google Drive, iCloud) after a change or deploy, to verify a post, image, thumbnail, document conversion or generated asset end to end, to check the S3 migration of generated assets, or to smoke-test a read-only freeze or deploy with real syncs.
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

- Markdown post (`# Title` and a paragraph): fastest; exercises sync, build, render.
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
are blocking the shell from the cloud folder. Do not work around it: tell the
operator to grant the Claude app Full Disk Access (System Settings, Privacy &
Security) and restart Claude.

Git: the remote URL, with credentials, is the single line of
`data/test-blogs/gittest-remote` (gitignored; the operator creates it once).
If the file is missing, tell the operator to create it; never ask for
credentials in chat. Never print, log or echo the URL.

```
git clone "$(cat data/test-blogs/gittest-remote)" "$SCRATCH/gittest" >/dev/null 2>&1
cd "$SCRATCH/gittest"   # SCRATCH = session scratchpad, REPO = the repo root
# add skilltest-{ts}/..., then:
git add -A && git commit -qm "skilltest-{ts}"
git -c credential.helper= push -q "$(cat $REPO/data/test-blogs/gittest-remote)" HEAD 2>&1 | sed 's#https\?://[^ ]*#<remote>#g'
```

Redirect or redact all git output, since errors can echo the remote URL. Do
not run `git remote -v`, `git config --list` or `set -x`.

## Verification

1. **Public page.** Poll `https://{handle}.blot.im/{post-url}` (or the homepage,
   or `/search?q={ts}`) every few seconds with a timeout until the title appears.
   Typical: Dropbox/Drive seconds, iCloud tens of seconds to a minute or two,
   git immediate after the push. No result within a few minutes is a finding;
   check the sync client rather than waiting longer.
2. **Asset URLs.** From the HTML, extract CDN URLs (`https://cdn.blot.im/blog_.../...`)
   and blog-domain `/_assets/`, `/_image_cache/`, `/_thumbnails/` URLs. `curl -sI`
   each: status, `content-type`, `cache-control` (CDN assets are expected to
   be 200 with a long `max-age`). Compare with the S3 numbers below.
3. **Production disk and bucket**, one approved command (read-only, exits when done):
   `ssh blot docker exec blot-container-green node scripts/test-blogs/inspect.js <handle> [path-in-folder]`
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
   `disk=` is `storage/assets.exists`; the `s3=` part appears only when the
   assets bucket is configured and `storage/s3` exists (`s3=missing` is a
   failure then). The script only exists on production after the next deploy
   that includes it; before that, fall back to
   `ssh blot ls -la /var/www/blot/data/static/<blogID>/<subdir>/...`
   (blog ID from the `blog_...` segment of any CDN URL on the page).
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
