describe("resolveFolderLinks", function () {
  const resolveFolderLinks = require("../util/resolveFolderLinks");
  const Mustache = require("mustache");

  const hosts = ["example.blot.im", "www.example.blot.im", "example.com"];

  const html = (content, options) =>
    resolveFolderLinks(
      content,
      Object.assign({ viewName: "index.html", hosts }, options)
    );

  const css = (content, options) =>
    resolveFolderLinks(
      content,
      Object.assign({ viewName: "style.css", hosts }, options)
    );

  const wrap = (path) => `{{#cdn}}${path}{{/cdn}}`;

  describe("HTML attributes", function () {
    it("wraps double quoted, single quoted and unquoted values", function () {
      expect(html('<img src="/a.png">')).toBe(`<img src="${wrap("/a.png")}">`);
      expect(html("<img src='/a.png'>")).toBe(`<img src='${wrap("/a.png")}'>`);
      expect(html("<img src=/a.png>")).toBe(`<img src=${wrap("/a.png")}>`);
    });

    it("handles href, src and poster", function () {
      expect(
        html(
          '<link href="/style.css"><script src="/app.js"></script><video poster="/p.jpg" src="/v.mp4"></video><a href="/file.pdf">x</a>'
        )
      ).toBe(
        `<link href="${wrap("/style.css")}"><script src="${wrap("/app.js")}"></script><video poster="${wrap("/p.jpg")}" src="${wrap("/v.mp4")}"></video><a href="${wrap("/file.pdf")}">x</a>`
      );
    });

    it("is not case sensitive about attribute names or tags", function () {
      expect(html('<IMG SRC="/a.png">')).toBe(`<IMG SRC="${wrap("/a.png")}">`);
    });

    it("keeps the query string and hash in the target", function () {
      expect(html('<img src="/a.png?v=2#top">')).toBe(
        `<img src="${wrap("/a.png?v=2#top")}">`
      );
      expect(html('<img src="/a.png?x=1&amp;y=2">')).toBe(
        `<img src="${wrap("/a.png?x=1&amp;y=2")}">`
      );
    });

    it("wraps each srcset candidate separately", function () {
      expect(
        html(
          '<img srcset="/a.png 1x, /b.png 2x,/c.png 3x, https://other.com/d.png 4x" src="/a.png">'
        )
      ).toBe(
        `<img srcset="${wrap("/a.png")} 1x, ${wrap("/b.png")} 2x,${wrap("/c.png")} 3x, https://other.com/d.png 4x" src="${wrap("/a.png")}">`
      );
    });

    it("leaves a malformed srcset unchanged, ", function () {
      [
        '<img srcset=", /img.jpg 1x">',
        '<img srcset="/img.jpg 1x,">',
        '<img srcset="/a.jpg 1x, , /b.jpg 2x">',
      ].forEach((input) => expect(html(input)).toBe(input));
    });

    it("leaves empty href and src values alone", function () {
      const input = '<img src=""><a href="">';

      expect(html(input)).toBe(input);
    });

    it("wraps meta content that points at a file", function () {
      expect(
        html(
          '<meta property="og:image" content="/img/share.png"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x" content="share.png"><meta name="y" content="/not a file">'
        )
      ).toBe(
        `<meta property="og:image" content="${wrap("/img/share.png")}"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x" content="share.png"><meta name="y" content="/not a file">`
      );
    });

    it("leaves content on other elements alone", function () {
      const input = '<div content="/a.png"></div>';
      expect(html(input)).toBe(input);
    });

    it("wraps a link inside an attribute-level mustache section", function () {
      expect(html('<a {{#x}}href="/a.png"{{/x}}>a</a>')).toBe(
        `<a {{#x}}href="${wrap("/a.png")}"{{/x}}>a</a>`
      );
    });
  });

  describe("CSS", function () {
    it("wraps url() in a CSS view, quoted or not", function () {
      expect(
        css(
          'a{background:url(/a.png)} b{background:url("/b.png")} c{background:url(\'/c.png\')} d{background:url( /d.png )}'
        )
      ).toBe(
        `a{background:url(${wrap("/a.png")})} b{background:url("${wrap("/b.png")}")} c{background:url('${wrap("/c.png")}')} d{background:url( ${wrap("/d.png")} )}`
      );
    });

    it("wraps url() in <style> blocks and inline style attributes", function () {
      expect(
        html(
          '<style>a{background:url(/a.png)}</style><div style="background:url(/b.png)"></div><div style=\'background:url("/c.png")\'></div>'
        )
      ).toBe(
        `<style>a{background:url(${wrap("/a.png")})}</style><div style="background:url(${wrap("/b.png")})"></div><div style='background:url("${wrap("/c.png")}")'></div>`
      );
    });

    it("ignores comments and strings", function () {
      const input = 'a{content:"url(/a.png)"} /* url(/b.png) */';
      expect(css(input)).toBe(input);
    });

    it("ignores things that merely end in url(", function () {
      const input = "a{background:my-url(/a.png)}";
      expect(css(input)).toBe(input);
    });

    it("only treats CSS views, <style> blocks and style attributes as CSS", function () {
      const input = "<p>url(/a.png)</p>";
      expect(html(input)).toBe(input);
    });

    it("skips values that are not folder files", function () {
      const input =
        "a{background:url(https://other.com/a.png)} b{background:url(data:image/png;base64,AAAA)} c{background:url(/page.html)} d{background:url(/noextension)} e{background:url(#frag)}";
      expect(css(input)).toBe(input);
    });

    it("leaves url() with mustache tags in the value alone", function () {
      const input = "a{background:url({{image}})} b{background:url(/img/{{n}}.png)}";
      expect(css(input)).toBe(input);
    });

    it("wraps a {{blog.url}} prefixed url()", function () {
      expect(css("a{background:url({{{blog.url}}}/a.png)}")).toBe(
        `a{background:url(${wrap("/a.png")})}`
      );
    });

    it("only applies to views served as HTML or CSS", function () {
      const input = 'var a = "<img src=\'/a.png\'>"; var b = "url(/b.png)";';
      expect(resolveFolderLinks(input, { viewName: "script.js", hosts })).toBe(
        input
      );
      expect(resolveFolderLinks(input, { viewName: "feed.rss", hosts })).toBe(
        input
      );
    });

    it("honours an explicit legacy view type", function () {
      expect(
        resolveFolderLinks("a{background:url(/a.png)}", {
          viewName: "style",
          viewType: "text/css",
          hosts,
        })
      ).toBe(`a{background:url(${wrap("/a.png")})}`);
    });
  });

  describe("mustache values", function () {
    it("skips values containing mustache tags", function () {
      const input =
        '<img src="{{x}}/a.png"><img src="/a{{y}}.png"><img src="/{{{z}}}"><img src="{{> partial}}.png">';
      expect(html(input)).toBe(input);
    });

    it("wraps a {{blog.url}} or {{{blog.url}}} prefix followed by a literal path", function () {
      expect(html('<img src="{{blog.url}}/a.png">')).toBe(
        `<img src="${wrap("/a.png")}">`
      );
      expect(html('<img src="{{{blog.url}}}/a.png">')).toBe(
        `<img src="${wrap("/a.png")}">`
      );
      expect(html('<img src="{{ blog.url }}/dir/a.png?x=1">')).toBe(
        `<img src="${wrap("/dir/a.png?x=1")}">`
      );
    });

    it("wraps a {{blogURL}} or {{siteURL}} prefix like {{blog.url}}", function () {
      expect(html('<link rel="preload" href="{{{blogURL}}}/_Fonts/a.woff2">')).toBe(
        `<link rel="preload" href="${wrap("/_Fonts/a.woff2")}">`
      );
      expect(html('<img src="{{siteURL}}/a.png">')).toBe(
        `<img src="${wrap("/a.png")}">`
      );
      expect(html('<img src="{{blogURL}}/{{name}}.png">')).toBe(
        '<img src="{{blogURL}}/{{name}}.png">'
      );
    });

    it("skips a {{blog.url}} prefix followed by more mustache or a non path", function () {
      const input =
        '<img src="{{blog.url}}/{{name}}.png"><img src="{{blog.url}}a.png"><img src="{{blog.url}}">';
      expect(html(input)).toBe(input);
    });

    it("skips values already wrapped in {{#cdn}}", function () {
      const input = '<img src="{{#cdn}}/a.png{{/cdn}}"><img src="{{{cdn}}}/a.png">';
      expect(html(input)).toBe(input);
    });

    it("skips links inside the author's own {{#cdn}} section", function () {
      expect(html('{{#cdn}}<img src="/a.png">{{/cdn}}<img src="/b.png">')).toBe(
        `{{#cdn}}<img src="/a.png">{{/cdn}}<img src="${wrap("/b.png")}">`
      );
    });

    it("skips values already baked with the CDN token", function () {
      const input = '<img src="%%BLOT_CDN%%/folder/v-abcd1234/blog_1/a.png">';
      expect(html(input)).toBe(input);
    });

    it("wraps links inside sections", function () {
      expect(html('{{#x}}<img src="/a.png">{{/x}}{{^x}}<img src="/b.png">{{/x}}')).toBe(
        `{{#x}}<img src="${wrap("/a.png")}">{{/x}}{{^x}}<img src="${wrap("/b.png")}">{{/x}}`
      );
    });

    it("does not touch the text of comments", function () {
      const input = '{{! <img src="/a.png"> }}<!-- <img src="/b.png"> -->';
      expect(html(input)).toBe(input);
    });

    it("does not touch script contents", function () {
      const input =
        '<script>var s = \'<img src="/a.png">\'; var t = "url(/b.png)";</script>';
      expect(html(input)).toBe(input);
    });

    it("keeps going after a script", function () {
      expect(html('<script>var a = 1;</script><img src="/a.png">')).toBe(
        `<script>var a = 1;</script><img src="${wrap("/a.png")}">`
      );
    });

    it("leaves a template that changes delimiters alone", function () {
      const input = '{{=<% %>=}}<img src="/a.png">';
      expect(html(input)).toBe(input);
    });
  });

  describe("which links are folder files", function () {
    it("strips the blog's own hosts", function () {
      expect(
        html(
          '<img src="https://example.blot.im/a.png"><img src="http://www.example.blot.im/b.png?v=1"><img src="//example.com/c.png"><img src="https://example.blot.im/">'
        )
      ).toBe(
        `<img src="${wrap("/a.png")}"><img src="${wrap("/b.png?v=1")}"><img src="${wrap("/c.png")}"><img src="https://example.blot.im/">`
      );
    });

    it("leaves other hosts alone", function () {
      const input =
        '<img src="https://other.com/a.png"><img src="//other.com/a.png"><img src="https://example.blot.im.evil.com/a.png">';
      expect(html(input)).toBe(input);
    });

    it("skips data:, mailto: and other schemes, and fragments", function () {
      const input =
        '<img src="data:image/png;base64,AAA="><a href="mailto:a@b.co">x</a><a href="tel:+1.2">x</a><a href="javascript:a.b()">x</a><a href="#section.1">x</a><a href="?a=b.c">x</a>';
      expect(html(input)).toBe(input);
    });

    it("skips .html paths and paths without an extension", function () {
      const input =
        '<a href="/about.html">a</a><a href="/about">a</a><a href="/dir.d/page">a</a><a href="/">a</a>';
      expect(html(input)).toBe(input);
    });

    it("skips empty values and values with stray padding", function () {
      const input = '<img src=""><img src=" /a.png "><img src>';
      expect(html(input)).toBe(input);
    });

    it("percent-encodes spaces in a path instead of skipping it", function () {
      expect(html('<img src="/my file.png">')).toBe(
        `<img src="${wrap("/my%20file.png")}">`
      );
    });

    it("percent-encodes a % that doesn't start an escape", function () {
      expect(html('<img src="/100% luck.jpg">')).toBe(
        `<img src="${wrap("/100%25%20luck.jpg")}">`
      );
    });

    it("keeps the case and percent-encoding of the path as written", function () {
      expect(html('<img src="/Photos/My%20Photo.JPG">')).toBe(
        `<img src="${wrap("/Photos/My%20Photo.JPG")}">`
      );
    });

    it("wraps reserved global paths ", function () {
      expect(html('<link href="/fonts/x.css">')).toBe(
        `<link href="${wrap("/fonts/x.css")}">`
      );
    });

    it("ignores path traversal that has no file to point at", function () {
      const input =
        '<a href="../../../../etc/passwd">a</a><img src="/../../etc/passwd">';

      expect(html(input)).toBe(input);
    });

    it("leaves relative links that climb with .. alone", function () {
      const input = '<img src="../../../../a.jpg">';

      expect(html(input)).toBe(input);
    });

    it("resolves a CSS url() that climbs with .. against the root", function () {
      expect(css("a{background:url(../../../../a.jpg)}")).toBe(
        `a{background:url(${wrap("/a.jpg")})}`
      );
      expect(
        css("@font-face{src:url('../Type/x.woff2') format('woff2')}")
      ).toBe(`@font-face{src:url('${wrap("/Type/x.woff2")}') format('woff2')}`);
      expect(css('a{background:url("../../etc/passwd")}')).toBe(
        'a{background:url("../../etc/passwd")}'
      );
    });

    it("resolves .. in a style attribute but not in an HTML link", function () {
      expect(html('<p style="background:url(../a.png)"><img src="../a.png">')).toBe(
        `<p style="background:url(${wrap("/a.png")})"><img src="../a.png">`
      );
    });

    it("normalizes dot segments", function () {
      expect(html('<img src="/a/../b/./c.png">')).toBe(
        `<img src="${wrap("/b/c.png")}">`
      );
    });
  });

  describe("relative paths", function () {
    // The manifest is keyed without a leading slash, so a relative target
    // resolves against the root (as the request-time pass did) while a miss
    // still renders exactly as written
    it("keeps relative HTML links relative, dropping a leading ./", function () {
      expect(html('<img src="img/a.png"><img src="./b.png"><img src="../c.png">')).toBe(
        `<img src="${wrap("img/a.png")}"><img src="${wrap("b.png")}"><img src="../c.png">`
      );
    });

    it("keeps relative CSS links relative, dropping a leading ./ and resolving ..", function () {
      expect(
        css("a{background:url(img/a.png)} b{background:url(../img/b.png)} c{background:url(./c.png?v=1)}")
      ).toBe(
        `a{background:url(${wrap("img/a.png")})} b{background:url(${wrap("/img/b.png")})} c{background:url(${wrap("c.png?v=1")})}`
      );
    });
  });

  describe("unchanged input", function () {
    it("returns the very same string when nothing qualifies", function () {
      const inputs = [
        "",
        "plain text",
        "<p>{{title}}</p>",
        '<a href="https://example.org/page">x</a>',
        "<img src=data:image/gif;base64,R0lGOD>",
      ];

      inputs.forEach((input) => expect(html(input)).toBe(input));
    });

    it("copies everything outside the rewritten spans byte for byte", function () {
      const before = '\n\t<!doctype html>\r\n  <p  class = "x" >{{{body}}}  </p>\n  <img  src = "';
      const after = '"  alt=\'{{alt}}\' />\n<br/>{{! c }}{{#a}}\t{{.}}{{/a}}  \n';
      const input = before + "/a.png" + after;

      expect(html(input)).toBe(before + wrap("/a.png") + after);
    });

    it("is not confused by a literal > or quote inside a mustache tag in an attribute", function () {
      const input = '<a title="{{ a > b }}" href="/a.png">x</a>';
      expect(html(input)).toBe(`<a title="{{ a > b }}" href="${wrap("/a.png")}">x</a>`);
    });

    it("never throws on malformed input", function () {
      const inputs = [
        '<img src="/a.png',
        "<img src=",
        "<img",
        "{{",
        "{{#cdn}}<img src='/a.png'>",
        "url(",
        "a{background:url(/a.png",
        '<style>a{background:url("/a.png}',
        '<img srcset="/a.png 1x, , /b.png">',
      ];

      inputs.forEach((input) => {
        expect(() => html(input)).not.toThrow();
        expect(() => css(input)).not.toThrow();
      });
    });
  });

  describe("rendering", function () {
    // The resolved copy must render exactly like the original once the
    // {{#cdn}} helper hands every target straight back.
    const identity = function () {
      return function (text, render) {
        return render(text);
      };
    };

    it("renders the same output as the original with a pass-through helper", function () {
      const views = [
        '<link href="/style.css">\n{{#posts}}\n<a href="{{url}}"><img src="/a.png" srcset="/a.png 1x, /b.png 2x"></a>\n{{/posts}}\n<style>\n  a { background: url(/c.png); }\n</style>\n',
        '<meta property="og:image" content="/share.png"><div style="background:url(\'/d.png\')">{{title}}</div>',
      ];

      views.forEach((view) => {
        const resolved = html(view);
        const data = { title: "Hello", posts: [{ url: "/one" }, { url: "/two" }] };

        expect(resolved).not.toBe(view);
        expect(Mustache.render(resolved, Object.assign({ cdn: identity }, data))).toBe(
          Mustache.render(view, data)
        );
      });
    });
  });

  describe("folderTarget", function () {
    const folderTarget = resolveFolderLinks.folderTarget;

    it("returns a rooted link without its leading slash", function () {
      expect(folderTarget("/img/a.png", hosts)).toBe("img/a.png");
      expect(folderTarget("/a.png?v=2", hosts)).toBe("a.png?v=2");
    });

    it("accepts an absolute link on one of the blog's own hosts", function () {
      expect(folderTarget("https://example.blot.im/img/a.png", hosts)).toBe(
        "img/a.png"
      );
      expect(folderTarget("http://example.com/a.png", hosts)).toBe("a.png");
    });

    it("returns null for a relative link", function () {
      expect(folderTarget("img/a.png", hosts)).toBe(null);
      expect(folderTarget("./a.png", hosts)).toBe(null);
    });

    it("returns null for a page or a path without an extension", function () {
      expect(folderTarget("/about.html", hosts)).toBe(null);
      expect(folderTarget("/about", hosts)).toBe(null);
    });

    it("percent-encodes spaces", function () {
      expect(folderTarget("/my pic.jpg", hosts)).toBe("my%20pic.jpg");
    });

    it("returns null for another host, non-strings and plain text", function () {
      expect(folderTarget("https://other.com/a.png", hosts)).toBe(null);
      expect(folderTarget("//other.com/a.png", hosts)).toBe(null);
      expect(folderTarget("hello.world", hosts)).toBe(null);
      expect(folderTarget(42, hosts)).toBe(null);
      expect(folderTarget(null, hosts)).toBe(null);
    });
  });

  describe("wrapFolderLinks", function () {
    const wrapFolderLinks = resolveFolderLinks.wrapFolderLinks;

    it("returns the wrapped content and the targets it added", function () {
      const result = wrapFolderLinks(
        '<img src="/b.png"><img src="/a.png?v=1"><img src="/b.png"><link href="{{#cdn}}style.css{{/cdn}}">',
        { viewName: "index.html", hosts }
      );

      expect(result.content).toBe(
        `<img src="${wrap("/b.png")}"><img src="${wrap("/a.png?v=1")}"><img src="${wrap("/b.png")}"><link href="{{#cdn}}style.css{{/cdn}}">`
      );
      // sorted, without the leading slash, and not the author's own targets
      expect(result.targets).toEqual(["a.png?v=1", "b.png"]);
    });

    it("returns the same content and no targets when nothing qualifies", function () {
      const input = '{{=<% %>=}}<img src="/a.png">';

      expect(wrapFolderLinks(input, { viewName: "index.html", hosts })).toEqual({
        content: input,
        targets: [],
      });
      expect(wrapFolderLinks(undefined, {})).toEqual({ content: undefined, targets: [] });
    });

    it("finds the same targets as the template parser", function () {
      const parseTemplate = require("../parseTemplate");
      const result = wrapFolderLinks(
        '<img src="/a.png" srcset="/b.png 2x"><meta property="og:image" content="{{blog.url}}/c.png"><style>p{background:url(d.png)}</style>',
        { viewName: "index.html", hosts }
      );

      expect(result.targets).toEqual(parseTemplate(result.content).retrieve.cdn);
    });
  });


  describe("mapFolderLocals", function () {
    const mapFolderLocals = resolveFolderLinks.mapFolderLocals;
    const swap = (target) => "CDN:" + target;

    it("replaces folder links and leaves the original object untouched", function () {
      const locals = { logo: "/img/a.png", title: "hello.world", n: 1 };
      const result = mapFolderLocals(locals, hosts, swap);

      expect(result).toEqual({ logo: "CDN:img/a.png", title: "hello.world", n: 1 });
      expect(result).not.toBe(locals);
      expect(locals.logo).toBe("/img/a.png");
    });

    it("walks nested objects and arrays without modifying them", function () {
      const locals = {
        site: { images: ["/a.png", "/b.png", "text"], other: { x: "/c.png" } },
        keep: { y: "plain" },
      };
      const result = mapFolderLocals(locals, hosts, swap);

      expect(result.site.images).toEqual(["CDN:a.png", "CDN:b.png", "text"]);
      expect(Array.isArray(result.site.images)).toBe(true);
      expect(result.site.other.x).toBe("CDN:c.png");
      expect(result.keep).toBe(locals.keep);
      expect(locals.site.images[0]).toBe("/a.png");
      expect(locals.site.other.x).toBe("/c.png");
    });

    it("returns the same object when nothing matches or fn declines", function () {
      const locals = { a: "text", b: { c: "https://other.com/a.png" } };

      expect(mapFolderLocals(locals, hosts, swap)).toBe(locals);

      const same = { a: "/a.png" };
      expect(mapFolderLocals(same, hosts, () => null)).toBe(same);
      expect(mapFolderLocals(same, hosts, () => undefined)).toBe(same);
    });

    it("skips values nested deeper than four levels", function () {
      const locals = { a: { b: { c: { d: { e: "/a.png" } } } } };

      expect(mapFolderLocals(locals, hosts, swap)).toBe(locals);
    });

    it("passes the target and the original value to fn", function () {
      const calls = [];

      mapFolderLocals({ a: "https://example.blot.im/a.png" }, hosts, (t, v) => {
        calls.push([t, v]);
      });

      expect(calls).toEqual([["a.png", "https://example.blot.im/a.png"]]);
    });
  });
});
