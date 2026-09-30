// A case can be marked informational in thresholds.json: still measured and reported,
// but a threshold miss shouldn't fail the run (unlike a plain fail).

const { loadThresholds, evaluate, isInformational } = require("../lib/thresholds");

describe("pane qa thresholds", function () {
  it("marks the hand-written windows-*-list fixtures informational", function () {
    const thresholds = loadThresholds();
    expect(isInformational(thresholds, "windows-light-list")).toBe(true);
    expect(isInformational(thresholds, "windows-dark-list")).toBe(true);
  });

  it("does not mark an ordinary case informational", function () {
    const thresholds = loadThresholds();
    expect(isInformational(thresholds, "macos-light")).toBe(false);
    expect(isInformational(thresholds, "some-case-that-does-not-exist")).toBe(false);
  });

  it("evaluate() still reports failures for an informational case (the run decides the status)", function () {
    const thresholds = { default: { diffPercent: { overall: 1 } }, cases: { foo: { informational: true } } };
    const entry = {
      id: "foo",
      diff: { percent: 5 },
      regions: [],
      geometry: { sizeDelta: { w: 0, h: 0 } },
      rows: { meanYOffset: 0 },
      shadow: { error: 0 },
    };
    const verdict = evaluate(entry, thresholds);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.length).toBe(1);
    expect(isInformational(thresholds, "foo")).toBe(true);
  });
});
