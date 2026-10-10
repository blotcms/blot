# Storage bucket

Generated per-blog assets (thumbnails, the image cache, converter output,
bookmark screenshots, avatars, template uploads) live in one S3 bucket, and
nowhere else: there is no copy on the app host's disk. `app/storage/assets.js`
is the only code that touches them; `app/storage/README` explains the design.

Objects are keyed `{blogID}/{path}` at the bucket root, the same as the
asset's public CDN path (`https://cdn.blot.im/{blogID}/{path}`), so the CDN
fetches `blog_*` straight from the bucket. The bucket allows public
`s3:GetObject` on `blog_*` keys and nothing else public: no listing, no
writes.

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

## Bunny

On the pull zone for `cdn.blot.im`, two edge rules with the same condition,
URL matches `*/blog_*`:

- Change Origin URL to `https://<bucket>.s3.us-west-2.amazonaws.com`. Check
  that the pull zone isn't forwarding the CDN's own host header to the origin;
  S3 needs the bucket's host.
- Set Response Header `Access-Control-Allow-Origin: *`. The app's CORS header
  doesn't apply to responses that don't come from it.

Everything else on the CDN (`/template`, `/folder`, fonts, ...) still comes
from the app, which also serves `/blog_*` itself (from the bucket) to blog
domains and to anything that reaches it before the CDN does. Without the
rules, the CDN would fetch `blog_*` through the app: slower, but it works.

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
