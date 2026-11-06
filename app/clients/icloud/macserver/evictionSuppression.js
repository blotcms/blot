const EVICTION_SUPPRESSION_BLOG_SCOPE = "*";
const EVICTION_SUPPRESSION_POST_MS = 2_000;
const EVICTION_SUPPRESSION_TTL_MS = 30_000;

const evictionSuppressionMap = new Map();

const buildEvictionSuppressionKey = (
  blogID,
  pathInBlogDirectory = EVICTION_SUPPRESSION_BLOG_SCOPE
) => `${blogID}:${pathInBlogDirectory}`;

const getSuppressionRecord = (key) => {
  const suppression = evictionSuppressionMap.get(key);

  if (!suppression) {
    return null;
  }

  if (suppression.expiresAt <= Date.now()) {
    evictionSuppressionMap.delete(key);
    return null;
  }

  return suppression;
};

const markEvictionSuppressed = (
  blogID,
  pathInBlogDirectory = EVICTION_SUPPRESSION_BLOG_SCOPE
) => {
  if (!blogID || !pathInBlogDirectory) {
    return;
  }

  const now = Date.now();
  evictionSuppressionMap.set(
    buildEvictionSuppressionKey(blogID, pathInBlogDirectory),
    {
      suppressUntil: Number.POSITIVE_INFINITY,
      expiresAt: now + EVICTION_SUPPRESSION_TTL_MS,
    }
  );
};

const extendEvictionSuppression = (
  blogID,
  pathInBlogDirectory = EVICTION_SUPPRESSION_BLOG_SCOPE
) => {
  if (!blogID || !pathInBlogDirectory) {
    return;
  }

  const now = Date.now();
  evictionSuppressionMap.set(
    buildEvictionSuppressionKey(blogID, pathInBlogDirectory),
    {
      suppressUntil: now + EVICTION_SUPPRESSION_POST_MS,
      expiresAt: now + EVICTION_SUPPRESSION_TTL_MS,
    }
  );
};

const isEvictionSuppressed = (blogID, pathInBlogDirectory) => {
  if (!blogID) {
    return false;
  }

  if (pathInBlogDirectory) {
    const scopedSuppression = getSuppressionRecord(
      buildEvictionSuppressionKey(blogID, pathInBlogDirectory)
    );

    if (scopedSuppression?.suppressUntil > Date.now()) {
      return true;
    }
  }

  const blogSuppression = getSuppressionRecord(
    buildEvictionSuppressionKey(blogID, EVICTION_SUPPRESSION_BLOG_SCOPE)
  );

  return Boolean(blogSuppression?.suppressUntil > Date.now());
};

// Resolves true once the blog is no longer eviction-suppressed, or false if it
// still is after timeoutMs (the suppression record itself expires after the
// TTL, so a stuck eviction cannot hold callers forever).
const waitForEvictionSuppressionToClear = async (
  blogID,
  {
    timeoutMs = EVICTION_SUPPRESSION_TTL_MS + EVICTION_SUPPRESSION_POST_MS,
    pollMs = 500,
  } = {}
) => {
  const deadline = Date.now() + timeoutMs;

  while (isEvictionSuppressed(blogID)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return true;
};

const pruneEvictionSuppressions = () => {
  const now = Date.now();
  for (const [key, suppression] of evictionSuppressionMap.entries()) {
    if (suppression.expiresAt <= now) {
      evictionSuppressionMap.delete(key);
    }
  }
};

export {
  EVICTION_SUPPRESSION_BLOG_SCOPE,
  markEvictionSuppressed,
  extendEvictionSuppression,
  isEvictionSuppressed,
  waitForEvictionSuppressionToClear,
  pruneEvictionSuppressions,
};
