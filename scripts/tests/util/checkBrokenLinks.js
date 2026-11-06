const cheerio = require("cheerio");
const { resolve, parse } = require("url");
const clfdate = require("helper/clfdate");

class LinkChecker {
  constructor(fetch, baseUrl, options = {}) {
    this.validateInputs(fetch, baseUrl, options);

    this.fetch = fetch;
    this.baseUrl = baseUrl;
    this.options = options;

    this.state = {
      checked: new Set(),
      results: {},
      failures: new Map(),
      skipped: new Set(),
    };
  }

  validateInputs(fetch, url, options) {
    if (typeof fetch !== "function") {
      throw new Error("The first argument must be a function");
    }
    if (typeof url !== "string") {
      throw new Error("The second argument must be a string");
    }
    if (typeof options !== "object") {
      throw new Error("The third argument must be an object");
    }
  }

  log(...args) {
    console.log(clfdate(), "Broken:", ...args);
  }

  formatBrokenLinksError(brokenLinks) {
    return brokenLinks
      .map(
        ({ page, link, status }) =>
          `From: ${page}\n  To: ${link}\n      ${status}\n`
      )
      .join("\n");
  }

  getBrokenLinks() {
    const brokenLinks = [];

    for (const page in this.state.results) {
      for (const link in this.state.results[page]) {
        brokenLinks.push({
          page,
          link,
          status: this.state.results[page][link],
        });
      }
    }

    return brokenLinks.sort((a, b) => a.page.localeCompare(b.page));
  }

  addFailure(base, url, statusCode) {
    const basePath = base ? parse(base).pathname : "undefined";
    const pathname = url ? parse(url).pathname : "undefined";

    this.state.failures.set(pathname, statusCode);
    this.state.results[basePath] = this.state.results[basePath] || {};
    this.state.results[basePath][pathname] = statusCode;
  }

  async fetchPage(url) {
    const headers = this.options.headers || {};

    try {
      return await this.fetch(url, { headers });
    } catch (err) {
      this.log("Error", err.message);
      throw new Error(err.code || "Network Error", { cause: err });
    }
  }

  isHtmlResponse(response) {
    const contentType = response.headers.get("content-type");
    return contentType && contentType.includes("text/html");
  }

  async parseUrls(base, body) {
    let $;
    try {
      $ = cheerio.load(body);
    } catch (e) {
      throw new Error(`Failed to parse HTML: ${e.message}`, { cause: e });
    }

    return $("[href], [src]")
      .map((_, el) => $(el).attr("href") || $(el).attr("src"))
      .get()
      .filter(Boolean)
      .map((url) => resolve(base, url))
      .filter((url) => this.shouldCheckUrl(url, base));
  }

  shouldCheckUrl(url, base) {
    if (this.state.skipped.has(url) || parse(url).host !== parse(base).host) {
      this.state.skipped.add(url);
      return false;
    }
    return true;
  }

  async checkPage(base, url) {
    const pathname = parse(url).pathname;

    if (this.state.failures.has(pathname)) {
      this.addFailure(base, url, this.state.failures.get(pathname));
      return;
    }

    if (this.state.checked.has(pathname)) {
      return;
    }

    this.state.checked.add(pathname);

    try {
      const response = await this.fetchPage(url);

      if (response.status !== 200 && response.status !== 400) {
        this.addFailure(base, url, response.status);
      }

      if (this.isHtmlResponse(response)) {
        const body = await response.text();
        const urls = await this.parseUrls(url, body);
        await Promise.all(urls.map((url) => this.checkPage(base, url)));
      }
    } catch (error) {
      this.addFailure(base, url, error.message);
    }
  }

  async check() {
    await this.checkPage(this.baseUrl, this.baseUrl);

    const brokenLinks = this.getBrokenLinks();

    if (brokenLinks.length > 0) {
      throw new Error(
        "Broken links found:\n" + this.formatBrokenLinksError(brokenLinks)
      );
    }

    return null;
  }
}

async function checkLinks(fetch, url, options = {}) {
  const checker = new LinkChecker(fetch, url, options);
  return checker.check();
}

module.exports = checkLinks;
