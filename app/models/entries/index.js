var redis = require("models/client");
var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");
var Entry = require("../entry");
var entryKey = require("../entry/key").entry;
var pathNormalizer = require("helper/pathNormalizer");
var DateStamp = require("../../build/prepare/dateStamp");
var Blog = require("../blog");
var pathIndex = require("./pathIndex");
var normalizePathPrefix = require("helper/pathPrefix").normalizePathPrefix;
var isRedisUnavailableError =
  require("helper/redisUnavailable").isRedisUnavailableError;

var MAX_RANDOM_ATTEMPTS = 10;

module.exports = (function () {
  var lists = [
    "all",
    "created",
    "entries",
    "drafts",
    "scheduled",
    "pages",
    "deleted",
    "entries:lex",
  ];

  // async resave(blogID) re-saves every entry; rejects with "no blog" if the
  // blog is gone, or with the first error from Entry.set.
  async function resave(blogID) {
    var blog = await Blog.get({ id: blogID });

    if (!blog) throw new Error("no blog");

    await each(blogID, async function (entry) {
      var dateStamp = DateStamp(
        blog,
        entry.path,
        entry.metadata,
        typeof entry.created === "number" ? entry.created : undefined
      );
      var changes = {};

      // This is fine!
      if (dateStamp !== undefined) changes.dateStamp = dateStamp;

      // We now need to save every entry so that
      // changes to permalink format take effect.
      await Entry.set(blogID, entry.path, changes);
    });
  }

  // async adjacentTo(blogID, entryID) resolves { next, previous, index }:
  // next and previous are entries (undefined at a boundary) and index is the
  // 1-based position of the entry. It resolves {} for an entry with no rank
  // and on any Redis error, since the caller renders without neighbours.
  async function adjacentTo(blogID, entryID) {
    ensure(blogID, "string").and(entryID, "string");

    try {
      // Get the index of the entry in the list of entries
      var rank = await redis.zRank(listKey(blogID, "entries"), entryID);

      // If the entry has no rank its not got siblings
      // make sure you don't just bang rank, 0 is falsy in JS!
      if (typeof rank !== "number") return {};

      var lowerBound = rank > 0 ? rank - 1 : 0;

      var entryIDs = await redis.zRange(
        listKey(blogID, "entries"),
        lowerBound,
        rank + 1
      );

      // The caller already has the entry itself, so read only its
      // neighbours: entries are read in full (html and body included), and
      // re-reading this one doubled the bytes an entry page parses.
      var previousID = entryIDs[0] !== entryID ? entryIDs[0] : undefined;
      var nextID =
        entryIDs.length && entryIDs[entryIDs.length - 1] !== entryID
          ? entryIDs[entryIDs.length - 1]
          : undefined;
      var neighbourIDs = [previousID, nextID].filter(Boolean);

      // A failed read leaves no neighbours
      var entries = await Entry.get(blogID, neighbourIDs).catch(function () {
        return [];
      });
      var next, previous;

      entries.forEach(function (entry) {
        if (entry.id === previousID) previous = entry;
        else if (entry.id === nextID) next = entry;
      });

      return { next: next, previous: previous, index: rank + 1 };
    } catch (err) {
      return {};
    }
  }

  async function getTotal(blogID) {
    var entriesKey = listKey(blogID, "entries");

    return await redis.zCard(entriesKey);
  }

  async function getListTotal(blogID, listName) {
    return await redis.zCard(listKey(blogID, listName));
  }

  // Count of the "all" list, the same set Fix()'s each()-based checks (e.g.
  // entry-ghosts) scan one Redis round trip at a time - includes drafts,
  // pages, scheduled and deleted entries that getTotal's "entries" list
  // excludes, so this is the count that actually predicts that workload.
  var getAllTotal = promiseOnly(async function getAllTotal(blogID) {
    var allKey = listKey(blogID, "all");

    return await redis.zCard(allKey);
  });

  // includes deleted entries
  async function getAllIDs(blogID) {
    var allKey = listKey(blogID, "all");

    return await redis.zRange(allKey, 0, -1, { REV: true });
  }

  // includes deleted entries
  //
  // async getAll(blogID, [options]) resolves to the entries, newest first;
  // [] on a Redis failure, unless options.rejectOnOutage is set: a Redis
  // outage then rejects with the error (see getRange).
  async function getAll(blogID, options = {}) {
    ensure(blogID, "string").and(options, "object");

    // By default retrieve skinnier
    // entry info when getting every entry
    if (options.skinny === undefined) options.skinny = true;

    return await getRange(blogID, 0, -1, options);
  }

  // async get(blogID, options) resolves an object keyed by list name, each
  // value the list's entries (or IDs when options.skinny is false).
  async function get(blogID, options) {
    ensure(blogID, "string");

    if (!options.lists && options.list) options.lists = [options.list];

    ensure(options.lists, "array");

    // Skinny is true by default
    options.skinny = options.skinny !== false;

    var response = {},
      lists = options.lists.slice();

    delete options.lists;

    await Promise.all(
      lists.map(async function (listName) {
        // getRange resolves [] for a Redis error; only bad arguments reject
        // here: log, and use [] as the list, as before
        try {
          response[listName] = await getRange(
            blogID,
            0,
            -1,
            Object.assign({}, options, { list: listName })
          );
        } catch (err) {
          console.error("Entries: getRange failed", err);
          response[listName] = [];
        }
      })
    );

    return response;
  }

  var getListIDs = promiseOnly(
    async function getListIDs(blogID, listName, options) {
      ensure(blogID, "string").and(listName, "string").and(options, "object");

      var list = listKey(blogID, listName);

      var start = 0;
      var end = -1;

      if (options.first) {
        start = 0;
        end = options.first - 1;
      }

      // Scheduled posts list the soonest first
      return options.ascending
        ? await redis.zRange(list, start, end)
        : await redis.zRange(list, start, end, { REV: true });
    }
  );

  // includes deleted entries
  //
  // async each(blogID, dothis) awaits dothis(entry) for each entry, one at a
  // time and in order. The first error dothis throws stops the iteration and
  // rejects.
  async function each(blogID, dothis) {
    ensure(blogID, "string").and(dothis, "function");

    var ids = await redis.zRange(listKey(blogID, "all"), 0, -1, {
      REV: true,
    });

    // One entry at a time, in order
    for (var id of ids) {
      // A failed read is the same as no entry
      var entry = await Entry.get(blogID, id).catch(function () {});

      if (!entry) continue;

      await dothis(entry);
    }
  }

  // promiseOnly can't guard each: its last argument is always a function. A
  // third argument is the old callback.
  function eachOnly(blogID, dothis, ...rest) {
    if (rest.length) {
      throw new TypeError(
        "each no longer takes a callback; pass an async function and await it (#2559)"
      );
    }

    return each(blogID, dothis);
  }

  // Only whether each entry's key exists matters here, so it's checked with
  // EXISTS rather than by reading the entry. Reading entries in full (content
  // included) is what used to exhaust the heap when a blog with many large
  // entries was read in one MGET before pruneMissing ever got to zRem the
  // stale ones, and even in batches of 100 the replies (several hundred KB
  // each on a blog with ~900 posts) stall on production - see models/entry/get.js.
  //
  // The same id is usually a member of several of the lists above (eg. an
  // entry sits in "all", "created", "entries" and "entries:lex" at once), so
  // checking each list independently used to re-fetch that same entry once
  // per list it belonged to - up to 8x for one entry. Collecting every list's
  // ids first and checking each unique id once avoids that.
  var PRUNE_BATCH_SIZE = 100;

  async function prune(blogID) {
    var idsByList = {};
    var uniqueIds = new Set();

    for (var listName of lists) {
      var ids = await redis.zRange(listKey(blogID, listName), 0, -1);

      idsByList[listName] = ids || [];
      (ids || []).forEach(function (id) {
        uniqueIds.add(id);
      });
    }

    var allIds = Array.from(uniqueIds);
    var existing = {};
    var batches = [];

    for (var i = 0; i < allIds.length; i += PRUNE_BATCH_SIZE) {
      batches.push(allIds.slice(i, i + PRUNE_BATCH_SIZE));
    }

    // Check the raw keys directly (rather than via Entry.get) so
    // existence is tracked against the id we actually requested, not
    // an id parsed back out of the entry's JSON - a corrupted entry's
    // stored id can differ from its Redis key. It also lets a failed
    // batch abort the whole prune instead of being treated as proof
    // that every id in it is missing.
    for (var batch of batches) {
      var existsMulti = redis.multi();
      batch.forEach(function (id) {
        existsMulti.exists(entryKey(blogID, id));
      });

      var found = await existsMulti.exec();

      (found || []).forEach(function (exists, i) {
        var id = batch[i];

        // entryKey normalizes the path, so a noncanonical id
        // (eg. a trailing slash) maps to the same Redis key as
        // its canonical form - a hit there proves the canonical
        // entry exists, not that this exact list member does.
        // Only trust the lookup for ids that are already
        // canonical; anything else is a stale/duplicate member
        // that should be pruned regardless.
        if (exists && id === pathNormalizer(id)) {
          existing[id] = true;
        }
      });

      await new Promise(function (resolve) {
        setImmediate(resolve);
      });
    }

    // listName -> ids removed from that list, for callers (list-ghosts)
    // that want to report/account for what was pruned.
    var removed = {};

    for (var name of lists) {
      var missing = idsByList[name].filter(function (id) {
        return !existing[id];
      });

      if (!missing.length) continue;

      await redis.zRem(listKey(blogID, name), missing);
      removed[name] = missing;
    }

    return removed;
  }

  // async pruneMissing(blogID) resolves { listName: [removed ids] }
  async function pruneMissing(blogID) {
    ensure(blogID, "string");

    return await prune(blogID);
  }

  async function getCreated(blogID, after) {
    ensure(blogID, "string").and(after, "number");

    var key = listKey(blogID, "created");

    var ids = await redis.zRangeByScore(key, after, Date.now());

    // A failed read is the same as no entries
    var entries = await Entry.get(blogID, ids).catch(function () {
      return [];
    });

    return entries || [];
  }

  async function getDeleted(blogID, after) {
    ensure(blogID, "string").and(after, "number");

    var key = listKey(blogID, "deleted");

    var ids = await redis.zRangeByScore(key, after, Date.now());

    // A failed read is the same as no entries
    var entries = await Entry.get(blogID, ids).catch(function () {
      return [];
    });

    return entries || [];
  }

  // Resolves to the entries in the list from start to end, newest first: their
  // IDs, or the entries themselves with options.full or options.skinny. A
  // Redis failure resolves [], so that a caller that doesn't care renders an
  // empty list. Callers that would cache or render an empty list as if it
  // were real pass options.rejectOnOutage: a Redis outage then rejects with
  // the error instead.
  async function getRange(blogID, start, end, options) {
    ensure(blogID, "string")
      .and(start, "number")
      .and(end, "number")
      .and(options, "object");

    var listName = options.list || "entries";
    var key = listKey(blogID, listName);
    var entryIDs;

    try {
      entryIDs = await redis.zRange(key, start, end, { REV: true });
    } catch (err) {
      if (options.rejectOnOutage && isRedisUnavailableError(err)) throw err;

      return [];
    }

    if (!options.full && !options.skinny) return entryIDs;

    // A failed read resolves [], even with options.rejectOnOutage
    return await Entry.get(blogID, entryIDs).catch(function () {
      return [];
    });
  }

  // async random(blogID) resolves a random published entry that has a url,
  // or undefined if there is none within MAX_ATTEMPTS tries or on a Redis error.
  var random = promiseOnly(async function random(blogID) {
    ensure(blogID, "string");

    var key = listKey(blogID, "entries");

    for (var attempts = 0; attempts < MAX_RANDOM_ATTEMPTS; attempts++) {
      var entryID;

      try {
        entryID = normalizeEntryID(await redis.zRandMember(key));
      } catch (err) {
        return;
      }

      if (!entryID) return;

      // A failed read is the same as no entry
      var entry;

      try {
        entry = await Entry.get(blogID, entryID);
      } catch (err) {
        continue;
      }

      if (entry && entry.url) return entry;
    }
  });

  function normalizeEntryID(entryID) {
    if (Array.isArray(entryID)) entryID = entryID[0];
    if (Buffer.isBuffer(entryID)) entryID = entryID.toString();

    return entryID || null;
  }

  random.MAX_ATTEMPTS = MAX_RANDOM_ATTEMPTS;

  // Maximum page number to keep (pageNo - 1) * pageSize within Redis integer limits
  // Redis integers are 64-bit signed, so max safe value is 2^63 - 1
  // With reasonable page sizes (e.g., 100), we can safely allow up to ~9e15 pages
  // But for practical purposes, we'll cap at a much lower value
  const MAX_PAGE_NUMBER = 10000; // 10,000 pages should be more than enough

  /**
   * Validates and parses a page number from user input.
   * Returns null if the input is invalid, otherwise returns the validated page number.
   *
   * @param {string|number|undefined} pageNumber - The page number from user input.
   * @returns {number|null} - A valid page number, or null if invalid.
   */
  function validatePageNumber(pageNumber) {
    // Missing page number defaults to page 1.
    // Explicitly provided null/empty values are invalid user input.
    if (pageNumber === undefined) {
      return 1;
    }

    if (pageNumber === null || pageNumber === "") {
      return null;
    }

    // Convert to string for validation
    const pageStr = String(pageNumber).trim();

    // Must be purely digits (no decimals, no negative signs, no letters)
    if (!/^\d+$/.test(pageStr)) {
      return null;
    }

    // Parse as integer
    const parsed = parseInt(pageStr, 10);

    // Check if parsing was successful and result is a safe integer
    if (isNaN(parsed) || !Number.isSafeInteger(parsed)) {
      return null;
    }

    // Must be positive
    if (parsed <= 0) {
      return null;
    }

    // Must not exceed maximum
    if (parsed > MAX_PAGE_NUMBER) {
      return null;
    }

    return parsed;
  }

  /**
   * Validates and parses the page size.
   * Falls back to a default value if the input is invalid or undefined.
   *
   * @param {string|number|undefined} pageSize - Page size from user input.
   * @returns {number} - A valid page size (default: 5).
   */
  function validatePageSize(pageSize) {
    const defaultPageSize = 5;

    // Attempt to parse and validate page size (user input)
    const parsedPageSize = parseInt(pageSize, 10);
    if (!isNaN(parsedPageSize) && parsedPageSize > 0 && parsedPageSize <= 100) {
      return parsedPageSize;
    }

    return defaultPageSize; // Default page size
  }

  /**
   * Validates and parses the sort by field.
   * Falls back to a default value if the input is invalid or undefined.
   *
   * @param {string|undefined} sortBy - Sort by field from user input.
   * @returns {string} - A valid sort by field (default: "date").
   */
  function validateSortBy(sortBy) {
    const defaultSortBy = "date";

    // Validate and parse sort by field (user input)
    if (sortBy === "id") {
      return sortBy;
    }

    return defaultSortBy; // Default sort by field
  }

  /**
   * Validates and parses the sort order.
   * Falls back to a default value if the input is invalid or undefined.
   *
   * @param {string|undefined} order - Sort order from user input.
   * @returns {string} - A valid sort order (default: "asc").
   */
  function validateSortOrder(order) {
    const defaultSortOrder = "asc";

    // Validate and parse sort order (user input)
    if (order === "asc" || order === "desc") {
      return order;
    }

    return defaultSortOrder; // Default sort order
  }

  async function fetchEntryScores(blogID, entryIDs) {
    if (!entryIDs.length) return [];

    var key = listKey(blogID, "entries");

    var rawScores = await Promise.all(
      entryIDs.map(function (entryID) {
        return redis.zScore(key, entryID);
      })
    );

    var withScores = [];

    for (var i = 0; i < entryIDs.length; i++) {
      var score = rawScores && rawScores[i];
      if (score === null || score === undefined) continue;

      withScores.push({
        id: entryIDs[i],
        score: parseFloat(score),
      });
    }

    return withScores;
  }

  async function getPrefixFilteredPage(
    blogID,
    pathPrefix,
    sortBy,
    order,
    start,
    end,
    pageSize,
    zeroIndexedPageNo,
    pageNo
  ) {
    var min = "[" + pathPrefix;
    var max = "[" + pathPrefix + "\xff";
    var matchingIDs, pagedIDs, totalEntries;

    try {
      matchingIDs = await redis.zRangeByLex(pathIndex.lexKey(blogID), min, max);
      totalEntries = matchingIDs.length;

      if (!totalEntries) {
        pagedIDs = [];
      } else if (sortBy === "id") {
        var ids =
          order === "desc"
            ? matchingIDs.slice().reverse()
            : matchingIDs.slice();

        pagedIDs = ids.slice(start, end + 1);
      } else {
        var scoredEntries = await fetchEntryScores(blogID, matchingIDs);

        scoredEntries.sort(function (a, b) {
          var scoreDifference =
            order === "asc" ? b.score - a.score : a.score - b.score;

          if (scoreDifference !== 0) return scoreDifference;

          // Redis-compatible tie handling: equal scores are ordered by member
          // lexicographically (reverse for ZREVRANGE semantics, forward for ZRANGE).
          if (a.id === b.id) return 0;

          if (order === "asc") return a.id < b.id ? 1 : -1;

          return a.id < b.id ? -1 : 1;
        });

        totalEntries = scoredEntries.length;

        pagedIDs = scoredEntries.slice(start, end + 1).map(function (item) {
          return item.id;
        });
      }
    } catch (error) {
      console.error(error);
      throw error;
    }

    return await handlePagination(
      blogID,
      pagedIDs,
      totalEntries,
      zeroIndexedPageNo,
      pageSize,
      start,
      end,
      pageNo
    );
  }

  // Resolves to { entries, pagination }: a page of published entries with its
  // pagination. Rejects with a 400 for an invalid page number, or with the
  // Redis error.
  async function getPage(blogID, options = {}) {
    ensure(blogID, "string");

    // Extract and validate options
    const {
      pageNumber: pageNoInput = "1",
      pageSize: rawPageSize,
      sortBy: rawSortBy,
      order: rawOrder,
      pathPrefix: rawPathPrefix,
    } = options;

    // Validate page number input
    const pageNo = validatePageNumber(pageNoInput);
    if (pageNo === null) {
      const error = new Error("Invalid page number");
      error.statusCode = 400;
      error.invalidInput = pageNoInput;
      throw error;
    }

    // Validate and set page size
    const pageSize = validatePageSize(rawPageSize);

    // Validate and set sorting options
    const sortBy = validateSortBy(rawSortBy);
    const order = validateSortOrder(rawOrder);
    const pathPrefix = normalizePathPrefix(rawPathPrefix);

    const zeroIndexedPageNo = pageNo - 1; // zero indexed

    var start = zeroIndexedPageNo * pageSize;
    var end = start + (pageSize - 1);

    // Determine how to fetch the sorted list
    if (pathPrefix) {
      return await getPrefixFilteredPage(
        blogID,
        pathPrefix,
        sortBy,
        order,
        start,
        end,
        pageSize,
        zeroIndexedPageNo,
        pageNo
      );
    }

    var results;

    try {
      if (sortBy === "id") {
        var entriesKey = listKey(blogID, "entries");
        var entriesLexKey = pathIndex.lexKey(blogID);
        var lexRangePromise =
          order === "desc"
            ? redis.zRange(entriesLexKey, start, end, { REV: true })
            : redis.zRange(entriesLexKey, start, end);

        results = await Promise.all([lexRangePromise, redis.zCard(entriesKey)]);
      } else {
        // Default sorting by date (Redis scores)

        const rangePromise =
          order === "asc"
            ? redis.zRange(listKey(blogID, "entries"), start, end, {
                REV: true,
              })
            : redis.zRange(listKey(blogID, "entries"), start, end);

        results = await Promise.all([
          rangePromise,
          redis.zCard(listKey(blogID, "entries")),
        ]);
      }
    } catch (error) {
      console.error(error);
      throw error;
    }

    return await handlePagination(
      blogID,
      results[0],
      results[1],
      zeroIndexedPageNo,
      pageSize,
      start,
      end,
      pageNo
    );
  }

  /**
   * Fetches the page's entries and resolves to { entries, pagination }.
   */
  async function handlePagination(
    blogID,
    entryIDs,
    totalEntries,
    zeroIndexedPageNo,
    pageSize,
    start,
    end,
    pageNo
  ) {
    // A failed read is the same as no entries
    var entries = await Entry.get(blogID, entryIDs).catch(function () {
      return [];
    });

    var pagination = {};

    totalEntries = parseInt(totalEntries);

    pagination.total = Math.max(1, Math.ceil(totalEntries / pageSize));
    pagination.current = pageNo;
    pagination.page_size = pageSize;
    pagination.total_entries = totalEntries;

    // total entries is not 0 indexed, remove 1
    pagination.next = totalEntries - 1 > end ? zeroIndexedPageNo + 2 : null;

    pagination.previous = zeroIndexedPageNo > 0 ? zeroIndexedPageNo : null;

    // The first entry published should have an index of 1
    // The fifth entry published should have an index of 5
    // The most recently published entry should have an index
    // equal to the number of total entries published.
    let index = totalEntries - start;
    entries.forEach(function (entry) {
      entry.index = index;
      index--;
    });

    if (entries && entries.length > 0) {
      entries.at(-1).pagination = pagination;
    }

    return { entries, pagination };
  }

  async function lastUpdate(blogID) {
    var entries = await getRange(blogID, 0, 1, { skinny: true });

    if (entries && entries.length) return entries[0].dateStamp;
  }

  // Resolves to the most recent entries, each with its index. A Redis failure
  // resolves [], unless options.rejectOnOutage is set: an outage then rejects
  // with the error, so that no caller renders or caches an empty list as real.
  async function getRecent(blogID, options = {}) {
    var entries = await getRange(blogID, 0, 30, {
      skinny: true,
      rejectOnOutage: options.rejectOnOutage,
    });
    var totalEntries;

    try {
      totalEntries = await redis.zCard(listKey(blogID, "entries"));
    } catch (err) {
      if (options.rejectOnOutage && isRedisUnavailableError(err)) throw err;

      return [];
    }

    // The first entry published should have an index of 1
    // The fifth entry published should have an index of 5
    // The most recently published entry should have an index
    // equal to the number of total entries published.
    let index = totalEntries;
    entries.forEach(function (entry) {
      entry.index = index;
      index--;
    });

    return entries;
  }

  function listKey(blogID, list) {
    ensure(blogID, "string").and(list, "string");

    if (lists.indexOf(list) === -1)
      throw "There is no valid list with prefix " + list;

    return "blog:" + blogID + ":" + list;
  }

  return {
    get: promiseOnly(get),
    resave: promiseOnly(resave),
    each: eachOnly,
    pruneMissing: promiseOnly(pruneMissing),
    sweepExpiredDeleted: require("./sweepExpiredDeleted"),
    adjacentTo: promiseOnly(adjacentTo),
    getPage: getPage,
    getListIDs: getListIDs,
    getListTotal: getListTotal,
    getAll: getAll,
    getCatalog: require("./catalog"),
    getCachedPage: require("./cachedPage"),
    getCachedRecent: require("./cachedRecent"),
    getAllIDs: promiseOnly(getAllIDs),
    getTotal: promiseOnly(getTotal),
    getAllTotal: getAllTotal,
    getRecent: getRecent,
    lastUpdate: promiseOnly(lastUpdate),
    getCreated: promiseOnly(getCreated),
    getDeleted: promiseOnly(getDeleted),
    random: random,
    // Note: validatePageSize is NOT exported - it's internal to the model
  };
})();
