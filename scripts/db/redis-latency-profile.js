#!/usr/bin/env node

const redis = require("redis");

function parseArgs(argv) {
  const args = {
    host: process.env.BLOT_REDIS_HOST || "127.0.0.1",
    port: process.env.BLOT_REDIS_PORT
      ? parseInt(process.env.BLOT_REDIS_PORT, 10)
      : 6379,
    socket: process.env.BLOT_REDIS_SOCKET || undefined,
    intervalMs: 3000,
    samplesPerPoll: 5,
    reportEveryMs: 60000,
    maxSamples: 2000,
  };

  for (let i = 2; i < argv.length; i++) {
    const part = argv[i];
    const next = argv[i + 1];

    if (part === "--socket" && next) {
      args.socket = next;
      i++;
      continue;
    }

    // An explicit host means TCP, whatever BLOT_REDIS_SOCKET says
    if (part === "--host" && next) {
      args.host = next;
      args.socket = undefined;
      i++;
      continue;
    }

    if (part === "--port" && next) {
      args.port = parseInt(next, 10);
      i++;
      continue;
    }

    if (part === "--interval-ms" && next) {
      args.intervalMs = parseInt(next, 10);
      i++;
      continue;
    }

    if (part === "--samples-per-poll" && next) {
      args.samplesPerPoll = parseInt(next, 10);
      i++;
      continue;
    }

    if (part === "--report-every-ms" && next) {
      args.reportEveryMs = parseInt(next, 10);
      i++;
      continue;
    }

    if (part === "--max-samples" && next) {
      args.maxSamples = parseInt(next, 10);
      i++;
      continue;
    }

    if (part === "--help") {
      console.log(`Usage: node scripts/util/redis-latency-profile.js [options]\n\nOptions:\n  --host <host>                Redis host (default: BLOT_REDIS_HOST or 127.0.0.1)\n  --socket <path>              Redis Unix socket, used instead of host and port (default: BLOT_REDIS_SOCKET)\n  --port <port>                Redis port (default: BLOT_REDIS_PORT or 6379)\n  --interval-ms <ms>           Delay between polls (default: 3000)\n  --samples-per-poll <n>       Number of ping samples per poll (default: 5)\n  --report-every-ms <ms>       How often to print recommendations (default: 60000)\n  --max-samples <n>            Max rolling sample count retained (default: 2000)\n  --help                       Show this help message\n`);
      process.exit(0);
    }

    throw new Error(`Unknown or incomplete argument: ${part}`);
  }

  if (
    Number.isNaN(args.port) ||
    Number.isNaN(args.intervalMs) ||
    Number.isNaN(args.samplesPerPoll) ||
    Number.isNaN(args.reportEveryMs) ||
    Number.isNaN(args.maxSamples)
  ) {
    throw new Error("Invalid numeric argument.");
  }

  return args;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0] || 0;
  const max = sorted[count - 1] || 0;

  const mean = sorted.reduce((acc, value) => acc + value, 0) / count;

  let variance = 0;
  for (const value of sorted) {
    const d = value - mean;
    variance += d * d;
  }
  variance /= count;

  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);

  return {
    count,
    min,
    max,
    mean,
    stddev: Math.sqrt(variance),
    p50,
    p90,
    p95,
    p99,
  };
}

function recommendToxiproxy(stats) {
  const latency = Math.max(1, Math.round(stats.p50));
  const jitter = Math.max(0, Math.round(stats.p95 - stats.p50));
  const conservativeLatency = Math.max(1, Math.round(stats.p90));
  const conservativeJitter = Math.max(0, Math.round(stats.p99 - stats.p90));

  return {
    latency,
    jitter,
    conservativeLatency,
    conservativeJitter,
  };
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

function pingSample(client) {
  const start = process.hrtime.bigint();
  return client.ping().then(() => Number(process.hrtime.bigint() - start) / 1e6);
}

async function collectSamples(client, count) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const sample = await pingSample(client);
    samples.push(sample);
  }
  return samples;
}

async function main() {
  const args = parseArgs(process.argv);
  const client = redis.createClient({
    ...(args.socket ? {} : { url: `redis://${args.host}:${args.port}` }),
    RESP: 2,
    commandOptions: { timeout: undefined },
    socket: {
      ...(args.socket ? { path: args.socket } : {}),
      keepAliveInitialDelay: 5000,
      reconnectStrategy: () => 1000,
    },
  });

  client.on("error", (err) => {
    console.error(`[redis-latency-profile] redis error: ${err.message}`);
  });

  const sampleWindow = [];
  let polls = 0;
  let shuttingDown = false;

  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[redis-latency-profile] stopping...");
    try {
      await client.quit();
      process.exit(0);
    } catch (err) {
      console.error(`[redis-latency-profile] shutdown failed: ${err.message}`);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });

  await client.connect();

  console.log("[redis-latency-profile] started");
  console.log(
    `[redis-latency-profile] redis=${args.socket || args.host + ":" + args.port}, interval=${args.intervalMs}ms, samples-per-poll=${args.samplesPerPoll}, report-every=${args.reportEveryMs}ms`
  );

  const report = () => {
    if (!sampleWindow.length) {
      console.log("[redis-latency-profile] no samples yet");
      return;
    }

    const stats = summarize(sampleWindow);
    const recommendation = recommendToxiproxy(stats);

    console.log("\n[redis-latency-profile] report");
    console.log(
      `  samples=${stats.count}, polls=${polls}, min=${formatMs(stats.min)}, mean=${formatMs(
        stats.mean
      )}, p50=${formatMs(stats.p50)}, p90=${formatMs(stats.p90)}, p95=${formatMs(
        stats.p95
      )}, p99=${formatMs(stats.p99)}, max=${formatMs(stats.max)}, stddev=${formatMs(stats.stddev)}`
    );
    console.log(
      `  recommended (typical): BLOT_TOXIPROXY_LATENCY_MS=${recommendation.latency} BLOT_TOXIPROXY_JITTER_MS=${recommendation.jitter}`
    );
    console.log(
      `  recommended (conservative): BLOT_TOXIPROXY_LATENCY_MS=${recommendation.conservativeLatency} BLOT_TOXIPROXY_JITTER_MS=${recommendation.conservativeJitter}`
    );
  };

  report();
  setInterval(report, args.reportEveryMs);

  while (true) {
    try {
      const pollSamples = await collectSamples(client, args.samplesPerPoll);
      sampleWindow.push(...pollSamples);
      if (sampleWindow.length > args.maxSamples) {
        sampleWindow.splice(0, sampleWindow.length - args.maxSamples);
      }
      polls += 1;
    } catch (err) {
      console.error(`[redis-latency-profile] sample failed: ${err.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
  }
}

main().catch((err) => {
  console.error(`[redis-latency-profile] fatal error: ${err.message}`);
  process.exit(1);
});
