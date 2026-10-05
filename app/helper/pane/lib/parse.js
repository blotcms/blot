// Indented tree -> nested nodes. Two spaces per level. A row may carry columns after a
// pipe: "Apple.md | 2 KB | Mar 3, 2024" (size, then date; shown as written on every OS).

function parse(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  const depthOf = (l) => (l.length - l.trimStart().length) / 2;
  const root = { children: [], depth: -1 };
  const stack = [root];
  lines.forEach((line, i) => {
    const depth = depthOf(line);
    const [rawName, ...cols] = line.trim().split("|").map((s) => s.trim());
    const explicit = rawName.endsWith("/");
    const name = explicit ? rawName.slice(0, -1) : rawName;
    while (stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    const node = { name, depth, cols, children: [], path: "" };
    node.explicit = explicit;
    node.folder = explicit || (lines[i + 1] !== undefined && depthOf(lines[i + 1]) > depth) || !name.includes(".");
    node.path = (parent.path ? parent.path + "/" : "") + name;
    parent.children.push(node);
    stack.push(node);
  });
  return root.children;
}

module.exports = parse;
