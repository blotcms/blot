# Storage bucket

Generated per-blog assets (thumbnails, the image cache, converter output,
bookmark screenshots, avatars, template uploads) live in one S3 bucket, and
nowhere else: there is no copy on the app host's disk. `app/storage/assets.js`
is the only code that touches them; `app/storage/README` explains the design.

Objects are keyed `{blogID}/{path}` at the bucket root, the same as the
asset's public CDN path (`https://cdn.blot.im/{blogID}/{path}`), so the CDN
fetches `blog_*` straight from the bucket. Assets are a blog's top-level `_`
directories (`{blogID}/_thumbnails/...`); the rest of `{blogID}/` is reserved
for later content, which the assets code never lists, backfills or deletes.
The blog's folder content lives under `{blogID}/folder/{path}`, public like the
rest of `blog_*` because the blog's own domain already serves those files. The
bucket allows public `s3:GetObject` on `blog_*` keys, which covers the assets
and the folder content, and nothing else public: no listing, no writes. The
exceptions are `.git` directories inside a folder and the Git client repos
under `{blogID}/git/` ([#2259](https://github.com/blotcms/blot/issues/2259)),
which the bucket policy denies to everyone outside the AWS account (see below).

Tools that need a local path (sharp, pandoc, puppeteer) write to a staging
directory under the app's tmp directory, `{tmp}/storage-assets-staging/
{blogID}/...`; `assets.commit()` uploads it and deletes what it uploaded. The
daily tmp prune removes staged files a week after they were last written.

## Git repositories: `{blogID}/git/`, and what is not public under `blog_*`

The git client's store (`app/clients/git/store`, [#2259](https://github.com/blotcms/blot/issues/2259))
keeps each blog's repository, its packs, `.idx` files and numbered manifests,
under `{blogID}/git/`, so everything of a blog sits under one prefix. Decided
on 3 Nov 2026, over a private top-level `git/{blogID}/`. It is the only copy
of a git blog's repository on Blot's side (the bare repositories on the app
host's disk are gone), and the bucket has no versioning, so a deleted pack is
gone: the store's daily verifier (`app/clients/git/served/maintenance.js`)
checks every git blog's copy, and repairing one takes a full clone.

A repository must not be public, though `blog_*` is. A blog's folder is
roughly what it publishes; its repository is every version of every file ever
pushed, including deleted drafts and secrets someone committed and later
removed. Blog IDs are in every CDN URL and manifests are numbered from 1, so
a public copy could be downloaded whole, through `cdn.blot.im` at Blot's
egress cost, and would get around the git password. So the bucket policy
**denies anonymous reads** of two things under `blog_*`:

- `{blogID}/git/*`, the repositories;
- `{blogID}/folder/*.git/*`, any `.git` directory in a blog's folder content,
  at any depth (a folder can hold a checkout of some other repository, whose
  `.git/config` can hold a token). The blog itself never serves a path with
  `/.git` in it (`app/blog/routes/assets.js`). `*` also matches a directory
  named like `notes.git/`, which errs towards private.

The Deny applies to every request from outside the AWS account
(`aws:PrincipalAccount` is not the account's ID), which is every public read,
including the CDN's pulls (Bunny fetches `blog_*` from the bucket without
credentials, and an unsigned request has no account, so it doesn't match),
and also a request signed with another account's credentials, which the
`Principal: "*"` Allow would otherwise let through. The app's IAM user and
anyone signed in to the account are not affected, so the Deny needs no list
of exempt principals. `setup.sh` reads the account ID with
`aws sts get-caller-identity`, so it stays out of this repository.
Policy wildcards match across `/`, so `blog_*/git/*` would
also match a folder's `photos/git/` directory; the 32 `?` match exactly a
blog ID (`blog_` and 32 hex characters, `app/models/blog/generateID.js`),
which pins the Deny to the blog's top level.

Why not the private top-level prefix:

- **Blot is public by default** ([privacy](https://blot.im/privacy)), and one
  prefix a blog is simpler to reason about, list and delete. A mistake in the
  Deny exposes repositories; that is an accepted risk, checked after every
  policy change (below).
- **The lifecycle rule doesn't need the prefix.** Lifecycle filters take a
  literal prefix, no wildcards, so nothing can target every `blog_*/git/`.
  The one rule there is, aborting incomplete multipart uploads, applies to
  the whole bucket instead. A cheaper storage class for packs alone would
  save a negligible amount at the store's size.
- **Leftovers are found once a month.** Removing a blog from git, or deleting
  it, deletes `{blogID}/git/` (again five minutes later, for work another
  process had started). The store's sweep for copies left behind lists each
  blog's `git/`, a listing per blog, so it runs on the first of the month,
  and each copy it deletes is in the alert email as a removal path to fix.

After changing the policy, check that an anonymous read of a git object is
refused, directly and through the CDN, and a signed one is not:

```
curl -sI https://<bucket>.s3.us-west-2.amazonaws.com/<blogID>/git/manifests/0000000001.json   # 403
curl -sI https://cdn.blot.im/<blogID>/git/manifests/0000000001.json                       # 403 or 404
aws s3api head-object --bucket <bucket> --key <blogID>/git/manifests/0000000001.json      # 200
```

The bucket has one lifecycle rule, `abort-incomplete-multipart`: a multipart
upload anywhere in the bucket (a git pack over 8 MiB, a large asset) still
incomplete after 3 days is aborted, so a failed upload's parts don't stay
billed. `setup.sh` puts it. The IAM policy above doesn't grant
`s3:AbortMultipartUpload`, so the store's own abort after a failed upload is
refused, and this rule is what cleans up.

## Create the bucket and the app's IAM user

`setup.sh` is idempotent and uses whichever profile and credentials the `aws`
CLI finds:

```
export AWS_PROFILE=<profile> AWS_REGION=us-west-2
./config/storage-bucket/setup.sh --dry-run <bucket>   # prints each call, changes nothing
./config/storage-bucket/setup.sh <bucket>
```

It creates the bucket in us-west-2 (ACLs disabled, versioning off, public ACLs
blocked but a public bucket policy allowed), attaches the public-read policy
for `blog_*`, and creates an IAM user named after the bucket, `blot-storage-app-<bucket>` (so
another environment's bucket gets its own user and policy; override with
`IAM_USER`, and give each bucket a different one), with an inline policy for `s3:PutObject`, `s3:GetObject` and
`s3:DeleteObject` on the objects and `s3:ListBucket` on the bucket. It does not
create an access key. Make one and keep it out of the repo:

```
aws iam create-access-key --user-name blot-storage-app-<bucket>
```

## Configure the app

Add these to the app host's environment file (the one passed to the containers
with `--env-file`; see `config/environment.sh` for the full list), then deploy:

| Variable | Value |
| --- | --- |
| `BLOT_STORAGE_BUCKET` | The bucket name. Required: the app refuses to start without it, and the deploy's container checks fail if it can't reach the bucket. |
| `BLOT_STORAGE_REGION` | `us-west-2` (the default). |
| `BLOT_AWS_KEY`, `BLOT_AWS_SECRET` | The IAM user's access key. When unset, the AWS SDK's default credential chain is used. |
| `BLOT_STORAGE_ENDPOINT` | Only for a simulated S3 (MinIO) in development and tests. |

A failed upload or delete is an error for the operation which asked for it (a
build fails, a dashboard upload shows an error); nothing is kept locally to
fall back on.

**Why a key and not an instance profile.** The containers can't reach the
host's instance credentials unless the metadata service's hop limit is raised
to 2, which the app host deliberately doesn't do:
a request forgery in the app could then read role credentials that can write
and delete the public bucket. A key scoped to this bucket gives the app the
same access without that exposure. See `app/storage/README` §3.

## Bunny (cdn.blot.im)

### Current pull zone (as of 10 Oct 2026)

Pull zone `blot-cdn`, hostnames `cdn.blot.im`, `cdn.blot.site` and the system
hostname `blot-cdn.b-cdn.net` (SSL on, Force SSL off). High-volume tier,
SafeHop on.

- **Origin.** Type Origin URL, `http://<origin IP>` (the app host's openresty); plain HTTP to the IP on purpose, to keep the origin hop as fast as possible.
  Host header `cdn.blot.im`, Forward host header off, Verify origin SSL off,
  Follow redirects off, no middleware.
- **Caching.** Smart Cache off, so every response is cached with the 1-year
  override (with it on, m4a, mov and octet-stream files were never cached);
  cache expiration overridden to 1 year; browser
  cache "match server"; query string sort on; vary cache by URL query string,
  limited to the `version` parameter (the only one CDN URLs use, as the
  fonts' cache-buster; no CDN route reads the query string, so other
  parameters only fragmented the cache); cache error responses on (errors
  held for 5 s); strip response cookies
  on; optimize for large object delivery on; stale cache while origin offline
  and while updating.
- **Perma-Cache** on, storage zone `blot-cdn-storage`. It serves any object it
  already holds without asking the origin.
- **Request coalescing** on, 30 s lock timeout.
- **Headers:** "Add CORS headers" on for `eot, ttf, woff, woff2, css, otf`
  (added whatever the origin); canonical headers off.
- **Optimizer** off and no token authentication or URL signing (everything on
  the CDN is public by design), so Bunny requests the origin with the plain
  path.
- **Edge rules**, in order:
  1. Block requests by bot User-Agent: img2dataset, Bytespider, AhrefsBot,
     ClaudeBot, bingbot.
  2. The same, for GPTBot, python-requests, AliyunSecBot, Go-http-client,
     Yandex.
  3. "Disable Cache For Support Testing": request header `support: true`
     overrides the cache time to 0 s.
  4-5. The storage bucket and CORS rules, described below.
  6. "Never cache health check": Override Cache Time 0 and Bypass Perma-Cache
     on `*://cdn.blot.im/health*`, because updown.io monitors that URL.
  7. "Block unknown paths on cdn blot im": Block Request (Bunny answers 403, the
     origin never sees it) for any `cdn.blot.im` URL not on an allowlist, so
     scanner probes (`/.env`, `/.git`, `/api`, ...) stop reaching Node. The
     allowlist mirrors `app/cdn/index.js` plus the top level of
     `app/blog/static`: `/`, `/health`, `/favicon.ico`, `/robots.txt`,
     `/fonts/`, `/icons/`, `/katex/`, `/plugins/`, `/syntax-highlighter/`,
     `/html2canvas.min.js`, `/layout.css`, `/documentation/v-`, `/folder/v-`,
     `/template/`, `/blog_`. **A new top-level path on the CDN must be added
     to this rule or Bunny will 403 it.** Bunny allows 5 patterns per
     condition, so the allowlist is split over several "match none"
     conditions; `*` matches across `/`, so every pattern names the host (a
     host-less `*/fonts/*` would let `/.env/fonts/x` through). Rollback: switch
     the rule off.

Large folder files and generated assets (`/_image_cache/`, `/_assets/`, ...)
requested on a blog host answer with a 302 to this CDN (see
`app/blog/routes/assets.js`), so their bytes leave through Bunny, not the app
host.

The `cdn.` server block in `proxy/config/server.conf` answers whatever Bunny
asks the app host for. It serves the app's global static files (fonts, icons,
KaTeX, plugins, documentation, ...) from disk and passes everything else
straight to node (no openresty cache), which serves `/folder/v-...`,
`/template/...`, the dashboard bundles and `/blog_*` (from the bucket). No
per-blog file comes from disk.

### Pointing `/blog_*` at the bucket

Object keys in the bucket equal the CDN path (`{blogID}/_thumbnails/...`), so
nothing is rewritten. Only `/blog_*` changes origin. Everything else
(`/fonts`, `/icons`, `/katex`, `/plugins`, `/documentation`, `/folder/v-...`,
`/template/...`, the dashboard bundles) stays on the app.

1. **Prerequisites.** `backfill-assets.js --verify` reports nothing missing or
   different (see below), and the app is writing to S3 with a failed upload
   failing the write (before this change has deployed: `BLOT_ASSETS_READ=s3`),
   so the CDN never has a missing object behind a successful build. After the
   change deploys there is no flag; S3 is the only store.
2. **Edge rule "Storage bucket for generated assets"**, two actions:
   **Override Origin URL** to
   `https://blot-storage-prod.s3.us-west-2.amazonaws.com` (HTTPS: the bucket
   name has no dots, so S3's wildcard certificate matches), and **Add Request
   Header** `Host` = `blot-storage-prod.s3.us-west-2.amazonaws.com` (step 4).
   Condition:
   Request URL matches any of

   ```
   *://cdn.blot.im/blog_*
   *://cdn.blot.site/blog_*
   *://blot-cdn.b-cdn.net/blog_*
   ```

   Anchor on the hostname. A bare `*/blog_*` also matches
   `/folder/v-.../blog_.../` and `/template/...` URLs, which must stay on the
   app.
3. **Edge rule for CORS**, same condition: Set Response Header
   `Access-Control-Allow-Origin: *`. openresty and node add it to every file
   today and S3 doesn't. Bunny's own CORS setting already covers fonts and
   CSS (so template-editor font uploads keep working without this rule); the
   rule keeps parity for everything else, e.g. images a template loads with
   `crossorigin`.
4. **Host header.** The pull zone forces `Host: cdn.blot.im` on origin
   requests, and Override Origin URL has no host field of its own. S3 would
   read `cdn.blot.im` as the bucket name and fail (`NoSuchBucket`, or a
   wrong-host error), so rule 2 also sets `Host` with Add Request Header (Bunny has no Set
   Request Header action; Add replaces the forced `Host`, confirmed on 15 Oct
   2026 by `x-amz-*` response headers on a 200). If that ever stops working:
   give the app origin its own DNS name (for example `origin-cdn.blot.im`
   pointing at the app host), add it to `server_name` in the `cdn.` server
   block of `proxy/config/server.conf`, set the pull zone's Origin URL to it
   and clear the Host header field. Every origin, app or bucket, then gets its
   own hostname as `Host`.
5. **Test before going live.** Add a second condition to rules 2 and 3,
   Request Header `X-Blot-Origin` equals `s3` (a header, not a query string:
   Perma-Cache may key on the path alone), and send it together with
   `support: true` (rule 3 above sets cache time 0). Use objects Bunny hasn't
   stored yet, since Perma-Cache answers for anything it holds: a fresh image
   post on a test blog (the `test-blogs` skill). Check:
   - 200, with the S3 copy's `Content-Type`,
     `Cache-Control: public, max-age=31536000, immutable` and
     `Access-Control-Allow-Origin: *`.
   - A missing key returns 403, not 404: the public policy has no
     `ListBucket`, so S3 doesn't say whether a key exists. Bunny holds error
     responses for only 5 s.
   - A sample of the odd keys `--verify` lists behaves as it does on the app
     origin today.
6. **Go live.** Remove the `X-Blot-Origin` condition from both rules. The
   effect is gradual: Perma-Cache keeps serving what it already stores, and
   only cache misses reach the bucket. Watch Bunny's origin error statistics
   for a day.
7. **Roll back.** Disable rules 2 and 3 (or put the test condition back).
   Misses go to the app again. Before this change deploys the app still has
   its disk and S3; after, it serves `/blog_*` from S3 itself.
8. **Nothing to purge.** The objects in the bucket are byte-identical to what
   the app served.

## Backup

Blog folders (`{blogID}/folder/`), Git repos (`{blogID}/git/`), `_avatars` and
`_template_assets` exist only here and can't be regenerated, and the bucket has
no versioning, so the bucket is to be copied to Backblaze B2: a daily
`rclone sync` of the whole bucket from the host, with rclone's native B2
backend, into its own prefix of the Redis offsite bucket, with a key which
can't delete and a lifecycle rule which keeps hidden and prior versions for 30
days (agreed in #2258, Phase E). It replaces the data volume's EBS snapshots,
and goes in place, with a test restore of one blog, before the data volume is
deleted. The `models/file` index is rebuilt from the bucket
(`scripts/storage/rebuild-file-index.js`), so it isn't backed up. Check the
backup before anything which could lose objects.

## Re-seeding from a local copy

`scripts/storage/backfill-assets.js` copies a local directory of `blog_*`
directories into the bucket: for restoring a backup into an empty or damaged
bucket, and it is how the assets first got here from the app host's disk. It
lists the keys already in S3 for each blog and uploads files which are missing,
whose size differs, or which are stale (changed on disk after the object was
written, such as an overwrite whose upload failed), so it is safe to run
repeatedly and to resume. Run it
where the directory is, with the app's environment (for example in a node
container from the same image with the directory mounted):

```
node scripts/storage/backfill-assets.js --source /restore/static --dry-run
node scripts/storage/backfill-assets.js --source /restore/static
node scripts/storage/backfill-assets.js --source /restore/static --verify
```

| Option | |
| --- | --- |
| `--source <dir>` | Required. The directory of `blog_*` directories to copy from. |
| `--dry-run` | Report what would be uploaded. |
| `--verify` | Upload nothing; report, by directory, what is missing from the bucket, has a different size or is stale, and exit non-zero if anything is. |
| `--blog <blogID>` | Only this blog. |
| `--from <blogID>` | Start at this blog (inclusive), to resume a stopped run. |
| `--concurrency <n>` | Uploads at once (default 16). |

It prints a progress line every few seconds. Run `--dry-run`, then for real,
then `--verify` until it reports nothing missing. Both `--dry-run` and
`--verify` also list keys that may not survive being fetched through a plain
URL (`+`, `%`, `#`, `?`, `\`, control characters, spaces at the ends of a
name, non-ASCII); fetch each through the public bucket URL and through the CDN.
