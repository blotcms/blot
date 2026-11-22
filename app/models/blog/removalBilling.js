var client = require("models/client");
var key = require("./key");

// A customer who deletes a site from the dashboard has their Stripe
// subscription reduced after the removal. The route records that here before
// the removal starts, so a kill anywhere between the two leaves it to the
// scheduler (scheduler/resume-blog-removal) to finish. The record is cleared
// once the subscription has been looked at.

async function record(blogID, uid, at = Date.now()) {
  await client.hSet(
    key.removalBilling,
    blogID,
    JSON.stringify({ uid: uid, at: at })
  );
}

async function clear(blogID) {
  await client.hDel(key.removalBilling, blogID);
}

// Resolves to [{ blogID, uid, at }]
async function pending() {
  var all = await client.hGetAll(key.removalBilling);

  return Object.keys(all).map(function (blogID) {
    var parsed = {};

    try {
      parsed = JSON.parse(all[blogID]);
    } catch (err) {
      // an unreadable record is treated as the oldest
    }

    return { blogID: blogID, uid: parsed.uid, at: parsed.at || 0 };
  });
}

// An account being deleted cancels its whole subscription instead
async function clearForUser(uid) {
  for (var entry of await pending()) {
    if (entry.uid === uid) await clear(entry.blogID);
  }
}

module.exports = {
  record: record,
  clear: clear,
  pending: pending,
  clearForUser: clearForUser,
};
