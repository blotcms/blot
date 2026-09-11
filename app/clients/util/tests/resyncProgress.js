const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const { countLocalFiles, createProgress } = require("../resyncProgress");

describe("resync progress", function () {
  let directory;

  beforeEach(async function () {
    directory = await fs.mkdtemp(join(os.tmpdir(), "blot-resync-progress-"));
  });

  afterEach(async function () {
    await fs.remove(directory);
  });

  it("counts files recursively without counting directories", async function () {
    await fs.outputFile(join(directory, "one.txt"), "one");
    await fs.outputFile(join(directory, "nested", "two.txt"), "two");

    expect(await countLocalFiles(directory)).toBe(2);
  });

  it("increases the total before publishing newly discovered work", function () {
    const messages = [];
    const progress = createProgress(1, (message) => messages.push(message));

    progress.publish("Checking", "/one.txt");
    progress.publish("Downloading", "/two.txt", true);
    progress.finish("Finished processing folder");

    expect(messages).toEqual([
      "(1/1) Checking /one.txt",
      "(2/2) Downloading /two.txt",
      "(2/2) Finished processing folder",
    ]);
  });

  it("does not publish the same path twice", function () {
    const messages = [];
    const progress = createProgress(2, (message) => messages.push(message));

    progress.publish("Checking", "/one.txt");
    progress.publish("Checking", "/one.txt");

    expect(messages).toEqual(["(1/2) Checking /one.txt"]);
  });

  it("advances current by count when a whole directory is removed at once", function () {
    const messages = [];
    // total was seeded by counting 3 individual files, one of which lives
    // inside a folder that gets removed with a single fs.remove call.
    const progress = createProgress(3, (message) => messages.push(message));

    progress.publish("Checking", "/one.txt");
    progress.publish("Removing", "/orphaned-folder", false, 2);
    progress.finish("Finished processing folder");

    expect(messages).toEqual([
      "(1/3) Checking /one.txt",
      "(3/3) Removing /orphaned-folder",
      "(3/3) Finished processing folder",
    ]);
  });

  it("discovers work up front instead of growing total one item at a time", function () {
    const messages = [];
    // An empty local folder (total=0) about to download 3 remote-only files.
    const progress = createProgress(0, (message) => messages.push(message));

    progress.discover(3);
    progress.publish("Downloading", "/one.txt");
    progress.publish("Downloading", "/two.txt");
    progress.publish("Downloading", "/three.txt");
    progress.finish("Finished processing folder");

    expect(messages).toEqual([
      "(1/3) Downloading /one.txt",
      "(2/3) Downloading /two.txt",
      "(3/3) Downloading /three.txt",
      "(3/3) Finished processing folder",
    ]);
  });

  it("throttles high-volume updates without losing progress accounting", function () {
    const messages = [];
    const progress = createProgress(3, (message) => messages.push(message));

    // All three calls land within the same throttle window, so only the
    // first is actually emitted - but current still advances for each one.
    progress.publishThrottled("Checking", "/one.txt", false, 1, 100000);
    progress.publishThrottled("Checking", "/two.txt", false, 1, 100000);
    progress.publishThrottled("Checking", "/three.txt", false, 1, 100000);

    expect(messages).toEqual(["(1/3) Checking /one.txt"]);
    expect(progress.current).toBe(3);
  });
});
