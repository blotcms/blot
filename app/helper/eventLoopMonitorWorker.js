const { Session } = require("inspector");
const { parentPort, workerData } = require("worker_threads");

// Runs off the main thread. Profiles the main thread in short windows and,
// for any window in which its heartbeat stalled, reports where the time went.

const { shared, windowMs, stallMs } = workerData;

const session = new Session();
session.connectToMainThread();

const post = (method, params) =>
  new Promise((resolve, reject) =>
    session.post(method, params, (err, result) =>
      err ? reject(err) : resolve(result)
    )
  );

let lastBeat = Atomics.load(shared, 0);
let lastBeatAt = Date.now();
let longestStall = 0;

// Poll from a thread the main thread can't block.
setInterval(() => {
  const beat = Atomics.load(shared, 0);
  const now = Date.now();
  if (beat !== lastBeat) {
    lastBeat = beat;
    lastBeatAt = now;
  } else {
    longestStall = Math.max(longestStall, now - lastBeatAt);
  }
}, 50);

const IDLE = new Set(["(idle)", "(root)"]);

function summarise(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children || []) parent.set(child, node.id);
  }

  const label = (node) => {
    const { functionName, url, lineNumber } = node.callFrame;
    const file = url ? url.replace(/^.*\/(app|node_modules)\//, "$1/") : "";
    return (functionName || "(anonymous)") + (file ? ` ${file}:${lineNumber + 1}` : "");
  };

  const stackOf = (id) => {
    const frames = [];
    for (let at = id; at !== undefined && frames.length < 5; at = parent.get(at)) {
      const node = nodes.get(at);
      if (!IDLE.has(node.callFrame.functionName)) frames.push(label(node));
    }
    return frames.join(" <- ");
  };

  const totals = new Map();
  let busy = 0;
  profile.samples.forEach((id, i) => {
    const node = nodes.get(id);
    if (node.callFrame.functionName === "(idle)") return;
    const delta = (profile.timeDeltas[i] || 0) / 1000;
    busy += delta;
    const key = stackOf(id);
    totals.set(key, (totals.get(key) || 0) + delta);
  });

  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([stack, time]) => `${Math.round(time)}ms ${stack}`);

  return { busyMs: Math.round(busy), top };
}

async function loop() {
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 5000 });

  for (;;) {
    longestStall = 0;
    await post("Profiler.start");
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    const { profile } = await post("Profiler.stop");
    if (longestStall >= stallMs) {
      parentPort.postMessage(
        JSON.stringify({ stallMs: longestStall, ...summarise(profile) })
      );
    }
  }
}

loop().catch((err) => {
  throw err;
});
