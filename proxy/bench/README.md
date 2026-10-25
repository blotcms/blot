# Proxy cache benchmark

Compares cache hit throughput, proxy CPU per request and the cost of a fill
for the two blog cache implementations: nginx `proxy_cache` (the baseline,
the `proxy/` of `BASE_REF`, default `origin/master`) and the disk cache in
`config/diskcache.lua` (the `proxy/` of the working tree: hits are served with
sendfile, and a stored brotli-11 copy is made by worker 0 after an entry's
first hit). Neither has a stored gzip copy: gzip-only clients are compressed
on the fly (level 5) by both.

```sh
bash proxy/bench/run.sh                 # builds both images, writes results.md
SKIP_BUILD=1 bash proxy/bench/run.sh    # reuse blot-proxy:bench-* images
BASE_REF=some-tag bash proxy/bench/run.sh   # another baseline
ONLY='fill' bash proxy/bench/run.sh     # only the cases whose name matches
DURATION=30s CONNS=64 THREADS=4 PROXY_CPUS=2 bash proxy/bench/run.sh
```

`run.sh` needs `mustache` and `fs-extra` for the config generator (from
`NODE_PATH` or any `node_modules` above the current directory); the baseline
is exported with `git archive` into a temporary directory and rendered with
its own `proxy/build` and `proxy/config`.

`stub.js` is the upstream (seeded, so identical content every run): `/page`
(~60 KB HTML), `/large` (~2 MB HTML), `/image.jpg` (200 KB random). One proxy
runs at a time, limited with `--cpus`; wrk runs in a separate container.

Cases:

- Hit cases: a URL is requested twice (miss, then hit), then the disk cache
  run waits for the brotli copies of `/page` and `/large` to exist and for 65s
  (see below) before timing, so the timed window serves what a long-cached
  page is served. The brotli-11 compression therefore happens during
  warm-up, outside the timed window, and is **not** in the CPU figure. The
  CPU per request of a hit is the proxy container's cgroup `usage_usec` delta
  divided by requests completed, so it covers only serving.
- Fill cases (`fill ...`): wrk appends a counter to the URL, so every request
  is a miss that Node (the stub) answers and the proxy stores. `identity`
  isolates the cost of fetching and storing; `br+gzip` adds the on-the-fly
  compression of the response that both implementations do on a miss. The
  `stub cores` column shows what the upstream cost. No brotli-11 copies are
  made (nothing is hit twice).
- Brotli-11 cost: `brotli -q 11` (and `-q 4`, the on-the-fly
  `brotli_comp_level`) of the 60 KB and 2 MB pages, CPU time (user + system)
  of five runs in the proxy container. This is what worker 0 pays once per
  entry that is read twice (niced, so serving wins when the CPU is busy), and
  it comes on top of the fill cost. It is the CPU the "hit" figure leaves out.

Caveats:

- Per-host rate limiting (`hostlimit`, burst 30) cannot be whitelisted and a
  single `blog.test` would hit it at ~30k req/s, so `run.sh` deletes those
  `limit_req` lines from the generated `openresty.conf` before `docker build`.
  `proxy/config` is untouched. Per-IP limits are bypassed by whitelisting the
  private ranges over `cdn-ips.default.conf`.
- Docker Desktop's VM may have fewer CPUs than `PROXY_CPUS` (then all of them
  are used) and wrk, the proxy, the stub and Redis share them. Check the
  `wrk cores` column: a client near the VM's CPU count is the bottleneck. The
  VM also shares the Mac with whatever else is running (other containers,
  builds), which moves single rows by tens of percent between runs: read the
  ratios and the order of magnitude, not the absolute figures.
- Check the `non-2xx` column and the "Response checks" section: every hit
  case should be a HIT with the expected Content-Encoding, every fill case a
  MISS.
- Why the 65s wait: each nginx worker keeps its own `open_file_cache`
  (`open_file_cache_errors on`, valid 60s), so a worker that served an entry
  before its `.br` existed keeps compressing it on the fly until the entry is
  revalidated, up to 60s. Without the wait the disk cache rows served the
  on-the-fly brotli instead of the stored copy (`large br+gzip` 30 req/s
  instead of ~5000). `run.sh` checks 200 new connections are all served from
  the stored copy. In production the same delay applies to a page hit again
  within a minute of its first hit.

## Reading `Socket errors: timeout N`

wrk counts a request as a timeout when it has been outstanding for more than 2
seconds. Cases that really are that slow (`large br+gzip` and the large
fills on proxy_cache: 1.5s p50, compressing 2 MB per request on one CPU)
produce them in any number. A hit row with a healthy latency distribution and
exactly `-c` timeouts (64) is something else: every connection had one
request outstanding when something stalled the whole stack for 2s or more.
That was reproduced by `docker pause`-ing the proxy container for 2.5s in the
middle of a 20s `page identity` run on the disk cache: 19k req/s, p99 and
max latency normal, `timeout 64`. wrk's latency histogram does not include the
timed-out requests, which is why p99 stays flat. It was not the compressor
(running a 2 MB brotli-11 during a run slows the on-the-fly path but produced
no timeouts), the client closing connections (`keepalive_requests` would be a
`read` error, not a timeout), or requests in flight at the end (wrk does not
count those). The stall is the Docker VM or the Mac, on a 1-CPU VM that
shares the machine with other containers and builds; the earlier disk cache
rows (`page identity`, `large br+gzip`, 64 each) had that signature, and did
not recur in repeated 20s and 30s runs once the machine was quiet. If a row
shows a multiple of `-c`, rerun it with `ONLY='<case>'`.
