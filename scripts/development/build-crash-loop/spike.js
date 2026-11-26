// Reproduces the build crash loop of 26 Nov 2026 locally, against the dev
// Redis and folder storage, and shows whether it stops. See README.md.
//
// A scratch blog gets a long .docx of single-bold-child paragraphs, the shape
// of the customer's directory page. Then worker.js runs again and again, as
// the units' processes did: each takes the folder lock and builds the file.
// With the pre-#2988 converter the build blocks the event loop past the
// lock's 10s lease, the lock is lost and the process crashes. The follow-up
// queue retried a minute later; here the next worker starts a moment later.
//
//   node scripts/development/build-crash-loop/spike.js [--paragraphs 6000]
//     [--runs 6] [--edit]
//
// --edit: after the runs, changes the file and runs again, to show an edit
// gets a fresh try.
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const Blog = require("models/blog");
const Entry = require("models/entry");
const client = require("models/client");
const folder = require("storage/folder");
const hold = require("sync/hold");

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;

const PARAGRAPHS = option("--paragraphs", 6000);
const RUNS = option("--runs", 6);
const HANDLE = "crashloopspike";
const PATH = "/Pages/directory.docx";

async function scratchBlog() {
  const existing = await Blog.get({ handle: HANDLE }).catch(() => null);
  if (existing) return existing;
  const local = await Blog.get({ handle: "local" });
  await Blog.create(local.owner, { handle: HANDLE });
  return Blog.get({ handle: HANDLE });
}

// A long directory page: bold names, each followed by a line of text
async function writeDocx(blogID, marker) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spike-"));
  const lines = [];
  for (let i = 0; i < PARAGRAPHS; i++)
    lines.push(`**Artwork ${i}**`, "", `Location ${i}, ${marker}`, "");
  await fs.writeFile(path.join(dir, "in.md"), lines.join("\n"));
  await run("pandoc", ["in.md", "-o", "out.docx"], { cwd: dir });
  const buffer = await fs.readFile(path.join(dir, "out.docx"));
  await hold(blogID, () => folder.write(blogID, PATH, buffer));
  await fs.remove(dir);
}

// Runs one worker to its end. Resolves to { exit, ms }.
function worker(blogID) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = require("child_process").spawn(
      process.execPath,
      [path.join(__dirname, "worker.js"), blogID, PATH],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const keep = (data) =>
      String(data)
        .split("\n")
        .filter((line) =>
          /worker:|LOCK COMPROMISED|message:|\[BUILD\]|email|BUILD_STALLED/i.test(
            line
          )
        )
        .forEach((line) => console.log("   ", line.slice(0, 200)));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("exit", (code) =>
      resolve({ exit: code, ms: Date.now() - startedAt })
    );
  });
}

async function runs(blogID, label) {
  const results = [];
  for (let i = 1; i <= RUNS; i++) {
    console.log(`${label} run ${i}:`);
    const result = await worker(blogID);
    results.push(result);
    console.log(
      `${label} run ${i}: exit=${result.exit} after ${result.ms}ms`,
      result.exit === 0 ? "(finished)" : "(crashed)"
    );
    if (result.exit === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return results;
}

async function report(blogID, label, results) {
  const crashes = results.filter((r) => r.exit !== 0).length;
  const finished = results.some((r) => r.exit === 0);
  const entry = await Entry.get(blogID, PATH).catch(() => null);
  const stat = await folder.stat(blogID, PATH).catch(() => null);
  console.log(
    `${label}: ${crashes} crashes, ${finished ? "then finished" : `still crashing after ${results.length} runs`}`
  );
  console.log(
    `${label}: entry ${entry ? `exists (${(entry.html || "").length} chars of HTML)` : "missing"}, flags ${JSON.stringify((stat && stat.flags) || null)}`
  );
}

async function main() {
  const blog = await scratchBlog();
  console.log("blog", blog.id, "handle", HANDLE, "paragraphs", PARAGRAPHS);

  // Each run starts from no recorded crashes
  for await (const keys of client.scanIterator({
    MATCH: `blog:${blog.id}:build-*`,
  }))
    for (const key of [].concat(keys)) await client.del(key);

  await writeDocx(blog.id, "first");
  await report(blog.id, "loop", await runs(blog.id, "loop"));

  if (args.includes("--edit")) {
    await writeDocx(blog.id, "edited");
    await report(blog.id, "after edit", await runs(blog.id, "after edit"));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
