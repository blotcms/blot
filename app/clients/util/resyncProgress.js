const fs = require("fs-extra");
const { join } = require("path");

async function countLocalFiles(directory) {
  let total = 0;
  const contents = await fs.readdir(directory, { withFileTypes: true });

  for (const item of contents) {
    const path = join(directory, item.name);
    if (item.isDirectory()) total += await countLocalFiles(path);
    else total += 1;
  }

  return total;
}

function createProgress(total, publish) {
  const progress = { current: 0, total };
  const processed = new Set();

  // Add newly discovered remote-only work to total up front, before any of
  // it is processed - e.g. once per remote directory listing, for every
  // item in it with no local counterpart. Without this, total and current
  // grow together one item at a time (additional=true on publish below),
  // so the displayed percentage sits near 100% throughout a large batch of
  // new downloads instead of reflecting how much is actually left.
  progress.discover = function (count) {
    if (count) progress.total += count;
  };

  // `count` lets a caller that disposes of a whole directory in one action
  // (e.g. removing an orphaned local folder with a single fs.remove call)
  // advance current by the number of files that action accounted for,
  // rather than by 1 - otherwise current permanently lags total, which was
  // seeded by counting every file individually.
  function advance(path, additional, count) {
    if (processed.has(path)) return false;
    processed.add(path);

    if (additional) progress.total += count;
    progress.current = Math.min(progress.current + count, progress.total);
    return true;
  }

  progress.publish = function (message, path, additional, count = 1) {
    if (!advance(path, additional, count)) return;
    publish(`(${progress.current}/${progress.total}) ${message} ${path}`);
  };

  // Advances current/total exactly like publish(), but only actually emits
  // a status at most once per intervalMs. Use this for high-volume, low-
  // value updates (e.g. one "Checking" per unchanged file during a routine
  // sync) - publishing every one of them would push older, more useful
  // activity out of Blog.setStatus's capped history for no benefit, since
  // the skipped ones carry no information a viewer would act on.
  let lastThrottledPublish = 0;
  progress.publishThrottled = function (
    message,
    path,
    additional,
    count = 1,
    intervalMs = 2000
  ) {
    if (!advance(path, additional, count)) return;
    const now = Date.now();
    if (now - lastThrottledPublish < intervalMs) return;
    lastThrottledPublish = now;
    publish(`(${progress.current}/${progress.total}) ${message} ${path}`);
  };

  progress.finish = function (message) {
    progress.current = progress.total;
    publish(`(${progress.current}/${progress.total}) ${message}`);
  };

  return progress;
}

module.exports = { countLocalFiles, createProgress };
