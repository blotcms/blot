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

  it("keeps a monospace line followed by a monospace heading", function () {
    const out = html([
      para("intro"),
      para("x = 1", {}, mono),
      para(
        "Heading",
        { paragraphStyle: { namedStyleType: "HEADING_1" } },
        mono
      ),
    ]);
    expect(out).toContain("<pre><code>x = 1</code></pre>");
    expect(out.indexOf("x = 1")).toBeLessThan(out.indexOf("<h1>"));
  });

  it("leaves a Doc written wholly in a typewriter font as paragraphs", function () {
    const out = html([para("one", {}, mono), para(""), para("two", {}, mono)]);
    expect(out).not.toContain("<pre>");
    expect(out).toContain("<p><code>one</code></p>");
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

  it("never takes a list item as metadata", function () {
    const result = render(
      doc([para("Note: bring snacks", { bullet: { listId: "l" } })])
    );
    expect(result.metadata).toEqual({});
    expect(result.html).toContain("bring snacks");
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
