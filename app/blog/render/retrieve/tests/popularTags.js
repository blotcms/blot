const Tags = require("models/tags");

describe("popular tags", function () {
  require("blog/tests/util/setup")();

  it("lists popular tags", async function () {
    await this.write({ path: "/a.txt", content: "Tags: abc\n\nFoo" });
    await this.write({ path: "/b.txt", content: "Tags: abc\n\nBar" });
    await this.write({ path: "/c.txt", content: "Tags: def\n\nBaz" });
    await this.write({ path: "/d.txt", content: "Tags: def\n\nQux" });
    await this.write({ path: "/e.txt", content: "Tags: def\n\nQuux" });

    await this.template({
      "entries.html": `<ul>{{#popular_tags}}<li>{{tag}} {{entries.length}}</li>{{/popular_tags}}</ul>`,
    });

    const res = await this.get("/");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>def 3</li><li>abc 2</li></ul>");
  });

  it("lists popular tags with many posts", async function () {
    const tags = Array.from({ length: 100 }, (_, i) => `tag${i}`);
    const tagUsage = {};

    for (let i = 0; i < 200; i++) {
      const numTags = (i % 5) + 1; // Deterministically assign the number of tags
      const postTags = tags.slice(0, numTags); // Use the first `numTags` tags
      for (const tag of postTags) {
        tagUsage[tag] = (tagUsage[tag] || 0) + 1;
      }
      await this.blog.write({
        path: `/post${i}.txt`,
        content: `Tags: ${postTags.join(", ")}\n\nContent ${i}`,
      });
    }

    await this.blog.rebuild();

    await this.template({
      "entries.html": `<ul>{{#popular_tags}}<li>{{tag}} {{entries.length}}</li>{{/popular_tags}}</ul>`,
    });

    const res = await this.get("/");
    const body = await res.text();

    const sortedTags = Object.keys(tagUsage).sort(
      (a, b) => tagUsage[b] - tagUsage[a]
    );
    const expectedHtml = `<ul>${sortedTags.map((tag) => `<li>${tag} ${tagUsage[tag]}</li>`).join("")}</ul>`;

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual(expectedHtml);
  }, 30000);

  it("supports limit and offset options", async function () {
    await this.write({ path: "/one.txt", content: "Tags: alpha, beta\n\nOne" });
    await this.write({ path: "/two.txt", content: "Tags: alpha, beta\n\nTwo" });
    await this.write({
      path: "/three.txt",
      content: "Tags: alpha, gamma\n\nThree",
    });

    await this.blog.rebuild();

    const results = await new Promise((resolve, reject) => {
      Tags.popular(this.blog.id, { limit: 1, offset: 1 }, function (err, tags) {
        if (err) return reject(err);
        resolve(tags);
      });
    });

    expect(results.length).toEqual(1);
    expect(results[0].slug).toEqual("beta");
    expect(results[0].count).toEqual(2);
  });
  it("encodes slugs in popular_tags output", async function () {
    await this.write({ path: "/a.txt", content: "Tags: Design/UI\n\nFoo" });
    await this.write({ path: "/b.txt", content: "Tags: Design/UI\n\nBar" });

    await this.template({
      "entries.html": `{{#popular_tags}}{{slug}}{{/popular_tags}}`,
    });

    const res = await this.get("/");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("design%2Fui");
  });
});
