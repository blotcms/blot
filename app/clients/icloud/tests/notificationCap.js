const notificationCap = require("../util/notificationCap");

describe("notificationCap", function () {
  let time, calls, notify;

  const send = () => calls.push("send");
  const escalate = () => calls.push("escalate");

  beforeEach(function () {
    time = 0;
    calls = [];
  });

  it("sends up to max, escalates once, then suppresses", function () {
    notify = notificationCap({ max: 2, now: () => time });

    expect(notify("a", send, escalate)).toBe("sent");
    expect(notify("a", send, escalate)).toBe("sent");
    expect(notify("a", send, escalate)).toBe("escalated");
    expect(notify("a", send, escalate)).toBe("suppressed");
    expect(notify("a", send, escalate)).toBe("suppressed");

    expect(calls).toEqual(["send", "send", "escalate"]);
  });

  it("suppresses without escalating when no escalate callback is given", function () {
    notify = notificationCap({ max: 1, now: () => time });

    expect(notify("a", send)).toBe("sent");
    expect(notify("a", send)).toBe("suppressed");
    expect(calls).toEqual(["send"]);
  });

  it("counts each key separately", function () {
    notify = notificationCap({ max: 1, now: () => time });

    expect(notify("a", send)).toBe("sent");
    expect(notify("b", send)).toBe("sent");
    expect(notify("a", send)).toBe("suppressed");
    expect(calls).toEqual(["send", "send"]);
  });

  it("never resets without resetAfterMs", function () {
    notify = notificationCap({ max: 1, now: () => time });

    notify("a", send);
    time = 365 * 24 * 60 * 60 * 1000;
    expect(notify("a", send)).toBe("suppressed");
  });

  it("starts counting again once resetAfterMs has passed, escalating again too", function () {
    notify = notificationCap({ max: 1, resetAfterMs: 1000, now: () => time });

    expect(notify("a", send, escalate)).toBe("sent");
    time = 999;
    expect(notify("a", send, escalate)).toBe("escalated");
    expect(notify("a", send, escalate)).toBe("suppressed");

    time = 1000;
    expect(notify("a", send, escalate)).toBe("sent");
    expect(notify("a", send, escalate)).toBe("escalated");
    expect(calls).toEqual(["send", "escalate", "send", "escalate"]);
  });
});
