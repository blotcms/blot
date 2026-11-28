// How an entry is stored in its Redis string (blog:<id>:entry:<path>).
//
// An entry's HTML is usually stored more than once: `body` is `html` with
// the title removed, so it is `html` itself or its end (57% of entries,
// blotcms/blot#3014), and `teaser` and `teaserBody` are the same kind of
// pair, with `teaser` the start of `html` or all of it. Each copy is stored
// as a number that says where in the other field it is instead:
//
//   teaser      n  is html.slice(0, n)
//   body        n  is html.slice(n)
//   teaserBody  n  is teaser.slice(n)
//
// A number can't be confused with a stored field, which is always a string,
// so entries stored before this, with every field written out, read the same.
// Restoring a field is a slice of a string already parsed, which V8 makes
// without copying, so reading an entry costs less than before: there is less
// JSON to parse.

// Fields shorter than this are left as they are: a number would save little
const MIN_LENGTH = 16;

// The JSON text to store for an entry
function encode(entry) {
  const { html, teaser, body, teaserBody } = entry;
  const stored = { ...entry };

  if (typeof html === "string") {
    if (isPart(teaser) && html.startsWith(teaser)) {
      stored.teaser = teaser.length;
    }

    if (isPart(body) && html.endsWith(body)) {
      stored.body = html.length - body.length;
    }
  }

  if (typeof teaser === "string" && isPart(teaserBody)) {
    if (teaser.endsWith(teaserBody)) {
      stored.teaserBody = teaser.length - teaserBody.length;
    }
  }

  return JSON.stringify(stored);
}

function isPart(value) {
  return typeof value === "string" && value.length >= MIN_LENGTH;
}

// The entry stored as this JSON text
function decode(json) {
  const entry = JSON.parse(json);
  const { html } = entry;

  if (typeof entry.teaser === "number")
    entry.teaser = html.slice(0, entry.teaser);
  if (typeof entry.body === "number") entry.body = html.slice(entry.body);
  if (typeof entry.teaserBody === "number") {
    entry.teaserBody = entry.teaser.slice(entry.teaserBody);
  }

  return entry;
}

module.exports = { encode, decode };
