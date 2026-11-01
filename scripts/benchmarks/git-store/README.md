# Git store spike harness

The measurements behind the Phase 2 spike of [#2259](https://github.com/blotcms/blot/issues/2259): can a git repository live in S3 as immutable packs and a small manifest, be read only by byte ranges, and still serve a clone, a fetch, a push and a materialize with a 1 GB local cache?

It runs the store's foundation (`app/clients/git/store/`) against MinIO behind toxiproxy, counts every request and byte the store asks of S3, and checks what comes out with real `git`. It uses no AWS at all. **Nothing here is production code**: the clone streamer, push handler, tree diff and the like are throwaway ports of the earlier prototype, kept in this directory so the real versions can come in later PRs. The only thing from `app/clients/git/store/` it needs is the foundation itself.

## What is here

| File | |
|---|---|
| `docker-compose.yml`, `toxiproxy.json` | MinIO and toxiproxy, pinned as in `scripts/development/docker-compose.yml` and `.github/actions/start-minio`, with their own project name, ports (19000 MinIO, 19100 MinIO through toxiproxy, 18474 toxiproxy's API) and data directory. They cannot touch the development stack or `data/`. |
| `lib/profiles.js` | The network profiles (`direct`, `s3-standard`, `express-one-zone`), each with its assumptions written beside it. They are estimates. |
| `lib/generate.js`, `lib/gitobj.js` | A deterministic generator of synthetic repositories, written straight into packs and indexes. |
| `lib/counting.js` | Counts requests and bytes, by operation, in the store wrapper and in the SDK (every attempt, retries included). |
| `lib/manifests.js` | The foundation's `manifest.read` and `manifest.swap`, with the harness's lock. |
| `lib/clone.js`, `lib/fetch.js`, `lib/ops.js`, `lib/prefetch.js` | The operations: ref advertisement, streaming clone and fetch, push, materialize, Blot's one-file commit. |
| `lib/server.js` | One repository's operations over HTTP, in its own process so peak memory is the server's alone. |
| `lib/*suites.js`, `lib/failure.js`, `lib/idxbench.js`, `lib/growth.js`, `run.js` | The measurements and their driver. |
| `selftest.js` | Checks the generator and the clone streamer against real `git`, with no MinIO. |
| `report.js` | Turns the results into markdown tables. |

## Running it

Needs Docker, `git`, and Node (the repository's version) with `@aws-sdk/client-s3` installed. Use `GIT_STORE_SPIKE_WORK` for a directory with room (the large repository is about 2.5 GB in MinIO, and a verification clone needs the same again; the runner stops if free space falls below 3 GiB).

```sh
cd scripts/benchmarks/git-store
export GIT_STORE_SPIKE_DATA=/path/with/room/minio     # MinIO's data
export GIT_STORE_SPIKE_WORK=/path/with/room/work      # scratch, results, caches
docker compose up -d                                   # MinIO and toxiproxy
cd ../../..

node scripts/benchmarks/git-store/selftest.js          # the harness against real git

# build the repositories (the large one takes about 2 minutes)
node scripts/benchmarks/git-store/run.js generate large
node scripts/benchmarks/git-store/run.js generate blog              # a typical blog after compaction
node scripts/benchmarks/git-store/run.js generate blogUncompacted blogu   # one pack per commit

# measurements; each appends to $GIT_STORE_SPIKE_WORK/results.jsonl
node scripts/benchmarks/git-store/run.js reads blog --verify      # advertise, clone, fetch, materialize
node scripts/benchmarks/git-store/run.js reads large
node scripts/benchmarks/git-store/run.js push blog
node scripts/benchmarks/git-store/run.js commit blog
node scripts/benchmarks/git-store/run.js commit300
node scripts/benchmarks/git-store/run.js index
node scripts/benchmarks/git-store/run.js growth
node scripts/benchmarks/git-store/run.js failure

node scripts/benchmarks/git-store/report.js

docker compose -f scripts/benchmarks/git-store/docker-compose.yml down -v
rm -rf "$GIT_STORE_SPIKE_DATA" "$GIT_STORE_SPIKE_WORK"
```

`--profiles direct,s3-standard` limits a run to some profiles. `reads <repo>` compares materialize with `git diff-tree` in a reference built from a real clone (for `large`, make the reference during the one real verification clone, as described in "The large repository" below).

### The large repository

`generate large` writes about 2.4 GB of packs: 45 packs (four large ones, then many small pushes), about 415,000 objects, 40,000 commits, delta chains up to 50 deep, and the same object in two packs where a push's thin-pack bases were appended. Packs are uploaded as they are built and deleted locally, so the disk holds at most one pack plus MinIO's copy. The seed is fixed, so the same command gives the same bytes.

The full-size repository is checked once with real git: clone it with `transfer.fsckObjects`, run `git fsck --strict`, and take `git diff-tree` references for the materialize pairs. The clone is deleted straight afterwards; a small partial clone (blobs under 200 KB, sparse to `posts/` and `templates/`, depth 50) is kept to push from, so a real git client builds real thin packs against a repository it could not otherwise hold.

### Things that went wrong on the way

- Run it with the repository's Node (24). The foundation's cache uses `zlib.crc32`, which older Node (21) lacks; there `put` fails inside a `catch` and stores nothing, with no error, so a "warm" run is quietly memory-only.
- MinIO refuses writes when the drive it sits on has less than about 1% of its total free (about 4.6 GB on a 460 GB disk), whatever you ask of it. A 2.4 GB repository needs about 7 GB free to start.
- The AWS SDK's `requestTimeout` only logs a warning unless the client is made with `throwOnRequestTimeout: true`. The harness sets it; a host must.

## How it measures

- **Cold** is a new server process with an empty cache. **Warm** is the next run in the same process. The cache is capped at 1 GB; a run reports how much of it was used.
- **Requests** are HTTP requests to the endpoint as the SDK sends them, retries included. The harness also counts what the store code asked for (reads, HEADs, puts), by operation and whether it was an index or a pack.
- **Time** under a profile is real time against MinIO with toxiproxy's latency and bandwidth. It includes this machine's CPU, which is one core in Docker's VM and shared by the client, the server and MinIO. Read request and byte counts as results; read times as an upper bound on a machine which is not CPU-starved, except where a time is dominated by waiting for round trips.
- **Memory** is the server process's resident set, sampled every 25 ms, and includes about 60 MB for Node and the SDK before it does anything.
- Latency is added on the downstream side only, so a request pays it once.

## Manifests

A read is the hint (one GET), a HEAD of the next number (normally a miss), then a GET of the manifest, which is immutable and so is kept after the first. A swap is four HEADs (the packs it names are uploaded, the base is the newest, the next number is free), one conditional PUT and one PUT of the hint, so a warm one-file commit of Blot's is 10 requests. The first numbers taken with this harness modelled the manifest layer before the foundation had it, and counted a swap as the conditional PUT and the hint PUT alone.
