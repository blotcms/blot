// Shared page/limit normalization for tagged listings and the posts retriever.
// Out-of-range sizes reset to the default (not clamped), matching the
// historical tagged-route behavior.

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

function normalizePageNumber(value) {
  const page = parseInt(value, 10);
  if (!page || page < 1) return 1;
  return page;
}

function normalizePageSize(value, options = {}) {
  const defaultSize = options.defaultSize ?? DEFAULT_PAGE_SIZE;
  const maxSize = options.maxSize ?? MAX_PAGE_SIZE;

  let size = parseInt(value, 10);
  if (!Number.isFinite(size)) size = undefined;
  if (!size || size < 1 || size > maxSize) return defaultSize;
  return size;
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  normalizePageNumber,
  normalizePageSize,
};
