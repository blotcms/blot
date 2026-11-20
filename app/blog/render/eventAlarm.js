const alarm = require("helper/alarm");
const clfdate = require("helper/clfdate");

// Pages that list events (upcoming_events, all_upcoming_events and an event's
// next date) change when an occurrence ends, not when the blog is edited, and
// blog pages are cached until the blog's cacheID is bumped. So a blog whose
// events are listed has one alarm, at the first moment one of them changes
// (eventDate.nextChange). When it fires the cacheID is bumped; the next render
// that lists events reads them afresh and arms the alarm for the change after.
// A blog nobody visits in between is left alone until someone does.
//
// One alarm per blog, keyed by blog ID, so arming it again only moves it.
// Delivery is at-least-once; a second bump is harmless.
const alarms = alarm(
  "event-changes",
  async function handler(blogID) {
    const Blog = require("models/blog");
    const blog = await Blog.get({ id: blogID });
    if (!blog || blog.isDisabled) return;

    await Blog.bumpCacheID(blogID);

    console.log(
      clfdate(),
      "Blog:",
      blogID + ":",
      "An event ended, cache bumped"
    );
  },
  { pollMs: 15000 }
);

// Arms the blog's alarm for `when`, a stamp from eventDate.nextChange, or
// cancels it when no listed event will change again.
async function arm(blogID, when) {
  if (when === null || when === undefined) return alarms.cancel(blogID);
  return alarms.set(blogID, when);
}

module.exports = { arm, alarm: alarms };
