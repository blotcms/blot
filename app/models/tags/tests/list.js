describe("tags.list", function () {
  const set = require("../set");
  const list = require("../list");

  // Create a test user and blog before each spec
  global.test.blog();

  it("can be invoked without error", function (done) {
    const blogID = this.blog.id;
    const entry1 = {
      id: "entry1",
      path: "/entry1",
      tags: ["tag1", "tag2"],
    };

    const entry2 = {
      id: "entry2",
      path: "/entry2",
      tags: ["tag2", "tag3"],
    };

    set(blogID, entry1, function (err) {
      set(blogID, entry2, function (err) {
        list(blogID, function (err, tags) {
          expect(err).toBeNull();

          const sortedTags = tags
            .sort((a, b) => a.slug.localeCompare(b.slug))
            .map((tag) => {
              return {
                name: tag.name,
                slug: tag.slug,
                entries: tag.entries.sort(),
              };
            });

          // tags.list now returns entry placeholders with null values
          // the important property is the entries array length
          expect(sortedTags).toEqual([
            { name: "tag1", slug: "tag1", entries: [null] },
            { name: "tag2", slug: "tag2", entries: [null, null] },
            { name: "tag3", slug: "tag3", entries: [null] },
          ]);
          done();
        });
      });
    });
  });

  it("filters tags by pathPrefix", function (done) {
    const blogID = this.blog.id;

    set(
      blogID,
      {
        id: "/Blog/one",
        path: "/Blog/one",
        tags: ["TagA", "TagB"],
      },
      function () {
        set(
          blogID,
          {
            id: "/Blog/two",
            path: "/Blog/two",
            tags: ["TagA"],
          },
          function () {
            set(
              blogID,
              {
                id: "/notes/one",
                path: "/notes/one",
                tags: ["TagB", "TagC"],
              },
              function () {
                list(blogID, { pathPrefix: "  Blog/ " }, function (err, tags) {
                  expect(err).toBeNull();

                  const sortedTags = tags
                    .sort((a, b) => a.slug.localeCompare(b.slug))
                    .map((tag) => ({
                      slug: tag.slug,
                      entries: tag.entries.slice().sort(),
                    }));

                  expect(sortedTags).toEqual([
                    { slug: "taga", entries: ["/Blog/one", "/Blog/two"] },
                    { slug: "tagb", entries: ["/Blog/one"] },
                  ]);

                  done();
                });
              }
            );
          }
        );
      }
    );
  });

  it("does not call zcard when filtering by pathPrefix", function (done) {
    const blogID = this.blog.id;
    const client = require("models/client");

    set(
      blogID,
      {
        id: "/Blog/one",
        path: "/Blog/one",
        tags: ["TagA"],
      },
      function () {
        spyOn(client, "zCard").and.callThrough();

        list(blogID, { pathPrefix: "Blog" }, function (err, tags) {
          expect(err).toBeNull();
          expect(tags).toEqual([
            {
              name: "TagA",
              slug: "taga",
              entries: ["/Blog/one"],
            },
          ]);
          expect(client.zCard).not.toHaveBeenCalled();
          done();
        });
      }
    );
  });
});

describe("tags.list without a callback", function () {
  const set = require("../set");
  const list = require("../list");
  const popular = require("../popular");

  global.test.blog();

  it("returns a promise", async function () {
    const blogID = this.blog.id;
    await new Promise((resolve, reject) =>
      set(blogID, { id: "p1", path: "/p1", tags: ["tag1"] }, (err) =>
        err ? reject(err) : resolve()
      )
    );

    const tags = await list(blogID);
    expect(tags.map((tag) => tag.slug)).toEqual(["tag1"]);
    expect(await popular(blogID)).toEqual([
      jasmine.objectContaining({ slug: "tag1", count: 1 }),
    ]);
  });

  it("rejects on a bad blog ID", async function () {
    await expectAsync(list(123)).toBeRejected();
    await expectAsync(popular(123)).toBeRejected();
  });
});
