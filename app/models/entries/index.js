var redis = require("models/client");
var async = require("async");
var ensure = require("helper/ensure");
var Entry = require("../entry");
var DateStamp = require("../../build/prepare/dateStamp");
var Blog = require("../blog");
var pathIndex = require("./pathIndex");
var normalizePathPrefix = require("helper/pathPrefix").normalizePathPrefix;

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
          var dateStamp = DateStamp(blog, entry.path, entry.metadata);
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

      Entry.get(blogID, entryIDs, function (entries) {
        var next, previous;

        if (entries.length) {
          previous = entries[0].id != entryID ? entries[0] : undefined;
          next =
            entries[entries.length - 1].id != entryID
              ? entries[entries.length - 1]
              : undefined;
        }

        return callback(next, previous, ++rank);
      });
    })().catch(function () {
      return callback();
    });
  }

  function getTotal(blogID, callback) {
    var entriesKey = listKey(blogID, "entries");

    redis
      .zCard(entriesKey)
      .then(function (count) {
        callback(null, count);
      })
      .catch(function (err) {
        callback(err);
      });
  }

  // includes deleted entries
  function getAllIDs(blogID, callback) {
    var allKey = listKey(blogID, "all");

    redis
      .zRange(allKey, 0, -1, { REV: true })
      .then(function (ids) {
        callback(null, ids);
      })
      .catch(function (err) {
        callback(err);
      });
  }

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

    // options.limit caps the number of (most recent) entries returned,
    // instead of the entire "all" list. See app/blog/lib/limits.js for why
    // the render pipeline passes this.
    var end = options.limit ? options.limit - 1 : -1;

    return getRange(blogID, 0, end, options, callback);
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
      getRange(blogID, 0, -1, options, onComplete(options.list));
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

  function getListIDs(blogID, listName, options, callback) {
    ensure(blogID, "string")
      .and(listName, "string")
      .and(options, "object")
      .and(callback, "function");

    var list = listKey(blogID, listName);

    var start = 0;
    var end = -1;

    if (options.first) {
      start = 0;
      end = options.first - 1;
    }

    redis
      .zRange(list, start, end, { REV: true })
      .then(function (ids) {
        return callback(null, ids);
      })
      .catch(function (err) {
        return callback(err);
      });
  }

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

  function pruneMissing(blogID, callback) {
    if (!callback) callback = function () {};

    ensure(blogID, "string").and(callback, "function");

    async.eachSeries(
      lists,
      function (listName, nextList) {
        var key = listKey(blogID, listName);

        redis
          .zRange(key, 0, -1)
          .then(function (ids) {
            if (!ids || !ids.length) return nextList();

            Entry.get(blogID, ids, function (entries) {
              entries = entries || [];

              var existing = {};

              entries.forEach(function (entry) {
                if (entry && entry.id) existing[entry.id] = true;
              });

              var missing = ids.filter(function (id) {
                return !existing[id];
              });

              if (!missing.length) return nextList();

              redis
                .zRem(key, missing)
                .then(function () {
                  nextList();
                })
                .catch(function (err) {
                  nextList(err);
                });
            });
          })
          .catch(function (err) {
            nextList(err);
          });
      },
      callback
    );
  }

  function getCreated(blogID, after, callback) {
    ensure(blogID, "string").and(after, "number").and(callback, "function");

    var key = listKey(blogID, "created");

    redis
      .zRangeByScore(key, after, Date.now())
      .then(function (ids) {
        Entry.get(blogID, ids, function (entries) {
          callback(null, entries || []);
        });
      })
      .catch(function (err) {
        callback(err);
      });
  }

  function getDeleted(blogID, after, callback) {
    ensure(blogID, "string").and(after, "number").and(callback, "function");

    var key = listKey(blogID, "deleted");

    redis
      .zRangeByScore(key, after, Date.now())
      .then(function (ids) {
        Entry.get(blogID, ids, function (entries) {
          callback(null, entries || []);
        });
      })
      .catch(function (err) {
        callback(err);
      });
  }

  function getRange(blogID, start, end, options, callback) {
    ensure(blogID, "string")
      .and(start, "number")
      .and(end, "number")
      .and(options, "object")
      .and(callback, "function");

    var listName = options.list || "entries";
    var key = listKey(blogID, listName);

    redis
      .zRange(key, start, end, { REV: true })
      .then(function (entryIDs) {
        if (!options.full && !options.skinny) return callback(entryIDs);

        // options.fields (array of entry property names) narrows the Redis
        // read to just those fields - see models/entry/get.js. Only pass it
        // through when set so existing 3-arg callers (and their test spies)
        // are completely unaffected.
        if (options.fields) {
          Entry.get(blogID, entryIDs, options.fields, function (entries) {
            return callback(entries);
          });
        } else {
          Entry.get(blogID, entryIDs, function (entries) {
            return callback(entries);
          });
        }
      })
      .catch(function () {
        return callback([]);
      });
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
    if (
      !isNaN(parsedPageSize) &&
      parsedPageSize > 0 &&
      parsedPageSize <= 100
    ) {
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



  function fetchEntryScores(blogID, entryIDs, callback) {
    if (!entryIDs.length) return callback(null, []);

    var key = listKey(blogID, "entries");

    Promise.all(
      entryIDs.map(function (entryID) {
        return redis.zScore(key, entryID);
      })
    ).then(function (rawScores) {
      var withScores = [];

      for (var i = 0; i < entryIDs.length; i++) {
        var score = rawScores && rawScores[i];
        if (score === null || score === undefined) continue;

        withScores.push({
          id: entryIDs[i],
          score: parseFloat(score),
        });
      }

      callback(null, withScores);
    }, callback);
  }


  function getPrefixFilteredPage(
    blogID,
    pathPrefix,
    sortBy,
    order,
    start,
    end,
    pageSize,
    zeroIndexedPageNo,
    pageNo,
    callback
  ) {
    var min = "[" + pathPrefix;
    var max = "[" + pathPrefix + "\xff";

    redis
      .zRangeByLex(pathIndex.lexKey(blogID), min, max)
      .then(function (matchingIDs) {

      var totalEntries = matchingIDs.length;

      if (!totalEntries) {
        return handlePaginationAndCallback(
          blogID,
          [],
          0,
          zeroIndexedPageNo,
          pageSize,
          start,
          end,
          pageNo,
          callback
        );
      }

      if (sortBy === "id") {
        var ids = order === "desc" ? matchingIDs.slice().reverse() : matchingIDs.slice();

        return handlePaginationAndCallback(
          blogID,
          ids.slice(start, end + 1),
          totalEntries,
          zeroIndexedPageNo,
          pageSize,
          start,
          end,
          pageNo,
          callback
        );
      }

        fetchEntryScores(blogID, matchingIDs, function (error, scoredEntries) {
        if (error) {
          console.error(error);
          return callback(error, [], null);
        }

        scoredEntries.sort(function (a, b) {
          var scoreDifference = order === "asc" ? b.score - a.score : a.score - b.score;

          if (scoreDifference !== 0) return scoreDifference;

          // Redis-compatible tie handling: equal scores are ordered by member
          // lexicographically (reverse for ZREVRANGE semantics, forward for ZRANGE).
          if (a.id === b.id) return 0;

          if (order === "asc") return a.id < b.id ? 1 : -1;

          return a.id < b.id ? -1 : 1;
        });

        totalEntries = scoredEntries.length;

        var pagedIDs = scoredEntries
          .slice(start, end + 1)
          .map(function (item) {
            return item.id;
          });

        handlePaginationAndCallback(
          blogID,
          pagedIDs,
          totalEntries,
          zeroIndexedPageNo,
          pageSize,
          start,
          end,
          pageNo,
          callback
        );
      });
      })
      .catch(function (error) {
        console.error(error);
        return callback(error, [], null);
      });
  }
  function getPage(
    blogID,
    options = {},
    callback
  ) {
    ensure(blogID, "string").and(callback, "function");

    // Extract and validate options
    const { 
      pageNumber: pageNoInput = "1", 
      pageSize: rawPageSize, 
      sortBy: rawSortBy, 
      order: rawOrder,
      pathPrefix: rawPathPrefix
    } = options;

    // Validate page number input
    const pageNo = validatePageNumber(pageNoInput);
    if (pageNo === null) {
      const error = new Error("Invalid page number");
      error.statusCode = 400;
      error.invalidInput = pageNoInput;
      return callback(error, null, null);
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
      return getPrefixFilteredPage(
        blogID,
        pathPrefix,
        sortBy,
        order,
        start,
        end,
        pageSize,
        zeroIndexedPageNo,
        pageNo,
        callback
      );
    }

    if (sortBy === "id") {
      var entriesKey = listKey(blogID, "entries");
      var entriesLexKey = pathIndex.lexKey(blogID);
      var rangePromise =
        order === "desc"
          ? redis.zRange(entriesLexKey, start, end, { REV: true })
          : redis.zRange(entriesLexKey, start, end);

      Promise.all([rangePromise, redis.zCard(entriesKey)])
        .then(function (results) {
          var entryIDs = results[0];
          var totalEntries = results[1];

          handlePaginationAndCallback(
            blogID,
            entryIDs,
            totalEntries,
            zeroIndexedPageNo,
            pageSize,
            start,
            end,
            pageNo,
            callback
          );
        })
        .catch(function (error) {
          console.error(error);
          return callback(error, [], null);
        });
    } else {
      // Default sorting by date (Redis scores)

      const rangePromise =
        order === "asc"
          ? redis.zRange(listKey(blogID, "entries"), start, end, { REV: true })
          : redis.zRange(listKey(blogID, "entries"), start, end);

      Promise.all([rangePromise, redis.zCard(listKey(blogID, "entries"))])
        .then(function (results) {
          var entryIDs = results[0];
          var totalEntries = results[1];

          handlePaginationAndCallback(
            blogID,
            entryIDs,
            totalEntries,
            zeroIndexedPageNo,
            pageSize,
            start,
            end,
            pageNo,
            callback
          );
        })
        .catch(function (error) {
          console.error(error);
          return callback(error, [], null);
        });
    }
  }

  /**
   * Handles pagination and invokes the callback with the appropriate data.
   */
  function handlePaginationAndCallback(
    blogID,
    entryIDs,
    totalEntries,
    zeroIndexedPageNo,
    pageSize,
    start,
    end,
    pageNo,
    callback
  ) {
    Entry.get(blogID, entryIDs, function (entries) {
      var pagination = {};

      totalEntries = parseInt(totalEntries);

      pagination.total = Math.max(1, Math.ceil(totalEntries / pageSize));
      pagination.current = pageNo;
      pagination.pageSize = pageSize;
      pagination.page_size = pageSize;
      pagination.totalEntries = totalEntries;
      // Prefer snake_case in public payloads; keep camelCase for legacy compatibility.
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
      
      return callback(null, entries, pagination);
    });
  }

  function lastUpdate(blogID, callback) {
    getRange(blogID, 0, 1, { skinny: true }, function (entries) {
      if (entries && entries.length)
        return callback(null, entries[0].dateStamp);

      return callback();
    });
  }

  function getRecent(blogID, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }

    getRange(blogID, 0, 30, { skinny: true, fields: options.fields }, function (entries) {
      redis
        .zCard(listKey(blogID, "entries"))
        .then(function (totalEntries) {
          // The first entry published should have an index of 1
          // The fifth entry published should have an index of 5
          // The most recently published entry should have an index
          // equal to the number of total entries published.
          let index = totalEntries;
          entries.forEach(function (entry) {
            entry.index = index;
            index--;
          });

          callback(entries);
        })
        .catch(function () {
          callback([]);
        });
    });
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
    adjacentTo: adjacentTo,
    getPage: getPage,
    getListIDs: getListIDs,
    getAll: getAll,
    getAllIDs: getAllIDs,
    getTotal: getTotal,
    getRecent: getRecent,
    lastUpdate: lastUpdate,
    getCreated: getCreated,
    getDeleted: getDeleted,
    random: random,
    // Note: validatePageSize is NOT exported - it's internal to the model
  };
})();
