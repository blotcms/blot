// Parses the three kinds of git object which point at other objects: commits,
// trees and tags. A blob points at nothing. Each takes the object's data (what
// `git cat-file <type>` prints) and throws CorruptError if it isn't one, so
// bytes which have passed the hash check but are not an object git would
// accept never become a surprise further on.
const { CorruptError } = require("./errors");

const OID = /^[0-9a-f]{40}$/;

const DIRECTORY = "40000";
const GITLINK = "160000";

function fail(what, why) {
  throw new CorruptError("Invalid " + what + ": " + why);
}

// The header lines of a commit or tag (up to the blank line) and the message
// after them. A header can continue on following lines that start with a
// space (a signature), so those are joined to the line they belong to.
function parseHeaders(buffer, what) {
  const text = buffer.toString("utf8");
  const blank = text.indexOf("\n\n");
  const head = blank === -1 ? text.replace(/\n$/, "") : text.slice(0, blank);
  const message = blank === -1 ? "" : text.slice(blank + 2);

  const headers = [];
  for (const line of head.split("\n")) {
    if (line.startsWith(" ") && headers.length) {
      headers[headers.length - 1].value += "\n" + line.slice(1);
      continue;
    }
    const space = line.indexOf(" ");
    if (space < 1) fail(what, "a header line has no name");
    headers.push({ name: line.slice(0, space), value: line.slice(space + 1) });
  }
  return { headers, message };
}

function one(headers, name, what) {
  const found = headers.filter((header) => header.name === name);
  if (found.length !== 1) fail(what, "it must have exactly one " + name + " line");
  return found[0].value;
}

function oidOf(value, what, name) {
  if (!OID.test(value)) fail(what, name + " is not an object ID");
  return value;
}

// { tree, parents, author, committer, message }. `author` and `committer` are
// the lines as written ("Name <email> 1700000000 +0000").
function parseCommit(buffer) {
  const { headers, message } = parseHeaders(buffer, "commit");
  if (headers[0].name !== "tree") fail("commit", "it must start with its tree");

  const parents = headers.filter((header) => header.name === "parent").map((header) => oidOf(header.value, "commit", "parent"));
  return {
    tree: oidOf(one(headers, "tree", "commit"), "commit", "tree"),
    parents,
    author: one(headers, "author", "commit"),
    committer: one(headers, "committer", "commit"),
    message,
  };
}

// [{ mode, name, oid }] in the order stored. `mode` is as git writes it in
// the tree ("100644", "100755", "120000", "40000" for a directory, "160000"
// for a submodule), not zero-padded. `name` is decoded as UTF-8; `nameBytes` is
// the name as stored, and `validName` is false if those bytes are not UTF-8,
// in which case `name` holds replacement characters and cannot be used to
// tell two such names apart.
function parseTree(buffer) {
  const entries = [];
  let at = 0;

  while (at < buffer.length) {
    const space = buffer.indexOf(32, at);
    const nul = space === -1 ? -1 : buffer.indexOf(0, space);
    if (nul === -1 || nul + 21 > buffer.length) fail("tree", "an entry is cut short");

    const mode = buffer.toString("latin1", at, space);
    if (!/^[0-7]{5,6}$/.test(mode)) fail("tree", "an entry has the mode " + JSON.stringify(mode));

    const nameBytes = buffer.subarray(space + 1, nul);
    const name = nameBytes.toString("utf8");

    entries.push({
      mode,
      name,
      nameBytes,
      validName: Buffer.from(name, "utf8").equals(nameBytes),
      oid: buffer.toString("hex", nul + 1, nul + 21),
    });
    at = nul + 21;
  }

  return entries;
}

// { object, type, tag, tagger, message }: the object a tag points at, and its
// type ("commit" for the usual tag)
function parseTag(buffer) {
  const { headers, message } = parseHeaders(buffer, "tag");
  const tagger = headers.find((header) => header.name === "tagger");

  return {
    object: oidOf(one(headers, "object", "tag"), "tag", "object"),
    type: one(headers, "type", "tag"),
    tag: one(headers, "tag", "tag"),
    tagger: tagger ? tagger.value : null,
    message,
  };
}

const isDirectory = (entry) => entry.mode === DIRECTORY;
const isGitlink = (entry) => entry.mode === GITLINK;

module.exports = { parseCommit, parseTree, parseTag, isDirectory, isGitlink };
