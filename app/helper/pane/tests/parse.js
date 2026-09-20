const parse = require("../lib/parse");

describe("pane parse", function () {
  it("nests by two-space indentation", function () {
    const tree = parse("Fruits\n  Apple.md\n  Citrus\n    Lemon.md\nAbout.txt");
    expect(tree.map((n) => n.name)).toEqual(["Fruits", "About.txt"]);
    expect(tree[0].children.map((n) => n.name)).toEqual(["Apple.md", "Citrus"]);
    expect(tree[0].children[1].children[0].path).toBe("Fruits/Citrus/Lemon.md");
  });

  it("treats a trailing slash, children or a missing extension as a folder", function () {
    const [posts, drafts, fruits, about] = parse("Posts/\nDrafts\nFruits\n  Apple.md\nAbout.txt");
    expect([posts.folder, drafts.folder, fruits.folder, about.folder]).toEqual([true, true, true, false]);
    expect(posts.name).toBe("Posts");
  });

  it("reads columns after a pipe and ignores blank lines", function () {
    const [a] = parse("\nApple.md | 2 KB | Mar 3, 2024\n\n");
    expect(a.cols).toEqual(["2 KB", "Mar 3, 2024"]);
    expect(a.name).toBe("Apple.md");
  });
});
