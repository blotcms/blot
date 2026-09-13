"use strict";

// Set BENCHMARK_DEBUG=1 to print per-blog sitemap expansion details.
const DEBUG = !!process.env.BENCHMARK_DEBUG;

function debug(...args) {
  if (DEBUG) console.log("[benchmark:sitemap]", ...args);
}

function extractPathsFromSitemap(xml) {
  const locPattern = /<loc>([^<]+)<\/loc>/g;
  const paths = [];

  let match;
  while ((match = locPattern.exec(xml)) !== null) {
    const rawLoc = decodeXmlEntities(match[1].trim());

    try {
      const parsed = new URL(rawLoc);
      paths.push(parsed.pathname + (parsed.search || ""));
    } catch (err) {
      // Ignore malformed sitemap entries; keep benchmarking the valid pages.
    }
  }

  return paths;
}

function isSitemapUrl(pathname) {
  return /sitemap.*\.xml$/i.test(pathname);
}

/**
 * Expand a sitemap index: start from /sitemap.xml, follow any <loc> that points
 * to another sitemap (e.g. sitemap-pages.xml) and collect every page URL.
 * Returns a de-duplicated list of paths that should be requested.
 */
async function expandSitemapUrls(blog, sitemapXml, getForBlog) {
  const allPaths = new Set();

  const initialPaths = extractPathsFromSitemap(sitemapXml);
  const nestedSitemaps = initialPaths.filter(isSitemapUrl);
  const pagePaths = initialPaths.filter((p) => !isSitemapUrl(p));

  pagePaths.forEach((p) => allPaths.add(p));

  debug(
    blog.handle,
    `${initialPaths.length} <loc> in /sitemap.xml`,
    `(${nestedSitemaps.length} nested sitemaps, ${pagePaths.length} pages)`
  );

  for (const sitemapPath of nestedSitemaps) {
    const res = await getForBlog(blog, sitemapPath, { redirect: "manual" });

    if (res.status !== 200) {
      debug(blog.handle, `skip ${sitemapPath} -> status ${res.status}`);
      continue;
    }

    const xml = await res.text();
    const paths = extractPathsFromSitemap(xml);
    paths.forEach((p) => allPaths.add(p));
    debug(blog.handle, `${sitemapPath} -> ${paths.length} <loc>`);
  }

  const final = Array.from(allPaths);
  debug(blog.handle, `${final.length} unique URLs for render`);
  return final;
}

function decodeXmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

module.exports = {
  extractPathsFromSitemap,
  expandSitemapUrls,
  decodeXmlEntities,
};
