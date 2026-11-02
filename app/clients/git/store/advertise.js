// The ref advertisement for git-upload-pack: what GET /info/refs?service=git-upload-pack
// answers. It is built from the manifest alone, so it costs the object store
// nothing.
//
// This is protocol version 0 whatever the client asks for. A client which sends
// "Git-Protocol: version=2" gets a version 0 advertisement and falls back to it,
// as it does with Blot's endpoint today. The host must not pass that header on.
//
// It offers only what clone.js does. Left out on purpose: shallow, deepen-* and
// filter (not offered, and refused if asked for), multi_ack and no-done (there is
// no negotiation until fetch is built), thin-pack (a clone's pack is never thin),
// allow-*-sha1-in-want, and include-tag (a clone asks for every tag itself).
// Annotated tags are listed without their peeled "^{}" line, since peeling needs
// the object; git does not need it to clone.
const { packet, FLUSH } = require("./pktline");

const ZERO = "0".repeat(40);

const CAPABILITIES = ["side-band-64k", "ofs-delta", "no-progress", "object-format=sha1"];

const CONTENT_TYPE = "application/x-git-upload-pack-advertisement";

// The service line which comes first in a smart HTTP advertisement
const SERVICE = Buffer.concat([packet("# service=git-upload-pack\n"), FLUSH]);

// The body to answer with, as a Buffer. Refs are sorted by name, as git sorts
// them, and HEAD (when the branch it points to exists) is first.
function advertise(manifest, { agent = "blot-git-store" } = {}) {
  const capabilities = CAPABILITIES.slice();
  const lines = [];

  if (manifest.head && manifest.refs[manifest.head]) {
    lines.push(manifest.refs[manifest.head] + " HEAD");
    capabilities.push("symref=HEAD:" + manifest.head);
  }

  const names = Object.keys(manifest.refs).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const name of names) lines.push(manifest.refs[name] + " " + name);

  capabilities.push("agent=" + agent);

  // A repository with no refs is advertised the way git does it
  if (!lines.length) lines.push(ZERO + " capabilities^{}");

  const packets = lines.map((line, index) => packet(line + (index === 0 ? "\0" + capabilities.join(" ") : "") + "\n"));
  return Buffer.concat([SERVICE, ...packets, FLUSH]);
}

module.exports = { advertise, CAPABILITIES, CONTENT_TYPE };
