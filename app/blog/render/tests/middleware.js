
describe("render middleware", function() {

  require('blog/tests/util/setup')();
  const config = require("config");

  // it("should handle errors in retrieving the full view", function() {

  // });

  // it("should handle non-existing views", function() {

  // });

  it("rewrites CDN links to http for requests served over http", async function () {
    // forceSSL defaults to true, and vhosts.js redirects any plain-http
    // request to https before it reaches this middleware - disable it so
    // the request actually reaches the CDN-link rewrite branch below.
    await this.blog.update({ forceSSL: false });
    await this.template({ "entries.html": "{{{cdn}}}" });

    const res = await this.get("/", {
      headers: { "x-forwarded-proto": "http" },
    });
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body).toEqual(config.cdn.origin.split("https://").join("http://"));
  });

  it("leaves CDN links as https for requests served over https", async function () {
    await this.template({ "entries.html": "{{{cdn}}}" });

    const body = await this.text("/");

    expect(body).toEqual(config.cdn.origin);
  });

  it("sends json when the query string debug or json is present", async function() {

    await this.write({path: '/a.txt', content: 'Link: /foo\n\nHello, world!'});
    await this.template({
      'entry.html': `Entry`
    });

    const res = await this.get('/foo?json=true');
    const body = await res.json();

    expect(res.status).toEqual(200);
    console.log(body);
    // expect body to be a json object
    expect(body.entry.path).toEqual('/a.txt');
    expect(body.feedURL).toEqual('/feed.rss');
    expect(body.handle).toEqual(this.blog.handle);
    expect(body.cacheID).toEqual(jasmine.any(Number));
  });

});