// Runs inside the jail (nsjail, as uid 65000): proxy/unit/sandbox/jail.js starts
//
//   node main.js <job>
//
// stdin is one line of JSON arguments and then the input bytes; stdout is one
// line of JSON, {"meta": ..., "lengths": [...]}, and then the output bytes.
// The job itself, ./<job>.js, exports run(args, input) and is shared with the
// in-process path (../index.js). Bare requires such as "sharp" resolve through
// the NODE_PATH the jail is given.

const JOB = /^[a-z-]+$/;
const JOBS = [
  "metadata",
  "thumbnail",
  "resize",
  "to-png",
  "exif",
  "screenshot",
  "template-image",
  "favicon",
  "pandoc",
  "unzip",
  "fetch-image",
  "fetch",
  "parse-html",
];

// The jobs that don't use sharp
const WITHOUT_SHARP = ["exif", "pandoc", "unzip", "parse-html"];

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const name = process.argv[2];
  if (!JOB.test(name || "") || !JOBS.includes(name)) throw new Error("unknown job");

  // Here, not in the jobs: this is process-wide, and in-process that would be
  // every other use of sharp in the app. One thread per jail keeps a jail's CPU
  // and memory to what the broker's slots assume.
  if (!WITHOUT_SHARP.includes(name)) require("sharp").concurrency(1);

  const stdin = await readStdin();
  const end = stdin.indexOf(10);
  if (end === -1) throw new Error("no arguments line");

  const args = JSON.parse(stdin.subarray(0, end).toString());
  const input = stdin.subarray(end + 1);
  const { meta, outputs } = await require("./" + name).run(args, input);

  // Written one by one, not joined: the outputs of a batch of fetches can be
  // tens of MiB, and a copy of them would double what the jail holds
  const header = JSON.stringify({ meta, lengths: outputs.map((o) => o.length) });
  for (const chunk of [Buffer.from(header + "\n")].concat(outputs)) {
    await new Promise((resolve, reject) =>
      process.stdout.write(chunk, (err) => (err ? reject(err) : resolve()))
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${err.message}\n`.slice(0, 200));
    process.exit(1);
  }
);
