const client = require("models/client");
const Blog = require("models/blog");
const clfdate = require("helper/clfdate");
const lock = require("helper/lock");
const alert = require("helper/alertBlogRemoval");
const decreaseSubscription = require("helper/decreaseSubscription");
const removalBilling = require("models/blog/removalBilling");

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

// A customer's delete also reduces their subscription (models/blog/
// removalBilling). A reduction that can't be made is retried on every run, with
// the maintainer emailed at most once a day for it, and dropped after this long.
const BILLING_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
const ALERT_TTL_MS = 24 * 60 * 60 * 1000;

// At most one alert a day for each thing that keeps failing
async function alertOnce(name, summary, details) {
  if (await lock.once("notify:blog-removal:" + name, ALERT_TTL_MS))
    await alert(summary, details);
}

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

// Resolves to { resumed, failed, gaveUp: [blog ids], billed: [blog ids whose
// owner's subscription was reduced] }
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
      await alertOnce(
        blogID,
        "gave up removing " + blogID,
        "It failed " + attempts + " attempts and stays in " + Blog.key.removing
      );
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

  result.billed = await reduceSubscriptions(now);

  return result;
}

// The blogs a customer deleted whose removal has finished, with the owner's
// subscription still to reduce. The quantity is worked out from the owner's
// blogs as they are now, so it doesn't matter if the delete route did it too.
async function reduceSubscriptions(now) {
  const billed = [];

  for (const { blogID, uid, at } of await removalBilling.pending()) {
    // The delete route may still be running
    if (now - at < Blog.RESUME_AFTER_MS) continue;

    try {
      // Still being removed: wait for it
      if ((await client.zScore(Blog.key.removing, blogID)) !== null) continue;

      // The removal never started, so there is nothing to reduce for
      if (await Blog.get({ id: blogID })) {
        await removalBilling.clear(blogID);
        continue;
      }

      const outcome = uid ? await decreaseSubscription(uid) : {};

      await removalBilling.clear(blogID);
      if (outcome.changed) {
        billed.push(blogID);
        console.log(
          clfdate(),
          "Subscription decrease: reduced " + uid + " to",
          outcome.quantity,
          "after " + blogID
        );
      }
    } catch (err) {
      console.error(
        clfdate(),
        "ERROR Subscription decrease: could not reduce " + uid + " after",
        blogID,
        err
      );
      await alertOnce(
        "billing:" + blogID,
        "could not reduce the subscription of " + uid,
        "After " + blogID + " was deleted: " + err.message
      );

      if (now - at > BILLING_GIVE_UP_MS) {
        await alert(
          "gave up reducing the subscription of " + uid,
          "After " + blogID + " was deleted: " + err.message
        );
        await removalBilling.clear(blogID);
      }
    }
  }

  return billed;
}

module.exports = resumeBlogRemoval;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
