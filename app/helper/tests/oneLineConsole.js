describe("oneLineConsole", function () {
  const { format } = require("helper/oneLineConsole");

  it("prints an error as its message, status and top frames", function () {
    const err = new Error("Failed to fetch changes from Dropbox");
    err.status = 401;
    err.headers = { date: ["today"] };

    const line = format("dropbox:retry invoked with err", err);

    expect(line).not.toContain("\n");
    expect(line).toMatch(
      /^dropbox:retry invoked with err Error: Failed to fetch changes from Dropbox status=401 at /
    );
    expect(line).not.toContain("headers");
    expect(line.split(" < ").length).toBeLessThanOrEqual(3);
  });

  it("keeps an error's code", function () {
    const err = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";

    expect(format(err)).toMatch(
      /^Error: connect ECONNREFUSED code=ECONNREFUSED/
    );
  });

  it("prints objects on one line", function () {
    const line = format("state", { a: { b: [1, 2, 3] }, c: "x" });

    expect(line).toBe("state { a: { b: [ 1, 2, 3 ] }, c: 'x' }");
  });

  it("escapes newlines in strings", function () {
    expect(format("Folder: one\n\nnext")).toBe("Folder: one\\n\\nnext");
  });

  it("formats like console.log", function () {
    expect(format("%s took %dms", "render", 12)).toBe("render took 12ms");
    expect(format("100%")).toBe("100%");
  });
});
