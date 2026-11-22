const client = require("models/client");
const Blog = require("models/blog");
const clfdate = require("helper/clfdate");

// A deploy can kill the process between the steps of Blog.remove. Remove
// records each blog in key.removing (scored with the time it may next be
// resumed) before its first step and drops it after the last, so this finds
// the ones a kill left behind and runs remove again, which every step allows.
//
// A blog that keeps failing waits longer each time (BACKOFF_MS, doubling up to
// a day) and is given up on after MAX_ATTEMPTS. A blog given up on is only
// logged, once a day, and stays in the set for the maintainer to look at.
const MAX_ATTEMPTS = 8;
const BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

function backoff(attempts) {
  return Math.min(BACKOFF_MS * Math.pow(2, attempts - 1), MAX_BACKOFF_MS);
}

async function reschedule(blogID, now, delay) {
  // XX: a blog finished meanwhile is not added back
  await client.zAdd(
    Blog.key.removing,
    { score: now + delay, value: blogID },
    { XX: true }
  );
}

// Resolves to { resumed: [ids], failed: [ids], gaveUp: [ids] }
async function resumeBlogRemoval({ now = Date.now() } = {}) {
  const result = { resumed: [], failed: [], gaveUp: [] };
  const due = await client.zRangeByScore(Blog.key.removing, "-inf", now);

  for (const blogID of due) {
    const attempts = Number(
      (await client.hGet(Blog.key.removalAttempts, blogID)) || 0
    );

    if (attempts >= MAX_ATTEMPTS) {
      console.error(
        clfdate(),
        "ERROR Blog removal: giving up on " + blogID + " after",
        attempts,
        "attempts; it stays in " + Blog.key.removing
      );
      result.gaveUp.push(blogID);
      await reschedule(blogID, now, MAX_BACKOFF_MS);
      continue;
    }

    const made = await client.hIncrBy(Blog.key.removalAttempts, blogID, 1);

    // Wait before the next attempt in case this one dies partway
    await reschedule(blogID, now, backoff(made));

    console.log(
      clfdate(),
      "Blog removal: resuming " + blogID + " (attempt " + made + ")"
    );

    try {
      await Blog.remove(blogID);
      result.resumed.push(blogID);
      console.log(clfdate(), "Blog removal: finished " + blogID);
    } catch (err) {
      result.failed.push(blogID);
      console.error(
        clfdate(),
        "ERROR Blog removal: could not finish " + blogID + " (attempt " + made,
        "of " + MAX_ATTEMPTS + ")",
        err
      );
    }
  }

  return result;
}

module.exports = resumeBlogRemoval;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
