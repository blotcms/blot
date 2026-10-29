const request = require("request");
const fs = require("fs-extra");
// Inside the proxy containers (the blot-proxy-auto-ssl volume, which blot-blue
// and blot-green share), not on the host
const CERT_DIR = "/etc/resty-auto-ssl/letsencrypt/certs";
const get = require("../get/blog");
const client = require("models/client");
const exec = require("child_process").exec;
var getConfirmation = require("../util/getConfirmation");

// This deletes the Redis certificate keys, then prints the commands to run on
// the proxy host to remove the certificate files (once: both proxies share the
// volume) and restart the proxies one at a time, so one is always serving. A
// restart, not a reload: auto-ssl's in-memory certificate cache (a shared dict)
// survives a reload. It does not run them itself.

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
    console.log("proxy containers' shared volume (once, from either) and restart");
    console.log("BOTH proxies, one at a time: the second only once the first");
    console.log("answers its health check again (a reload keeps auto-ssl's");
    console.log("cached certificate).");
    certDirs.forEach((dir) => {
      console.log("  docker exec blot-blue rm -rf", dir);
    });
    console.log("  for u in blue green; do");
    console.log("    docker restart --time 30 blot-$u");
    console.log("    until docker exec blot-$u curl -fsS -o /dev/null \\");
    console.log("      --unix-socket /run/openresty/health.sock http://localhost/health; do sleep 1; done");
    console.log("  done");
  });
});
