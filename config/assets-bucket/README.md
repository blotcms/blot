# Assets bucket

Generated per-blog assets (thumbnails, the image cache, converter output,
bookmark screenshots, avatars, template uploads) are written to local disk
and, when a bucket is configured, to S3 as well. `app/storage/assets.js` is
the only code that touches either; `app/storage/README` explains the design.

Objects are keyed `{blogID}/{path}` at the bucket root, the same as the
asset's public CDN path (`https://cdn.blot.im/{blogID}/{path}`), so the CDN can
fetch `blog_*` straight from the bucket. The bucket allows public
`s3:GetObject` on `blog_*` keys and nothing else public: no listing, no
writes.

## Create the bucket and the app's IAM user

`setup.sh` is idempotent and uses whichever profile and credentials the `aws`
CLI finds:

```
export AWS_PROFILE=<profile> AWS_REGION=us-west-2
./config/assets-bucket/setup.sh --dry-run <bucket>   # prints each call, changes nothing
./config/assets-bucket/setup.sh <bucket>
```

It creates the bucket in us-west-2 (ACLs disabled, versioning off, public ACLs
blocked but a public bucket policy allowed), attaches the public-read policy
for `blog_*`, and creates the IAM user `blot-assets-app` (override with
`IAM_USER`) with an inline policy for `s3:PutObject`, `s3:GetObject` and
`s3:DeleteObject` on the objects and `s3:ListBucket` on the bucket. It does not
create an access key. Make one and keep it out of the repo:

```
aws iam create-access-key --user-name blot-assets-app
```

## Configure the app

Add these to the app host's environment file (the one passed to the containers
with `--env-file`; see `config/environment.sh` for the full list), then deploy:

| Variable | Value |
| --- | --- |
| `BLOT_ASSETS_BUCKET` | The bucket name. Empty (the default) keeps assets on local disk only. |
| `BLOT_ASSETS_REGION` | `us-west-2` (the default). |
| `BLOT_AWS_KEY`, `BLOT_AWS_SECRET` | The IAM user's access key. When unset, the AWS SDK's default credential chain is used. |
| `BLOT_ASSETS_READ` | `disk` (the default) or `s3`. Where reads look first; the other is the fallback. |
| `BLOT_ASSETS_ENDPOINT` | Only for a simulated S3 (MinIO) in development and tests. |

With a bucket set, every new asset is written to disk and uploaded, and
deletes remove both. While `BLOT_ASSETS_READ=disk`, a failed upload or delete
is logged and doesn't fail the operation; grep the app logs for
`[storage/assets] s3`. Once reads are `s3` a failure is an error, because
disk is no longer the copy to trust. Files which were already on disk before
the bucket was set aren't uploaded until the backfill.

## Backfill

`scripts/storage/backfill-assets.js` copies what is on disk into the bucket.
It lists the keys already in S3 for each blog, and uploads files which are
missing, whose size differs, or which are stale (changed on disk after the
object was written, such as an overwrite whose upload failed), so it is safe to
run repeatedly and to resume.
Run it on the app host inside a node container (the same image, environment
file and data directory as the app containers), for example:

```
docker exec <container> node scripts/storage/backfill-assets.js --dry-run
docker exec <container> node scripts/storage/backfill-assets.js
docker exec <container> node scripts/storage/backfill-assets.js --verify
```

| Option | |
| --- | --- |
| `--dry-run` | Report what would be uploaded. |
| `--verify` | Upload nothing; report, by directory, what is missing from the bucket, has a different size or is stale, and exit non-zero if anything is. |
| `--blog <blogID>` | Only this blog. |
| `--from <blogID>` | Start at this blog (inclusive), to resume a stopped run. |
| `--concurrency <n>` | Uploads at once (default 16). |

It prints a progress line every few seconds. Run `--dry-run`, then for real,
then `--verify` until it reports nothing missing; files written while the
backfill runs are uploaded by the app itself, and a later run catches any that
weren't. Both `--dry-run` and `--verify` also list keys that may not survive
being fetched through a plain URL (`+`, `%`, `#`, `?`, `\`, control
characters, spaces at the ends of a name, non-ASCII). Fetch each of those
through the public bucket URL and through the CDN before the flip (below).

## Flip reads to S3 and the CDN to the bucket

Only once `--verify` is clean:

1. Set `BLOT_ASSETS_READ=s3` and redeploy. Disk stays as the fallback, and
   writes still go to both.
2. In Bunny, on the pull zone for `cdn.blot.im`, add two edge rules with the
   same condition, URL matches `*/blog_*`:
   - Change Origin URL to `https://<bucket>.s3.us-west-2.amazonaws.com`. Check
     that the pull zone isn't forwarding the CDN's own host header to the
     origin; S3 needs the bucket's host.
   - Set Response Header `Access-Control-Allow-Origin: *`. The app's CORS
     header no longer applies to responses that don't come from it.

   Everything else on the CDN (`/template`, `/folder`, fonts, ...) still comes
   from the app.
3. Check images, a range request and one of the odd keys from the `--verify`
   list through `https://cdn.blot.im/...`.

To go back, remove the Bunny edge rules and set `BLOT_ASSETS_READ=disk`.

## Later

Back up the bucket (`_avatars` and `_template_assets` can't be regenerated)
before deleting anything on disk. Once reads and the CDN are on S3, the local
`data/static` copy can go and the data volume can shrink; see
`app/storage/README` §5 for the order.
