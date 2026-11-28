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
//
// Each restored field is a copy, not a slice: a V8 slice keeps the whole
// string it was cut from alive, so a list or cache that keeps an entry's
// teaser and drops its html (blog/render/retrieve/projectEntryFields) would
// keep the html too (#2795). Copying costs less than parsing the same text
// from JSON did, so reading an entry still costs less than before: on a
// catalog shaped like the largest blogs', 3 ms less to decode its ~1,300
// entries at the median (#3014).

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

  if (typeof entry.teaser === "number") {
    entry.teaser = copy(html.slice(0, entry.teaser));
  }
  if (typeof entry.body === "number") entry.body = copy(html.slice(entry.body));
  if (typeof entry.teaserBody === "number") {
    entry.teaserBody = copy(entry.teaser.slice(entry.teaserBody));
  }

  return entry;
}

// A string with its own characters, holding nothing else alive. V8 copies
// the characters when it slices a concatenation, so the slice it returns
// refers to that copy rather than to the string the field was cut from.
function copy(string) {
  return (" " + string).slice(1);
}

module.exports = { encode, decode };
