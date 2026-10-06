const clfdate = require("./clfdate");
const prefix = () => `${clfdate()} flushCache:`;

// Purges hosts from every reverse proxy's cache.
//
// Cached pages stay cached until purged, so a proxy that misses a purge
// serves stale HTML indefinitely. Each proxy is therefore purged
// independently (one failing or hanging proxy must not skip the others), and
// when a `pending` store is supplied the hosts a proxy missed are recorded
// and retried until that proxy accepts them.
//
// pending: {
//   add(target, hosts)        record hosts a proxy failed to purge
//   list(target)              -> [{ host, score }]
//   remove(target, entries)   drop entries unchanged since list()
// }
module.exports = ({
  reverse_proxies,
  requestsPerSecond = 3,
  maxHostsPerPurge = 10,
  timeoutMs = 5000,
  retryIntervalMs = 30 * 1000,
  token,
  pending,
}) => {
  let queue = new Set(); // Changed to Set to automatically handle duplicates
  let isProcessing = false;
  let lastRequestTime = 0;
  let currentBatchResolvers = [];
  let isRetrying = false;

  const minimumGap = 1000 / requestsPerSecond;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function add(hosts) {
    return new Promise((resolve, reject) => {
      // Add all hosts to the Set (duplicates will be automatically ignored)
      hosts.forEach((host) => queue.add(host));
      currentBatchResolvers.push({ resolve, reject });
      process();
    });
  }

  async function process() {
    if (isProcessing) return;

    isProcessing = true;

    let failure = null;

    while (queue.size > 0) {
      console.log(prefix(), "processing", queue.size, "hosts");
      const timeSinceLastRequest = Date.now() - lastRequestTime;

      if (timeSinceLastRequest < minimumGap) {
        await sleep(minimumGap - timeSinceLastRequest);
      }

      // Convert part of the Set to Array for processing
      const hostsBatch = Array.from(queue).slice(0, maxHostsPerPurge);
      // Remove processed hosts from the Set
      hostsBatch.forEach((host) => queue.delete(host));

      try {
        await flushHosts(hostsBatch);
      } catch (error) {
        // Keep going: the remaining hosts still need purging, and the hosts
        // in this batch have already been recorded as pending per proxy.
        failure = failure || error;
      }

      lastRequestTime = Date.now();
    }

    const resolvers = currentBatchResolvers;
    currentBatchResolvers = [];
    resolvers.forEach(({ resolve, reject }) =>
      failure ? reject(failure) : resolve()
    );

    console.log(prefix(), "done processing, queue is empty");
    isProcessing = false;
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

  async function flushHosts(hosts) {
    const results = await Promise.allSettled(
      reverse_proxies.map((reverse_proxy_url) =>
        purgeTarget(reverse_proxy_url, hosts)
      )
    );

    const failures = [];

    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failures.push({ target: reverse_proxies[i], error: result.reason });
      }
    });

    if (!failures.length) return;

    await Promise.all(
      failures.map(async ({ target, error }) => {
        console.log(prefix(), error.message);

        if (!pending) return;

        try {
          await pending.add(target, hosts);
        } catch (pendingError) {
          console.log(
            prefix(),
            "could not record pending purge for",
            target,
            pendingError
          );
        }
      })
    );

    throw new Error(
      `Failed to flush ${failures.length} of ${reverse_proxies.length} proxies: ` +
        failures.map(({ error }) => error.message).join("; ")
    );
  }

  // Re-send purges that a proxy previously failed to accept
  async function retryPending() {
    if (!pending || isRetrying) return;

    isRetrying = true;

    try {
      for (const target of reverse_proxies) {
        let entries;

        try {
          entries = await pending.list(target);
        } catch (error) {
          console.log(prefix(), "could not list pending purges", error);
          continue;
        }

        for (let i = 0; i < entries.length; i += maxHostsPerPurge) {
          const batch = entries.slice(i, i + maxHostsPerPurge);

          try {
            await purgeTarget(
              target,
              batch.map(({ host }) => host)
            );
            await pending.remove(target, batch);
          } catch (error) {
            // still unreachable, try again on the next interval
            console.log(prefix(), "retry failed", error.message);
            break;
          }

          await sleep(minimumGap);
        }
      }
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

    await add(hosts);
  };

  flush.retryPending = retryPending;

  return flush;
};
