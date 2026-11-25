const render = require("../json");

// Small Docs JSON cases for the renderer's edge cases (#2975)
describe("gdoc json renderer", function () {
  const MARK = String.fromCharCode(0xe907);
  const run = (content, textStyle = {}) => ({
    textRun: { content, textStyle },
  });
  const mono = { weightedFontFamily: { fontFamily: "Courier New" } };
  const para = (text, extra = {}, textStyle) => ({
    paragraph: { elements: [run(text + "\n", textStyle)], ...extra },
  });
  const doc = (content, more = {}) => ({
    documentId: "d",
    tabs: [{ documentTab: { body: { content }, ...more } }],
  });
  const html = (content, more) => render(doc(content, more)).html;

  it("leaves a paragraph wholly in a typewriter font as a paragraph", function () {
    const out = html([para("intro"), para("Le texte", {}, mono)]);
    expect(out).toBe("<p>intro<br>\nLe texte</p>");
  });

  it("marks monospace words among others as code", function () {
    const out = html([
      {
        paragraph: {
          elements: [run("run "), run("npm test", mono), run("\n")],
        },
      },
    ]);
    expect(out).toBe("<p>run <code>npm test</code></p>");
  });

  it("drops a code block mark with no partner", function () {
    const out = html([para(MARK + "Hello"), para("world")]);
    expect(out).not.toContain("<pre>");
    expect(out).toContain("world");
  });

  it("renders a code block between two marks", function () {
    const out = html([para(MARK + "a"), para("b"), para(MARK), para("after")]);
    expect(out).toContain("<pre><code>a\nb</code></pre>");
    expect(out).toContain("<p>after</p>");
  });

  it("skips the cells a merge covers", function () {
    const cell = (text, style) => ({
      content: [para(text)],
      tableCellStyle: style,
    });
    const out = html([
      {
        table: {
          columns: 2,
          tableRows: [
            { tableCells: [cell("merged", { columnSpan: 2 }), cell("")] },
            { tableCells: [cell("a"), cell("b")] },
          ],
        },
      },
    ]);
    expect(out).toContain('<td colspan="2">merged</td>\n</tr>');
    expect((out.match(/<td/g) || []).length).toBe(3);
  });

  it("numbers a sub-list from 1 under each item", function () {
    const item = (text, level) =>
      para(text, { bullet: { listId: "l", nestingLevel: level } });
    const lists = {
      l: {
        listProperties: {
          nestingLevels: [{ glyphType: "DECIMAL" }, { glyphType: "ALPHA" }],
        },
      },
    };
    const out = html(
      [item("A", 0), item("x", 1), item("y", 1), item("B", 0), item("z", 1)],
      { lists }
    );
    expect(out).not.toContain('start="3"');
  });

  it("numbers footnotes across tabs without repeating ids", function () {
    const tab = (id) => ({
      tabProperties: { title: id },
      documentTab: {
        body: {
          content: [
            {
              paragraph: {
                elements: [
                  run("text"),
                  {
                    footnoteReference: { footnoteId: id, footnoteNumber: "1" },
                  },
                ],
              },
            },
          ],
        },
        footnotes: { [id]: { content: [para("note " + id)] } },
      },
    });
    const out = render({ documentId: "d", tabs: [tab("f1"), tab("f2")] }).html;
    expect(out).toContain('id="ref-1"');
    expect(out).toContain('id="ref-2"');
  });

  it("reads a list with no glyph and no format as a plain list", function () {
    const lists = {
      l: {
        listProperties: {
          nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }],
        },
      },
    };
    const out = html([para("item", { bullet: { listId: "l" } })], { lists });
    expect(out).toBe("<ul>\n<li>item</li>\n</ul>");
  });

  it("keeps a heading with a bullet as a heading in its item", function () {
    const out = html([
      para("CWS on Fargate", {
        bullet: { listId: "l" },
        paragraphStyle: { namedStyleType: "HEADING_2" },
      }),
    ]);
    expect(out).toBe("<ul>\n<li><h2>CWS on Fargate</h2></li>\n</ul>");
  });

  it("applies a heading style's italic, but not its underline", function () {
    const namedStyles = {
      styles: [
        {
          namedStyleType: "HEADING_1",
          textStyle: { italic: true, underline: true },
        },
      ],
    };
    const out = html(
      [para("Prologue", { paragraphStyle: { namedStyleType: "HEADING_1" } })],
      { namedStyles }
    );
    expect(out).toBe("<h1><em>Prologue</em></h1>");
  });

  it("turns Shift+Enter into a new line in a 1x1 code table", function () {
    const LINE = String.fromCharCode(11);
    const out = html([
      {
        table: {
          columns: 1,
          tableRows: [{ tableCells: [{ content: [para("a" + LINE + "b")] }] }],
        },
      },
    ]);
    expect(out).toBe("<pre><code>a\nb</code></pre>");
  });

  it("starts a numbered list at its configured number", function () {
    const lists = {
      l: {
        listProperties: {
          nestingLevels: [{ glyphType: "DECIMAL", startNumber: 5 }],
        },
      },
    };
    const item = (text) => para(text, { bullet: { listId: "l" } });
    expect(html([item("a"), item("b")], { lists })).toContain('<ol start="5">');
  });

  it("keeps blank lines past the first as line breaks", function () {
    expect(html([para("a"), para(""), para(""), para(""), para("b")])).toBe(
      "<p>a</p>\n<br>\n<br>\n<p>b</p>"
    );
  });

  it("never gives two headings the same id", function () {
    const h = (text, id) =>
      para(text, {
        paragraphStyle: { namedStyleType: "HEADING_2", headingId: id },
      });
    const out = html([
      h("Intro", "h.1"),
      h("Intro", "h.2"),
      h("Intro 1", "h.3"),
    ]);
    expect(out.match(/id="[^"]+"/g)).toEqual([
      'id="intro"',
      'id="intro-1"',
      'id="intro-1-1"',
    ]);
  });

  it("keeps a display equation on paragraphs of its own together", function () {
    const spaced = { paragraphStyle: { spaceBelow: { magnitude: 8 } } };
    const out = html([
      para("$$", spaced),
      para("x = y", spaced),
      para("$$", spaced),
    ]);
    expect(out).toBe("<p>$$<br>\nx = y<br>\n$$</p>");
  });

  it("never takes a list item as metadata", function () {
    const result = render(
      doc([para("Note: bring snacks", { bullet: { listId: "l" } })])
    );
    expect(result.metadata).toEqual({});
    expect(result.html).toContain("bring snacks");
  });

  it("reads metadata lines joined with Shift+Enter", function () {
    const LINE = String.fromCharCode(11);
    const result = render(
      doc([para("Date: 1 Oct" + LINE + "Tags: a, b"), para(""), para("Body")])
    );
    expect(result.metadata).toEqual({ Date: "1 Oct", Tags: "a, b" });
    expect(result.html).toBe("<p>Body</p>");
  });

  it("keeps an image straight after the metadata lines", function () {
    const result = render(
      doc(
        [
          para("Menu: no"),
          {
            paragraph: {
              elements: [
                { inlineObjectElement: { inlineObjectId: "i" } },
                run("\n"),
              ],
            },
          },
        ],
        {
          inlineObjects: {
            i: {
              inlineObjectProperties: {
                embeddedObject: { imageProperties: { blotSrc: "/a.png" } },
              },
            },
          },
        }
      )
    );
    expect(result.metadata).toEqual({ Menu: "no" });
    expect(result.html).toContain('<img src="/a.png"');
  });

  it("links to a heading in the tabs form of a link", function () {
    const out = html([
      para("Intro", {
        paragraphStyle: { namedStyleType: "HEADING_1", headingId: "h.1" },
      }),
      para("see", {}, { link: { heading: { id: "h.1", tabId: "t.0" } } }),
    ]);
    expect(out).toContain('<a href="#intro">see</a>');
  });

  it("drops a javascript: link but keeps its text", function () {
    const out = html([para("x", {}, { link: { url: "javascript:alert(1)" } })]);
    expect(out).toBe("<p>x</p>");
  });
});
