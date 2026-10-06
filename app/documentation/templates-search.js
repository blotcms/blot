// A basic title-weighted + README search across the built-in templates.
// The template set is small and static enough (21 items) that an
// in-memory index built once from disk is simpler than anything backed
// by a search engine or Redis.
const fs = require("fs");
const path = require("path");

const TEMPLATES_DIRECTORY = path.join(__dirname, "../templates/source");
const NAME_MAP = { cv: "CV" };

// Title tiers are separated by a gap far wider than any README match
// count could plausibly close, so a template's title always outranks
// one that only matches in its README, no matter how many times.
const TITLE_TIER_GAP = 10000;
const TITLE_EXACT_WEIGHT = 3 * TITLE_TIER_GAP;
const TITLE_PREFIX_WEIGHT = 2 * TITLE_TIER_GAP;
const TITLE_CONTAINS_WEIGHT = 1 * TITLE_TIER_GAP;
const README_MATCH_WEIGHT = 1;
const README_SCORE_CAP = TITLE_TIER_GAP - 1;

let index = null;

function buildIndex() {
  const items = fs
    .readdirSync(TEMPLATES_DIRECTORY)
    .filter((i) => !i.startsWith(".") && !i.endsWith(".md"));

  return items
    .map((slug) => {
      const packagePath = path.join(TEMPLATES_DIRECTORY, slug, "package.json");
      if (!fs.existsSync(packagePath)) return null;

      const name = NAME_MAP[slug] || slug[0].toUpperCase() + slug.slice(1);

      const readmePath = path.join(TEMPLATES_DIRECTORY, slug, "README");
      const readme = fs.existsSync(readmePath)
        ? fs.readFileSync(readmePath, "utf8")
        : "";

      return {
        slug,
        name,
        nameLower: name.toLowerCase(),
        readmeLower: readme.toLowerCase(),
      };
    })
    .filter(Boolean);
}

// The index is rebuilt from disk on the first search after a server
// (re)start - the built-in template set doesn't change at runtime, so
// nothing here needs to watch app/templates/source for changes.
function getIndex() {
  if (!index) index = buildIndex();
  return index;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function scoreItem(item, terms) {
  let score = 0;

  for (const term of terms) {
    if (item.nameLower === term) score += TITLE_EXACT_WEIGHT;
    else if (item.nameLower.startsWith(term)) score += TITLE_PREFIX_WEIGHT;
    else if (item.nameLower.includes(term)) score += TITLE_CONTAINS_WEIGHT;

    const readmeMatches = countOccurrences(item.readmeLower, term);
    score += Math.min(readmeMatches * README_MATCH_WEIGHT, README_SCORE_CAP);
  }

  return score;
}

// Pure ranking function, reused by both the JSON API below (for the
// live in-page search box) and the /templates/search/:query page route
// (for a shareable, bookmarkable results URL).
function rank(rawQuery) {
  const q = String(rawQuery || "")
    .trim()
    .toLowerCase()
    .slice(0, 100);

  if (!q) return [];

  const terms = q.split(/\s+/).filter(Boolean);

  return getIndex()
    .map((item) => ({
      slug: item.slug,
      name: item.name,
      score: scoreItem(item, terms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

module.exports = function templatesSearch(req, res) {
  res.json({ results: rank(req.query.q) });
};

module.exports.getIndex = getIndex;
module.exports.rank = rank;
