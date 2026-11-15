// A tag's slug as it goes in a /tagged/:tag link. Stored slugs come from
// helper/makeSlug, which ends with encodeURI, so they are already
// percent-encoded except for "/", which encodeURI leaves alone. Encode just
// that, so a tag such as "Design/UI" still matches the single-segment route.
module.exports = function tagSlug(slug) {
  return typeof slug === "string" ? slug.replace(/\//g, "%2F") : slug;
};
