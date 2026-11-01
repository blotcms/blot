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
const JOBS = ["metadata"];

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

  const stdin = await readStdin();
  const end = stdin.indexOf(10);
  if (end === -1) throw new Error("no arguments line");

  const args = JSON.parse(stdin.subarray(0, end).toString());
  const input = stdin.subarray(end + 1);
  const { meta, outputs } = await require("./" + name).run(args, input);

  const header = JSON.stringify({ meta, lengths: outputs.map((o) => o.length) });
  await new Promise((resolve, reject) =>
    process.stdout.write(
      Buffer.concat([Buffer.from(header + "\n")].concat(outputs)),
      (err) => (err ? reject(err) : resolve())
    )
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${err.message}\n`.slice(0, 200));
    process.exit(1);
  }
);
