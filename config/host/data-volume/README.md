# Resizing the data volume

Operator scripts, run from the Mac over ssh, to grow or shrink the EBS volume
mounted at `/var/www/blot/data` on the app host. EBS volumes cannot shrink, so
a shrink builds a new smaller volume, copies the data across and swaps it in
with a short read-only window for the app. Nothing here is used by the app.

| File | What it does |
| --- | --- |
| `resize.sh` | `status`, `grow <GiB>`, `shrink <GiB>`, `finish` (see the usage at the top of the file). |
| `host.sh` | Runs on the host as root; `resize.sh` copies it to `/tmp/blot-data-volume/` and calls it. |
| `drill.sh` | Launch, set up and tear down a throwaway instance to rehearse on. |
| `lib.sh` | Helpers shared by the two Mac-side scripts. |

Needs the AWS CLI with SSO (`aws sso login --profile blot`) and the ssh alias
`blot`. Both scripts take `--dry-run`: every check runs, every step is printed,
nothing changes.

## Before the first shrink

A shrink depends on three things being deployed:

- the read-only freeze (`scripts/read-only.js`, run in an app container),
- the `rslave` bind of the data directory in the app containers, and the
  shared host mount (`config/host/scripts/mount-data-volume.sh`),
- `/etc/blot/data-volume` and the `.blot-data-volume` marker on the host
  (`config/host/deploy.sh` writes them).

`resize.sh shrink` checks all of it and stops with what to deploy if it is
missing. It also refuses a new size that would leave the volume more than 85%
full.

## Shrink, and why each step

`resize.sh shrink <GiB> [--type gp3] [--iops N] [--throughput MiBps]`, every
phase confirmed unless `--yes`:

1. **New volume.** Created in the instance's zone with the same encryption,
   tagged `Name=Blot data (copy in progress)` and
   `BlotDataVolumeResizeFrom=<old id>`, attached at the first free device name.
2. **Prepare.** `host.sh prepare` formats it (XFS, label `blotdata`) and mounts
   it at `/mnt/blot-data-staging/new`, writes the `.blot-data-volume` marker
   with its own ID, and records the resize in
   `/etc/blot/data-volume-resize.state`. The staging directory is a private
   mount of itself: `mount --move` cannot move a mount that sits under a shared
   one.
3. **Live passes.** rsync from the data directory to the new volume while the
   app keeps running, as a transient systemd unit (`blot-data-copy-p1`, ...)
   so it survives the ssh session. The first pass takes hours; each later one
   copies only what changed and is shorter. Ctrl-C the script whenever you
   like; re-running the same command attaches to the unit. Passes stop once one
   takes `--max-final-seconds` or less (default 60, which a tree this size
   will probably not reach; `--max-final-seconds 600` is a more useful target),
   or after five, when you are asked whether to go on. The contents of `logs/`
   and `tmp/` are not copied (the directories are), and the new volume keeps its
   own marker.
4. **Freeze, final copy, swap.** Never within 10 minutes of 01:00 or 05:00 UTC
   (host cron and the app scheduler delete files then) unless `--any-time`.
   - `read-only.js on --ttl 900`: the app refuses dashboard and client writes
     and `sync()` waits before taking a folder lock. The TTL is a dead-man
     switch: if the script dies the freeze lapses by itself (`--freeze-ttl`).
   - Wait `--grace` seconds (15), then until no folder lock is held (up to
     `--lock-wait`). The freeze only gates new requests, so requests already in
     flight (a dashboard save, a git push) finish in the grace period.
   - `mount -o remount,ro` on the data directory, retried for 30 seconds. It
     fails with EBUSY while anything has a file open for writing, so success is
     the proof that nothing is writing, which the app-level freeze cannot give.
     The containers see the volume read-only too (same filesystem).
   - Final copy: the same rsync, now with a source that cannot change, split
     into one rsync per child of `static/`, `blogs/` and `git/` run eight at a
     time, plus a top-level pass and a non-recursive pass per parent so
     deletions are carried across. This is what the window pays for; the metadata
     walk of millions of files is what is slow, and it parallelises. Any rsync
     failure aborts, including "files vanished" (exit 24), which is only
     tolerated in the live passes.
   - Snapshot of the old volume (not waited for), tagged
     `BlotDataVolumeResizeFrom`.
   - `host.sh swap`: writes the new ID to `/etc/blot/data-volume` (previous in
     `.previous`), `mount --move`s the new volume over the data directory,
     makes it shared, and checks the marker on the host and inside every
     `blot-container-*`. The containers bind the directory with `rslave`, so
     they see the new volume at once, without a restart. On any mismatch it
     unmounts the new volume and restores the old ID.
   - `read-only.js off`. The script prints how long the window lasted.

   If anything fails, or you press Ctrl-C, between the freeze and the swap, the
   script remounts the old volume read-write, lifts the freeze and says what
   state things are in. Outside this step Ctrl-C needs no undo.
5. **Retag.** The new volume becomes `Name=Blot /var/www/blot/data` (the tag
   the DLM snapshot policy targets); the old one becomes
   `Name=Blot data (replaced by <new id>)` with `BlotDataVolumeReplacedAt`.

After it:

- Redeploy the proxy (`npm run deploy-proxy`). It bind-mounts only
  `data/static` and does not follow the swap, so until then it serves the old
  volume; files it misses fall through to Node, so nothing breaks.
- The next app deploy recreates the containers on the new volume.
- The old volume stays mounted underneath the new one, read-only, in every
  mount namespace until the containers are recreated and the host reboots, so
  it cannot be detached right away. Then `resize.sh finish` checks it is no
  longer mounted anywhere and detaches it. It never deletes anything.

## Grow

`resize.sh grow <GiB>`: `modify-volume` (same type, IOPS and throughput), wait
for `optimizing`, then `xfs_growfs`. It is online and needs no freeze. AWS
allows one modification per volume every 6 hours; the error is passed on
clearly.

## Drill first

`drill.sh` rehearses the whole thing on an Amazon Linux 2 arm64 instance, the
production kernel, without touching production:

    drill.sh launch --ami <id> --subnet <id> --security-group <id> --key-name <name>
    drill.sh --key <pem> setup ec2-user@<ip>
    # then the commands setup prints: resize.sh --host ... shrink 6, grow 10
    drill.sh teardown <instance-id>

`setup` fills a small data volume with tens of thousands of files and runs
reader and writer containers (named `blot-container-*`, `rslave` binds) and a
proxy container that binds only `data/static`. The drill host is marked by
`/etc/blot/drill`, so `resize.sh` pauses the containers instead of calling
`read-only.js`, and tags the new volume `BlotDrill=true` and names it
`drill-data-volume` (never the production tag, or DLM would snapshot it).
`setup` takes `mount-data-volume.{sh,service}` from this checkout, or from
`origin/claude/data-volume-mount` until that is merged. `teardown` refuses an
instance that is not tagged `BlotDrill=true` and deletes volumes and snapshots
one by one by ID, re-checking each tag first.

## Resuming and rollback

Re-run the same `shrink` command to resume: the host's state file, the
`blot-data-copy-*` units and the `BlotDataVolumeResizeFrom` tag say how far it
got. A finished pass older than half an hour does not count (the difference
has grown since), so a new one starts. `resize.sh status` shows the host, the
volume, any resize in progress and each pass.

- Before the swap, rollback is automatic (above), and the old volume was never
  written to by the copy.
- After the swap, the old volume (still tagged, still attached) and the
  snapshot taken just before are the rollback. Keep both for about a week, then
  delete them by hand.

## Cost

- gp3 includes 3000 IOPS and 125 MiB/s; extra throughput costs little, extra
  IOPS more. A gp2 volume of this size has a similar baseline, so a gp3 volume
  of the same speed costs less per GiB.
- The new volume's first DLM snapshot is a full copy and the old volume's last
  snapshots stay until they expire, so snapshot cost roughly doubles for about
  a week.
- Delete the old volume after the rollback window; it bills until then.
