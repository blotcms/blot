// Sites in sites.txt are not tagged with a category directly —
// each has only a free-text bio (e.g. "software engineer",
// "production designer"). These rules match that bio against a
// fixed set of audience categories so /examples/:category can
// filter the list without touching sites.txt. A site's bio may
// match more than one category.

const CATEGORIES = [
  {
    slug: "writers",
    label: "Writers",
    keywords: [
      "writer",
      "journalist",
      "poet",
      "translator",
      "author",
      "novelist",
      "essayist",
      "critic",
    ],
  },
  {
    slug: "artists",
    label: "Artists",
    keywords: [
      "artist",
      "painter",
      "cartoonist",
      "illustrator",
      "jeweller",
      "sculptor",
      "dancer",
      "musician",
      "pianist",
    ],
  },
  {
    slug: "researchers",
    label: "Researchers",
    keywords: [
      "academic",
      "anthropologist",
      "historian",
      "economist",
      "epidemiologist",
      "linguist",
      "librarian",
      "think-tank director",
      "researcher",
      "scientist",
    ],
  },
  {
    slug: "photographers",
    label: "Photographers",
    keywords: [
      "photographer",
      "cinematographer",
      "production designer",
      "filmmaker",
    ],
  },
  {
    slug: "designers",
    label: "Designers",
    keywords: ["designer", "architect"],
  },
  {
    slug: "developers",
    label: "Developers",
    keywords: [
      "software engineer",
      "computer scientist",
      "engineer",
      "programmer",
      "developer",
    ],
  },
];

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bioMatchesKeyword(bio, keyword) {
  const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");
  return pattern.test(bio);
}

function categoryForSlug(slug) {
  return CATEGORIES.find((category) => category.slug === slug);
}

function siteMatchesCategory(site, category) {
  if (!site || !site.bio) return false;
  return category.keywords.some((keyword) => bioMatchesKeyword(site.bio, keyword));
}

function filterSitesByCategory(sites, slug) {
  const category = categoryForSlug(slug);
  if (!category) return null;
  return sites.filter((site) => siteMatchesCategory(site, category));
}

module.exports = {
  CATEGORIES,
  categoryForSlug,
  siteMatchesCategory,
  filterSitesByCategory,
};
