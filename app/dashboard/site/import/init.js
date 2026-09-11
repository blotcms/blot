const fs = require("fs-extra");
const tempDir = require("helper/tempDir")();
const client = require("models/client");
const { join } = require("path");
const archiver = require("archiver");
const lifecycle = require("./lifecycle");

module.exports = ({ blogID, label }) => {
  // Keep the existing label/timestamp parser compatible while avoiding same-tick collisions.
  const importID = label + "-" + Date.now() + "." + require("crypto").randomBytes(12).toString("hex");
  const importDirectory = join(tempDir, "import", blogID, importID);
  const outputDirectory = join(importDirectory, "output");
  fs.ensureDirSync(outputDirectory);
  const state = lifecycle.create(importDirectory);
  let statuses = Promise.resolve();

  function status(message) {
    // Progress must not overwrite a terminal cancellation status.
    if (state.signal.aborted && message !== "Cancelled" && message !== "Failed") return;
    // Recover from any prior write failure before chaining the next one, so a
    // single rejected write (e.g. ENOSPC) can't permanently stop status.txt
    // from ever being updated again for the rest of this job.
    statuses = statuses.catch(() => {}).then(() => fs.outputFile(join(importDirectory, "status.txt"), message));
    statuses.catch(err => console.error("Failed to write import status", err));
    client.publish("import:status:" + blogID, JSON.stringify({ status: message, importID }))
      .catch(err => console.error("Failed to publish import status", err));
    return statuses;
  }

  async function finish() {
    state.check();
    let identifier;
    try {
      identifier = await fs.readFile(join(importDirectory, "identifier.txt"), "utf8");
    } catch (_) {
      identifier = importID;
    }
    state.check();
    // Expose the archive only once its output stream has closed successfully.
    const temporary = join(importDirectory, "result.zip.part");
    await new Promise((resolve, reject) => {
      const archive = archiver("zip");
      const output = fs.createWriteStream(temporary);
      let error;
      const fail = err => {
        if (error) return;
        error = err;
        archive.abort();
        output.destroy();
      };
      const abort = () => fail(lifecycle.cancelled());
      state.signal.addEventListener("abort", abort, { once: true });
      archive.on("error", fail);
      output.on("error", fail);
      output.on("close", () => {
        state.signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      });
      archive.pipe(output);
      archive.directory(outputDirectory, identifier);
      if (state.signal.aborted) return abort();
      archive.finalize().catch(fail);
    });
    state.check();
    await fs.move(temporary, join(importDirectory, "result.zip"), { overwrite: true });
    state.check();
    await status("Finished");
  }

  // Own the complete worker lifetime, including its archive and cleanup. Async
  // context carries cancellation into legacy callback-based asset pipelines.
  async function run(worker) {
    return state.run(async () => {
      try {
        state.check();
        await worker();
        await finish();
        state.check();
      } catch (error) {
        // A replaced owner must not erase or publish over another worker.
        if (!state.ownsLease()) return;
        const wasCancelled = fs.existsSync(join(importDirectory, "cancelled.txt"));
        await fs.remove(outputDirectory);
        await fs.remove(join(importDirectory, "result.zip.part"));
        await fs.remove(join(importDirectory, "result.zip"));
        if (!wasCancelled) await fs.outputFile(join(importDirectory, "error.txt"), error.message);
        await status(wasCancelled ? "Cancelled" : "Failed");
      } finally {
        state.dispose();
        await Promise.all(Array.from(state.assets, directory => fs.remove(directory)));
        if (state.ownsLease()) {
          await fs.remove(state.stagingDirectory);
          await fs.remove(join(importDirectory, "running.txt"));
        }
      }
    });
  }

  return { importID, run, finish, outputDirectory, importDirectory, status };
};
