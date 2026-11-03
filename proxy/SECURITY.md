# Proxy OpenResty security assessment

Reviewed 3 November 2026 against the
[nginx advisory index](https://nginx.org/en/security_advisories.html), the
[OpenResty 1.31.8.1 announcement](https://openresty.org/en/ann-1031008001.html),
vendor CVE records linked below, and the checked-in `config/` templates. This
is a configuration review, not an exploit test. Deployment environment
overrides and future configuration changes need a fresh review.

## Release

The proxy runs [OpenResty 1.31.8.1](https://openresty.org/en/download.html)
(nginx 1.31.8, released 26 October 2026), compiled from its checksummed source
tarball in `Dockerfile`'s `openresty` stage with OpenSSL 3.5.9 and PCRE2 10.49,
the versions OpenResty's own packaging builds. Brotli is built against the
same tarball, including its nginx patches. CI asserts the OpenResty release
and the OpenSSL version from `openresty -V`.

nginx 1.31.8 is past the fixed version of every advisory in the nginx index,
so no advisory range covers it. The release announcement lists the twelve CVE
fixes it took from nginx 1.31.2 through 1.31.8, among them both HTTP/3
advisories that had kept QUIC disabled: CVE-2026-42530 (use-after-free, fixed
in 1.31.2) and CVE-2026-95101 (request-body injection, fixed in 1.31.7).

## HTTP/3

HTTP/3 is enabled on all six public servers, which listen for QUIC on UDP 443
and advertise it with `Alt-Svc: h3=":443"; ma=86400`. The fail2ban jails ban
over UDP as well as TCP.

It was disabled in PR #2225, on OpenResty 1.31.1.1 (nginx 1.31.1), because
that release was in range for CVE-2026-42530 and CVE-2026-95101, and the
previous OpenResty 1.25.3.1 had publicly served HTTP/3 through the six 2024
QUIC advisories. Any future nginx HTTP/3 advisory is a reason to drop the
`quic` listeners again until a fixed release ships.

## Advisory applicability

Every advisory that covered an nginx version the proxy has run since 1.25.3 is
fixed in 1.31.8. The configuration notes record whether the old versions were
exposed and still matter if a feature is enabled later.

| CVE(s) | Configuration notes | Fixed in |
| --- | --- | --- |
| 2024-24989, 2024-24990, 2024-31079, 2024-32760, 2024-34161, 2024-35200 | Public QUIC listeners on 1.25.3; 34161 needs an MTU above 4096. | 1.25.4 / 1.27.0 |
| 2026-40460 | Public QUIC listeners on 1.25.3. | 1.31.0 |
| 2026-42530 | HTTP/3 use-after-free; QUIC was disabled on 1.31.1. | 1.31.2 |
| 2026-95101 | HTTP/3 request-body injection with the default request buffering; QUIC was disabled on 1.31.1. | 1.31.7 |
| 2026-90439 | HTTP/3, and OpenSSL <= 3.5.0 per the [vendor record](https://www.cve.org/CVERecord?id=CVE-2026-90439); the bundled OpenSSL was always newer. | 1.31.6 |
| 2024-7347, 2026-27784, 2026-32647 | MP4 module compiled, but no `mp4` directive. | 1.27.1 / 1.29.7 |
| 2025-23419 | TLS 1.3 and shared session cache, but no `ssl_verify_client` to bypass. | 1.27.4 |
| 2026-40701 | Resolver enabled; no `ssl_verify_client` or `ssl_ocsp`. `ssl_stapling off`. | 1.31.0 |
| 2026-1642 | Upstreams use `http://` or Unix sockets; no nginx HTTPS upstream. | 1.29.5 |
| 2026-27654 | No `dav_methods`. | 1.29.7 |
| 2026-27651, 2026-28753, 2025-53859 | No mail listeners or mail authentication. | 1.29.1 / 1.29.7 |
| 2026-9256, 2026-42945 | No nginx `rewrite` directives matching the vendor prerequisites; `rewrite_by_lua_block` is separate. | 1.31.1 / 1.31.0 |
| 2026-42946 | No `scgi_pass` or `uwsgi_pass`. | 1.31.0 |
| 2026-42934, 2026-48142 | `charset utf-8`, but no `source_charset` or `charset_map` conversion. | 1.31.0 / 1.31.2 |
| 2026-42055 | HTTP/1.1 upstreams; no `proxy_http_version 2` or `grpc_pass`. | 1.31.2 |
| 2026-42533 | Regex map `$bad_bot` has constant outputs, read only in a standalone `if`; no matching prerequisite identified. | 1.31.3 |
| 2026-60005 | No `slice` directive. | 1.31.3 |
| 2026-56434 | No `ssi on`. | 1.31.3 |
| 2026-15176 | No `alias` or `$request_filename` expressions. | 1.31.7 |
| 2026-93479 | String expressions with variables (document root, logging); only nginx 1.31.2–1.31.6 were affected, which the proxy never ran. | 1.31.7 |
| 2026-97629 | `ssl_session_tickets off`. | 1.31.7 |
| 2026-97205 | No `aio`; default is off. | 1.31.7 |

Not applicable to any version the proxy has run: 2026-42926 (nginx
1.29.4–1.30.0) and 2026-28755 (1.27.2–1.29.6, stream OCSP). The older MP4
advisories 2022-41741/41742, resolver 2021-23017 and the 2019 HTTP/2
advisories were fixed before nginx 1.25.3.

Configuration prerequisites above come from the vendor CVE records, notably
[rewrite](https://www.cve.org/CVERecord?id=CVE-2026-9256),
[OCSP resolver](https://www.cve.org/CVERecord?id=CVE-2026-40701),
[regex map](https://www.cve.org/CVERecord?id=CVE-2026-42533),
[HTTP/2 upstream](https://www.cve.org/CVERecord?id=CVE-2026-42055), and
[charset conversion](https://www.cve.org/CVERecord?id=CVE-2026-42934).

## Upgrade notes

- nginx 1.31.8 resolves `working_directory` against the nginx prefix rather
  than the current directory. The config does not set it.
- lua-nginx-module 0.10.32rc7 changes `precontent_by_lua` return values and
  fixes `ssl_certificate_by_lua` certificate handling. The config uses
  `ssl_certificate_by_lua_block` (auto-ssl and the Redis wildcard
  certificate), which the integration checks exercise; it does not use
  `precontent_by_lua`.
- Stricter Host/`:authority` parsing arrived with 1.31.1.1; see the
  [OpenResty 1.31.1.1 notes](https://openresty.org/en/ann-1031001001.html).

## GitHub validation

A `proxy/**` change triggers the existing GitHub workflows:

- `integration`: builds the image, asserts the OpenResty release and OpenSSL
  version, logs `openresty -V`, parses the generated config, then runs
  routing, compression/Brotli, disk cache, request matrix and parity, wildcard
  certificates, ACME/sockproc, Redis outages, graceful proxy handover and
  Node swaps. Protocol checks assert the QUIC listeners and a live UDP 443
  socket, HTTP/1.1 and HTTP/2 with the HTTP/3 advertisement on every public
  vhost, and real HTTP/3 requests to the site, a custom domain and the Redis
  wildcard certificate. `cert-issuance` also makes a verified HTTP/3 request
  to a custom domain with a Pebble-issued certificate on a freshly started
  container, before any TCP handshake has cached it.
- `unit-image`: builds the production arm64 unit image (OpenResty included),
  checks OpenResty in it and publishes it to GHCR.
- `app-e2e` and `proxy-deploy-e2e`: real application requests and deployment
  exercises on GitHub runners.
