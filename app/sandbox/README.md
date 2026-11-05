# Sandbox

Runs jobs on untrusted bytes (images, their metadata, documents pandoc converts, web pages and remote images so far) in an [nsjail](https://github.com/google/nsjail)
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
- `template-image` a template image setting: a decode check, then the original
  and its thumbnails, cropped and cut to a shape (`image-mask.js`, `crop.js`).
- `favicon` a template's favicon set, one ICO and a few PNGs.
- `pandoc` a docx, odt, rtf, org or markdown document to HTML, through
  `build/converters/pandoc.js`. The job picks pandoc's options from a few checked
  args (the format, and for markdown KaTeX, callouts and citations), never flags
  from the caller. A markdown post's bibliography and CSL come after the
  document in the input, their lengths in the args. outputs[0] is the HTML and
  the rest are the media pandoc extracted from a docx or odt, named in
  `meta.media`; the converters write them to the blog's assets. A document
  pandoc can't convert is `meta.error`, so it fails the build like any bad file
  without being a sandbox failure. The callouts Lua filter is `jobs/callouts.lua`.

  **In a jail it is a worker** (see below): `pandoc lua jobs/pandoc-worker.lua`,
  which converts one document after another, so a document doesn't pay for a
  jail, Node and pandoc's start-up each time (a typical post went from about
  104 ms to 22 ms through the broker, before nsjail's own setup). The worker
  converts exactly as `jobs/pandoc.js`, the in-process job that development and
  the specs run, does with the CLI; `tests/pandoc-worker.js` runs every
  converter fixture through both, so a change to the options in one must be
  made in the other. It has the usual 512 MiB and 128 MiB `/tmp`, under the
  unit's sandbox subtree's cap, and caps pandoc's heap at 400M. A document gets
  15s, after which the broker kills its worker: the caller fails that document
  with "Pandoc exited ... (timed out)", and `alerts.js` logs it instead of
  emailing. pandoc killed by the jail's memory limit is `SANDBOX_KILLED`, which
  emails the admin; a heap pandoc can't grow (it exits) is `SANDBOX_FAILED`.
- `unzip` a zip archive into its files, one output each. It refuses absolute and
  upward paths, symlinks, too many records, too many bytes and too high a ratio
  (a bad archive is a `meta.error`, not a thrown error). Output stops at 60 MiB.
- `fetch-image` fetches an image from a URL and re-encodes it, for the remote
  images in posts (`helper/transformer/download`), so Node never handles the
  bytes a server sent. It has a network: see below. Args are `{ url, etag,
  lastModified }`; the job checks the URL (http or https, no credentials) and
  the two conditional headers itself, and sends no others. It follows up to 5
  redirects, each checked the same way, and gives up after 20s, or 5s without
  data. The body is capped at 32 MiB as it arrives and again once its gzip,
  deflate or brotli is undone, so a small bomb stops there. It must be a JPEG,
  PNG or GIF of at most 24 million pixels, every frame counted, or 12 million
  for what is decoded whole: a progressive JPEG (unless its chroma is 4:2:0),
  an interlaced PNG and WebP. Measured, the worst of these stays under about
  220 MiB. It comes back in that format, shrunk to fit inside 3000 px as the
  callers do anyway (which lets the decoder shrink as it reads): JPEG and WebP
  at quality 90, with the EXIF rotation applied and only the colour profile
  kept, a GIF still animated and its size.
  Never SVG, which sharp can only rasterise: a remote SVG stays a remote link.
  `meta` is the status, the caching headers (`etag`, `lastModified`,
  `expires`, `cacheControl`, `age`), the format and size; a 304 has no
  output. Whatever the URL does is `meta.error` (with `meta.code` for a network
  error), so the job only fails when the jail is broken, and that is alerted.

- `fetch` a batch of up to 32 URLs, fetched one after the other in one jail, for
  everything else the app fetches from a URL it doesn't trust: an import's
  images, audio and PDFs (`dashboard/site/import/helper/download.js`), domain
  verification, the featured-site checks and the SSL warm-up of a new blog or
  domain. Callers use the client, `sandbox/fetch` (`one(request)`, which throws,
  and `many(requests)`, which answers each URL by itself), not `sandbox.run`. It
  shares `jobs/fetching.js` with `fetch-image`, so it has the same limits: 5
  redirects, a byte limit on the wire and again after gzip, deflate or brotli is
  undone, 5s without data in a body, and a time for the whole request with its
  redirects (`timeoutMs`, 20s by default and 30s at most), which is also how
  long it waits for any response's headers (10s for `fetch-image`): the first
  visit to a domain can wait on its certificate.
  Args are `{ requests: [...] }`, and each request is `url`, `kind` and options:
  - `kind: "text"` (the default) a body of at most `maxBytes` (1 MiB by default,
    8 MiB at most), decompressed in the jail and returned as the string `text`.
    `truncate` keeps the first `maxBytes` instead of failing on a longer one.
  - `kind: "file"` the bytes, at most 50 MiB, after a check of what they are:
    `check: "pdf"` wants `%PDF-` at the start, and `check: "audio"`, like no
    check, refuses a body that starts like HTML, SVG, XML or JSON or has an
    `<html>`, `<svg>` or `<script>` near the start. The importer writes these
    into a blog's folder, so what the remote server calls a PDF can't be a page
    that is served as one.
  - `kind: "image"` a JPEG, PNG, GIF or WebP, decoded and encoded again exactly as
    `fetch-image` does (`jobs/reencode.js`): its `format`, `width` and `height`
    come back, and anything else, SVG included, is an error. The importer's
    images use this, so what it writes into a folder is libvips's output, not
    the server's.
  - `kind: "html"` a web page that the jail parses itself, so Node never does:
    the request names one fixed `extract`ion (`jobs/html.js`), and what comes back
    is its small, validated structure as `extracted`, not the page. The only one
    is `"og-video"`, the player a page names in its Open Graph tags
    (`{ src, width, height }`, each only if present and valid: `src` an http(s)
    URL with no space, quote or angle bracket, the sizes whole numbers of
    pixels up to 10,000), for bandcamp embeds
    (`build/plugins/videoEmbeds/bandcamp.js`). `maxBytes` is 2 MiB (the most the
    parser takes) and `truncate` reads the head of a longer page. A page the
    parser refuses (see `parse-html`) is an error of that request. The
    caller never supplies a selector or code.
  - `ip` connects the first request to that address, with the URL's host as the
    Host header and the TLS name, as domain verification needs (the address it
    resolved itself, which the resolver in the jail may not agree with yet). A
    redirect goes where the server says. The egress filter still applies: a
    private address is refused as for any other.
  - `method` (`GET`, `HEAD`), `redirect` (`follow`, `manual`), `anyStatus` (a body
    for any status, not only 2xx: the status is in the answer) and `headers`
    (`userAgent`, `referer`, `accept`: no others are sent).

  `meta.results` has one entry for each request, in order, and `outputs` one
  buffer for each. A request that can't be fetched is `{ error }` (with `status`,
  `code` for a network error or `timedOut`), so the job fails only when the jail
  is broken. A batch keeps one body of any size up to the limits and others only
  while all of them together stay under 16 MiB, so the jail's memory is the
  first body's plus 16 MiB (and an image's decode: see below); a request left
  over is `{ error, deferred: true }`, not tried or not kept, and the client
  sends it again in a later jail. A batch has 60s in all and its jail 75s.
  `many` splits a longer list across jails of 32, and everything it returns is
  in memory at once. In production a unit with no sandbox refuses, as the old
  egress boundary did.

  The importer collects a post's images, then its audio, then its PDFs, and
  fetches each kind a jail's worth at a time (`download.prefetch`): a batch is
  fetched when the import reaches its first URL, and the next only when it
  reaches a URL that isn't in it, so Node holds one batch's bodies, not the
  post's, and the import's 1 GiB limit, checked as each is taken, stops the
  next batch from being fetched. A bulk import pays for a jail's start once for
  several files, not for each. A request is started only with the whole of its
  `timeoutMs` left in the batch's 60s, else it is put off like one that didn't
  fit, not cut short; and `many` takes a `signal` and starts no jail after it
  aborts.

- `parse-html` parses the HTML of a post the importer holds, so Node doesn't:
  a post comes from an Are.na block (remote text) or from an export, and the
  importer's stages used to hand it to cheerio and Turndown. The input is the
  HTML; `args.op` names one of three fixed operations and a caller supplies no
  selector or option (`jobs/html.js`, `jobs/parse-html.js`):
  - `scan` (`kind` `images`, `pdfs` or `audio`) `meta.urls`, the http(s) URLs of
    that kind in the post, each once, in order, at most 1000 of at most 2048
    characters: every `<img src>`; every `<a href>` whose whole address ends in
    `.pdf`; every `<audio src>`. `outputs[0]` is the post as the parser writes it
    back, which is what the importer keeps if nothing is downloaded.
  - `rewrite` (`kind`, `replacements`: a list of `[url, name]`) `outputs[0]` is the
    post with each URL changed to its name: an image's `src` and the link around
    it if that went to the same address; a PDF link's `href` and its text if
    that was the address; audio's `src`. A name is set as an attribute value,
    never parsed.
  - `markdown` `outputs[0]` is the post as Markdown (Turndown, GFM, with
    nothing escaped and audio, video and iframes kept).

  The importer does a `scan` for each of its PDF, image and audio stages, one
  `rewrite` for a stage that downloaded something, and one `markdown`
  (`dashboard/site/import/helper/html_assets.js`). Markup it won't parse is
  `meta.error` (the stage fails that post with the message, and downloads
  nothing), not a failure of the job: more than 2 MiB, more than 30,000 tags
  (each `<` that starts a tag or a closing tag), a tag with more than 256
  attributes (parse5 takes 16s over 100,000), or nested more than 500 deep (the
  parser and the serialiser recurse, and parse5 is slow in depth). The depth
  limit is enforced while the tree is built (a tree adapter that checks each
  node's depth), and the others by one pass over the text before parsing, so a
  hostile page is refused in milliseconds. It has no network, a 384 MiB cgroup
  and a heap limit of 256 MiB. Measured in a real jail, the worst accepted posts
  (2 MiB of text, a comment or one attribute; 29,000 `<li>`; 14,500 links)
  peak at about 160, 220, 275 and 300 MiB for the whole jail with Node and the
  modules, and finish in under 5s; a post of ordinary size takes about 30 MiB
  and 100ms.

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

The broker runs at most 4 jails, fewer of a job with its own `maxRunning` or `cgroups`, and queues 32 more, then answers `busy`. It
takes no paths, and logs one line per failed job with no input data. A client
that vanishes after ending its input is not noticed until the jail finishes,
which is at most its time limit.

## Workers

A job with `worker` in `proxy/unit/sandbox/jail.js` (only `pandoc` so far)
keeps its jails for many requests instead of starting one for each. The
client's side is the same: one connection is one request, answered as a jail's
stdout. The broker takes an idle worker, or starts one, and sends it the
client's bytes in frames, `<length>\n<bytes>`, ended by `0\n`. The worker
answers `<length>\n` and that many bytes, or `E\n` for arguments it refuses
(`failed`, and it carries on). A busy worker counts as a running jail, as any
job does, so the broker's limit of 4 and its queue are unchanged.

- **Replaced** when it dies (`failed`, or `killed` past the jail's memory),
  answers nonsense, takes longer than `requestSeconds` on a request
  (`timeout`), gets more input than the job's limit, or loses its client
  mid-request.
- **Retired**, by closing its stdin, after `requests` requests or
  `maxAgeSeconds` (before nsjail's own time limit, its whole life,
  `timeSeconds`), after `idleSeconds` idle, after a heavy request (more than
  `heavyInputBytes` in or `heavyMs` of work, since its heap may have grown), or
  when `maxIdle` workers already wait.

So a worker sees documents from many blogs, one after another. A document
that compromised pandoc could tamper with the HTML of those converted after
it in the same worker, for as long as it lives. That is accepted for the
speed, as screenshot batches accept it for their pages; the jail boundary
itself is unchanged.

Memory: at most 4 busy workers (the broker's limit across all jobs) and
`maxIdle` (2) idle ones, all in the unit's sandbox subtree. An idle pandoc
worker holds about 20-40 MiB of its own; the ~85 MiB of pandoc's binary is page
cache that every pandoc jail shares.

## Adding a job

1. Add `jobs/<name>.js` exporting `run(args, input)`, returning
   `{ meta, outputs: [Buffer, ...] }`. `meta` must be JSON.
2. Add `<name>` to `JOBS` in `jobs/main.js` and an entry in `proxy/unit/sandbox/jail.js`
   (command, memory, time and byte limits). The names are `/^[a-z-]+$/`.
3. If it needs a binary or library the jail doesn't bind, add a read-only bind
   in `jail.js`. Never bind `/usr` or `/`.

## Jobs with a network

`screenshot` runs Chromium on a URL, and `helper/screenshot` uses it whenever the unit has a sandbox: since the airlock
container went (#2257) production has no other browser. Every URL is treated as hostile, whoever asks:
customer sites run their own template code. The job starts its own Chromium, driven
over a pipe so there is no DevTools port, and all of it goes when the job ends.

**A job is a batch of up to 8 pages**, taken one after the other in one Chromium, each in a fresh incognito context.
A job costs about 2.1 s before it touches a page (jail, Chromium, re-encode; measured on production, 3 Nov 2026), and
a batch pays it once. Pages from different sites and customers share a batch on purpose. This accepts that a hostile
page that compromises Chromium (`--no-sandbox` inside the jail) can tamper with or break the other screenshots of its
batch, and that one heavy page can kill its batch (`helper/screenshot` then retries each page alone). The host is
protected by the jail boundary itself: no secrets or env vars, no data mount, the egress filter, no capabilities,
seccomp. That is the same for one page or eight. The rule: keep the boundary intact above all; isolation between
jobs inside one jail is not a goal, so don't split batches by site or customer.

`fetch-image` and `fetch` fetch with Node's `http` and `https`, not through the
proxy jail: their own jail is behind the same filter.

Their jails differ from the others (`networkArgs` in `proxy/unit/sandbox/jail.js`):

- **The network is pasta, inside the jail's namespace,** and it is only safe with
  the filter: alone it reaches the instance metadata service and the host's
  loopback. `enter-network.sh` loads `egress.nft`, drops every capability and
  sets no-new-privs before the job starts, and the job doesn't start if that fails.
  The unit needs `/dev/net/tun`, and `setns` and `unshare` in its seccomp profile.
- **It is started by uid 65001, not root,** because pasta won't start from a root
  nsjail. So nsjail can't make cgroups: the broker's shell joins the job to a
  free one of the job's `cgroups` first, whose limits are the job's, and the
  broker kills what is left in it afterwards. So each holds one jail at a time.
  The browser's is `/sandbox-browser-cgroup` (`/sys/fs/cgroup/blot-sandbox/<unit>-browser`
  on the host), so one screenshot runs at a time per unit. `fetch-image`'s is
  `/sandbox-cgroup/fetch`, 256 MiB and 64 pids, which the broker makes when it
  starts (`proxy/unit/sandbox/cgroup.js`), as the proxy jail makes its own. So
  one fetch runs at a time per unit, and a slow server holds the rest up for
  as long as 20s. That is background build work. A fetch waits in a queue of
  its own, at most 8, inside the broker's, so a backlog of them never fills
  the queue the dashboard's jobs wait in: past it, or after a minute queued,
  the answer is `busy` (logged, not emailed: see Alerts) and the post keeps its remote link.
- **`fetch` is in the same cgroup, with a queue of its own.** An import's
  files, the domain checks and the featured-site checks take turns with the
  post builds' images in the one slot, and add no memory. What keeps them from
  blocking each other is the queues and the broker's turn-taking: each job's
  queue is its own (`fetch` 16, `fetch-image` 8), and when a cgroup is free the
  broker starts the oldest request, except that a job that ran last in it yields
  to a waiting job of the other name. So a big import's batches, however many
  are queued ahead, alternate with the post build's images, and a post build's
  image waits behind at most one batch (75s at most, usually a few seconds); and
  the import waits behind at most one image (30s),
  not behind the build's whole backlog. `busy` for either is logged, and the
  caller carries on without that file or link. A second cgroup for imports was
  weighed and left. It would have to be 128 MiB or less (the proxy jail's 128 +
  `fetch-image`'s 256 + 128 is the whole 512 MiB), so the image jobs would have
  nothing when all three were busy, and 128 MiB can't hold a 50 MiB file in the
  jail together with the copy made when it is joined (measured, in a real jail:
  a 50 MiB file peaks at about 170 MiB), nor an image's decode.
  The cost of one slot is that a domain check, which waits in the same queue,
  can wait for an import batch that is running (the verification's 5s covers the
  request, not the wait).
- **The fetch shares the unit's sandbox subtree** (`blot-sandbox/<unit>`,
  512 MiB) with the proxy jail (128 MiB at most) and the image jobs (each up
  to 512 MiB, four at once). The fetch jobs and the proxy together take at most
  384 MiB of it (256 + 128), whichever fetch job is running; the image jobs have
  the rest and whatever those two aren't using. The subtree's final size is for
  the unit memory work (TODO) to set from measured peaks.
- **`/proc` is the container's, read-only, for the browser job only.** Chromium aborts without a real one.
  A job can read the unit's process list and command lines, so no secret may
  ever be on a command line. Other uids' `environ`, `maps` and `fd` are denied.
  `fetch-image` has none, and no fonts or `/etc/ssl/certs`: Node has its own CAs.
- **Never bind `/etc/ssl`.** The unit's TLS private keys are at `/etc/ssl/private`.
- **The seccomp policy** is `policy-browser.kafel`: the other jobs' policy with
  `socket` allowed for Unix, IPv4, IPv6 and the two netlink protocols nft uses.

- **The PNG is re-encoded in the jail.** Chromium's bytes come from a process that
  ran a hostile page, so the job decodes them with sharp and returns the PNG sharp
  writes: no ancillary chunks or metadata, and no bigger than the viewport in
  screen pixels (width and height times the device scale factor of 2). In a batch
  this happens right after each page, with its context closed and Chromium idle,
  so only one raw PNG is held at a time; for a 1260×778 @2x shot it takes about
  10 ms and adds about 10 MiB, nothing next to the browser's. Bytes that don't
  decode fail that page. Node still checks the PNG signature before writing them.
- **A batch has limits of its own.** Args are `{ pages: [{ url, width, height, mobile }] }`,
  1 to 8 pages (the single-page form still works). A page keeps its limits
  (HTML 10 s, render grace 8 s, screenshot 5 s, closing 3 s: 26 s at worst), and the
  browser cgroup runs one job at a time while the broker answers `busy` to a
  request queued for 60 s, so a batch must be short enough to wait behind. The
  job therefore starts no page after 40 s (typical pages take 3-7 s, so 8 fit
  in 30-40 s), and a page it didn't reach, or whose PNG would
  take the replies past 56 MiB, comes back `deferred` for the client to send
  again in a later batch (without counting as a failed attempt). The jail's limit
  is 70 s, the backstop (40 s plus a page started at the last moment, 26 s, plus
  closing), and the client's 150 s covers a minute queued and then a job. A
  `busy` answer to a batch is backpressure: `helper/screenshot` sends its pages
  again after 5 s, up to 6 times, before failing them, and it is logged, not
  emailed (`alerts.js`). A `deferred` page is a result, not an error, so
  `alerts.js` never sees it. If Chromium dies mid-batch the pages done are returned and the rest are
  deferred. If the job as a whole is killed (the 1 GiB browser cgroup's OOM kill
  takes the group) or times out, `helper/screenshot` sends each page of that
  batch on its own, so a heavy page costs only itself.
- **`helper/screenshot` coalesces requests** from every caller (bookmark links,
  the template gallery): a request waits at most 150 ms for company, a batch
  goes at 8, only one batch is out at a time per process, and what arrives
  while it runs goes out as soon as it is done. A lone request is delayed
  150 ms. The retry (3 attempts, 1 s apart) is per page and re-batched.
- **What a batch costs.** Starting the jail, Chromium and the re-encode takes
  about 2.1 s per job on production (`about:blank`, measured 3 Nov 2026), and
  a real page 2.7-7 s per job. A batch pays the 2.1 s once, so each page after
  the first in a batch saves about that much.

A page that can't be screenshotted comes back as its entry in `meta.results` (`error`
and `retryable`); only a broken job is a job failure.

## The proxy jail

Nothing in the app fetches through it now: the fetches of user-supplied URLs are the `fetch` and `fetch-image`
jobs, and `helper/egress` is left with the screenshot job's fail-closed check. tinyproxy still runs, in a long-running
jail in the unit, whenever the unit has a sandbox, until it is retired (TODO). It isn't a job, so the broker has no part in it: the supervisor
keeps `proxy/unit/sandbox/proxy.js` running, which is root like the broker, makes
`/sandbox-cgroup/proxy` (128 MiB, 128 pids) and starts the jail.

It uses the same pasta network, `egress.nft` and capability drop as the browser
job, and binds much less: no Node, app code or `/proc`. pasta forwards one port on
the unit's loopback to it (`network-proxy-<unit>.cfg`, which must match
`sandboxProxyPort` in `scripts/deploy/constants.js`), and `egress-proxy.nft`
lets that port through the jail's loopback interface. pasta delivers connections
from the jail's own address, `10.255.255.2`, which is the one client tinyproxy
allows. A URL for `127.0.0.1:8888` gets a refusal from tinyproxy. pasta shares
the job's uid outside the namespace, so the filter can't tell the two apart, and
the most a URL can do is hold one of its 64 connections, as any slow server can.

## Node's filter

With the sandbox on, the unit's seccomp profile gives the whole container `clone`
with namespace flags, `mount`, `umount2`, `pivot_root`, `sethostname`, `setns` and
`unshare`, so nsjail and pasta can build jails. Node needs none of them, and
creating a user namespace is the usual first step of a kernel exploit. So the
supervisor starts Node under a second filter (`proxy/unit/sandbox/node-filter.js`,
written when the image is built) that refuses them, and refuses 32-bit calls and
`clone3`, whose flags seccomp can't read. Everything Node spawns inherits it, and
no-new-privs comes with it, so no setuid program works under Node. The broker and
the proxy jail start separately, as they must. OpenResty isn't filtered, and
neither is anything run by `docker exec`.

## Markup from the network

The sandbox parses markup that came from the network, so the parsers' bugs and
the cost of hostile markup stay in a jail. Where Node does still parse such
bytes, and why:

- **In the jail:** bandcamp's page (`fetch`, `kind: "html"`), and the HTML of an
  imported post: the PDF, image and audio stages and the Markdown conversion
  (`parse-html`). This includes the importers' Are.na blocks, and a WordPress or
  Blogger export's posts, which go through the same stages.
- **Not markup:** domain verification, the featured-site checks and the SSL
  warm-ups read a status, a header, a string comparison or (the subscription
  duration, at most 4 KiB) `JSON.parse`; Are.na's channel listing is JSON.
- **Out of scope, parsed in Node:** the importers' own parsing of an export the
  user uploaded (WordPress WXR and Blogger's feed, `sources/*/parse.js`,
  `resolve_url`, `replace_embeds`, `remove_inline_images`); a blog's own files and
  entries at build time; the Google Drive document export; the documentation
  site's build, which fetches the maintainers' tool pages. The oEmbed embeds
  (Twitter, Flickr, Bluesky, Vimeo, YouTube) fetch JSON from a fixed host with
  `node-fetch` and put the `html` it names into the entry, which cheerio then
  parses along with the entry; moving that would not stop the parse, since the
  entry is parsed in Node anyway.

## Alerts

`alerts.js` emails the admin (`SANDBOX_ALERT`) when a job is killed, times out,
is cut short or answers nonsense, when the broker can't be reached or its queue
is full, and, checked every five minutes from each web process, when the unit's
fetch proxy jail stops answering or lets the metadata
address through. A job that fails on bad input isn't reported, except
`fetch-image` and `fetch`, which answer bad input with `meta.error`, so their
failing means the jail is broken. A busy `fetch-image` or `fetch` is the other
way round: their short queues fill by design when builds have many remote
images and when an import is big, so that is logged with a count (`sandbox: job
fetch-image busy`, `sandbox: job fetch busy`) rather than emailed. A fetch that
is killed, times out (the job, not a URL), can't reach the broker or answers
nonsense is emailed like any job's. At most one
email per process every ten minutes, with counts for what happened in between.

## Why

- **The broker is root-owned.** A jail with its own uid and cgroups has to be
  started by root, so a root process is needed. The app (uid 1000) can rewrite
  everything under `/usr/src/app`, so root must never load code from there: the
  Dockerfile copies the broker to `/usr/local/lib/blot-sandbox`, root-owned and
  not writable by 1000, it requires only Node built-ins and its siblings, and
  the supervisor starts it with a clean environment (no secrets, no `NODE_OPTIONS`).
- **No `/proc`, except for the browser job.** `--disable_proc`. A fresh `/proc` can't be mounted under
  Docker's masked paths, and the alternative (`systempaths=unconfined`) would
  let root in the unit write host sysctls. sharp, exiftool and pandoc don't need it.
- **`-u 65000:65000:1`, not `--user`.** As root, `--user` leaves the job mapped
  to root outside the namespace.
- **Binds are listed, never `/usr`.** nsjail binds are recursive and
  `/usr/src/app/data` is the blog data mount. The jail has no `/bin`, so jobs
  run `/usr/local/bin/node file.js` and `/usr/bin/perl /usr/bin/exiftool`
  directly; `#!/usr/bin/env` scripts won't start. pandoc is a static binary,
  bound on its own: never `/usr/local/bin`.
- **The environment is empty** except `NODE_PATH`, so `require("sharp")` resolves.
- **Job cgroups are outside the unit's.** The host makes
  `/sys/fs/cgroup/blot-sandbox/<unit>` (`config/host/host/setup.sh`) and the
  deploy binds it at `/sandbox-cgroup` with `--cgroupns=host`; `--cgroupns=private`
  can't move a job into it. So their limits add to the units' on the host.
- **Jobs go first when the host runs out of memory.** The broker's shell sets
  `oom_score_adj` to 1000 before it execs nsjail, so a job is killed before the
  units' Node: `node-b` sets itself to 900 (`app/index.js`) and `node-a` stays
  at 0. Only Redis's BGSAVE child, also 1000 and larger, goes ahead of it. Set as root, the job's uid can't lower it. The proxy jail is left alone.
- **The seccomp profile** (`proxy/deploy/sandbox-seccomp.json`) is Docker's
  default plus `clone`, `mount`, `umount2`, `pivot_root` and `sethostname`, so
  nsjail can build the jail, and `setns` and `unshare` for pasta. Nothing else is added: not `--privileged`, not
  `seccomp=unconfined`, no capabilities. The jail's own policy
  (`proxy/unit/sandbox/policy.kafel`) is much tighter and blocks those calls.
