describe("build/flags", function () {
  var { report, collect, fromError } = require("../flags");

  it("collects what a build reports, one flag per code", async function () {
    var { result, flags } = await collect(async function () {
      report({ code: "EMBED_FAILED", targets: ["https://x.com/a"] });
      await new Promise((resolve) => setTimeout(resolve, 1));
      report({ code: "EMBED_FAILED", targets: ["https://x.com/b"] });
      report({ code: "EMBED_FAILED", targets: ["https://x.com/a"] });
      report({ code: "DATE_INVALID", value: "not a date" });
      return "built";
    });

    expect(result).toEqual("built");
    expect(flags).toEqual([
      { code: "EMBED_FAILED", targets: ["https://x.com/a", "https://x.com/b"] },
      { code: "DATE_INVALID", value: "not a date" },
    ]);
  });

  it("keeps builds running at once apart", async function () {
    var [a, b] = await Promise.all([
      collect(async function () {
        await new Promise((resolve) => setTimeout(resolve, 5));
        report({ code: "DATE_INVALID", value: "a" });
      }),
      collect(async function () {
        report({ code: "DATE_INVALID", value: "b" });
      }),
    ]);

    expect(a.flags).toEqual([{ code: "DATE_INVALID", value: "a" }]);
    expect(b.flags).toEqual([{ code: "DATE_INVALID", value: "b" }]);
  });

  it("ignores a report outside a build, or of an unknown code", async function () {
    report({ code: "DATE_INVALID", value: "nowhere" });

    var { flags } = await collect(async function () {
      report({ code: "NOT_A_CODE" });
    });

    expect(flags).toEqual([]);
  });

  it("names why a build failed", function () {
    expect(
      fromError(
        new Error("Pandoc exited with code null (SIGKILL) (timed out): x")
      )
    ).toEqual({ code: "BUILD_TIMEOUT", step: "pandoc" });

    var killed = new Error("Pandoc exited with code null (SIGKILL) in 9ms: ");
    killed.code = "SANDBOX_KILLED";
    expect(fromError(killed)).toEqual({
      code: "BUILD_TOO_COMPLEX",
      step: "pandoc",
    });

    var busy = new Error("sandbox: busy");
    busy.code = "SANDBOX_BUSY";
    expect(fromError(busy).code).toEqual("BUILD_DEFERRED");

    expect(fromError(new Error("bad document"))).toEqual({
      code: "BUILD_FAILED",
      step: undefined,
      error: "bad document",
    });
  });
});
