const key = require("./key");
const client = require("models/client");
const ensure = require("helper/ensure");
const promiseOnly = require("helper/promiseOnly");

// Resolves to { statuses, next, previous }
module.exports = promiseOnly(async function getStatuses(blogID, options = {}) {
  ensure(blogID, "string").and(options, "object");

  // Fetch the first page by default
  options.page = options.page === undefined ? 1 : options.page;

  // Use a page size of 100 by default
  options.pageSize = options.pageSize === undefined ? 200 : options.pageSize;

  const unexpectedOptionParameters = Object.keys(options).filter(
    (i) => i !== "page" && i !== "pageSize"
  );

  if (unexpectedOptionParameters.length) {
    throw new TypeError(
      `Invalid options: ${unexpectedOptionParameters} are not valid`
    );
  }

  if (!Number.isInteger(options.page) || options.page < 1) {
    throw new TypeError('Invalid option: "page" must be a positive integer');
  }

  if (!Number.isInteger(options.pageSize) || options.pageSize < 1) {
    throw new TypeError(
      'Invalid option: "pageSize" must be a positive integer'
    );
  }

  const offset = (options.page - 1) * options.pageSize;

  // We remove one because, per the redis docs:
  // > Note that if you have a list of numbers from 0 to 100,
  // > LRANGE list 0 10 will return 11 elements, that is, the
  // > rightmost item is included. This may or may not be
  // > consistent with behavior of range-related functions in
  // > your programming language of choice.
  const limit = offset + options.pageSize - 1;

  ensure(offset, "number").and(limit, "number");

  const [statusesResult, total] = await Promise.all([
    client.lRange(key.status(blogID), offset, limit),
    client.lLen(key.status(blogID)),
  ]);

  const statuses = statusesResult.map(JSON.parse);

  // Work out if there are more pages of statuses
  const next = total > limit + 1 ? options.page + 1 : null;
  const previous = options.page > 1 ? options.page - 1 : null;

  return { statuses, next, previous };
});
