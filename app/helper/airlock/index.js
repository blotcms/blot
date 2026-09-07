const config = require("config");
const http = require("http");
const nodeFetch = require("node-fetch");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

// App-side entry point for the "airlock" container (config/airlock) - the
// single egress boundary for fetching untrusted, user-supplied URLs. The
// airlock's in-kernel nftables egress filter is the actual SSRF control
// (it matches the real destination IP at connect() time, so it also covers
// redirects, sub-resources and DNS-rebinding); everything in this module is
// just the wiring to route a fetch through the airlock's forward proxy, plus
// the fail-closed assertion below.
//
// Fail closed: in production a caller that hands us a user-controlled URL
// must go through the airlock. If the proxy isn't configured (a deploy that
// missed BLOT_AIRLOCK_PROXY_URL on some container) we throw here rather than
// letting the caller fall back to fetching the URL directly with no SSRF
// protection. The individual operation fails and its caller degrades
// gracefully (a post builds without the image, a domain check errors) - the
// app still boots and serves. Outside production (dev, tests) nothing is
// required and fetches go direct.

// True in production (see config/index.js). Both BLOT_AIRLOCK_* vars set on
// every app container is the deployed state; see config/airlock/README.md.
const required = !!(config.airlock && config.airlock.required);

const proxyUrl = (config.airlock && config.airlock.proxy) || null;
const browserUrl = (config.airlock && config.airlock.browser_url) || null;

const proxyConfigured = !!proxyUrl;
const browserConfigured = !!browserUrl;

const parsedProxy = proxyUrl ? new URL(proxyUrl) : null;

const VERIFY_USER_AGENT = "Blot (+https://blot.im)";
const MAX_VERIFY_REDIRECTS = 5;

// node-fetch's `agent` option accepts a function of the parsed URL, so one
// value covers both http: and https: targets (and redirects between them).
const httpProxyAgent = proxyUrl ? new HttpProxyAgent(proxyUrl) : null;
const httpsProxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
const proxyAgent = proxyUrl
  ? (parsedURL) =>
      parsedURL.protocol === "https:" ? httpsProxyAgent : httpProxyAgent
  : undefined;

function assertProxyReady(label) {
  if (required && !proxyConfigured) {
    throw new Error(
      `airlock: refusing to fetch a user-controlled URL${
        label ? " (" + label + ")" : ""
      } - BLOT_AIRLOCK_PROXY_URL is not set. See config/airlock/README.md.`
    );
  }
}

function assertBrowserReady(label) {
  if (required && !browserConfigured) {
    throw new Error(
      `airlock: refusing to screenshot a user-controlled URL${
        label ? " (" + label + ")" : ""
      } - BLOT_AIRLOCK_BROWSER_URL is not set. See config/airlock/README.md.`
    );
  }
}

// Drop-in replacement for require("node-fetch") at a user-controlled sink:
// applies the airlock proxy agent and enforces fail-closed. Any options the
// caller passes (headers, signal, redirect, timeout, ...) are forwarded
// unchanged; an explicit `agent` wins over the proxy agent.
async function fetch(url, options = {}) {
  assertProxyReady(options.airlockLabel);
  const { airlockLabel, ...fetchOptions } = options;
  if (fetchOptions.agent === undefined && proxyAgent !== undefined) {
    fetchOptions.agent = proxyAgent;
  }
  return nodeFetch(url, fetchOptions);
}

function abortError() {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

// GET a path from a fixed destination IP through the airlock, with an
// explicit Host header. This exists for app/dashboard/site/domain/verify.js:
// it resolves the domain itself (authoritative nameservers + public fallback
// resolvers) and must make the FIRST connection to THAT IP - during DNS
// propagation or split-horizon the airlock's own resolver can disagree, and
// a normal proxied fetch can't express this (http-proxy-agent rebuilds the
// request-line URI from the Host header, so the IP is dropped and the proxy
// re-resolves the name).
//
// Hop 0 targets `http://<ip><path>` with Host: <domain> - tinyproxy connects
// to that exact IP, the egress filter still re-checks it. If hop 0 redirects
// (a very common HTTP->HTTPS bounce via a CDN or reverse proxy), the rest of
// the chain goes through the normal proxied fetch() below - still
// egress-filtered - since the pinning only ever mattered for the initial
// connection to the user-declared A record. Fails closed like fetch().
// Rejects on request/response error, timeout, or abort. Resolves
// { status, text }.
function getViaIP(ip, path, { host, timeout, signal, label } = {}) {
  assertProxyReady(label || "domain/verify");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const done = (fn) => (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    const succeed = done(resolve);
    const failWith = done(reject);

    const onAbort = () => {
      try {
        req.destroy(abortError());
      } catch (e) {
        /* already destroyed */
      }
      failWith(abortError());
    };

    if (timeout) {
      timer = setTimeout(() => {
        const e = new Error("request-timeout");
        e.type = "request-timeout";
        try {
          req.destroy(e);
        } catch (err) {
          /* already destroyed */
        }
        failWith(e);
      }, timeout);
    }

    const headers = {
      Host: host,
      Connection: "close",
      "User-Agent": VERIFY_USER_AGENT,
    };

    const options = parsedProxy
      ? {
          host: parsedProxy.hostname,
          port: parsedProxy.port || 80,
          method: "GET",
          path: `http://${ip}${path}`,
          headers,
        }
      : { host: ip, port: 80, method: "GET", path, headers };

    const req = http.request(options, (res) => {
      res.on("error", failWith);
      res.on("aborted", () => failWith(new Error("response aborted")));

      const status = res.statusCode;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // discard the redirect body
        let next;
        try {
          next = new URL(res.headers.location, `http://${host}${path}`);
        } catch (e) {
          return failWith(new Error("bad redirect location"));
        }
        fetch(next.toString(), {
          redirect: "follow",
          follow: MAX_VERIFY_REDIRECTS,
          timeout,
          signal,
          headers: { "User-Agent": VERIFY_USER_AGENT },
        })
          .then((r) => r.text().then((text) => succeed({ status: r.status, text })))
          .catch(failWith);
        return;
      }

      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => succeed({ status, text }));
    });

    req.on("error", failWith);

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    req.end();
  });
}

module.exports = {
  required,
  proxyConfigured,
  browserConfigured,
  proxyAgent,
  assertProxyReady,
  assertBrowserReady,
  fetch,
  getViaIP,
};
