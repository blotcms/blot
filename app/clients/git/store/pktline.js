// The two things of git's pkt-line format the store needs: framing a packet,
// and splitting a request into packets.
//
// A packet is four hex digits giving its whole length (the digits included)
// and then its content. "0000" is a flush packet, which has no content.
const { ProtocolError } = require("./errors");

// The most a packet can hold, the four length digits included
const MAX_PACKET = 65520;

const FLUSH = Buffer.from("0000");

function packet(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (body.length + 4 > MAX_PACKET)
    throw new Error("A pkt-line is at most " + MAX_PACKET + " bytes");
  return Buffer.concat([
    Buffer.from((body.length + 4).toString(16).padStart(4, "0")),
    body,
  ]);
}

// Splits a whole request body into [{ flush: true } | { data: Buffer }], the
// data without the trailing newline git puts on most lines
function split(body) {
  const packets = [];
  let at = 0;

  while (at < body.length) {
    const digits = body.toString("latin1", at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(digits))
      throw new ProtocolError("Bad pkt-line length");

    const length = parseInt(digits, 16);
    if (length === 0) {
      packets.push({ flush: true });
      at += 4;
      continue;
    }
    // 0001 (delimiter) and 0002 (response end) are protocol version 2
    if (length < 4 || at + length > body.length)
      throw new ProtocolError("Bad pkt-line length");

    let end = at + length;
    if (body[end - 1] === 10) end--;
    packets.push({ data: body.subarray(at + 4, end) });
    at += length;
  }

  return packets;
}

module.exports = { MAX_PACKET, FLUSH, packet, split };
