// Capture the input/output screenshot pairs. Runs ON THE HOST.
//
//   node capture.js <targets.json> <verificationDir>
//
// Reads the targets resolved in the container by targets.js, screenshots the
// source site and the local site at matching viewports, and writes them as
// input-<label>.png / output-<label>.png so a pair is matchable by suffix.
//
// A source site that blocks headless browsers, times out, or simply has no page
// at the guessed path is expected, not exceptional: the local shot is still
// worth having, so failures are reported and the run continues.

const fs = require("fs-extra");
const { join } = require("path");

const { captureAll } = require("./screenshot");

// A source URL guessed from the local path (see targets.js) can easily land on
// a 404 or a soft redirect to the homepage. Keeping that as the "input" of a
// pair would be actively misleading, so drop it.
const BAD_STATUS = (status) => status !== null && status >= 400;

async function main(targetsPath, verificationDir) {
  if (!targetsPath || !verificationDir) {
    console.error("Usage: node capture.js <targets.json> <verificationDir>");
    process.exit(1);
  }

  const targets = await fs.readJson(targetsPath);

  if (!Array.isArray(targets) || !targets.length) {
    console.error("[capture] No targets to capture");
    process.exit(1);
  }

  const shots = [];

  for (const target of targets) {
    if (target.source) {
      shots.push({
        label: `input-${target.label}`,
        url: target.source,
        path: join(verificationDir, `input-${target.label}.png`),
        mobile: !!target.mobile,
      });
    }

    shots.push({
      label: `output-${target.label}`,
      url: target.local,
      path: join(verificationDir, `output-${target.label}.png`),
      mobile: !!target.mobile,
    });
  }

  const results = await captureAll(shots);

  const captured = [];
  const failed = [];

  for (const result of results) {
    if (result.ok && BAD_STATUS(result.status)) {
      // Remove it so a stale image from an earlier run cannot linger and be
      // mistaken for a current one.
      await fs.remove(result.path).catch(() => {});
      failed.push({ ...result, error: `HTTP ${result.status}` });
      continue;
    }

    if (result.ok) captured.push(result);
    else failed.push(result);
  }

  // A manifest saves the comparison UI from guessing at filenames, and records
  // what was attempted rather than only what succeeded.
  await fs.outputJson(
    join(verificationDir, "screenshots.json"),
    {
      capturedAt: new Date().toISOString(),
      targets,
      captured: captured.map((r) => ({
        label: r.label,
        path: r.path,
        status: r.status,
      })),
      failed: failed.map((r) => ({ label: r.label, error: r.error })),
    },
    { spaces: 2 }
  );

  captured.forEach((r) => console.log(`captured=${r.label}`));
  failed.forEach((r) => console.log(`failed=${r.label}: ${r.error}`));

  // Only a total failure is fatal. Missing an input shot is normal.
  const anyOutput = captured.some((r) => r.label.startsWith("output-"));

  if (!anyOutput) {
    console.error("[capture] Could not capture the local site at all");
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv[2], process.argv[3]).catch((err) => {
    console.error("[capture]", err.message);
    process.exit(1);
  });
}

module.exports = main;
