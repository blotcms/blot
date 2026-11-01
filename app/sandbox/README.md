# Sandbox

Runs jobs on untrusted bytes (image metadata and web pages so far) in an [nsjail](https://github.com/google/nsjail)
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

The broker runs at most 4 jails, fewer of a job with its own `maxRunning`, and queues 32 more, then answers `busy`. It
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

## The browser job

`screenshot` runs Chromium on a URL. It is the one job with a network, and it is
off until the host also sets `BLOT_SANDBOX_BROWSER=1`, when `helper/screenshot`
uses it in place of the airlock. Every URL is treated as hostile, whoever asks:
customer sites run their own template code. The job starts its own Chromium, driven
over a pipe so there is no DevTools port, and all of it goes when the job ends.

Its jail differs from the others (`networkArgs` in `proxy/unit/sandbox/jail.js`):

- **The network is pasta, inside the jail's namespace,** and it is only safe with
  the filter: alone it reaches the instance metadata service and the host's
  loopback. `enter-network.sh` loads `egress.nft`, drops every capability and
  sets no-new-privs before the job starts, and the job doesn't start if that fails.
  The unit needs `/dev/net/tun`, and `setns` and `unshare` in its seccomp profile.
- **It is started by uid 65001, not root,** because pasta won't start from a root
  nsjail. So nsjail can't make cgroups: the broker's shell joins the job to
  `/sandbox-browser-cgroup` first (`/sys/fs/cgroup/blot-sandbox/<unit>-browser`
  on the host), whose limits are the job's, and the broker kills what is left in
  it afterwards. That is why one job runs at a time per unit.
- **`/proc` is the container's, read-only.** Chromium aborts without a real one.
  A job can read the unit's process list and command lines, so no secret may
  ever be on a command line. Other uids' `environ`, `maps` and `fd` are denied.
- **Never bind `/etc/ssl`.** The unit's TLS private keys are at `/etc/ssl/private`.
- **The seccomp policy** is `policy-browser.kafel`: the other jobs' policy with
  `socket` allowed for Unix, IPv4, IPv6 and the two netlink protocols nft uses.

A page that can't be screenshotted comes back as `meta.error`; only a broken job
is a job failure.

## The proxy jail

The app's fetches of user-supplied URLs (`helper/airlock`) go through tinyproxy.
With `BLOT_SANDBOX_PROXY=1` that is a long-running jail in the unit in place of
the airlock's. It isn't a job, so the broker has no part in it: the supervisor
keeps `proxy/unit/sandbox/proxy.js` running, which is root like the broker, makes
`/sandbox-cgroup/proxy` (128 MiB, 128 pids) and starts the jail.

It uses the same pasta network, `egress.nft` and capability drop as the browser
job, and binds much less: no Node, app code or `/proc`. pasta forwards one port on
the unit's loopback to it (`network-proxy-<unit>.cfg`, which must match
`sandboxProxyPort` in `scripts/deploy/constants.js`), and `egress-proxy.nft`
lets that port through the jail's loopback. pasta shares the job's uid outside the
namespace, so the filter can't tell them apart, and a URL for `127.0.0.1:8888`
reaches tinyproxy itself. That can only return its own error page.

## Why

- **The broker is root-owned.** A jail with its own uid and cgroups has to be
  started by root, so a root process is needed. The app (uid 1000) can rewrite
  everything under `/usr/src/app`, so root must never load code from there: the
  Dockerfile copies the broker to `/usr/local/lib/blot-sandbox`, root-owned and
  not writable by 1000, it requires only Node built-ins and its siblings, and
  the supervisor starts it with a clean environment (no secrets, no `NODE_OPTIONS`).
- **No `/proc`, except for the browser job.** `--disable_proc`. A fresh `/proc` can't be mounted under
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
  nsjail can build the jail, and `setns` and `unshare` for pasta. Nothing else is added: not `--privileged`, not
  `seccomp=unconfined`, no capabilities. The jail's own policy
  (`proxy/unit/sandbox/policy.kafel`) is much tighter and blocks those calls.
