const clfdate = require("./clfdate");
const prefix = () => `${clfdate()} flushCache:`;

// Purges hosts from every reverse proxy's cache.
//
// Cached pages stay cached until purged, so a proxy that misses a purge
// serves stale HTML indefinitely. Each proxy therefore has its own queue and
// rate limit, so one failing or hanging proxy neither skips nor slows the
// others.
//
// When a `pending` store is supplied, hosts are recorded there for every
// proxy before they are purged and removed once that proxy accepts them. A
// purge still queued in memory when the process dies, or one a proxy failed
// to accept, is therefore re-sent by the retry loop (in any process) until
// that proxy accepts it.
//
// pending: {
//   add(target, hosts, score)       record hosts not yet purged on a proxy
//   list(target, maxScore, count)   -> [{ host, score }] recorded by maxScore
//   remove(target, entries)         drop entries unchanged since recorded
// }
module.exports = ({
  reverse_proxies,
  requestsPerSecond = 3,
  maxHostsPerPurge = 10,
  timeoutMs = 5000,
  retryIntervalMs = 30 * 1000,
  // only retry entries at least this old, so a purge another queue is
  // still working through is not sent twice
  retryAfterMs = 30 * 1000,
  maxHostsPerRetry = 1000,
  token,
  pending,
}) => {
  let isRetrying = false;
  let lastScore = 0;

  const minimumGap = 1000 / requestsPerSecond;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const queues = new Map(
    reverse_proxies.map((target) => [target, proxyQueue(target)])
  );

  // One queue per proxy. Entries are { host, score }, where score is the
  // score of the host's pending record, or null when it has none.
  function proxyQueue(target) {
    let queue = new Map(); // host -> score
    let isProcessing = false;
    let lastRequestTime = 0;
    let resolvers = [];

    function add(entries) {
      return new Promise((resolve, reject) => {
        // keep the newest record's score, which is the one a removal must
        // match
        entries.forEach(({ host, score }) => {
          if (!queue.has(host) || (score ?? -1) > (queue.get(host) ?? -1)) {
            queue.set(host, score);
          }
        });
        resolvers.push({ resolve, reject });
        process();
      });
    }

    async function process() {
      if (isProcessing) return;

      isProcessing = true;

      let failure = null;

      while (queue.size > 0) {
        console.log(prefix(), target, "processing", queue.size, "hosts");
        const timeSinceLastRequest = Date.now() - lastRequestTime;

        if (timeSinceLastRequest < minimumGap) {
          await sleep(minimumGap - timeSinceLastRequest);
        }

        const batch = Array.from(queue, ([host, score]) => ({
          host,
          score,
        })).slice(0, maxHostsPerPurge);

        batch.forEach(({ host }) => queue.delete(host));

        try {
          await purgeTarget(
            target,
            batch.map(({ host }) => host)
          );
          await settle(target, batch);
        } catch (error) {
          console.log(prefix(), error.message);
          failure = failure || error;
          await record(target, batch);

          // Hosts with a pending record are retried later, so stop sending
          // them to a proxy which is failing. Keep trying the rest: they
          // would be lost otherwise.
          for (const [host, score] of queue) {
            if (score !== null) queue.delete(host);
          }
        }

        lastRequestTime = Date.now();
      }

      const settled = resolvers;
      resolvers = [];
      settled.forEach(({ resolve, reject }) =>
        failure ? reject(failure) : resolve()
      );

      isProcessing = false;
    }

    return { add };
  }

  async function purgeTarget(reverse_proxy_url, hosts) {
    const url = `${reverse_proxy_url}/purge?${hosts
      .map((host) => `host=${encodeURIComponent(host)}`)
      .join("&")}`;

    console.log(prefix(), "fetching", url);

    try {
      const res = await fetch(url, {
        headers: token ? { "X-Blot-Purge-Token": token } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }

      const text = await res.text();
      console.log(prefix(), text.trim().split("\n").join(" "));
    } catch (error) {
      const reason =
        error.name === "TimeoutError"
          ? `timed out after ${timeoutMs}ms`
          : error.message;
      throw new Error(`Failed to flush proxy ${reverse_proxy_url}: ${reason}`);
    }
  }

  // The proxy accepted these hosts: drop their pending records. A failure
  // here only means an extra purge later.
  async function settle(target, entries) {
    const recorded = entries.filter(({ score }) => score !== null);

    if (!pending || !recorded.length) return;

    try {
      await pending.remove(target, recorded);
    } catch (error) {
      console.log(prefix(), "could not clear pending purge for", target, error);
    }
  }

  // The proxy failed to purge these hosts: record them again with a fresh
  // score, whether or not they were recorded up front, so the retry loop
  // has them even if another purge's success removed an earlier record.
  async function record(target, entries) {
    if (!pending || !entries.length) return;

    try {
      await pending.add(
        target,
        entries.map(({ host }) => host),
        nextScore()
      );
    } catch (error) {
      console.log(prefix(), "could not record pending purge for", target, error);
    }
  }

  // Scores identify one purge's records, so a removal only clears its own.
  // A millisecond timestamp plus a random sub-millisecond part makes two
  // processes unlikely to collide, and this process never repeats one.
  function nextScore() {
    const score = Date.now() + Math.floor(Math.random() * 1000) / 1000;
    lastScore = Math.round(Math.max(score, lastScore + 0.001) * 1000) / 1000;
    return lastScore;
  }

  // Record hosts as pending on every proxy before purging them. Returns the
  // score recorded for each proxy, or null where recording failed.
  async function recordAll(hosts) {
    const scores = new Map(reverse_proxies.map((target) => [target, null]));

    if (!pending || !hosts.length) return scores;

    const score = nextScore();

    await Promise.all(
      reverse_proxies.map(async (target) => {
        try {
          await pending.add(target, hosts, score);
          scores.set(target, score);
        } catch (error) {
          console.log(
            prefix(),
            "could not record pending purge for",
            target,
            error
          );
        }
      })
    );

    return scores;
  }

  // Re-send purges that are still pending: ones a proxy failed to accept,
  // and ones a process died before sending.
  async function retryPending() {
    if (!pending || isRetrying) return;

    isRetrying = true;

    try {
      await Promise.all(
        reverse_proxies.map(async (target) => {
          let entries;

          try {
            entries = await pending.list(
              target,
              Date.now() - retryAfterMs,
              maxHostsPerRetry
            );
          } catch (error) {
            console.log(prefix(), "could not list pending purges", error);
            return;
          }

          if (!entries.length) return;

          console.log(prefix(), "retrying", entries.length, "hosts", target);

          try {
            await queues.get(target).add(entries);
          } catch (error) {
            // still failing, try again on the next interval
            console.log(prefix(), "retry failed", error.message);
          }
        })
      );
    } finally {
      isRetrying = false;
    }
  }

  if (pending && reverse_proxies.length > 0 && retryIntervalMs > 0) {
    const timer = setInterval(() => {
      retryPending().catch((error) =>
        console.log(prefix(), "retry error", error)
      );
    }, retryIntervalMs);

    // never keep the process alive just to retry purges
    timer.unref();
  }

  const flush = async (hosts) => {
    // if the host is a string, convert it to an array
    if (typeof hosts === "string") {
      hosts = [hosts];
    }

    // ensure the hosts are an array
    if (!Array.isArray(hosts)) {
      throw new Error("hosts must be a string or an array of strings");
    }

    hosts = Array.from(new Set(hosts));

    const scores = await recordAll(hosts);

    const results = await Promise.allSettled(
      reverse_proxies.map((target) =>
        queues
          .get(target)
          .add(hosts.map((host) => ({ host, score: scores.get(target) })))
      )
    );

    const failures = results.filter(({ status }) => status === "rejected");

    if (!failures.length) return;

    throw new Error(
      `Failed to flush ${failures.length} of ${reverse_proxies.length} proxies: ` +
        failures.map(({ reason }) => reason.message).join("; ")
    );
  };

  flush.retryPending = retryPending;

  return flush;
};
