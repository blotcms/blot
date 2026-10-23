const notificationCap = require("../util/notificationCap");
const client = require("models/client");
const { randomUUID } = require("crypto");

describe("notificationCap", function () {
  let calls, name;

  const send = () => calls.push("send");
  const escalate = () => calls.push("escalate");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cap = (options) =>
    notificationCap({ name, max: 1, resetAfterMs: 60 * 1000, ...options });

  beforeEach(function () {
    calls = [];
    name = "test-" + randomUUID();
  });

  afterEach(async function () {
    for (const key of await client.keys("notify-cap:" + name + ":*")) {
      await client.del(key);
    }
  });

  it("sends up to max, escalates once, then suppresses", async function () {
    const notify = cap({ max: 2 });

    expect(await notify("a", send, escalate)).toBe("sent");
    expect(await notify("a", send, escalate)).toBe("sent");
    expect(await notify("a", send, escalate)).toBe("escalated");
    expect(await notify("a", send, escalate)).toBe("suppressed");
    expect(await notify("a", send, escalate)).toBe("suppressed");

    expect(calls).toEqual(["send", "send", "escalate"]);
  });

  it("suppresses without escalating when no escalate callback is given", async function () {
    const notify = cap();

    expect(await notify("a", send)).toBe("sent");
    expect(await notify("a", send)).toBe("suppressed");
    expect(calls).toEqual(["send"]);
  });

  it("counts each key separately", async function () {
    const notify = cap();

    expect(await notify("a", send)).toBe("sent");
    expect(await notify("b", send)).toBe("sent");
    expect(await notify("a", send)).toBe("suppressed");
    expect(calls).toEqual(["send", "send"]);
  });

  it("is shared by separate caps with the same name, as processes are", async function () {
    const first = cap();
    const second = cap();

    expect(await first("a", send, escalate)).toBe("sent");
    expect(await second("a", send, escalate)).toBe("escalated");
    expect(await first("a", send, escalate)).toBe("suppressed");
    expect(calls).toEqual(["send", "escalate"]);
  });

  it("lets exactly max of many concurrent callers send", async function () {
    const notify = cap({ max: 2 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => notify("a", send, escalate))
    );

    expect(results.filter((r) => r === "sent").length).toBe(2);
    expect(results.filter((r) => r === "escalated").length).toBe(1);
    expect(results.filter((r) => r === "suppressed").length).toBe(7);
  });

  it("starts counting again once resetAfterMs has passed, escalating again too", async function () {
    // Long enough that a slow CI runner cannot expire the window mid-test
    const notify = cap({ resetAfterMs: 1500 });

    expect(await notify("a", send, escalate)).toBe("sent");
    expect(await notify("a", send, escalate)).toBe("escalated");
    expect(await notify("a", send, escalate)).toBe("suppressed");

    await sleep(1700);
    expect(await notify("a", send, escalate)).toBe("sent");
    expect(await notify("a", send, escalate)).toBe("escalated");
    expect(calls).toEqual(["send", "escalate", "send", "escalate"]);
  });
});
