// pollDriveActivity runs under a lease (init.js): it must wind down promptly
// when the lease is lost or the process drains, not carry on after another
// process has taken over.
describe("google drive pollDriveActivity", function () {
  const database = require("clients/google-drive/database");
  const pollDriveActivity = require("../pollDriveActivity");

  const finishedWithin = (promise, ms) =>
    Promise.race([
      promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), ms)),
    ]);

  let iterations;

  beforeEach(function () {
    iterations = 0;
    spyOn(console, "log");
    spyOn(database.blog, "iterateByServiceAccountId").and.callFake(async () => {
      iterations++;
    });
  });

  it("stops during its pause between rounds when the signal aborts", async function () {
    const controller = new AbortController();
    const running = pollDriveActivity("test-sa", {}, controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(iterations).toEqual(1);

    controller.abort();

    // The pause between rounds is 5 seconds
    expect(await finishedWithin(running, 1000)).toEqual(true);
    expect(iterations).toEqual(1);
  });

  it("does nothing when the signal is already aborted", async function () {
    const controller = new AbortController();
    controller.abort();

    await pollDriveActivity("test-sa", {}, controller.signal);

    expect(iterations).toEqual(0);
  });
});
