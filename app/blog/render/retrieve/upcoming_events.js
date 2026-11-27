const { LRUCache } = require("lru-cache");
const getAllCached = require("./helpers/getAllCached");
const asRetriever = require("../../lib/asRetriever");
const eventDate = require("../load/eventDate");
const augment = require("../load/augment");
const eventAlarm = require("../eventAlarm");
const { normalize } = require("models/tags");

// Posts whose Event line is a date still to come, soonest first (a repeating
// event at its next occurrence; on a tag page, only that tag's):
//
//   Event: 2026-12-08 18:30
//
// {{#upcoming_events}} ... {{/upcoming_events}} lists them (at most
// upcoming_events_limit from the template's locals, 12 by default), each an
// entry like any other with {{#formatEvent}}...{{/formatEvent}} for its date
// (render/load/augment.js). {{#upcoming_events.0}} is the next one.
//
// The events are found once per blog cacheID: the catalog is read, and a
// light copy of each post with an event date is kept. Each request then only
// filters those by the time now, so a blog whose template never names this
// local never pays for it, and one that does reads the catalog once a publish.
const LIGHT_FIELDS = [
  "id",
  "path",
  "url",
  "title",
  "summary",
  "teaser",
  "metadata",
  "tags",
  "thumbnail",
  "dateStamp",
  "updated",
  "created",
  "page",
  "menu",
  "draft",
  "deleted",
  "scheduled",
];

const DEFAULT_LIMIT = 12;
// all_upcoming_events (a calendar feed): every one, within reason
const ALL_LIMIT = 500;

const eventsCache = new LRUCache({ max: 500 });

function light(entry) {
  const copy = {};
  for (const field of LIGHT_FIELDS) {
    if (entry[field] !== undefined) copy[field] = entry[field];
  }
  return JSON.parse(JSON.stringify(copy));
}

async function eventsFor(req) {
  const key = `${req.blog.id}:${req.blog.cacheID}:${req.blog.timeZone}`;
  const cached = eventsCache.get(key);
  if (cached) return cached;

  const catalog = await getAllCached(req.blog, { log: req.log });
  const events = [];

  for (const entry of catalog || []) {
    if (!entry || entry.deleted || entry.draft || entry.scheduled) continue;
    const parsed = eventDate(entry.metadata, req.blog.timeZone);
    if (!parsed) continue;
    events.push({ parsed, entry: light(entry) });
  }

  eventsCache.set(key, events);

  // Cached pages list these events until the blog's cacheID changes, so
  // arm an alarm to bump it when the first of them next changes (an
  // occurrence ends). Once per cacheID, like the read above; a failure only
  // means pages may lag until the next publish, so it doesn't fail the page.
  const now = Date.now();
  let when = null;
  for (const event of events) {
    const change = eventDate.nextChange(event.parsed, now, req.blog.timeZone);
    if (change !== null && (when === null || change < when)) when = change;
  }
  try {
    await eventAlarm.arm(req.blog.id, when);
  } catch (err) {
    if (typeof req.log === "function")
      req.log("Could not arm event alarm", err && err.message);
  }

  return events;
}

async function upcomingEvents(req, res, now = Date.now(), unlimited = false) {
  const locals = (req.template && req.template.locals) || {};
  const limit = unlimited
    ? ALL_LIMIT
    : parseInt(locals.upcoming_events_limit, 10) > 0
      ? parseInt(locals.upcoming_events_limit, 10)
      : DEFAULT_LIMIT;

  const events = await eventsFor(req);

  // On a tag page, only that tag's events
  const tag = req.params && req.params.tag ? normalize(req.params.tag) : null;

  const upcoming = events
    .filter(
      (event) =>
        !tag || (event.entry.tags || []).some((name) => normalize(name) === tag)
    )
    .map((event) => ({
      event,
      next: eventDate.next(event.parsed, now, req.blog.timeZone),
    }))
    .filter((item) => item.next !== null)
    .sort((a, b) => a.next - b.next)
    .slice(0, limit)
    .map((item) => JSON.parse(JSON.stringify(item.event.entry)));

  // Augmented here, as the list locals are, so each gets formatEvent,
  // formatDate, its tags and the rest (render/load/augment.js).
  if (res && res.locals) {
    for (const entry of upcoming) await augment(req, res, entry);
  }

  return upcoming;
}

module.exports = asRetriever(upcomingEvents);
module.exports._upcomingEvents = upcomingEvents;
module.exports.all = asRetriever((req, res) =>
  upcomingEvents(req, res, Date.now(), true)
);
module.exports._clear = function () {
  eventsCache.clear();
};
