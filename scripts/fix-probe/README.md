# fix-probe

Runs one of `sync/fix`'s checks (`tag-ghosts` by default) against one blog on
production, read-only, in a throwaway container, while watching the Redis
connection it runs on. It answers one question: can that check's Redis
traffic hold up other commands on the same connection for long enough to
expire a sync's folder lock? The lock has a 10s TTL and is renewed every 3s
over the same shared connection; see `app/sync/lock.js`.

```
npm run fix-probe -- blog_3dc3b49ffb3043039c7585bbfb6e8c2f --stats-only
npm run fix-probe -- blog_3dc3b49ffb3043039c7585bbfb6e8c2f
npm run fix-probe -- example.com --check list-ghosts --repeat 2
npm run fix-probe -- --help
```

The container is started by the shared launcher (`scripts/probe/run.js`, see
`scripts/render-probe/README.md`). It uses green's heap limit, joins the
airlock network as green does, asks for confirmation first, and copies its
output back to `./data/fix-probe/<run>/`.

## Read-only

- Every command on the shared client must be a read (`READ_COMMANDS` in
  `probe.js`). Anything else is refused before it is queued, which fails the
  check, and is listed under `refusedWrites`.
- `client.multi()` and `Entry.set` are replaced with recorders that send
  nothing. The repairs the check would have made are counted under
  `wouldWrite`, and the first 20 report items are kept.

The check still reads everything the real one does (for `tag-ghosts`, every
tagged entry in full), so it puts the same read load on Redis that the hourly
Dropbox and iCloud validators do.

## What it records

- `summary.json`
  - `stats`: the blog's shape, read over a separate connection before the
    check runs:
    - tags, and the commands `Tags.list` queues at once
    - entries per tag
    - entry sizes, and the largest entries
    - the byte size of each MGET batch `tag-ghosts` would issue
  - each run's duration and report.
  - `sharedPing` and `controlPing`: how long pings waited. The shared
    connection is pinged every 100ms and its pings queue behind the check's
    commands, as a lock heartbeat would. The control connection is a separate
    connection, so it shows what Redis and the network were doing meanwhile.
  - Redis commands by type, with reply sizes.
  - TCP retransmits in the container while the check ran.
- `samples.ndjson`, every 100ms:
  - node-redis' queue: `pending`, and whether commands were still unsent
  - each ping's wait so far
  - for the shared socket, from Node: bytes written and read since the last
    sample, bytes buffered in Node, `writableNeedDrain`
  - for the same socket, from the kernel (`/proc/net/tcp`): send and receive
    queues, and retransmits
- `calls.ndjson`: each `Tags.list` and `Tags.get` call, with its duration.
- `commands.ndjson`: each MGET, and any command that took 100ms or more.

How to read it:
- If shared pings stall while control pings stay fast, the check's traffic
  is blocking its own connection.
- `pending` with unsent commands while Node's buffer is full and the kernel's
  send queue stays high: the network isn't taking the data.
- `pending` with Node's buffer empty: the commands never left node-redis.

The output holds customer data (tag names and entry paths): delete it when
done.
