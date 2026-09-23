const fetch = require("node-fetch");
const setup = require("./util/setup");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cacher rebuild retry", function () {
  setup("./retry.conf");

  it("does not keep a partial index across a reload mid-walk", async function () {
    // 20k shared dict fits about 128 hashes. 110 fit once. A reload that
    // kept the first ~96 and then walked all 110 again fails rpush and
    // leaves /purge at 503. One yield (32 files) still fits, so the wait
    // has to land on a later pause.
    const count = 110;
    for (let i = 0; i < count; i++) {
      const res = await fetch(this.origin + "/timestamp/retry-" + i);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Status")).toBe("MISS");
    }

    await this.restartOpenresty({ waitForIndex: false });
    // Yields are a second apart, after every 32 files. At 2.5s the walk has
    // indexed 96 and is paused. 110 more copies of that prefix do not fit in
    // the 20k dictionary unless the retry drops the partial list first.
    await sleep(2500);
    await this.signalOpenresty("HUP");

    let body = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const purge = await fetch(this.origin + "/purge?host=127.0.0.1", {
        timeout: 1000,
      });
      if (purge.status === 503) {
        await sleep(50);
        continue;
      }
      if (purge.status !== 200) {
        throw new Error("unexpected purge status " + purge.status);
      }
      body = (await purge.text()).trim();
      break;
    }

    expect(body).toBe("127.0.0.1: " + count);
    expect(await this.listCache({ watch: false })).toEqual([]);
  }, 60000);
});
