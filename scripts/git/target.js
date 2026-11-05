// The command line of the git store's operator scripts (import-repo.js,
// rewrite-repo.js): parsing, and the object store they act on. The target is
// always explicit: a local directory (--dir) or an S3 bucket (--bucket, with
// --prefix, --endpoint and --region). There is no default bucket.

const path = require("path");

const store = require("../../app/clients/git/store");
const createFsStore = require("../../app/clients/git/store/objectStore/fs");

const TARGET_VALUES = ["dir", "bucket", "prefix", "endpoint", "region"];

// { options, positional } from argv. `flags` are the options that take no
// value, `values` the ones that take one (besides the target's).
function parse(argv, { flags = [], values = [] }) {
  const isFlag = new Set(flags);
  const takesValue = new Set([...TARGET_VALUES, ...values]);
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) positional.push(arg);
    else if (isFlag.has(arg.slice(2))) options[arg.slice(2)] = true;
    else if (takesValue.has(arg.slice(2))) {
      if (i + 1 >= argv.length) throw new Error(arg + " needs a value");
      options[arg.slice(2)] = argv[++i];
    } else throw new Error("Unknown option " + arg);
  }
  return { options, positional };
}

// { store, client } for the target the options name; `client` (an S3 client
// to destroy at the end) only for a bucket
function objectStore(options) {
  if (options.dir && options.bucket) throw new Error("Give --dir or --bucket, not both");
  if (options.dir) return { store: createFsStore({ root: path.resolve(options.dir) }), client: null };

  if (!options.bucket) throw new Error("Give a target: --dir <folder> or --bucket <name>");
  const { S3Client } = require("@aws-sdk/client-s3");
  const key = process.env.BLOT_AWS_KEY || process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.BLOT_AWS_SECRET || process.env.AWS_SECRET_ACCESS_KEY;
  const client = new S3Client({
    region: options.region || "us-east-1",
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    // B2 and MinIO want checksums only when an operation requires one
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // The app's own keys when set (a unit has only those), else the SDK's
    // usual chain
    ...(key && secret ? { credentials: { accessKeyId: key, secretAccessKey: secret } } : {}),
  });
  const prefix = options.prefix ? options.prefix.replace(/\/?$/, "/") : "";
  return { client, store: store.createS3Store({ client, bucket: options.bucket, prefix }) };
}

module.exports = { parse, objectStore };
