---
name: data-volume
description: Grow or shrink the EBS volume that holds the app host's data directory (/var/www/blot/data), with config/host/data-volume/resize.sh (grow in place; shrink by live rsync passes, a brief read-only freeze and a mount swap the running containers follow without a restart), release and detach the old volume afterwards with `resize.sh finish`, or rehearse the whole flow on a throwaway instance with drill.sh. Holds the guardrails (ask before every production command, drill first, tear down only by explicit ID), what to expect at production scale, and an incident log. Use when asked to resize, grow or shrink the data volume, free disk on the app host by moving to a smaller or larger volume, detach or delete the old data volume, run a data-volume drill, or use the app's read-only freeze (scripts/read-only.js).
---

# Data volume

The app host's data directory (`/var/www/blot/data`: blog folders, generated
assets, git repos) is one XFS-formatted EBS volume. It is mounted by
`mount-data-volume.service` by its volume ID (`/etc/blot/data-volume`, checked
against the `.blot-data-volume` marker at the volume's root), shared, and the
app containers bind it with `bind-propagation=rslave` (config/host/README.md).

`config/host/data-volume/README.md` explains the scripts and every step. This
skill does not repeat it: it holds the rules, what to expect, and the log.

Related: `scripts/read-only.js` (the app's read-only freeze, also usable on
its own), `redis-host` (the same style of operation for the Redis host).

## Rules

1. **Ask the operator before every production command**: `resize.sh` (even
   `--dry-run`: it copies host.sh to the host), `ssh blot`, `docker exec`,
   `read-only.js on/off`. State the exact command. Read-only AWS `describe-*`
   and CloudWatch calls (`--profile blot --region us-west-2`) are fine without
   asking; say what you ran.
2. **Let the operator run `resize.sh` in their own terminal.** It asks yes/no
   at each step and the "Freeze now?" moment is theirs to choose; `--yes`
   would skip it. Watch from the side (CloudWatch, plain HTTP requests) and
   read what they paste.
3. **Drill before changing anything on the freeze, copy or swap path.**
   `drill.sh launch/setup` on a throwaway from production's AMI, then
   `resize.sh --host drill …`. Keep a subagent away from production
   mechanically: an ssh config passed with `-F` (so the `blot` alias does not
   resolve) and `--host drill` on every call.
4. **Tear down only by explicit ID**, re-checking `BlotDrill=true` on each
   resource immediately before deleting it, and never anything that is the
   app host or its volumes. Show the operator the list and get a yes first.
5. **Never delete the old volume or its pre-resize snapshot without the
   operator.** They are the rollback for about a week after a shrink.
6. **No freeze within 10 minutes of 01:00 and 05:00 UTC** (host cron and the
   scheduler delete files then; the script refuses).
7. **After `finish` released an old volume on the host, deploy the app before
   the next resize.** The release breaks the running containers' link to host
   mounts until they are recreated (README, "After it").
8. Public repo: volume and snapshot IDs are fine in commits; no account IDs,
   key names or ssh details, and sizes only as percentages here.

## What to expect at production scale

- Pass 1 (everything) runs for hours at roughly 100-120 MB/s, the site fully
  live; the instance's EBS byte burst balance drains a few percent per five
  minutes during it and refills afterwards. Watch `EBSByteBalance%` on the
  instance and read latency on the old volume; stopping the copy
  (`ssh blot sudo bash /tmp/blot-data-volume/host.sh stop-copy`) and
  re-running later loses nothing.
- Pass 2 (nothing changed) is a metadata walk of both trees: minutes with a
  cold cache.
- The frozen pass runs in parallel shards and takes about a minute; the whole
  read-only window (grace, lock drain, remount, copy, snapshot call, swap) is
  about two minutes. Blogs and the dashboard keep serving; writes get 503s,
  syncs wait and catch up within seconds of the freeze lifting, iCloud's retry
  within about 20s.
- Afterwards: `npm run deploy-proxy` (its `data/static` bind does not follow a
  swap) and an app deploy; then `resize.sh finish` releases the old volume on
  the host without a reboot and detaches it.

## Incident log

Newest last. Times in UTC.

```
### <date> — <operation>
- What / why: …
- Timings: …
- Problems: …
- Follow-up: …
```

### 2026-10-09 — first shrink (gp2 to a smaller gp3 volume)

- What / why: the data volume was about half used and on gp2; shrunk to a gp3
  volume at about 70% used after the copy (logs/ and tmp/ contents not
  copied), roughly 40% cheaper. PRs #2099 (read-only freeze), #2100 (mount by
  ID, rslave), #2101 (Sync paused), #2102 (scripts), #2103 (finish releases on
  the host).
- Drill first (AL2, kernel 5.10): it found that systemd 219 rejects the copy
  unit's properties (every live pass would have failed to start) and that
  `docker exec` fails on paused containers; both fixed before production.
- Timings: pass 1 1h49m, pass 2 4m46s, frozen copy 1m11s over ~3,100 shards,
  read-only window 2m00s, ending 18:12:50 (swap 18:12:48).
  EBS byte burst balance bottomed out around 45%; old-volume read latency
  about 1 ms during the copy.
- Afterwards: proxy and app deploys; the host still held the old volume under
  the new one, released by hand without a reboot (umount, umount,
  mount-data-volume.sh; containers unaffected), then `finish` detached it.
  That sequence is now `host.sh release-old`, offered by `finish`.
- Follow-up: delete the old volume and its snapshot from 16 Oct (TODO).
