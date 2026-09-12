---
name: node-response-time-review
description: Analyze production Node.js app container response times to find slow-rendering sites, cross-checking against nginx queuing delay to rule out false positives (a site only looks slow because the event loop was blocked by a different, pathological site). Use when asked to look for slow sites, investigate response times, or re-run the node response time analysis.
---

# Node.js response time review → problem-site identification

Reproduces the workflow from issue #1825: aggregate per-domain render times
across the app containers, flag anything crossing the concern threshold, and
distinguish genuinely slow sites from sites merely queued behind one.

**Concern threshold: 150ms.** Any single render over 150ms is worth a look;
a site is worth flagging when a meaningful share of its requests exceed it,
or its *average* render time is elevated (avg >150ms means most requests
are slow, not just an occasional GC pause / cold cache).

This skill only **identifies** problem sites — it does not investigate root
causes (why a given site is slow) unless separately asked to.

## 1. Source of the technique

The `upstream` alias in `~/.bashrc` on the prod host (`ssh blot`) live-tails
`access.log` for `st=$upstream_response_time`:

```bash
alias upstream='tail -f /var/instance-ssd/logs/access.log | stdbuf -oL grep "st=[^-]" | stdbuf -oL awk "{print \$10, \$3, \$4, \$7}"'
```

That's a live view of nginx's *upstream* wait time — useful for watching
traffic in real time, but it conflates two different things: the app
actually being slow to render a site, vs. the app's single-threaded event
loop being busy with a *different* concurrent request when this one arrived
(queuing delay). At the ~15s nginx proxy timeout, both look identical from
nginx's side alone. So this skill goes one step further and cross-checks
against the app's own logged render time per request.

## 2. Get the data

SSH host is `blot`. **Always confirm with the user before running anything
against production**; stick to read-only commands.

nginx access log (for cross-checking / a broader traffic sample, and to see
504s / true timeouts that never got a completion line in the app log):

```bash
ssh blot "wc -l /var/instance-ssd/logs/access.log"
```

Log format (see `config/openresty/conf/http.conf` `log_format
access_log_format`): space-separated, `$7` = full URL, `$10` = `st=` value
(comma-separated if the request was retried across upstreams — sum the
parts). `st=-` means no upstream was contacted (pure cache hit) — skip
those lines. Exclude blot.im's own long-lived endpoints, which are
long-polling by design, not bugs:

```
^https://blot\.im/sites/[^/]+/status   (publish-status long poll)
^https://webhooks\.blot\.im/           (webhook delivery)
/draft/stream/                          (live preview SSE)
```

App container logs (the authoritative source for "did the app itself take
a long time to render this"). Check container uptime first — a recent
deploy/restart limits how far back `--since` can usefully go:

```bash
ssh blot "docker ps --format '{{.Names}}\t{{.Status}}'"
for c in blue green yellow; do
  ssh blot "docker logs --since 6h blot-container-$c 2>&1"
done > /tmp/app_logs_combined.txt
```

Completed-request lines look like:
`[12/Sep/2026:09:29:23 +0000] [yellow] <request-id> 200 0.013 https://www.example.com/path`
— fields: `$3`=`[color]`, `$4`=request id, `$5`=status, `$6`=render time
(seconds), `$7`=url. A request that hangs past nginx's timeout never gets
this line — instead you'll see `<request-id> Connection closed by client
<url>` once nginx gives up. That's itself a strong signal: search for it
directly (`grep "Connection closed by client"`) to catch sites whose worst
requests are too slow to even produce a normal timing line.

## 3. Aggregate per domain

```bash
awk '
{
  if ($3 ~ /^\[(blue|green|yellow)\]$/ && $5 ~ /^[0-9]+$/ && $6 ~ /^[0-9]+\.[0-9]+$/ && $7 ~ /^https?:\/\//) {
    t = $6 + 0; url = $7;
    n = split(url, u, "/"); domain = u[3];
    if (domain == "") next;
    count[domain]++; sum[domain] += t;
    if (t > max[domain]) max[domain] = t;
    if (t > 0.15) over150[domain]++;
    if (t > 1) over1s[domain]++;
  }
}
END {
  for (d in count)
    printf "%s\tcount=%d\tavg=%.4f\tmax=%.3f\tover150ms=%d\tover1s=%d\tpct150=%.1f\n",
      d, count[d], sum[d]/count[d], max[d], over150[d]+0, over1s[d]+0, (over150[d]+0)*100/count[d]
}' /tmp/app_logs_combined.txt > /tmp/app_domain_stats.txt
```

Rank by average render time and by `pct150` (share of requests over the
150ms bar), filtering out low-traffic domains (`count < 20` or so — too
noisy to draw conclusions from a handful of requests):

```bash
awk -F'\t' '{
  for(i=1;i<=NF;i++){split($i,kv,"="); v[kv[1]]=kv[2]}
  if (v["count"]+0 >= 20) print v["avg"], v["count"], v["pct150"]+0, v["max"], $1
}' /tmp/app_domain_stats.txt | sort -rn | head -40
```

## 4. Classify each candidate

For every domain that crosses the threshold, characterize *how* it's slow —
this determines severity and whether it's a false positive:

- **High avg AND high pct150 AND high max** (e.g. nashp.com: avg 3.8s, 75%
  >150ms, max 17s) → genuinely, severely slow. Real bug, high priority.
- **High pct150 but low max, avg well above 150ms but well below 1s** (e.g.
  chuckpearson.blog: avg 0.78s, 87% >150ms, max only 1.7s) → consistently
  *moderately* slow on nearly every request, not occasional spikes. Also
  real, but a different shape of problem (steady overhead vs. pathological
  worst case) — worth noting as such.
- **Moderate pct150, avg comfortably under 150ms** (e.g. karaman.is: avg
  0.44s pulled up by a handful of outliers, but most requests fast) →
  borderline; note it but don't treat as confirmed without a second look.
- **High nginx-level `st=` numbers but the SAME domain's app-log render
  times are almost all fast** (e.g. www.markwadley.com: nginx avg 3s / 25%
  >3s, but app-log avg 0.24s / 12% >150ms with no correlation) → **false
  positive**. The slowness measured at nginx is queuing delay from a
  different concurrent request blocking the event loop, not this site's
  own cost. Don't flag it as the site's problem.
- **No completed app-log lines at all, but nginx shows requests and/or
  `Connection closed by client` for the domain** (e.g. anchor.blot.im) →
  the app never finished rendering within the proxy timeout at all. This is
  a severe finding even with a tiny sample size — a single hang beyond 15s
  matters more than a moderate average.

Always sanity-check a top candidate against `TODO` in the repo root — some
slow sites are already known/tracked (e.g. "Fix performance issues with
nashp", "Fix issue with warwickmostyn").

## 5. Report

Don't file a new issue every run — this is a recurring check. Update the
existing tracking issue (currently
[#1825](https://github.com/davidmerfield/blot/issues/1825)) with the
current window's numbers via `gh issue edit` (replace body) or `gh issue
comment` (append), rather than creating a duplicate. Structure the update
as: threshold/method recap, confirmed slow sites (with the avg/pct150/max
numbers and the app-vs-nginx evidence), false positives ruled out, and
anything low-confidence that needs another pass. Keep root-cause
speculation out unless asked — this skill is about identification only.

Clean up scratch files on both ends when done:
`ssh blot "rm -f /tmp/app_logs_combined.txt"` and remove any local
`/tmp/app_domain_stats.txt` equivalents.
