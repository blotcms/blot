const request = require("request");
const fs = require("fs-extra");
// Inside the proxy container (the blot-proxy-auto-ssl volume), not on the host
const CERT_DIR = "/etc/resty-auto-ssl/letsencrypt/certs";
const get = require("../get/blog");
const client = require("models/client");
const exec = require("child_process").exec;
var getConfirmation = require("../util/getConfirmation");

// This deletes the Redis certificate keys, then prints the commands to run on
// the proxy host to remove the certificate files from the proxy container and
// reload it. It does not run them itself.

if (!(process.getuid && process.getuid() === 0))
  throw new Error("This script must be run as root");

get(process.argv[2], function (err, user, blog) {
  const domain = blog.domain;

  if (!domain) throw new Error("blog does not have a domain");

  const secureURL = `https://${domain}`;
  const startsWithWWW = domain.indexOf("www.") === 0;
  const domainWithoutWWW = startsWithWWW ? domain.slice("www.".length) : domain;
  const domainWithWWW = startsWithWWW ? domain : "www." + domain;

  const certKeys = [
    `ssl:${domainWithoutWWW}:latest`,
    `ssl:${domainWithWWW}:latest`,
  ];

  const certDirs = [
    `${CERT_DIR}/${domainWithWWW}`,
    `${CERT_DIR}/${domainWithoutWWW}`,
  ];

  console.log("secureURL", secureURL);
  console.log("domainWithWWW:", domainWithWWW);
  console.log("domainWithoutWWW:", domainWithoutWWW);
  console.log("Keys to drop:", certKeys);
  console.log("Directories to remove:", certDirs);

  getConfirmation("Proceed? (y/n)", async function (err, ok) {
    if (!ok) throw "Not ok!";

    await client.del(certKeys);

    console.log("removed redis keys", certKeys);
    console.log("");
    console.log("Now, on the proxy host, remove the certificate files from the");
    console.log("proxy container and reload it. Find the running colour with:");
    console.log("  docker ps --filter name=blot-proxy-");
    console.log("then, with <colour> being blue or green:");
    certDirs.forEach((dir) => {
      console.log("  docker exec blot-proxy-<colour> rm -rf", dir);
    });
    console.log(
      "  docker exec blot-proxy-<colour> /usr/local/openresty/bin/openresty -s reload"
    );
  });
});
