describe("scripts/template/compress-views", function () {
  require("models/template/tests/setup")({ createTemplate: true });

  const client = require("models/client");
  const key = require("models/template/key");
  const viewContent = require("models/template/util/viewContent");
  const { setView, getView } = require("models/template");
  const { processView, newTotals } = require("../compress-views");

  const long = "<article>{{{entry.html}}}</article>\n".repeat(100);

  beforeEach(function () {
    spyOn(console, "log");
  });

  // A view stored as written, as every view was before setView compressed
  // them (and as a short one still is)
  async function writePlain(templateID, name, content) {
    await client
      .multi()
      .hSet(key.view(templateID, name), { name, content })
      .sAdd(key.allViews(templateID), name)
      .exec();
  }

  function hasField(name, field) {
    return client.hExists(key.view(this.template.id, name), field);
  }

  it("compresses a long view and leaves a short one as written", async function () {
    await writePlain(this.template.id, "long.html", long);
    await writePlain(this.template.id, "short.html", "hi");

    const totals = newTotals();

    for (const name of ["long.html", "short.html"])
      await processView(
        key.view(this.template.id, name),
        { apply: true },
        totals
      );

    expect(totals.moved).toBe(1);
    expect(totals.skipped).toBe(1);
    expect(await hasField.call(this, "long.html", "content")).toBeFalsy();
    expect(
      await hasField.call(this, "long.html", viewContent.FIELD)
    ).toBeTruthy();
    expect(await hasField.call(this, "short.html", "content")).toBeTruthy();
    expect((await getView(this.template.id, "long.html")).content).toEqual(
      long
    );
    expect((await getView(this.template.id, "short.html")).content).toEqual(
      "hi"
    );

    // A second run finds nothing left to do
    const again = newTotals();
    await processView(
      key.view(this.template.id, "long.html"),
      { apply: true },
      again
    );
    expect(again.skipped).toBe(1);
  });

  it("only reports what it would do without --apply", async function () {
    await writePlain(this.template.id, "long.html", long);

    const totals = newTotals();
    await processView(key.view(this.template.id, "long.html"), {}, totals);

    expect(totals.moved).toBe(1);
    expect(await hasField.call(this, "long.html", "content")).toBeTruthy();
  });

  it("leaves a view saved since it was read", async function () {
    await writePlain(this.template.id, "long.html", long);

    const viewKey = key.view(this.template.id, "long.html");
    const pack = viewContent.pack;
    const template = this.template;

    // The save lands between the backfill's read and its write
    spyOn(viewContent, "pack").and.callFake(async function (source) {
      await setView(template.id, { name: "long.html", content: long + "!" });
      return pack(source);
    });

    const totals = newTotals();
    await processView(viewKey, { apply: true }, totals);

    expect(totals.changed).toBe(1);
    expect((await getView(this.template.id, "long.html")).content).toEqual(
      long + "!"
    );
  });

  it("writes compressed views back as written with --revert", async function () {
    await writePlain(this.template.id, "long.html", long);

    const viewKey = key.view(this.template.id, "long.html");

    await processView(viewKey, { apply: true }, newTotals());

    const totals = newTotals();
    await processView(viewKey, { apply: true, revert: true }, totals);

    expect(totals.moved).toBe(1);
    expect(await client.hExists(viewKey, "content")).toBeTruthy();
    expect(await client.hExists(viewKey, viewContent.FIELD)).toBeFalsy();
    expect((await getView(this.template.id, "long.html")).content).toEqual(
      long
    );
  });
});
