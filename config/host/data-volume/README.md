# Resizing and moving the data volume

Operator scripts, run from the Mac over ssh, to grow or shrink the EBS volume
mounted at `/var/www/blot/data` on the app host, or to move its contents to
another host. EBS volumes cannot shrink, so a shrink builds a new smaller
volume, copies the data across and swaps it in with a short read-only window
for the app. A move does the same onto a second host. Nothing here is used by
the app.

| File | What it does |
| --- | --- |
| `resize.sh` | `status`, `grow <GiB>`, `shrink <GiB>`, `finish`, and `move prepare/copy/freeze/thaw/retag/status` (see the usage at the top of the file). |
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
   takes `--max-final-seconds` or less (default 300: the frozen pass walks the
   tree in parallel, so it takes well under the last live pass),
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
     `blot-blue` and `blot-green`. The containers bind the directory with `rslave`, so
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

- The next app deploy (`npm run deploy-units`) recreates the containers on the
  new volume.
- The old volume stays mounted underneath the new one, read-only, on the host
  and in every container's mount namespace, so it cannot be detached right
  away. Once the app deploy has recreated every container, run
  `resize.sh finish` (no reboot, no downtime):
  - `host.sh old-volume-status` reports which mount namespaces still have the
    old volume (`mounted_host`, `mounted_elsewhere`, a `holder=` line naming a
    process and, for a container, its name). While a container holds it,
    `finish` says which and stops: a deploy releases them.
  - When only the host's own namespace has it, `finish` asks, then runs
    `host.sh release-old`: it checks that exactly two mounts are stacked at
    the data directory and the top one carries the current volume's marker,
    that no copy is running and that `mount-data-volume.sh` is installed;
    unmounts the top mount, checks the old volume shows, unmounts that
    too, and runs `mount-data-volume.sh`, which mounts the current volume by ID,
    checks its marker and makes it shared. It then checks one mount, the
    marker, `shared`, and the marker inside each unit (`blot-blue` and `blot-green`), and sets
    the state file's phase to `released`. If the first `umount` fails (EBUSY)
    nothing has changed and it prints what has files open; any other
    surprise stops it with the state and the commands to inspect it, without
    guessing. For a few seconds the data directory shows the old volume and then
    nothing, on the host only: the containers keep their own copies of the
    mounts and are not affected.
  - Then `finish` detaches the old volume (re-checking its tags, by explicit
    ID). It never deletes anything.
- After `release-old`, the running containers' copies are no longer linked to
  the host's mount, so a later swap would not reach them until the next app
  deploy recreates them. `swap` checks the marker in every container and puts
  the old volume back if one does not follow, so this is safe, only a
  reason to deploy before the next resize.

## Grow

`resize.sh grow <GiB>`: `modify-volume` (same type, IOPS and throughput), wait
for `optimizing`, then `xfs_growfs`. It is online and needs no freeze. AWS
allows one modification per volume every 6 hours; the error is passed on
clearly.

It refuses to run between a shrink and `finish`: the old volume is still mounted
underneath, and `xfs_growfs` would stop at that volume's size and exit 0.

## Moving to another host

`resize.sh --host <source> move ...` copies the data to a new host with a
volume made from a snapshot, then a delta rsync. The old host keeps serving
until the Elastic IP moves, and writes stop only for the final pass. Detaching
the volume and attaching it to the new host is ruled out: the old host would
lose its folder files and uncached renders for minutes. It is a mode of
`resize.sh` because it shares the shrink's freeze, passes and undo; the swap
and everything after it stay shrink-only. Every command takes `--dry-run`
(which also copies `host.sh` to the new host) and `--yes`, and is safe to repeat.

`move prepare --to <new ssh host> [--existing]`:

1. **Check both hosts.** Passwordless sudo, rsync, the new host's own instance
   and zone (from its metadata), that it is set up as a Blot host
   (`/etc/blot` or `mount-data-volume.sh`), that neither host has a shrink or
   a move in progress, and that a drill host is never paired with a
   production one.
2. **Snapshot** of the source's volume, tagged `Name=Blot data before move`
   and `BlotDataVolumeMoveFrom=<old id>`, waited for. It is the source of the
   new volume and the first rollback. A snapshot from the last two days is
   reused on a resume.
3. **New volume** from the snapshot in the new host's zone, with the same size
   and encryption and the shrink's IOPS and throughput rules, attached at the
   first free device name. It is named `Blot data (copy in progress)`, not
   with the production name, because the DLM snapshot policy targets that tag.
4. **`host.sh adopt`** on the new host: waits for the device, refuses it if it
   is mounted anywhere or is not XFS, mounts it at a staging directory,
   writes its own ID over the snapshot's old ID in `.blot-data-volume` and
   unmounts. It never formats.
5. **Pre-warm** on the new host: a transient unit `blot-data-prewarm` reads the
   whole device once at low priority. A volume made from a snapshot loads its
   blocks from S3 on first read, so the switch must not be the first read.
6. **`host.sh move-prepare`** on the source: makes an ed25519 key
   (`/etc/blot/data-move-key`), records the new host's host key, and writes
   the state file (`phase=prepared`, the volumes, the target). The hosts have
   no key for each other and root login is off, so the copy runs as
   `ec2-user` on the new host with `sudo rsync`. The new host's key is
   checked against the one read over your own ssh, not accepted on first use
   (Amazon Linux 2's ssh has no `accept-new` either).
7. **Authorize the key** in `ec2-user`'s `authorized_keys` on the new host,
   with `from="<source's private address>"` and no forwarding, and the comment
   `blot-data-move` that `retag` finds it by. The new host's security group
   must let the source's address in on its ssh port; `prepare` checks that
   the source can ssh and `sudo rsync` there.
8. **It prints the next step**: the new host mounts the volume with
   `DATA_VOLUME_ID=<id> config/host/deploy.sh`, which writes
   `/etc/blot/data-volume` and starts `mount-data-volume.service`. A new host
   runs `deploy.sh` directly, not `npm run deploy-host` (see
   `config/host/launch.sh`, which prints the command).

`--existing` is for the direction back, where the new host already has its
volume mounted: it skips the snapshot, volume and pre-warm, and reads the volume
ID from the target's `/etc/blot/data-volume`.

`move copy` first checks that the volume mounted at `/var/www/blot/data` on
the new host carries the marker of the new volume, then runs the shrink's live
passes (`blot-data-copy-p1`, ... on the source, surviving the ssh session),
stopping by the same rule, and reports the pre-warm's progress. The passes
reach the new host with their own ssh connections; `logs/`, `tmp/` and the new
volume's marker are never touched on the target.

`move freeze` refuses unless the pre-warm has finished (`--no-prewarm-check`
overrides) or within 10 minutes of 01:00 or 05:00 UTC. Then it runs the
shrink's sequence: `read-only.js on`, grace, wait for folder locks, remount
read-only, re-arm the TTL, the final copy (one ssh connection for all the
parallel rsyncs, so `FINAL_COPY_JOBS` must stay below sshd's `MaxSessions`
of 10), and a snapshot of the source. Then it **stops with everything still
frozen**: the app refuses writes, the source's data directory is read-only,
and the command prints how long the freeze has left. This is the difference
from a shrink: the switch (Redis promotion, the Elastic IP) comes next, and has
to finish inside the TTL or re-arm it. A failure or Ctrl-C before the final
copy and the snapshot are done undoes the freeze; after that nothing does.
On a drill host the units are paused instead and stay paused.

`move thaw` is the rollback when no switch happened: the data directory goes
read-write and the freeze is lifted (the units unpaused on a drill). It also
cleans up after a failed `move freeze`.

`move retag`, after the switch: the new volume gets the production `Name` tag
first, then the old one becomes `Blot data (replaced by <new id>)` with
`BlotDataVolumeReplacedAt`. The key is removed from the new host's
`authorized_keys`, and the key and known-hosts file are deleted on the source,
which records `phase=moved`. Nothing is detached, deleted or unmounted: the old
host and its volume are the rollback until the cycle's finish. Name the old
host by an address that still reaches it (`--host`), because an alias for the
Elastic IP points at the new host by then.

`move status` shows the state, the passes, the pre-warm and the marker of the
volume mounted on the new host.

Rollback:

- **Before the switch**: `move thaw`. The old host never stopped being the
  primary; delete the new volume and the snapshot by hand.
- **After the switch**: on the old host `move thaw` (its data directory goes
  read-write), start its units, then copy what the new host has written since,
  with the hosts swapped: `resize.sh --host <new host> move prepare --to <old
  host> --existing`, then `copy`, `freeze` and the switch back. The old host's
  volume then gets the production name again at that `retag`.

## Drill first

`drill.sh` rehearses the whole thing on an Amazon Linux 2023 arm64 instance, the OS
of a new app host, without touching production:

    drill.sh launch --ami <id> --subnet <id> --security-group <id> --key-name <name>
    # add --ssh-port N if the security group does not allow 22: user data moves sshd there
    drill.sh --key <pem> setup ec2-user@<ip>
    # then the commands setup prints: resize.sh --host ... shrink 6, finish, grow 10
    drill.sh teardown <instance-id>

`drill.sh launch-target ...` (same options as `launch`) makes a second instance
with no data volume and `drill.sh setup-target ec2-user@<ip>` installs docker,
rsync, xfsprogs and the mount unit on it, for rehearsing `move`; it prints the
`resize.sh move` commands. In a drill the new host has no `deploy.sh`, so
`move prepare` prints the two commands that mount the volume instead.

`setup` fills a small data volume with tens of thousands of files and runs
reader and writer containers (named `blot-blue` and `blot-green`, `rslave` binds). The drill host is marked by
`/etc/blot/drill`, so `resize.sh` pauses the containers instead of calling
`read-only.js`, and tags the new volume `BlotDrill=true` and names it
`drill-data-volume` (never the production tag, or DLM would snapshot it).
`setup` takes `mount-data-volume.{sh,service}` and the docker drop-in from this
checkout, or from `origin/master`. `teardown` refuses an
instance that is not tagged `BlotDrill=true` and deletes volumes and snapshots
(those of a shrink or a move, found by their `BlotDataVolumeResizeFrom` or
`BlotDataVolumeMoveFrom` tags) one by one by ID, re-checking each tag first. A
volume attached to a different instance is left for that instance's teardown.

## Resuming and rollback

Re-run the same `shrink` command (or `move prepare`, `copy`) to resume: the host's state file, the
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

- gp3 includes 3000 IOPS and 125 MiB/s, which is what a shrink creates unless
  given `--iops` or `--throughput`. Leave them out: the app peaks around
  1000 IOPS and briefly a little over 125 MB/s, and a copy pass runs at about
  100-120 MB/s anyway, so paying for more buys little. Either can be raised
  later online with `aws ec2 modify-volume`, like a grow.
- The new volume's first DLM snapshot is a full copy and the old volume's last
  snapshots stay until they expire, so snapshot cost roughly doubles for about
  a week.
- Delete the old volume after the rollback window; it bills until then.
