const config = require("config");

const cdnRegex = (path) =>
  new RegExp(`${config.cdn.origin}/folder/v-[a-f0-9]{8}/blog_[a-f0-9]+${path}`);

const extractHash = (cdnURL) => {
  // New format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
  // Example: /template/f0/60/a480fb013c56e90af7f0ac1e961c/style.css
  const templateMatch = cdnURL.match(
    /\/template\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]+)\//
  );

  expect(templateMatch).toBeTruthy(`Invalid CDN URL format: ${cdnURL}`);

  const dir1 = templateMatch[1];
  const dir2 = templateMatch[2];
  const hashRemainder = templateMatch[3];

  // Reconstruct full hash: first 4 chars from dirs + remainder
  const hash = dir1 + dir2 + hashRemainder;

  expect(typeof hash).toBe("string", `Wrong CDN hash type: ${cdnURL}`);
  expect(hash.length).toBe(
    32,
    `Wrong CDN hash length: ${cdnURL} (got ${hash.length})`
  );

  return hash;
};

const validate = (cdnURL) => {
  // Check CDN origin is present
  expect(cdnURL).toContain(config.cdn.origin, `Missing CDN: ${cdnURL}`);

  // Check /template/ path is present
  expect(cdnURL).toContain(
    "/template/",
    `Missing "/template/" path: ${cdnURL}`
  );

  // New format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{viewName}
  // Validate the structure matches this pattern
  const urlPattern = new RegExp(
    `${config.cdn.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/template/[a-f0-9]{2}/[a-f0-9]{2}/[a-f0-9]+/.+`
  );

  expect(cdnURL).toMatch(urlPattern, `Wrong CDN URL format: ${cdnURL}`);

  // Extract hash and validate it's 32 characters
  const hash = extractHash(cdnURL);
  expect(hash.length).toBe(32, `Hash should be 32 characters: ${cdnURL}`);

  // Extract view name (filename) from URL
  const urlParts = cdnURL.split("/template/");
  expect(urlParts.length).toBe(2, `Invalid CDN URL structure: ${cdnURL}`);

  const pathAfterTemplate = urlParts[1];
  const pathSegments = pathAfterTemplate.split("/");
  expect(pathSegments.length).toBeGreaterThanOrEqual(
    4,
    `Invalid path segments: ${cdnURL}`
  );

  // Last segment should be the view name (filename)
  const fileName = pathSegments[pathSegments.length - 1];
  expect(fileName).toBeTruthy(`Missing CDN filename: ${cdnURL}`);
};

module.exports = {
  validate,
  extractHash,
  cdnRegex,
};
