// The parts of git's receive-pack protocol that are about the request, not the
// repository: reading the commands of a push (<old> <new> <ref>) up to the
// flush packet, the capabilities Blot advertises and the client asked for,
// and a few helpers for smart HTTP responses. served/receive.js reads a push
// with these and hands the rest (the pack, the checks, the report) to the git
// store's receive (store/receive.js); served/reads.js advertises the same
// capabilities.

// What a push to Blot supports, and so all it advertises. "agent" is only
// logged.
var CAPABILITIES = [
  "report-status",
  "delete-refs",
  "side-band-64k",
  "quiet",
  "ofs-delta",
  "agent=blot",
];

// The command section of a push is a few hundred bytes. A client which sends
// more than this before the flush packet is not git.
var MAX_COMMAND_BYTES = 1024 * 1024;
var MAX_COMMANDS = 5000;

// The longest pkt-line git allows
var MAX_PACKET = 65520;

function noCache(res) {
  res.setHeader("expires", "Fri, 01 Jan 1980 00:00:00 GMT");
  res.setHeader("pragma", "no-cache");
  res.setHeader("cache-control", "no-cache, max-age=0, must-revalidate");
}

function pktLine(content) {
  var body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  var length = (4 + body.length).toString(16);

  return Buffer.concat([Buffer.from("0000".slice(length.length) + length), body]);
}

function badRequest(message) {
  var err = new Error(message);

  err.badRequest = true;

  return err;
}

// Reads pkt-lines from an async iterator of Buffers up to and including the
// first flush packet. Resolves with the lines and whatever followed the flush
// packet in the last chunk read; the iterator is left to continue from there.
async function readPackets(iterator) {
  var buffer = Buffer.alloc(0);
  var lines = [];
  var size = 0;

  for (;;) {
    while (buffer.length >= 4) {
      var header = buffer.toString("latin1", 0, 4);

      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw badRequest("not a git request");

      var length = parseInt(header, 16);

      if (length === 0) return { lines: lines, rest: buffer.subarray(4) };
      if (length < 4 || length > MAX_PACKET) throw badRequest("invalid packet length");
      if (buffer.length < length) break;

      lines.push(buffer.subarray(4, length));
      size += length;
      buffer = buffer.subarray(length);

      if (size > MAX_COMMAND_BYTES || lines.length > MAX_COMMANDS) {
        throw badRequest("too many commands");
      }
    }

    var next = await iterator.next();

    if (next.done) throw badRequest("the request ended before its commands did");

    buffer = Buffer.concat([buffer, next.value]);
  }
}

// { commands: [{ old, new, ref }], capabilities: ["report-status", ...] }
function parseCommands(lines) {
  var commands = [];
  var capabilities = [];

  lines.forEach(function (line) {
    var text = line.toString("utf8");
    var nul = text.indexOf("\0");

    if (nul !== -1) {
      if (!capabilities.length) {
        capabilities = text
          .slice(nul + 1)
          .replace(/\n$/, "")
          .split(" ")
          .filter(Boolean);
      }
      text = text.slice(0, nul);
    }

    text = text.replace(/\n$/, "");

    // Sent by a client with a shallow clone: the store's receive checks that
    // the pushed commits connect to what it has
    if (/^shallow [0-9a-f]{40}$/.test(text)) return;

    var match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text);

    if (!match) throw badRequest("malformed command");

    commands.push({ old: match[1], new: match[2], ref: match[3] });
  });

  return { commands: commands, capabilities: capabilities };
}

function capability(capabilities, name) {
  for (var i = 0; i < capabilities.length; i++) {
    if (capabilities[i] === name) return true;
    if (capabilities[i].indexOf(name + "=") === 0) return capabilities[i].slice(name.length + 1);
  }

  return false;
}

// The sizes git reads from config are written like 1900m
function parseSize(value) {
  var match = /^(\d+)([kmg]?)$/i.exec(String(value).trim());

  if (!match) return 0;

  return Number(match[1]) * Math.pow(1024, " kmg".indexOf((match[2] || " ").toLowerCase()));
}

module.exports = {
  readPackets: readPackets,
  parseCommands: parseCommands,
  CAPABILITIES: CAPABILITIES,
  capability: capability,
  parseSize: parseSize,
  noCache: noCache,
  pktLine: pktLine,
};
