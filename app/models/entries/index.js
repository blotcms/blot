var redis = require("models/client");
var async = require("async");
var ensure = require("helper/ensure");
var withCallback = require("helper/withCallback");
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

  function resave(blogID, callback) {
    Blog.get({ id: blogID }, function (err, blog) {
      if (err || !blog) return callback(err || new Error("no blog"));

      each(
        blogID,
        function (entry, nextEntry) {
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
          Entry.set(blogID, entry.path, changes, nextEntry);
        },
        callback
      );
    });
  }

  function adjacentTo(blogID, entryID, callback) {
    ensure(blogID, "string").and(entryID, "string").and(callback, "function");

    (async function () {
      // Get the index of the entry in the list of entries
      var rank = await redis.zRank(listKey(blogID, "entries"), entryID);

      // If the entry has no rank its not got siblings
      // make sure you don't just bang rank, 0 is falsy in JS!
      if (typeof rank !== "number") return callback();

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

      Entry.get(blogID, neighbourIDs, function (entries) {
        var next, previous;

        entries.forEach(function (entry) {
          if (entry.id === previousID) previous = entry;
          else if (entry.id === nextID) next = entry;
        });

        return callback(next, previous, ++rank);
      });
    })().catch(function () {
      return callback();
    });
  }

  var getTotal = withCallback(async function getTotal(blogID) {
    var entriesKey = listKey(blogID, "entries");

    return await redis.zCard(entriesKey);
  });

  // Count of the "all" list, the same set Fix()'s each()-based checks (e.g.
  // entry-ghosts) scan one Redis round trip at a time - includes drafts,
  // pages, scheduled and deleted entries that getTotal's "entries" list
  // excludes, so this is the count that actually predicts that workload.
  var getAllTotal = withCallback(async function getAllTotal(blogID) {
    var allKey = listKey(blogID, "all");

    return await redis.zCard(allKey);
  });

  // includes deleted entries
  var getAllIDs = withCallback(async function getAllIDs(blogID) {
    var allKey = listKey(blogID, "all");

    return await redis.zRange(allKey, 0, -1, { REV: true });
  });

  // includes deleted entries
  function getAll(blogID, options, callback) {
    if (typeof options === "function" && !callback) {
      callback = options;
      options = {};
    }

    ensure(blogID, "string").and(options, "object").and(callback, "function");

    // By default retrieve skinnier
    // entry info when getting every entry
    if (options.skinny === undefined) options.skinny = true;

    return getRangeWithCallback(blogID, 0, -1, options, callback);
  }

  function get(blogID, options, callback) {
    ensure(blogID, "string").and(callback, "function");

    if (!options.lists && options.list) options.lists = [options.list];

    ensure(options.lists, "array");

    // Skinny is true by default
    options.skinny = options.skinny !== false;

    var totalToFetch = 0,
      response = {},
      lists = options.lists.slice();

    delete options.lists;

    for (var i in lists) {
      totalToFetch++;
      options.list = lists[i];
      getRangeWithCallback(blogID, 0, -1, options, onComplete(options.list));
    }

    function onComplete(listName) {
      return function (listOfEntries) {
        totalToFetch--;

        response[listName] = listOfEntries;

        if (!totalToFetch) {
          callback(null, response);
        }
      };
    }
  }

  var getListIDs = withCallback(
    async function getListIDs(blogID, listName, options) {
      ensure(blogID, "string").and(listName, "string").and(options, "object");

      var list = listKey(blogID, listName);

      var start = 0;
      var end = -1;

      if (options.first) {
        start = 0;
        end = options.first - 1;
      }

      return await redis.zRange(list, start, end, { REV: true });
    }
  );

  // includes deleted entries
  function each(blogID, dothis, callback) {
    ensure(blogID, "string").and(dothis, "function").and(callback, "function");

    redis
      .zRange(listKey(blogID, "all"), 0, -1, { REV: true })
      .then(function (ids) {
        async.eachSeries(
          ids,
          function (id, next) {
            Entry.get(blogID, id, function (entry) {
              if (!entry) return next();
              dothis(entry, next);
            });
          },
          callback
        );
      })
      .catch(function (error) {
        callback(error);
      });
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

  function pruneMissing(blogID, callback) {
    if (!callback) callback = function () {};

    ensure(blogID, "string").and(callback, "function");

    var idsByList = {};
    var uniqueIds = new Set();

    async.series(
      [
        function collectListIds(next) {
          async.eachSeries(
            lists,
            function (listName, nextList) {
              var key = listKey(blogID, listName);

              redis
                .zRange(key, 0, -1)
                .then(function (ids) {
                  idsByList[listName] = ids || [];
                  (ids || []).forEach(function (id) {
                    uniqueIds.add(id);
                  });
                  nextList();
                })
                .catch(nextList);
            },
            next
          );
        },
        function fetchEachIdOnce(next) {
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
          async.eachSeries(
            batches,
            function (batch, nextBatch) {
              var keys = batch.map(function (id) {
                return entryKey(blogID, id);
              });

              var existsMulti = redis.multi();
              keys.forEach(function (key) {
                existsMulti.exists(key);
              });

              existsMulti
                .exec()
                .then(function (found) {
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

                  setImmediate(nextBatch);
                })
                .catch(nextBatch);
            },
            function (err) {
              if (err) return next(err);
              next(null, existing);
            }
          );
        },
      ],
      function (err, results) {
        if (err) return callback(err);

        var existing = results[1];
        // listName -> ids removed from that list, for callers (list-ghosts)
        // that want to report/account for what was pruned.
        var removed = {};

        async.eachSeries(
          lists,
          function (listName, nextList) {
            var key = listKey(blogID, listName);
            var missing = idsByList[listName].filter(function (id) {
              return !existing[id];
            });

            if (!missing.length) return nextList();

            redis
              .zRem(key, missing)
              .then(function () {
                removed[listName] = missing;
                nextList();
              })
              .catch(nextList);
          },
          function (err) {
            if (err) return callback(err);
            callback(null, removed);
          }
        );
      }
    );
  }

  var getCreated = withCallback(async function getCreated(blogID, after) {
    ensure(blogID, "string").and(after, "number");

    var key = listKey(blogID, "created");

    var ids = await redis.zRangeByScore(key, after, Date.now());

    // Entry.get calls back with the entries and no error argument
    var entries = await new Promise(function (resolve) {
      Entry.get(blogID, ids, resolve);
    });

    return entries || [];
  });

  var getDeleted = withCallback(async function getDeleted(blogID, after) {
    ensure(blogID, "string").and(after, "number");

    var key = listKey(blogID, "deleted");

    var ids = await redis.zRangeByScore(key, after, Date.now());

    // Entry.get calls back with the entries and no error argument
    var entries = await new Promise(function (resolve) {
      Entry.get(blogID, ids, resolve);
    });

    return entries || [];
  });

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

    return await new Promise(function (resolve) {
      Entry.get(blogID, entryIDs, resolve);
    });
  }

  // getRange for the callback functions above: calls back with the entries and
  // no error argument. options.onError, if given, hears of a Redis outage
  // (or bad arguments) instead, and then the callback is never called.
  function getRangeWithCallback(blogID, start, end, options, callback) {
    withCallback(getRange)(
      blogID,
      start,
      end,
      Object.assign({}, options, { rejectOnOutage: !!options.onError }),
      function (err, entries) {
        if (err) {
          if (options.onError) return options.onError(err);

          // Only bad arguments get here (getRange resolves [] for any other
          // error without rejectOnOutage): log, and call back with [] as it
          // does for those, rather than leaving the caller hanging
          console.error("Entries: getRange failed", err);
          return callback([]);
        }

        callback(entries);
      }
    );
  }

  function random(blogID, callback) {
    ensure(blogID, "string").and(callback, "function");

    var key = listKey(blogID, "entries");
    var attempts = 0;

    function attempt() {
      if (attempts >= MAX_RANDOM_ATTEMPTS) return callback();

      attempts++;

      pickRandomEntryID(function (err, entryID) {
        if (err) return callback();

        if (!entryID) return callback();

        Entry.get(blogID, entryID, function (entry) {
          if (!entry || !entry.url) return attempt();

          callback(entry);
        });
      });
    }

    function pickRandomEntryID(done) {
      redis
        .zRandMember(key)
        .then(function (entryID) {
          done(null, normalizeEntryID(entryID));
        })
        .catch(function (err) {
          done(err);
        });
    }

    function normalizeEntryID(entryID) {
      if (Array.isArray(entryID)) entryID = entryID[0];
      if (Buffer.isBuffer(entryID)) entryID = entryID.toString();

      return entryID || null;
    }

    attempt();
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
    var entries = await new Promise(function (resolve) {
      Entry.get(blogID, entryIDs, resolve);
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

  var lastUpdate = withCallback(async function lastUpdate(blogID) {
    var entries = await getRange(blogID, 0, 1, { skinny: true });

    if (entries && entries.length) return entries[0].dateStamp;
  });

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
    get: get,
    resave: resave,
    each: each,
    pruneMissing: pruneMissing,
    sweepExpiredDeleted: require("./sweepExpiredDeleted"),
    adjacentTo: adjacentTo,
    getPage: getPage,
    getListIDs: getListIDs,
    getAll: getAll,
    getCatalog: require("./catalog"),
    getCachedPage: require("./cachedPage"),
    getCachedRecent: require("./cachedRecent"),
    getAllIDs: getAllIDs,
    getTotal: getTotal,
    getAllTotal: getAllTotal,
    getRecent: getRecent,
    lastUpdate: lastUpdate,
    getCreated: getCreated,
    getDeleted: getDeleted,
    random: random,
    // Note: validatePageSize is NOT exported - it's internal to the model
  };
})();
