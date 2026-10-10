# Storage bucket

Generated per-blog assets (thumbnails, the image cache, converter output,
bookmark screenshots, avatars, template uploads) live in one S3 bucket, and
nowhere else: there is no copy on the app host's disk. `app/storage/assets.js`
is the only code that touches them; `app/storage/README` explains the design.

Objects are keyed `{blogID}/{path}` at the bucket root, the same as the
asset's public CDN path (`https://cdn.blot.im/{blogID}/{path}`), so the CDN
fetches `blog_*` straight from the bucket. Assets are a blog's top-level `_`
directories (`{blogID}/_thumbnails/...`); the rest of `{blogID}/` is reserved
for later content (`folder/` for the blog's folder, possibly `git/`), which the
assets code never lists, backfills or deletes. The bucket allows public
`s3:GetObject` on `blog_*` keys, which covers all of it because blog content is
public by design, and nothing else public: no listing, no writes.

Tools that need a local path (sharp, pandoc, puppeteer) write to a staging
directory under the app's tmp directory, `{tmp}/storage-assets-staging/
{blogID}/...`; `assets.commit()` uploads it and deletes what it uploaded. The
daily tmp prune removes staged files a week after they were last written.

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
to 2, which the app host deliberately doesn't do (`config/airlock/README.md`):
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
- **Caching.** Smart Cache on; cache expiration overridden to 1 year; browser
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
   name has no dots, so S3's wildcard certificate matches), and **Set Request
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
   wrong-host error), so rule 2 also sets `Host` with Set Request Header, the
   way Bunny's direct-IP-origin guide does. Confirm it in the test. If Bunny
   still sends `cdn.blot.im`:
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

`_avatars` and `_template_assets` exist only here and can't be regenerated, so
the bucket is backed up hourly to Backblaze B2 (see `app/storage/README` §3).
Check that backup before anything which could lose objects.

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
