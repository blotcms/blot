describe("robots.txt", function () {
  require("./util/setup")();

  // this is designed to prevent search engines from indexing the blog twice
  it("returns an override if the blog has a custom domain and we request the blot subdomain", async function () {
    await this.template({ "robots.txt": "custom robots.txt" });

    const res = await this.get("/robots.txt");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body).toEqual("custom robots.txt");

    await this.blog.update({ domain: "example.com", redirectSubdomain: false });

    const res2 = await this.get("/robots.txt");
    const body2 = await res2.text();

    expect(res2.status).toEqual(200);
    expect(body2).toEqual("User-agent: *\nDisallow: /");
  });
});
