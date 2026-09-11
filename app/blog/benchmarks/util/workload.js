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

function buildWorkload(config, blogs, rng) {
  const files = [];
  const filesPerSite = new Array(blogs.length).fill(0);
  const tagPoolBySite = blogs.map(() => buildTagPool(config, rng));
  const tagsUsedBySite = blogs.map(() => new Set());
  const searchKeywordPoolBySite = blogs.map(() =>
    buildSearchKeywordPool(config, rng)
  );
  const searchKeywordsUsedBySite = blogs.map(() => new Set());
  const hubSlugBySite = blogs.map(
    (_, blogIndex) => `benchmark-hub-${blogIndex}`
  );
  const hubCreatedBySite = blogs.map(() => false);

  for (let index = 0; index < config.files; index++) {
    const blogIndex = index % blogs.length;
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
    const filePath = isHub
      ? `/${slug}.txt`
      : `/${segments.join("/")}/${slug}.txt`;

    const tags = pickTags(rng, tagPoolBySite[blogIndex]);
    tags.forEach((tag) => tagsUsedBySite[blogIndex].add(tag));

    let keyword = null;
    const keywordPool = searchKeywordPoolBySite[blogIndex];
    if (keywordPool.length && rng() < SEARCH_KEYWORD_PROBABILITY) {
      keyword = keywordPool[Math.floor(rng() * keywordPool.length)];
      searchKeywordsUsedBySite[blogIndex].add(keyword);
    }

    const linksToHub = !isHub && rng() < HUB_LINK_PROBABILITY;

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
};
