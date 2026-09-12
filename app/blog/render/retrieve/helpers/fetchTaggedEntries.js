const Tags = require("models/tags");
const {
  normalizePathPrefix,
  filterEntryIDsByPathPrefix,
} = require("helper/pathPrefix");
const { sortEntryIDs, isNewestFirst } = require("blog/sortOptions");

function buildPagination(current, pageSize, totalEntries) {
  const total = pageSize > 0 ? Math.max(1, Math.ceil(totalEntries / pageSize)) : 0;
  const previous = current > 1 ? current - 1 : null;
  const next = total > 0 && current < total ? current + 1 : null;
  return {
    current,
    pageSize,
    page_size: pageSize,
    total,
    totalEntries,
    // Prefer snake_case in public payloads; keep camelCase for legacy compatibility.
    total_entries: totalEntries,
    previous,
    next,
  };
}

function buildTagMetadata(prettyTags) {
  const label = (prettyTags || []).filter(Boolean).join(" + ");
  const tagged = {};
  if (label) {
    tagged[label] = true;
    tagged[label.toLowerCase()] = true;
  }
  return { tag: label, tagged };
}

function normalizeSlugs(slugs) {
  if (Array.isArray(slugs)) return slugs.filter(Boolean).map(String);
  if (typeof slugs === "string") return [slugs];
  throw new Error("Unexpected type of tag");
}

function parsePaginationOptions(options) {
  if (!options || options.limit === undefined) return { hasPagination: false };
  const limit = parseInt(options.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) return { hasPagination: false };
  let offset = parseInt(options.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return {
    hasPagination: true,
    limit,
    offset,
    currentPage: Math.floor(offset / limit) + 1,
  };
}

function attachPagination(meta, pg) {
  if (!pg.hasPagination) return meta;
  const totalEntries =
    meta.total !== undefined ? meta.total : (meta.entryIDs || []).length;
  meta.total = totalEntries;
  meta.pagination = buildPagination(pg.currentPage, pg.limit, totalEntries);
  return meta;
}

function buildTaggedResult({ entryIDs, total, prettyTags, slugs, pg }) {
  const metadata = buildTagMetadata(prettyTags);
  const result = {
    entryIDs,
    tag: metadata.tag,
    tagged: metadata.tagged,
    prettyTags,
    slugs,
  };

  if (total !== undefined) {
    result.total = total;
  }

  return attachPagination(result, pg);
}

function buildSingleTagResult({ entryIDs, prettyTag, slugs, pg, total }) {
  return buildTaggedResult({
    entryIDs,
    total,
    prettyTags: [prettyTag],
    slugs,
    pg,
  });
}

function buildMultiTagResult({ entryIDs, prettyTags, slugs, pg, total }) {
  return buildTaggedResult({
    entryIDs,
    total,
    prettyTags,
    slugs,
    pg,
  });
}

function applyPathPrefixFiltering(entryIDs, pathPrefix) {
  return filterEntryIDsByPathPrefix(entryIDs || [], pathPrefix);
}

function intersectMany(arrays) {
  if (!arrays.length) return [];
  let set = new Set(arrays[0]);
  for (let i = 1; i < arrays.length; i++) {
    const nextSet = new Set(arrays[i]);
    set = new Set([...set].filter((x) => nextSet.has(x)));
    if (!set.size) break;
  }
  return [...set];
}

function getTag(blogID, slug, opts) {
  return new Promise((resolve, reject) => {
    // Tags.get may accept options for single-tag queries
    const cb = (err, entryIDs, prettyTag, total) =>
      err
        ? reject(err)
        : resolve({
            entryIDs: entryIDs || [],
            prettyTag: prettyTag || slug,
            total,
          });
    opts ? Tags.get(blogID, slug, opts, cb) : Tags.get(blogID, slug, cb);
  });
}

async function fetchTaggedEntriesInternal(blogID, slugs, options) {
  options = options || {};

  const pg = parsePaginationOptions(options);
  const normalized = normalizeSlugs(slugs);
  const pathPrefix = normalizePathPrefix(options.pathPrefix);
  const sortOptions = { sortBy: options.sortBy, order: options.order };
  const newestFirst = isNewestFirst(sortOptions);
  // The tag's sorted set is scored by dateStamp, so Redis can paginate either
  // date direction (via zRange REV). Only file-path ("id") sorting has no
  // matching index and needs the whole list pulled and sorted here.
  const dateSorted = sortOptions.sortBy !== "id";

  if (!normalized.length) {
    return buildMultiTagResult({
      entryIDs: [],
      total: pg.hasPagination ? 0 : undefined,
      prettyTags: [],
      slugs: [],
      pg,
    });
  }

  if (normalized.length === 1) {
    const slug = normalized[0];
    // Redis paginates date sorting (both directions) directly off the tag's
    // dateStamp-scored set. "id" sorting, path_prefix filtering and the
    // multi-tag intersection have no index, so those pull the whole list and
    // order it here before slicing.
    const canPageInRedis = !pathPrefix && pg.hasPagination && dateSorted;
    const tagOptions = canPageInRedis
      ? { limit: pg.limit, offset: pg.offset, rev: newestFirst }
      : undefined;
    const { entryIDs, prettyTag, total } = await getTag(blogID, slug, tagOptions);
    const filteredEntryIDs = applyPathPrefixFiltering(entryIDs, pathPrefix);
    const filteredTotal = filteredEntryIDs.length;

    let finalEntryIDs;
    if (canPageInRedis) {
      finalEntryIDs = filteredEntryIDs;
    } else {
      const orderedEntryIDs = sortEntryIDs(filteredEntryIDs, sortOptions);
      finalEntryIDs = pg.hasPagination
        ? orderedEntryIDs.slice(pg.offset, pg.offset + pg.limit)
        : orderedEntryIDs;
    }

    const finalTotal = pathPrefix
      ? filteredTotal
      : (total !== undefined ? total : filteredTotal);

    return buildSingleTagResult({
      entryIDs: finalEntryIDs,
      total: finalTotal,
      prettyTag,
      slugs: normalized,
      pg,
    });
  }

  // Multiple tags: fetch without pagination options, then intersect and slice locally
  const results = await Promise.all(normalized.map((slug) => getTag(blogID, slug)));
  const lists = results.map((result) => result.entryIDs || []);
  const intersectedEntryIDs = intersectMany(lists);
  const prettyTags = results.map((result) => result.prettyTag);
  const filteredEntryIDs = applyPathPrefixFiltering(intersectedEntryIDs, pathPrefix);
  const orderedEntryIDs = sortEntryIDs(filteredEntryIDs, sortOptions);
  const finalEntryIDs = pg.hasPagination
    ? orderedEntryIDs.slice(pg.offset, pg.offset + pg.limit)
    : orderedEntryIDs;

  return buildMultiTagResult({
    entryIDs: finalEntryIDs,
    total: pg.hasPagination ? filteredEntryIDs.length : undefined,
    prettyTags,
    slugs: normalized,
    pg,
  });
}

module.exports = function fetchTaggedEntries(blogID, slugs, options) {
  return fetchTaggedEntriesInternal(blogID, slugs, options || {});
};
