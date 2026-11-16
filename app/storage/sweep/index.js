// The weekly sweep of Perma-Cache (./permaCache). The Redis and S3 steps of
// #2745 join it here.
module.exports = { start: () => require("./permaCache").start() };
