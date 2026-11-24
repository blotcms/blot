describe("google drive rateLimit", function () {
  const { isRateLimited, reasonOf, backoff } = require("../rateLimit");

  const refusal = (code, reason) =>
    Object.assign(new Error("refused"), {
      code,
      ...(reason ? { errors: [{ reason }] } : {}),
    });

  it("counts a 429 and a 403 for a rate limit, not other refusals", function () {
    expect(isRateLimited(refusal(429))).toBe(true);
    expect(isRateLimited(refusal(403, "userRateLimitExceeded"))).toBe(true);
    expect(isRateLimited(refusal(403, "rateLimitExceeded"))).toBe(true);
    expect(isRateLimited(refusal(403))).toBe(true);
    expect(isRateLimited(refusal(403, "insufficientPermissions"))).toBe(false);
    expect(isRateLimited(refusal(404))).toBe(false);
    expect(isRateLimited(new Error("socket hang up"))).toBe(false);
  });

  it("reads the reason from the error or its response", function () {
    expect(reasonOf(refusal(403, "userRateLimitExceeded"))).toBe(
      "userRateLimitExceeded"
    );
    expect(
      reasonOf({
        response: {
          data: { error: { errors: [{ reason: "rateLimitExceeded" }] } },
        },
      })
    ).toBe("rateLimitExceeded");
    expect(reasonOf(new Error("no reason"))).toBe(null);
  });

  it("doubles the wait with each refusal in a row, up to the cap, and starts over on reset", function () {
    const longest = backoff({ base: 1000, max: 4000, random: () => 1 });
    expect([
      longest.next(),
      longest.next(),
      longest.next(),
      longest.next(),
    ]).toEqual([1000, 2000, 4000, 4000]);
    expect(longest.refusals).toBe(4);

    longest.reset();
    expect(longest.refusals).toBe(0);
    expect(longest.next()).toBe(1000);
  });

  it("waits a random time between half the wait and all of it", function () {
    const shortest = backoff({ base: 1000, max: 4000, random: () => 0 });
    expect([shortest.next(), shortest.next()]).toEqual([500, 1000]);
  });
});
