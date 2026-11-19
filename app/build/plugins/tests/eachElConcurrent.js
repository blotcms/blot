describe("eachElConcurrent", function () {
  const cheerio = require("cheerio");
  const eachElConcurrent = require("../eachElConcurrent");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it("applies results in document order however the lookups finish", async function () {
    const $ = cheerio.load(
      "<a>1</a><a>2</a><a>3</a><a>4</a><a>5</a><a>6</a><a>7</a>"
    );
    const applied = [];

    // Earlier links take longer, so the lookups finish in reverse
    await eachElConcurrent(
      $,
      "a",
      async (el) => {
        const n = Number($(el).text());
        await sleep((8 - n) * 10);
        return n;
      },
      (el, n) => applied.push(n)
    );

    expect(applied).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("runs at most four lookups at once, and runs them together", async function () {
    const $ = cheerio.load("<a></a>".repeat(10));
    let running = 0;
    let peak = 0;

    await eachElConcurrent(
      $,
      "a",
      async () => {
        peak = Math.max(peak, ++running);
        await sleep(20);
        running--;
        return true;
      },
      () => {}
    );

    expect(peak).toBe(4);
  });

  it("skips elements whose lookup returns undefined", async function () {
    const $ = cheerio.load("<a>1</a><a>2</a><a>3</a>");
    const applied = [];

    await eachElConcurrent(
      $,
      "a",
      async (el) => ($(el).text() === "2" ? undefined : $(el).text()),
      (el, text) => applied.push(text)
    );

    expect(applied).toEqual(["1", "3"]);
  });

  it("does not apply anything until every lookup has finished", async function () {
    const $ = cheerio.load("<a>1</a><a>2</a>");
    const events = [];

    await eachElConcurrent(
      $,
      "a",
      async (el) => {
        await sleep($(el).text() === "1" ? 1 : 30);
        events.push("lookup " + $(el).text());
        return $(el).text();
      },
      (el, text) => events.push("apply " + text)
    );

    expect(events).toEqual(["lookup 1", "lookup 2", "apply 1", "apply 2"]);
  });
});
