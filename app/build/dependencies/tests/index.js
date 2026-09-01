describe("dependencies", function () {
  var depedencies = require("../index");

  // tests for depedencies

  function should_get_dependencies(input) {
    it("gets dependencies from " + input.path, function () {
      var result = depedencies(input.path, input.html, input.metadata);
      expect(result).toEqual(input.result);
    });
  }

  should_get_dependencies({
    html: '<img src="./goo.jpg">',
    path: "/foo/bar.txt",
    metadata: {},
    result: {
      html: '<img src="/foo/goo.jpg">',
      metadata: {},
      dependencies: ["/foo/goo.jpg"],
    },
  });

  should_get_dependencies({
    html: '<img src="goo.jpg">',
    path: "/foo/bar.txt",
    metadata: {},
    result: {
      html: '<img src="/foo/goo.jpg">',
      metadata: {},
      dependencies: ["/foo/goo.jpg"],
    },
  });

  // Should extract absolute paths
  should_get_dependencies({
    html: '<img src="/foo/goo.jpg">',
    path: "/foo/bar.txt",
    metadata: {},
    result: {
      html: '<img src="/foo/goo.jpg">',
      metadata: {},
      dependencies: ["/foo/goo.jpg"],
    },
  });

  // Should return unique list
  should_get_dependencies({
    html: '<img src="/foo/goo.jpg"><img src="/foo/goo.jpg">',
    path: "/foo/bar.txt",
    metadata: {},
    result: {
      html: '<img src="/foo/goo.jpg"><img src="/foo/goo.jpg">',
      metadata: {},
      dependencies: ["/foo/goo.jpg"],
    },
  });

  // Lots of items
  should_get_dependencies({
    html:
      '<script type="text/javascript" src="javascript.js"></script><img src="../image.jpg"><link rel="stylesheet" type="text/css" href="/theme.css">',
    path: "/sub/folder/post.txt",
    metadata: {},
    result: {
      html:
        '<script type="text/javascript" src="/sub/folder/javascript.js"></script><img src="/sub/image.jpg"><link rel="stylesheet" type="text/css" href="/theme.css">',
      metadata: {},
      dependencies: [
        "/sub/folder/javascript.js",
        "/sub/image.jpg",
        "/theme.css",
      ],
    },
  });

  // Links are resolved exactly like src attributes, extension and
  // all: a relative link to another post's source file resolves
  // directly to that file, not to the rendered post's permalink.
  should_get_dependencies({
    html: '<a href="page.html"></a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="/page.html"></a>',
      metadata: {},
      dependencies: ["/page.html"],
    },
  });

  // Same for a link with no extension at all
  should_get_dependencies({
    html: '<a href="other-page"></a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="/other-page"></a>',
      metadata: {},
      dependencies: ["/other-page"],
    },
  });

  // Should resolve relative links to plain files, e.g. a link
  // directly to another post's source file (not the rendered post)
  should_get_dependencies({
    html: '<a href="other-post.md"></a>',
    path: "/folder/post.txt",
    metadata: {},
    result: {
      html: '<a href="/folder/other-post.md"></a>',
      metadata: {},
      dependencies: ["/folder/other-post.md"],
    },
  });

  // Should resolve a relative link to a local image
  should_get_dependencies({
    html: '<a href="beach.jpg">Download</a>',
    path: "/photos/vacation.txt",
    metadata: {},
    result: {
      html: '<a href="/photos/beach.jpg">Download</a>',
      metadata: {},
      dependencies: ["/photos/beach.jpg"],
    },
  });

  // Should resolve an image wrapped in a link to the same image,
  // keeping both attributes in sync (the original bug report)
  should_get_dependencies({
    html: '<a href="beach.jpg"><img src="beach.jpg"></a>',
    path: "/photos/vacation.txt",
    metadata: {},
    result: {
      html: '<a href="/photos/beach.jpg"><img src="/photos/beach.jpg"></a>',
      metadata: {},
      dependencies: ["/photos/beach.jpg"],
    },
  });

  // Should preserve a fragment appended to a resolved link
  should_get_dependencies({
    html: '<a href="report.pdf#page=3">Report</a>',
    path: "/docs/index.txt",
    metadata: {},
    result: {
      html: '<a href="/docs/report.pdf#page=3">Report</a>',
      metadata: {},
      dependencies: ["/docs/report.pdf"],
    },
  });

  // Should preserve a query string appended to a resolved link
  should_get_dependencies({
    html: '<a href="report.pdf?download=1">Report</a>',
    path: "/docs/index.txt",
    metadata: {},
    result: {
      html: '<a href="/docs/report.pdf?download=1">Report</a>',
      metadata: {},
      dependencies: ["/docs/report.pdf"],
    },
  });

  // Should not touch fragment-only hrefs, e.g. footnotes and
  // tables of contents
  should_get_dependencies({
    html: '<a href="#fn1">1</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="#fn1">1</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Should not touch query-only hrefs
  should_get_dependencies({
    html: '<a href="?page=2">Next</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="?page=2">Next</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Should not touch links which are already absolute. It's still
  // added to `dependencies` (matching src) - an href the author
  // already wrote as absolute (e.g. a normal link to another post)
  // is treated exactly like one that's already resolved.
  should_get_dependencies({
    html: '<a href="/docs/report.pdf">Report</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="/docs/report.pdf">Report</a>',
      metadata: {},
      dependencies: ["/docs/report.pdf"],
    },
  });

  // Should not touch external links
  should_get_dependencies({
    html: '<a href="https://example.com/image.jpg">Image</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="https://example.com/image.jpg">Image</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Should not touch mailto/tel links, even with a dotted domain
  should_get_dependencies({
    html: '<a href="mailto:user@example.com">Email</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="mailto:user@example.com">Email</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Should not rewrite the href of a wikilink (title="wikilink"),
  // even when it looks like a file reference - the wikilinks plugin
  // resolves these later, from their original, unresolved target
  // text. The resolved guess is still tracked as a dependency, so
  // the post rebuilds automatically if a matching file appears.
  should_get_dependencies({
    html: '<a href="Spec Sheet.md" title="wikilink">Spec Sheet.md</a>',
    path: "/notes/index.txt",
    metadata: {},
    result: {
      html: '<a href="Spec Sheet.md" title="wikilink">Spec Sheet.md</a>',
      metadata: {},
      dependencies: ["/notes/Spec Sheet.md"],
    },
  });

  // Should not rewrite wikilink media embeds either, but should
  // still track the resolved guess as a dependency
  should_get_dependencies({
    html: '<img src="diagram.png" title="wikilink">',
    path: "/notes/index.txt",
    metadata: {},
    result: {
      html: '<img src="diagram.png" title="wikilink">',
      metadata: {},
      dependencies: ["/notes/diagram.png"],
    },
  });

  // A wikilink to another page, e.g. [[target-of-link]], has no
  // extension in its raw target - that literal guess can never
  // match a real file, so it should not be tracked as a dependency
  // (the wikilinks plugin tracks the actual resolved file itself)
  should_get_dependencies({
    html: '<a href="target-of-link" title="wikilink">target-of-link</a>',
    path: "/contains-wikilink.md",
    metadata: {},
    result: {
      html: '<a href="target-of-link" title="wikilink">target-of-link</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // SHould not extract them from URLs
  should_get_dependencies({
    html: '<img src="//google.com/goo.jpg">',
    path: "/bar.txt",
    metadata: {},
    result: {
      html: '<img src="//google.com/goo.jpg">',
      metadata: {},
      dependencies: [],
    },
  });

  // Should ignore non-file URL schemes (mailto)
  should_get_dependencies({
    html: '<img src="mailto:user@example.com">',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<img src="mailto:user@example.com">',
      metadata: {},
      dependencies: [],
    },
  });

  // Should ignore non-file URL schemes (tel)
  should_get_dependencies({
    html: '<img src="tel:+15551234567">',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<img src="tel:+15551234567">',
      metadata: {},
      dependencies: [],
    },
  });

  // Should ignore non-file URL schemes (sms)
  should_get_dependencies({
    html: '<img src="sms:+15551234567">',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<img src="sms:+15551234567">',
      metadata: {},
      dependencies: [],
    },
  });

  // SHould not consider itself a dependency
  should_get_dependencies({
    html: '<img src="/image.jpg">',
    path: "/image.jpg",
    metadata: {},
    result: {
      html: '<img src="/image.jpg">',
      metadata: {},
      dependencies: [],
    },
  });

  // A link to a post's own source file should still be rewritten to
  // an absolute path, just not counted as a dependency of itself.
  should_get_dependencies({
    html: '<a href="post.txt">Source</a>',
    path: "/folder/post.txt",
    metadata: {},
    result: {
      html: '<a href="/folder/post.txt">Source</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Browsers treat a backslash the same as a forward slash - a
  // single leading backslash is root-relative
  should_get_dependencies({
    html: '<a href="\\Files\\report.pdf">Report</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="/Files/report.pdf">Report</a>',
      metadata: {},
      dependencies: ["/Files/report.pdf"],
    },
  });

  // A double leading backslash is an external network-path
  // reference, same as "//host/..." - must not be resolved locally
  should_get_dependencies({
    html: '<a href="\\\\host\\report.pdf">Report</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="\\\\host\\report.pdf">Report</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Should preserve a trailing slash on a resolved directory link
  should_get_dependencies({
    html: '<a href="gallery/">Gallery</a>',
    path: "/posts/index.txt",
    metadata: {},
    result: {
      html: '<a href="/posts/gallery/">Gallery</a>',
      metadata: {},
      dependencies: ["/posts/gallery/"],
    },
  });

  // Should treat a bare "." as a directory reference too
  should_get_dependencies({
    html: '<a href=".">Home</a>',
    path: "/posts/index.txt",
    metadata: {},
    result: {
      html: '<a href="/posts/">Home</a>',
      metadata: {},
      dependencies: ["/posts/"],
    },
  });

  // Should treat a trailing "/." dot-segment as a directory reference
  should_get_dependencies({
    html: '<a href="gallery/.">Gallery</a>',
    path: "/posts/index.txt",
    metadata: {},
    result: {
      html: '<a href="/posts/gallery/">Gallery</a>',
      metadata: {},
      dependencies: ["/posts/gallery/"],
    },
  });

  // Should trim whitespace before classifying a fragment-only href
  should_get_dependencies({
    html: '<a href=" #details">Details</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href=" #details">Details</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Should trim whitespace before classifying a protocol-relative URL
  should_get_dependencies({
    html: '<a href=" //example.com/file.jpg">Download</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href=" //example.com/file.jpg">Download</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Should strip an embedded newline before classifying a URL,
  // not just leading/trailing whitespace
  should_get_dependencies({
    html: '<a href="ht\ntps://example.com/file.jpg">Download</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="ht\ntps://example.com/file.jpg">Download</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Should strip an embedded tab before classifying a URI scheme -
  // browsers do this too, closing off "java\tscript:" as a way to
  // sneak a scheme past a naive string check
  should_get_dependencies({
    html: '<a href="java\tscript:void(0)">Click</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="java\tscript:void(0)">Click</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Should not touch anchors using URI schemes it doesn't recognize
  should_get_dependencies({
    html: '<a href="javascript:void(0)">Click</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="javascript:void(0)">Click</a>',
      metadata: {},
      dependencies: [],
    },
  });

  should_get_dependencies({
    html: '<a href="geo:37.7,-122.4">Map</a>',
    path: "/post.txt",
    metadata: {},
    result: {
      html: '<a href="geo:37.7,-122.4">Map</a>',
      metadata: {},
      dependencies: [],
    },
  });

  // Authored link text is never touched, even when it happens to
  // equal the original href - only the destination gets resolved
  // (the autoImage plugin, which used to rely on href === text,
  // is responsible for tolerating this on its own side)
  should_get_dependencies({
    html: '<a href="photo.jpg">photo.jpg</a>',
    path: "/posts/index.txt",
    metadata: {},
    result: {
      html: '<a href="/posts/photo.jpg">photo.jpg</a>',
      metadata: {},
      dependencies: ["/posts/photo.jpg"],
    },
  });

  // A custom-labeled link (text !== href) should keep its label
  should_get_dependencies({
    html: '<a href="photo.jpg">My photo</a>',
    path: "/posts/index.txt",
    metadata: {},
    result: {
      html: '<a href="/posts/photo.jpg">My photo</a>',
      metadata: {},
      dependencies: ["/posts/photo.jpg"],
    },
  });

  // Should resolve thumbnail metadata
  should_get_dependencies({
    html: "Hello",
    path: "/foo/post.txt",
    metadata: { thumbnail: "image.jpg" },
    result: {
      html: "Hello",
      metadata: { thumbnail: "/foo/image.jpg" },
      dependencies: ["/foo/image.jpg"],
    },
  });


  // Should resolve thumbnail metadata with mixed-case key
  should_get_dependencies({
    html: "Hello",
    path: "/foo/post.txt",
    metadata: { ThUmBnAiL: "image.jpg" },
    result: {
      html: "Hello",
      metadata: { ThUmBnAiL: "/foo/image.jpg" },
      dependencies: ["/foo/image.jpg"],
    },
  });

  // Should ignore thumbnail metadata which is a URL
  should_get_dependencies({
    html: "x",
    path: "/foo/post.txt",
    metadata: { thumbnail: "http://wikipedia.org/example.jpg" },
    result: {
      html: "x",
      metadata: { thumbnail: "http://wikipedia.org/example.jpg" },
      dependencies: [],
    },
  });

  // Should resolve relative path in arbritrary metadata
  should_get_dependencies({
    html: '<img src="other-image.jpg">',
    path: "/foo/post.txt",
    metadata: { title: "./image.jpg" },
    result: {
      html: '<img src="/foo/other-image.jpg">',
      metadata: { title: "/foo/image.jpg" },
      dependencies: ["/foo/image.jpg", "/foo/other-image.jpg"],
    },
  });

  // Should ignore metadata without paths
  should_get_dependencies({
    html: "Hello",
    path: "/foo/post.txt",
    metadata: { title: "image.jpg" },
    result: {
      html: "Hello",
      metadata: { title: "image.jpg" },
      dependencies: [],
    },
  });
});
