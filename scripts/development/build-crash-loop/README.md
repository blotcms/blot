# Build crash loop spike

Reproduces, in the local stack, the crash loop of 26 Nov 2026: a long `.docx`
whose build blocked the event loop for about 17s crashed a unit's process
every minute for over two hours (fixed in #2988). It also shows that
`app/sync/update/stalledBuilds.js` ends such a loop.

`spike.js` makes a scratch blog, `crashloopspike`, owned by the owner of the
`local` blog. It writes `/Pages/directory.docx` into it: a long list of
paragraphs, each a single bold child, which is the shape of the customer's
page. Then it runs `worker.js` again and again, as the units' processes did.
Each worker takes the blog's folder lock and updates the file through
`sync/update`, as a sync would, and a crash starts the next worker a second
later. In production, the follow-up queue retried the sync about a minute
after each crash.

```bash
OLD=1 scripts/development/build-crash-loop/run.sh --paragraphs 1800 --edit
```

- `OLD=1` mounts the converter from before #2988 over the current one.
- `--paragraphs` sets the file's length. The old converter's work grows with
  the square of it: 1,200 paragraphs blocked for about 6s, and 1,800 for
  about 19s, which is past the lock's 10s lease.
- `--runs` is the most workers to start (default 6).
- `--edit` changes the file afterwards and runs again.

What it showed (26 Nov 2026):

- **Without `stalledBuilds`:** every worker lost the lock and crashed, with
  production's own error (`Socket timeout ... 6000ms`), with no end.
- **With it:** two crashes, then the third worker skipped the file and
  finished in 30ms. The existing post stayed, the file was flagged
  `BUILD_TIMEOUT` (step `build`), and one `BUILD_STALLED` email was sent.
  After an edit, the new version got two tries of its own, and no second
  email went out within the hour.
- **With the current converter:** the same file built in 1.3s and left no
  attempt behind.
- **How the crash is recorded:** each build's finally ran before the lock was
  found lost. So an attempt cleared when the build ended would never be
  counted. In half the crashes, the Redis client was already offline by the
  time `onCompromised` ran. So the attempt is written before the build
  starts, not at the crash.

The scratch blog is left in place for the next run. Remove it with
`scripts/blog/remove.js` when done.
