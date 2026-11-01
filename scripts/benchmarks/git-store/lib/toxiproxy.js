// A small client for toxiproxy's HTTP API (the proxy "minio" in toxiproxy.json)
const profiles = require("./profiles");

const API = process.env.GIT_STORE_SPIKE_TOXIPROXY || "http://127.0.0.1:18474";
const PROXY = "minio";

async function call(method, path, body) {
  // The API closes idle connections, which fetch may reuse just as it does;
  // a reset is retried once
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(API + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (err) {
      if (attempt) throw err;
    }
  }
  if (!res.ok && res.status !== 404) throw new Error(method + " " + path + " " + res.status + " " + (await res.text()));
  return res.status === 204 || res.status === 404 ? null : res.json().catch(() => null);
}

async function clear() {
  const proxy = await call("GET", "/proxies/" + PROXY);
  for (const toxic of (proxy && proxy.toxics) || []) {
    await call("DELETE", "/proxies/" + PROXY + "/toxics/" + toxic.name);
  }
  await call("POST", "/proxies/" + PROXY, { enabled: true });
}

async function add(toxic) {
  return call("POST", "/proxies/" + PROXY + "/toxics", toxic);
}

// Makes the proxy behave as the named profile. Existing connections keep
// their old toxics, so callers make new clients after switching.
async function useProfile(name) {
  const profile = profiles[name];
  if (!profile) throw new Error("Unknown profile " + name);
  await clear();
  if (profile.latencyMs) {
    await add({
      name: "latency",
      type: "latency",
      stream: "downstream",
      toxicity: 1,
      attributes: { latency: profile.latencyMs, jitter: profile.jitterMs },
    });
  }
  if (profile.rateKBps) {
    for (const stream of ["upstream", "downstream"]) {
      await add({
        name: "bandwidth-" + stream,
        type: "bandwidth",
        stream,
        toxicity: 1,
        attributes: { rate: profile.rateKBps },
      });
    }
  }
}

// Failure injection. `reset_peer` closes connections with a TCP reset after
// `timeout` ms (0 is at once); `timeout` with 0 stalls a connection for ever
// (data is held back and dropped when the connection closes); `limit_data`
// cuts the stream after `bytes`.
async function resetAfterBytes(bytes, stream = "downstream") {
  return add({ name: "limit-" + stream, type: "limit_data", stream, toxicity: 1, attributes: { bytes } });
}

async function reset(stream = "downstream", timeout = 0) {
  return add({ name: "reset-" + stream, type: "reset_peer", stream, toxicity: 1, attributes: { timeout } });
}

async function stall(stream = "downstream") {
  return add({ name: "stall-" + stream, type: "timeout", stream, toxicity: 1, attributes: { timeout: 0 } });
}

module.exports = { useProfile, clear, add, reset, stall, resetAfterBytes, call, PROXY };
