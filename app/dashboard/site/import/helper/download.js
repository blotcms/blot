const airlock = require("helper/airlock");
const lifecycle = require("../lifecycle");

// Each import processes assets sequentially. Keep per-asset memory and total
// transferred data bounded independently of remote Content-Length headers.
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

// Count decompressed response bytes, including chunked bodies. The deadline
// covers both headers and body consumption, and abort destroys the socket.
module.exports = async function download(url, options = {}) {
  const { timeout = 5000, maxBytes = MAX_BYTES, ...fetchOptions } = options;
  lifecycle.check();
  const state = lifecycle.current();
  const signal = fetchOptions.signal || (state && state.signal);
  const controller = new AbortController();
  let body;
  const abort = () => {
    controller.abort();
    if (body && !body.destroyed) body.destroy(lifecycle.cancelled());
  };
  if (signal) {
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
  }
  const timer = setTimeout(abort, timeout);
  try {
    const response = await airlock.fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      size: maxBytes,
    });
    body = response.body;
    if (controller.signal.aborted) throw lifecycle.cancelled();
    if (!response.ok) throw new Error("Bad status code: " + response.status);
    if (Number(response.headers.get("content-length")) > maxBytes) {
      throw new Error("Import download exceeds byte limit");
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of body) {
      // lifecycle.check() does synchronous filesystem I/O (existsSync/
      // readJsonSync); calling it once per stream chunk would block the
      // event loop hundreds of times per download. lifecycle's own 250ms
      // background timer (see lifecycle.js) already polls the same state and
      // aborts this signal, and an explicit cancel aborts it immediately, so
      // checking it here is enough to react promptly without the extra I/O.
      if (controller.signal.aborted) throw lifecycle.cancelled();
      bytes += chunk.length;
      if (state) state.bytes += chunk.length;
      if (state && state.bytes > MAX_IMPORT_BYTES) {
        const error = new Error("Import exceeds 1 GiB download limit");
        error.code = "IMPORT_BYTE_LIMIT";
        state.abort(error);
        throw error;
      }
      if (bytes > maxBytes) throw new Error("Import download exceeds byte limit");
      chunks.push(chunk);
    }
    if (controller.signal.aborted) throw lifecycle.cancelled();
    return { data: Buffer.concat(chunks, bytes), headers: response.headers };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abort);
    controller.abort();
    if (body && !body.destroyed) body.destroy();
  }
};
