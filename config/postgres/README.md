# Postgres host

Postgres stores entries, tags and dependencies alongside Redis
(`app/models/postgres/README.md`). While the app only dual-writes, every row
can be rebuilt from Redis with `scripts/postgres/backfill.js`, so losing the
database loses nothing: rebuild it and run the backfill. Backups, a replica
and the host cycle's handling of it are needed before reads move over (see
the follow-up in the root `TODO`).

It runs on the production host next to Redis and both units. The units run
with `--network host`, so they reach it on `127.0.0.1:5432`; it listens on
localhost only. The major version is `POSTGRES_VERSION` in
`config/versions.env`, the one dev and CI run.

These steps have not been run on Amazon Linux 2023 yet. Run them one at a
time over `ssh blot` and check each.

## Setting up the production host

Install, initialise and start it:

```bash
sudo dnf install -y postgresql17-server
```

```bash
sudo postgresql-setup --initdb
```

Settings, in `/var/lib/pgsql/data/postgresql.conf` (memory is shared with
Redis, whose maxmemory is 6gb, and the units):

```
listen_addresses = 'localhost'
max_connections = 100           # 2 units x 2 processes x BLOT_POSTGRES_POOL_SIZE 4, plus scripts
shared_buffers = 512MB
effective_cache_size = 2GB
wal_compression = on
```

Password logins over TCP from localhost: in `/var/lib/pgsql/data/pg_hba.conf`
the `host ... 127.0.0.1/32` and `::1/128` lines use `scram-sha-256` (the
default `ident` refuses the units).

```bash
sudo systemctl enable --now postgresql
```

Create the role and database, with a generated password:

```bash
sudo -u postgres psql -c "CREATE ROLE blot LOGIN PASSWORD '<password>'" -c "CREATE DATABASE blot OWNER blot"
```

Add the URL to `/etc/blot/secrets.env`, which the units read at start:

```
BLOT_POSTGRES_URL=postgres://blot:<password>@127.0.0.1:5432/blot
```

## Rolling out the dual write

1. Before the deploy: the steps above, so the new units start with
   `BLOT_POSTGRES_URL` (the running ones ignore it).
2. Deploy, then at once apply the schema from a new unit:
   `docker exec blot-blue node scripts/postgres/migrate.js`. Saves between
   the units starting and the migration fail their Postgres write (logged
   once per 30 seconds per process as `Postgres: entry write failed`) and
   mark their blog dirty; the backfill covers them anyway.
3. `docker exec blot-blue node scripts/postgres/backfill.js` copies every
   blog. It holds 25 entries at a time, so it adds little to the unit's
   memory, takes no sync lock, and can be stopped and resumed (`-s n`).
4. `node scripts/postgres/backfill.js --verify` should then report every blog
   ok. Entry differences are the mirror's (`--fix` resyncs them); index
   differences with matching entries are Redis drift or a query bug.

Rolling back is removing `BLOT_POSTGRES_URL` and restarting the units; the
database can be left or dropped.
