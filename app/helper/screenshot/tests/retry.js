const retry = require("../retry");

describe("screenshot retry", function () {
  it("retries a plain error until it runs out of attempts", async function () {
    let attempts = 0;

    await expectAsync(
      retry(
        async () => {
          attempts++;
          throw new Error("boom");
        },
        3,
        0
      )
    ).toBeRejectedWithError("Failed after 3 attempts. Last error: boom");

    expect(attempts).toBe(3);
  });

  it("does not retry an error marked as not retryable", async function () {
    let attempts = 0;

    await expectAsync(
      retry(
        async () => {
          attempts++;
          const error = new Error("never loads");
          error.retryable = false;
          throw error;
        },
        3,
        0
      )
    ).toBeRejectedWithError("Failed after 1 attempts. Last error: never loads");

    expect(attempts).toBe(1);
  });
});
