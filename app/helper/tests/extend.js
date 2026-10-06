describe("extend ", function () {
  var extend = require("../extend");

  it("merges two objects", function () {
    var a1 = {
        name: "Foo",
        this: "Bar",
        count: {
          shit: "piss",
          fuck: "that",
          hey: { there: { delilah: { woooooo: 1 } } },
        },
      },
      b1 = {
        name: "Shit",
        that: "This",
        count: {
          shit: "FHDJGDHJFGHJD",
          fuck: "FDHJFGDHJGFJHDF",
          then: "who",
          man: { who: "fuck" },
          hey: { there: { delilah: { SNOOOOO: "abc" } } },
        },
      },
      r1 = {
        name: "Foo",
        this: "Bar",
        that: "This",
        count: {
          shit: "piss",
          fuck: "that",
          then: "who",
          man: { who: "fuck" },
          hey: { there: { delilah: { woooooo: 1, SNOOOOO: "abc" } } },
        },
      };
    extend(a1).and(b1);
    expect(a1).toEqual(r1);
  });

  it("merges two other objects", function () {
    var a2 = {
      name: "Default",
      description:
        "The default template. Designed to work well with text, image and video posts. Set in Georgia & Helvetica.",
      thumb:
        "https://d1u95qvrdsh2gl.cloudfront.net/avatars/1425441405690_u054WwMUSeU8f9PmbymEhtDQ.png",
    };

    var b2 = {
      views: {
        archives: { url: "/archives", locals: [Object] },
        sitemap: { url: "/sitemap.xml" },
        feed: { url: "/feed.rss", type: "application/xml" },
        robots: { url: "/robots.txt" },
      },
    };

    var r2 = {
      name: "Default",
      description:
        "The default template. Designed to work well with text, image and video posts. Set in Georgia & Helvetica.",
      thumb:
        "https://d1u95qvrdsh2gl.cloudfront.net/avatars/1425441405690_u054WwMUSeU8f9PmbymEhtDQ.png",
      views: {
        archives: { url: "/archives", locals: [Object] },
        sitemap: { url: "/sitemap.xml" },
        feed: { url: "/feed.rss", type: "application/xml" },
        robots: { url: "/robots.txt" },
      },
    };

    extend(a2).and(b2);
    expect(a2).toEqual(r2);
  });

  it("merges arrays when both exist", function () {
    var a = { items: [1, 2], tags: ["foo"] };
    var b = { items: [3, 4], tags: ["bar", "foo"], other: [5, 6] };
    extend(a).and(b);
    expect(a.items).toEqual([1, 2, 3, 4]);
    expect(a.tags).toEqual(["foo", "bar"]); // deduplicated and sorted
    expect(a.other).toEqual([5, 6]);
  });

  it("sets array if undefined in target", function () {
    var a = { name: "Test" };
    var b = { items: [1, 2, 3] };
    extend(a).and(b);
    expect(a.items).toEqual([1, 2, 3]);
  });

  it("preserves array if undefined in source", function () {
    var a = { items: [1, 2, 3] };
    var b = { name: "Test" };
    extend(a).and(b);
    expect(a.items).toEqual([1, 2, 3]);
  });
});
