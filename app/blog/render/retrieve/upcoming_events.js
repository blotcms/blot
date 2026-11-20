const { LRUCache } = require("lru-cache");
const getAllCached = require("./helpers/getAllCached");
const asRetriever = require("../../lib/asRetriever");
const eventDate = require("../load/eventDate");

// Posts whose Event line is a date still to come, soonest first:
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

  events.sort((a, b) => a.parsed.stamp - b.parsed.stamp);
  eventsCache.set(key, events);
  return events;
}

async function upcomingEvents(req, res, now = Date.now()) {
  const locals = (req.template && req.template.locals) || {};
  const limit =
    parseInt(locals.upcoming_events_limit, 10) > 0
      ? parseInt(locals.upcoming_events_limit, 10)
      : DEFAULT_LIMIT;

  const events = await eventsFor(req);

  return events
    .filter((event) =>
      eventDate.isUpcoming(event.parsed, now, req.blog.timeZone)
    )
    .slice(0, limit)
    .map((event) => JSON.parse(JSON.stringify(event.entry)));
}

module.exports = asRetriever(upcomingEvents);
module.exports._upcomingEvents = upcomingEvents;
module.exports._clear = function () {
  eventsCache.clear();
};
