// A blog's actions run several at a time (see limiters.js), but two changes
// to one path, or to a folder and something inside it, must reach Blot in the
// order they happened: an upload overtaken by an older removal of the same
// file deletes it from Blot, and a file can't be pushed into a folder before
// the folder's removal has gone through. takeTurn() hands out turns in the
// order it is called; a turn is ready once every earlier, unfinished turn on
// the same path, an ancestor or a descendant has finished.
//
// Paths are compared without case and in one Unicode form, as the disk
// compares them: a rename from "Post.md" to "post.md" is a removal and an
// upload of what Blot treats as the same file.

const blogs = new Map(); // blogID -> { at, under, pending }

const keyOf = (path) =>
  path
    .normalize("NFC")
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "");

// "a/b/c" -> ["a/b", "a"]
const ancestorsOf = (key) => {
  const ancestors = [];
  for (let i = key.lastIndexOf("/"); i > 0; i = key.lastIndexOf("/", i - 1))
    ancestors.push(key.slice(0, i));
  return ancestors;
};

const addTo = (map, key, turn) => {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(turn);
};

const removeFrom = (map, key, turn) => {
  const turns = map.get(key);
  if (!turns) return;
  turns.delete(turn);
  if (!turns.size) map.delete(key);
};

// Returns { ready, done }: wait for ready, act, then call done (always, even
// when the action fails or never ran), or every later turn on the path waits
// for ever.
const takeTurn = (blogID, path) => {
  const key = keyOf(path);
  const ancestors = ancestorsOf(key);

  if (!blogs.has(blogID))
    blogs.set(blogID, { at: new Map(), under: new Map(), pending: 0 });
  const blog = blogs.get(blogID);

  const earlier = [];
  const collect = (turns) => {
    if (turns) for (const turn of turns) earlier.push(turn.finished);
  };
  collect(blog.at.get(key));
  for (const ancestor of ancestors) collect(blog.at.get(ancestor));
  collect(blog.under.get(key));

  let finish;
  const turn = {
    finished: new Promise((resolve) => (finish = resolve)),
    since: Date.now(),
  };

  addTo(blog.at, key, turn);
  for (const ancestor of ancestors) addTo(blog.under, ancestor, turn);
  blog.pending++;

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    removeFrom(blog.at, key, turn);
    for (const ancestor of ancestors) removeFrom(blog.under, ancestor, turn);
    if (--blog.pending === 0 && blogs.get(blogID) === blog)
      blogs.delete(blogID);
    finish();
  };

  return { ready: Promise.all(earlier).then(() => {}), done };
};

// for specs
const pendingTurns = (blogID) => blogs.get(blogID)?.pending || 0;

// Every action waiting for its turn or running, for /stats: how many, how
// long the oldest has waited, and the blog with the most. A turn is listed
// once under its own path (blog.at), so this counts each action once.
const backlog = (now = Date.now()) => {
  let pending = 0;
  let oldest = null;
  let busiest = null;
  for (const [blogID, blog] of blogs) {
    pending += blog.pending;
    if (!busiest || blog.pending > busiest.pending)
      busiest = { blogID, pending: blog.pending };
    for (const turns of blog.at.values())
      for (const turn of turns)
        if (oldest === null || turn.since < oldest) oldest = turn.since;
  }
  return {
    pending,
    oldestMs: oldest === null ? 0 : now - oldest,
    busiest: busiest && busiest.pending ? busiest : null,
  };
};

export { takeTurn, pendingTurns, backlog, keyOf };
