// Where does a custom domain point? The SSL check only runs this for domains
// whose certificate is already in trouble, to decide how to report them.
//
// Resolves to { status, extraIPs? }:
//   "blot"    points at Blot, so a failed renewal is worth a look
//   "mixed"   some address records point at Blot and some elsewhere
//             (extraIPs): ACME challenges land on the wrong server some of
//             the time, which is a common reason renewal fails
//   "proxied" every address belongs to Cloudflare, so we can't tell from DNS
//             whether the domain still goes to Blot. Once the origin
//             certificate expires Cloudflare answers 526, so it stays in the
//             report rather than being dropped
//   "moved"   points elsewhere or nowhere: renewal fails legitimately
//   "unknown" couldn't tell (eg. timeout): treated like "blot"
const dns = require("dns").promises;
const net = require("net");
const config = require("config");

// https://www.cloudflare.com/ips/
const CLOUDFLARE = new net.BlockList();

[
  ["173.245.48.0", 20],
  ["103.21.244.0", 22],
  ["103.22.200.0", 22],
  ["103.31.4.0", 22],
  ["141.101.64.0", 18],
  ["108.162.192.0", 18],
  ["190.93.240.0", 20],
  ["188.114.96.0", 20],
  ["197.234.240.0", 22],
  ["198.41.128.0", 17],
  ["162.158.0.0", 15],
  ["104.16.0.0", 13],
  ["104.24.0.0", 14],
  ["172.64.0.0", 13],
  ["131.0.72.0", 22],
].forEach(([address, prefix]) => CLOUDFLARE.addSubnet(address, prefix, "ipv4"));

[
  ["2400:cb00::", 32],
  ["2606:4700::", 32],
  ["2803:f800::", 32],
  ["2405:b500::", 32],
  ["2405:8100::", 32],
  ["2a06:98c0::", 29],
  ["2c0f:f248::", 32],
].forEach(([address, prefix]) => CLOUDFLARE.addSubnet(address, prefix, "ipv6"));

// What verify() throws when the domain is somewhere else. Anything not listed
// (eg. REQUEST_TIMEOUT) is a failure to find out, not an answer.
const NOT_POINTING_AT_BLOT = [
  "NO_NAMESERVERS",
  "CNAME_RECORD_EXISTS_BUT_DOES_NOT_MATCH",
  "NO_A_RECORD",
  "HANDLE_MISMATCH",
];

const isCloudflare = (address) =>
  CLOUDFLARE.check(address, net.isIPv6(address) ? "ipv6" : "ipv4");

const lookup = (promise) => promise.catch(() => []);

module.exports = async function classifyDNS(hostname, { handle } = {}) {
  const [cnames, a, aaaa] = await Promise.all([
    lookup(dns.resolveCname(hostname)),
    lookup(dns.resolve4(hostname)),
    lookup(dns.resolve6(hostname)),
  ]);

  const cname = (cnames[0] || "").toLowerCase().replace(/\.$/, "");
  if (cname === config.host) return { status: "blot" };

  const addresses = [...a, ...aaaa];
  if (!addresses.length) return { status: "moved" };

  const ours = [config.ip, config.ipv6].filter(Boolean);

  if (addresses.some((address) => ours.includes(address))) {
    const extraIPs = addresses.filter((address) => !ours.includes(address));
    return extraIPs.length ? { status: "mixed", extraIPs } : { status: "blot" };
  }

  if (addresses.every(isCloudflare)) return { status: "proxied" };

  // Some other proxy or CDN may still forward to Blot, which only a request
  // can tell us.
  try {
    await require("dashboard/site/domain/verify")({
      hostname,
      handle,
      ourIP: config.ip,
      ourIPv6: config.ipv6,
      ourHost: config.host,
    });
    return { status: "blot" };
  } catch (err) {
    return {
      status: NOT_POINTING_AT_BLOT.includes(err.message) ? "moved" : "unknown",
    };
  }
};
