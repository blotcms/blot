// The memory the machine this process runs on has available, for
// check-redis-host.js (blotcms/blot#2261). Containers here have no lxcfs, so
// /proc/meminfo inside one is the host's. MemAvailable is what can be handed
// out without swapping, counting page cache that is easily dropped, so a busy
// page cache does not look like a shortage (MemFree would). os.freemem() reads
// the same field on libuv 1.45 and later (every Node this repo runs), but
// reading the file keeps that from depending on the runtime.
const fs = require("fs");

// { total, available } in bytes, or null if the text has neither.
function parse(text) {
  const kb = (name) => {
    const match = new RegExp("^" + name + ":\\s+(\\d+)\\s*kB", "m").exec(
      String(text)
    );
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");

  return total > 0 && available !== null ? { total, available } : null;
}

// Null where there is no /proc/meminfo (development on a Mac).
async function read(path = "/proc/meminfo") {
  try {
    return parse(await fs.promises.readFile(path, "utf8"));
  } catch (e) {
    return null;
  }
}

module.exports = read;
module.exports.parse = parse;
