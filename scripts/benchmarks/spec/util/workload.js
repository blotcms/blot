const path = require("path");
const { getFixtures } = require("./fixtures");

// Modelled on a real customer blog that suffered severe request-queueing
// slowdowns: several hundred entries, each carrying a handful of tags out of
// a few dozen distinct ones, so most tag pages have a healthy number of
// matching entries rather than one or two.
function buildTagPool(config, rng) {
  const tagCount = Math.max(0, Math.floor(config.tags));
  const pool = [];

  for (let i = 0; i < tagCount; i++) {
    pool.push(`benchmark-tag-${i}-${randomWord(rng, 6)}`);
  }

  return pool;
}

function pickTags(rng, tagPool) {
  if (!tagPool.length) return [];

  const tagsPerEntry = 1 + Math.floor(rng() * 4); // 1-4 tags, like real posts
  const picked = new Set();

  for (let i = 0; i < tagsPerEntry && picked.size < tagPool.length; i++) {
    picked.add(tagPool[Math.floor(rng() * tagPool.length)]);
  }

  return Array.from(picked);
}

// A distinct word pool spliced verbatim into a fraction of entry bodies, so
// full-text search (Entry.search matches against title/tags/path/html) has
// realistic, guaranteed-to-match terms instead of relying on random word
// collisions.
function buildSearchKeywordPool(config, rng) {
  const keywordCount = Math.max(0, Math.floor(config.searchKeywords));
  const pool = [];

  for (let i = 0; i < keywordCount; i++) {
    pool.push(`benchmarkkeyword${i}${randomWord(rng, 5)}`);
  }

  return pool;
}

// Roughly a third of entries carry one search keyword, so most keywords have
// a healthy pool of matching entries for Entry.search to scan and sort.
const SEARCH_KEYWORD_PROBABILITY = 0.35;
// Roughly a quarter of non-hub entries link to their site's hub entry, so
// the hub accumulates a realistic backlinks list.
const HUB_LINK_PROBABILITY = 0.25;

// --- skewed (production-shaped) distribution helpers ----------------------
//
// Draws one log-normal weight per site, with a small chance of a much larger
// "mega site" multiplier, so that allocating a fixed total (posts, tags,
// keywords, ...) across weights produces the "a few sites have thousands,
// most sites have a handful" shape the flat/round-robin mode doesn't.
// Deterministic given the caller's seeded rng.
function buildSiteWeights(rng, siteCount) {
  const weights = [];

  for (let i = 0; i < siteCount; i++) {
    // Box-Muller transform for a standard normal sample.
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    const sigma = 1.8; // heavier tail = more skew between small/large sites
    let weight = Math.exp(z * sigma);

    // ~1% of sites become "mega" sites, pushing them far into the long tail
    // (thousands of posts/tags) the way a handful of real customer blogs
    // dwarf the median blog.
    if (rng() < 0.01) weight *= 40;

    weights.push(weight);
  }

  return weights;
}

// Allocates `total` discrete units across `weights` proportionally, with a
// floor of `min` per bucket, correcting rounding drift against the largest
// buckets so the sum stays exactly `total`.
function allocateByWeight(total, weights, min = 0) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const counts = weights.map((w) =>
    Math.max(min, Math.round((w / sum) * total))
  );

  const order = counts
    .map((_, i) => i)
    .sort((a, b) => weights[b] - weights[a]);

  let diff = total - counts.reduce((a, b) => a + b, 0);
  let guard = 0;
  const maxGuard = Math.abs(diff) * order.length + order.length + 10;

  while (diff !== 0 && guard < maxGuard) {
    const i = order[guard % order.length];

    if (diff > 0) {
      counts[i] += 1;
      diff -= 1;
    } else if (counts[i] > min) {
      counts[i] -= 1;
      diff += 1;
    }

    guard += 1;
  }

  return counts;
}

// `mediaFiles` is the (already-generated, see lib/generate-media.js)
// absolute-path list of the shared media pool - passed in rather than
// resolved here since generating it is async and this function is not, and
// because its location depends on config.blog_folder_dir which is only
// known to the caller (build-render.spec.js).
function buildWorkload(config, blogs, rng, mediaFiles = []) {
  const distribution = config.distribution === "skewed" ? "skewed" : "flat";
  const mediaFraction = Math.min(1, Math.max(0, config.mediaFraction || 0));
  mediaFiles = mediaFraction > 0 ? mediaFiles : [];

  const siteWeights =
    distribution === "skewed"
      ? buildSiteWeights(rng, blogs.length)
      : blogs.map(() => 1);

  // In flat mode every site gets the same-size tag/keyword pool (config.tags
  // / config.searchKeywords, unchanged behavior). In skewed mode the *total*
  // tag/keyword budget across all sites is config.tags/searchKeywords times
  // the site count, but it's allocated proportionally to each site's weight
  // (floor of 3) so a few big sites get thousands of tags/keywords and most
  // sites get a handful - mirroring the post-count skew.
  const tagCountBySite =
    distribution === "skewed"
      ? allocateByWeight(
          Math.max(0, Math.floor(config.tags)) * blogs.length,
          siteWeights,
          Math.min(3, Math.max(0, Math.floor(config.tags)))
        )
      : blogs.map(() => Math.max(0, Math.floor(config.tags)));

  const keywordCountBySite =
    distribution === "skewed"
      ? allocateByWeight(
          Math.max(0, Math.floor(config.searchKeywords)) * blogs.length,
          siteWeights,
          Math.min(3, Math.max(0, Math.floor(config.searchKeywords)))
        )
      : blogs.map(() => Math.max(0, Math.floor(config.searchKeywords)));

  if (distribution === "skewed" && config.files < blogs.length) {
    // allocateByWeight's "minimum one file per site" floor means every site
    // gets at least 1 file regardless of weighting, so a --files below
    // --sites would silently produce more files than requested and disagree
    // with what gets recorded in the manifest/config. "Give every site at
    // least one post" and "total below site count" are contradictory - fail
    // fast instead of generating a mismatched corpus.
    throw new Error(
      `--distribution skewed requires --files (${config.files}) >= --sites (${blogs.length}) ` +
        `since every site gets at least one file`
    );
  }

  const filesPerSiteTarget =
    distribution === "skewed"
      ? allocateByWeight(config.files, siteWeights, 1)
      : null;

  const files = [];
  const filesPerSite = new Array(blogs.length).fill(0);
  const tagPoolBySite = blogs.map((_, i) =>
    buildTagPool({ tags: tagCountBySite[i] }, rng)
  );
  const tagsUsedBySite = blogs.map(() => new Set());
  const searchKeywordPoolBySite = blogs.map((_, i) =>
    buildSearchKeywordPool({ searchKeywords: keywordCountBySite[i] }, rng)
  );
  const searchKeywordsUsedBySite = blogs.map(() => new Set());
  const hubSlugBySite = blogs.map(
    (_, blogIndex) => `benchmark-hub-${blogIndex}`
  );
  const hubCreatedBySite = blogs.map(() => false);

  // Build the (blogIndex, globalIndex) sequence to generate. Flat mode keeps
  // the original round-robin order (index % blogs.length) exactly. Skewed
  // mode instead walks each site's pre-allocated post count in turn, so
  // sites with thousands of posts actually get thousands of posts rather
  // than an even split.
  const entryPlan = [];

  if (distribution === "skewed") {
    for (let blogIndex = 0; blogIndex < blogs.length; blogIndex++) {
      for (let n = 0; n < filesPerSiteTarget[blogIndex]; n++) {
        entryPlan.push(blogIndex);
      }
    }
  } else {
    for (let index = 0; index < config.files; index++) {
      entryPlan.push(index % blogs.length);
    }
  }

  for (let index = 0; index < entryPlan.length; index++) {
    const blogIndex = entryPlan[index];
    filesPerSite[blogIndex] += 1;

    const depth = 1 + Math.floor(rng() * 3);
    const segments = [];

    for (let i = 0; i < depth; i++) {
      segments.push(randomWord(rng, 6 + Math.floor(rng() * 8)));
    }

    // The first entry generated for each site becomes that site's "hub" -
    // a fixed, known URL that a fraction of later entries link to, so it
    // accumulates a realistic backlinks list (see augment.js's per-backlink
    // Entry.getByUrl fan-out).
    const isHub = !hubCreatedBySite[blogIndex];
    hubCreatedBySite[blogIndex] = true;

    const slug = isHub
      ? hubSlugBySite[blogIndex]
      : `benchmark-${blogIndex}-${index}-${randomWord(rng, 8)}`;

    const tags = pickTags(rng, tagPoolBySite[blogIndex]);
    tags.forEach((tag) => tagsUsedBySite[blogIndex].add(tag));

    let keyword = null;
    const keywordPool = searchKeywordPoolBySite[blogIndex];
    if (keywordPool.length && rng() < SEARCH_KEYWORD_PROBABILITY) {
      keyword = keywordPool[Math.floor(rng() * keywordPool.length)];
      searchKeywordsUsedBySite[blogIndex].add(keyword);
    }

    const linksToHub = !isHub && rng() < HUB_LINK_PROBABILITY;

    // A configurable fraction of (non-hub) posts get a hard link to a file
    // from the shared media pool instead of plain text, so a big corpus
    // still exercises the image pipeline without unique media bytes per
    // post (see build-render.spec.js's write step for why this is a hard
    // link and not a symlink). Picked pseudo-randomly per post from the
    // same seeded rng, so it's reproducible.
    const wantsMedia =
      !isHub && mediaFiles.length > 0 && rng() < mediaFraction;
    const mediaPath = wantsMedia
      ? mediaFiles[Math.floor(rng() * mediaFiles.length)]
      : null;

    if (mediaPath) {
      const mediaExt = mediaPath.slice(mediaPath.lastIndexOf("."));
      const filePath = isHub
        ? `/${slug}${mediaExt}`
        : `/${segments.join("/")}/${slug}${mediaExt}`;

      files.push({ blogIndex, path: filePath, mediaPath });

      // Media posts still need a text entry so they show up in the sitemap/
      // tag/search indices like a normal post; the media file itself is
      // just an extra asset referenced from within it, matching how authors
      // actually attach images to a post folder.
      const textFilePath = isHub
        ? `/${slug}.txt`
        : `/${segments.join("/")}/${slug}.txt`;

      files.push({
        blogIndex,
        path: textFilePath,
        content: makeEntryContent({
          rng,
          slug,
          blogIndex,
          index,
          tags,
          keyword,
          hubPath: linksToHub ? `/${hubSlugBySite[blogIndex]}` : null,
          // The body must reference the *hard-linked destination's* name
          // (`${slug}${mediaExt}`, written to `filePath` above), not the
          // pool source file's own basename - those differ (the pool file
          // is one of ~24 shared fixtures reused across many posts, while
          // each post gets its own slug), so linking the source's basename
          // would point at a filename that doesn't exist alongside the post.
          mediaFilename: path.basename(filePath),
        }),
      });

      filesPerSite[blogIndex] += 1;
      continue;
    }

    const filePath = isHub
      ? `/${slug}.txt`
      : `/${segments.join("/")}/${slug}.txt`;

    files.push({
      blogIndex,
      path: filePath,
      content: makeEntryContent({
        rng,
        slug,
        blogIndex,
        index,
        tags,
        keyword,
        hubPath: linksToHub ? `/${hubSlugBySite[blogIndex]}` : null,
      }),
    });
  }

  const fixtures = getFixtures();
  for (let blogIndex = 0; blogIndex < blogs.length; blogIndex++) {
    for (const { sourcePath, targetPath } of fixtures) {
      files.push({ blogIndex, path: targetPath, sourcePath });
      filesPerSite[blogIndex] += 1;
    }
  }

  return {
    files,
    filesPerSite,
    fixtureCount: fixtures.length,
    distribution,
    tagsBySite: tagsUsedBySite.map((set) => Array.from(set)),
    searchKeywordsBySite: searchKeywordsUsedBySite.map((set) =>
      Array.from(set)
    ),
    // null for a site that ended up with zero entries (fewer --files than
    // --sites); consumers should treat that as "no hub for this site".
    hubPathBySite: hubCreatedBySite.map((created, blogIndex) =>
      created ? `/${hubSlugBySite[blogIndex]}` : null
    ),
  };
}

function makeEntryContent({
  rng,
  slug,
  blogIndex,
  index,
  tags,
  keyword,
  hubPath,
  mediaFilename,
}) {
  const sentenceCount = 3 + Math.floor(rng() * 5);
  const sentences = [];

  for (let i = 0; i < sentenceCount; i++) {
    sentences.push(randomSentence(rng));
  }

  const header = [`Title: Benchmark ${blogIndex}-${index}`, `Link: /${slug}`];

  if (tags && tags.length) {
    header.push(`Tags: ${tags.join(", ")}`);
  }

  let body = sentences.join(" ");

  if (keyword) {
    body += ` This entry also mentions ${keyword} in passing.`;
  }

  if (hubPath) {
    body += ` See also [this related entry](${hubPath}) for more.`;
  }

  if (mediaFilename) {
    body += `\n\n![](./${mediaFilename})`;
  }

  return [...header, "", body, ""].join("\n");
}

function randomSentence(rng) {
  const words = [];
  const wordCount = 8 + Math.floor(rng() * 10);

  for (let index = 0; index < wordCount; index++) {
    words.push(randomWord(rng, 3 + Math.floor(rng() * 7)));
  }

  const first = words[0];
  words[0] = first[0].toUpperCase() + first.slice(1);

  return `${words.join(" ")}.`;
}

function randomWord(rng, length) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let output = "";

  while (output.length < length) {
    const idx = Math.floor(rng() * chars.length);
    output += chars[idx];
  }

  return output;
}

module.exports = {
  buildWorkload,
  makeEntryContent,
  randomSentence,
  randomWord,
  buildSiteWeights,
  allocateByWeight,
};
