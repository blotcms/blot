const screenshot = require("helper/screenshot");
const config = require("config");
const { dirname } = require("path");
const root = require("helper/rootDir");
const fs = require("fs-extra");
const demoFolders = require("./demoFolders");
const IMAGE_DIRECTORY = root + "/app/views/images/examples";
// Template gallery previews use a fixed 1060x780 viewport; this is independent
// of entry thumbnail sizing or OG image dimensions.
const TEMPLATE_SCREENSHOT_WIDTH = 1060;
const TEMPLATE_SCREENSHOT_HEIGHT = 780;

// These previews are served by a local server we start ourselves, so there is
// nothing to be polite to: take several at once and drop the pacing that
// helper/screenshot applies when screenshotting live sites.
const CONCURRENCY = Number(process.env.BLOT_SCREENSHOT_CONCURRENCY) || 4;

// Enough for helper/screenshot to burn a page-load timeout and retry, but not
// so long that one wedged preview stalls the whole run.
const SHOT_TIMEOUT = Number(process.env.BLOT_SCREENSHOT_TIMEOUT) || 60 * 1000;

const shotsFor = (template) => {
  const handle = demoFolders.forTemplate(template);
  const pages = ["/"];

  return pages.flatMap((page, index) => {
    const url = `${config.protocol}preview-of-${template}-on-${handle}.${config.host}${page}`;
    const destination = `${IMAGE_DIRECTORY}/${template}/${index}`;

    return [
      {
        url,
        path: `${destination}.png`,
        options: {
          width: TEMPLATE_SCREENSHOT_WIDTH,
          height: TEMPLATE_SCREENSHOT_HEIGHT,
        },
      },
      { url, path: `${destination}.mobile.png`, options: { mobile: true } },
    ];
  });
};

// Runs tasks with at most `limit` in flight. Each task's timeout only starts
// once a worker picks it up, otherwise queued tasks would spend their budget
// waiting rather than working.
const inParallel = async (items, limit, worker) => {
  let next = 0;

  const run = async () => {
    while (next < items.length) await worker(items[next++]);
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
};

const emptyImageDirectories = async (templates) => {
  if (templates.length === demoFolders.list().length) {
    // A full run owns the whole directory, so this also clears out images
    // belonging to templates which no longer exist.
    console.log("Emptying image directory", IMAGE_DIRECTORY);
    return fs.emptyDir(IMAGE_DIRECTORY);
  }

  // A filtered run must leave the other templates' images alone, otherwise
  // screenshotting one template would delete every other template's images.
  for (const template of templates) {
    const directory = `${IMAGE_DIRECTORY}/${template}`;
    console.log("Emptying image directory", directory);
    await fs.emptyDir(directory);
  }
};

const main = async ({ templates } = {}) => {
  const selected = demoFolders.parse(templates);
  const shots = selected.flatMap(shotsFor);

  screenshot.configure({ concurrency: CONCURRENCY, minTime: 0 });

  console.log("Templates:", selected.join(", "));

  await emptyImageDirectories(selected);

  console.log(`Taking ${shots.length} screenshots, ${CONCURRENCY} at a time`);

  const failures = [];

  await inParallel(shots, CONCURRENCY, async (shot) => {
    try {
      await Promise.race([
        takeScreenshot(shot),
        new Promise((resolve, reject) => {
          setTimeout(
            () => reject(new Error(`Timeout after ${SHOT_TIMEOUT}ms`)),
            SHOT_TIMEOUT
          );
        }),
      ]);
    } catch (error) {
      failures.push({ path: shot.path, error });
      console.error(shot.path, error);
    }
  });

  if (failures.length) {
    console.error(
      `Failed to take ${failures.length} of ${shots.length} screenshots:`
    );
    for (const { path, error } of failures) {
      console.error("-", path, error.message || error);
    }
  } else {
    console.log(`Took all ${shots.length} screenshots`);
  }

  return { shots, failures };
};

const takeScreenshot = async ({ url, path, options }) => {
  await fs.ensureDir(dirname(path));
  console.log(`Taking screenshot of ${url} to ${path}`);
  await screenshot(url, path, options);
};

module.exports = main;

if (require.main === module) {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("--"));

  main({ templates: arg || process.env.BLOT_SCREENSHOT_TEMPLATES })
    .then(({ failures }) => {
      console.log("Done!");
      // The image directory is emptied before the run, so a screenshot that
      // failed has left a gap rather than a stale image. Exiting non-zero is
      // what stops the caller committing that gap to the template gallery.
      process.exit(failures.length ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
