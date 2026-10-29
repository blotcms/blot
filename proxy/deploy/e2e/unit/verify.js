// Stands in for scripts/deploy/verify-container/index.js: blue-green.sh runs it
// in blue after the unit is healthy and passes the release ID it deployed.
if (process.env.BLOT_RELEASE_ID !== process.argv[2]) {
  console.error(`release ${process.env.BLOT_RELEASE_ID}, expected ${process.argv[2]}`);
  process.exit(1);
}
console.log("  PASS  release ID: " + process.argv[2]);
