# Sandbox

Runs jobs on untrusted bytes (images and their metadata so far) in an [nsjail](https://github.com/google/nsjail)
jail instead of in the app's Node process, which holds the secrets and the blog
data mount. Design and phases: #2257.

```js
const sandbox = require("sandbox");
const { meta, outputs } = await sandbox.run("metadata", {}, buffer); // or { path }
```

Off unless the host sets `BLOT_SANDBOX=1` in the proxy env file
(`proxy/deploy/proxy.env.example`). Then the deploy gives the unit the flags it
needs (`proxy/deploy/common.sh`), the supervisor starts the broker, and
`config.sandbox.socket` is set. With it unset, as in development and on Amazon
Linux 2, `run` calls the job in-process. With it set `run` fails closed: any
broker error, missing socket or timeout rejects with an Error whose `code`
starts `SANDBOX_`, and it never falls back to in-process.

## Pieces

- `index.js` the client, in the app.
- `jobs/` the job code, which runs in the jail (`jobs/main.js`) or in-process.
- `proxy/unit/sandbox/` the root broker, the table of jobs and the nsjail
  command line (`jail.js`), and the seccomp policy.

## Jobs

- `metadata` format, size and orientation of an image.
- `thumbnail` the thumbnail sizes of one image, static or animated; one output per size.
- `resize` shrinks an image to fit inside a square, in its own format.
- `to-png` converts an image (HEIC, AVIF, TIFF...) to PNG.
- `exif` exiftool on stdin, reduced to the fields asked for. It spawns
  `/usr/bin/perl /usr/bin/exiftool` directly; in-process it honours `EXIFTOOL_PATH`.

Callers write any output files themselves: the jail can't reach the data mount.
Args are JSON and every job checks them, since they come from the less trusted side.

## Protocol

One connection is one job, on `/run/blot-sandbox/broker.sock` (0660, root and group 1000, in a root-owned directory: root must never chown a path the app could replace).

1. The client sends one JSON line, `{"job":"metadata"}`. Every byte after it is
   piped unparsed to the jail's stdin, up to the job's `maxInputBytes`; the
   client ends its side of the socket to end the input. The client sends its
   arguments as a line of JSON and then the input, which `jobs/main.js` reads.
2. When the jail exits, the broker answers with `{"ok":true,"length":N}` and
   then N bytes: the jail's stdout, unparsed. Or `{"ok":false,"error":"<code>"}`
   with `busy`, `unknown-job`, `input-too-large`, `output-too-large`, `failed`,
   `killed` or `timeout`.
3. The jail's stdout is `{"meta":...,"lengths":[...]}` and then the output
   bytes. The client checks it against N and the lengths; the broker never
   reads it.

The broker runs at most 4 jails and queues 32 more, then answers `busy`. It
takes no paths, and logs one line per failed job with no input data. A client
that vanishes after ending its input is not noticed until the jail finishes,
which is at most its time limit.

## Adding a job

1. Add `jobs/<name>.js` exporting `run(args, input)`, returning
   `{ meta, outputs: [Buffer, ...] }`. `meta` must be JSON.
2. Add `<name>` to `JOBS` in `jobs/main.js` and an entry in `proxy/unit/sandbox/jail.js`
   (command, memory, time and byte limits). The names are `/^[a-z-]+$/`.
3. If it needs a binary or library the jail doesn't bind, add a read-only bind
   in `jail.js`. Never bind `/usr` or `/`.

## Why

- **The broker is root-owned.** A jail with its own uid and cgroups has to be
  started by root, so a root process is needed. The app (uid 1000) can rewrite
  everything under `/usr/src/app`, so root must never load code from there: the
  Dockerfile copies the broker to `/usr/local/lib/blot-sandbox`, root-owned and
  not writable by 1000, it requires only Node built-ins and its siblings, and
  the supervisor starts it with a clean environment (no secrets, no `NODE_OPTIONS`).
- **No `/proc`.** `--disable_proc`. A fresh `/proc` can't be mounted under
  Docker's masked paths, and the alternative (`systempaths=unconfined`) would
  let root in the unit write host sysctls. sharp and exiftool don't need it.
- **`-u 65000:65000:1`, not `--user`.** As root, `--user` leaves the job mapped
  to root outside the namespace.
- **Binds are listed, never `/usr`.** nsjail binds are recursive and
  `/usr/src/app/data` is the blog data mount. The jail has no `/bin`, so jobs
  run `/usr/local/bin/node file.js` and `/usr/bin/perl /usr/bin/exiftool`
  directly; `#!/usr/bin/env` scripts won't start.
- **The environment is empty** except `NODE_PATH`, so `require("sharp")` resolves.
- **Job cgroups are outside the unit's.** The host makes
  `/sys/fs/cgroup/blot-sandbox/<unit>` (`config/host/host/setup.sh`) and the
  deploy binds it at `/sandbox-cgroup` with `--cgroupns=host`; `--cgroupns=private`
  can't move a job into it.
- **The seccomp profile** (`proxy/deploy/sandbox-seccomp.json`) is Docker's
  default plus `clone`, `mount`, `umount2`, `pivot_root` and `sethostname`, so
  nsjail can build the jail. Nothing else is added: not `--privileged`, not
  `seccomp=unconfined`, no capabilities. The jail's own policy
  (`proxy/unit/sandbox/policy.kafel`) is much tighter and blocks those calls.
