# Proxy OpenResty upgrade assessment

Reviewed 25 October 2026 against the
[nginx advisory index](https://nginx.org/en/security_advisories.html), vendor
CVE records linked below, and the checked-in `config/` templates. This is a
configuration review, not an exploit test. Deployment environment overrides
and future configuration changes need a fresh review.

## Release and urgency

Upgrade OpenResty 1.25.3.1 (nginx 1.25.3) to the
[current OpenResty release, 1.31.1.1](https://openresty.org/en/download.html)
(nginx 1.31.1). All three Docker stages use the same pinned multi-architecture
image digest. Brotli uses the matching checksummed OpenResty source archive,
including its nginx patches, rather than unpatched nginx headers.

**High priority:** the old configuration publicly enabled HTTP/3 with
`listen 443 quic` in `config/server.conf`. The six 2024 QUIC advisories apply, including two rated
major by nginx; crafted sessions can crash workers, with additional corruption
or disclosure risks. The memory-disclosure case requires an MTU above 4096.
See the [February](https://mailman.nginx.org/pipermail/nginx-announce/2024/NW6MNW34VZ6HDIHH5YFBIJYZJN7FGNAV.html)
and [May](https://mailman.nginx.org/pipermail/nginx-announce/2024/GMY32CSHFH6VFTN76HJNX7WNEX4RLHF6.html)
advisories. This release fixes those issues and the older HTTP/3 address-spoofing
issue.

**Mitigation in this PR:** disable HTTP/3 until OpenResty supplies the fixes.
The current release still bundles nginx 1.31.1, which is in range for
[CVE-2026-42530](https://www.cve.org/CVERecord?id=CVE-2026-42530) (QUIC
use-after-free, introduced relative to 1.25.3) and
[CVE-2026-95101](https://www.cve.org/CVERecord?id=CVE-2026-95101) (request-body
injection with the default request buffering). All six public servers now
have no QUIC listener and send `Alt-Svc: clear` where server headers apply,
expiring clients' cached HTTP/3 advertisements. HTTP/2 and HTTP/1.1 stay enabled.
The base binary still includes HTTP/3; disabling the listener removes the
reachable path without claiming the vulnerable code is patched. Track a
patched release and re-enable checks in the task at the top of `TODO`.

## Advisory applicability

Thirty advisory version ranges cover nginx 1.25.3. The rows below account for
all thirty; module availability alone does not establish exploitability.
The base image includes HTTP/2, HTTP/3, MP4, DAV, slice, charset and SSL support;
the effective configuration determines exposure.

| CVE(s) | Configuration review / mitigation | nginx 1.31.1 |
| --- | --- | --- |
| 2024-24989, 2024-24990, 2024-31079, 2024-32760, 2024-34161, 2024-35200 | Old public QUIC listeners; MTU condition for 34161 as above. | Fixed |
| 2026-40460 | Old public QUIC listeners. | Fixed |
| 2026-95101 | Default request buffering on ordinary locations; QUIC now disabled. | Still in range; fix in 1.31.7 |
| 2024-7347, 2026-27784, 2026-32647 | MP4 module compiled, but no `mp4` directive. MIME types and ordinary file serving do not activate MP4 processing. | Fixed |
| 2025-23419 | TLS 1.3 and shared session cache enabled, but no `ssl_verify_client` authentication to bypass. | Fixed |
| 2026-40701 | Resolver enabled; no `ssl_verify_client` or `ssl_ocsp` validation. `ssl_stapling off`. | Fixed |
| 2026-1642 | Upstreams use `http://` or Unix sockets; no nginx HTTPS upstream. | Fixed |
| 2026-27654 | No `dav_methods`. | Fixed |
| 2026-27651, 2026-28753, 2025-53859 | No mail listeners or mail authentication. | Fixed |
| 2026-9256, 2026-42945 | No nginx `rewrite` directives matching the vendor prerequisites; `rewrite_by_lua_block` is separate. | Fixed |
| 2026-42946 | No `scgi_pass` or `uwsgi_pass`. | Fixed |
| 2026-42934 | `charset utf-8`, but no `source_charset` or `charset_map` conversion. | Fixed |
| 2026-15176 | No `alias` or `$request_filename` expressions. | Still in range; fix in 1.31.7 |
| 2026-97629 | `ssl_session_tickets off`. | Still in range; fix in 1.31.7 |
| 2026-97205 | No `aio`; default is off. | Still in range; fix in 1.31.7 |
| 2026-42533 | Regex map `$bad_bot` has constant outputs, read only in a standalone `if`; no capture-before-map-output expression or volatile maps. The only `$1` substitution is a separate location redirect. No matching prerequisite identified. | Still in range; fix in 1.31.3 |
| 2026-60005 | No `slice` directive. | Still in range; fix in 1.31.3 |
| 2026-56434 | No `ssi on`. | Still in range; fix in 1.31.3 |
| 2026-42055 | HTTP/1.1 upstreams; no `proxy_http_version 2` or `grpc_pass`, and no enlarged header buffers/disabled header validation. | Still in range; fix in 1.31.2 |
| 2026-48142 | No `source_charset utf-8` conversion. | Still in range; fix in 1.31.2 |

Additional ranges that **exclude 1.25.3**:

- 2026-42530: nginx 1.31.0–1.31.1; QUIC now disabled to prevent exposure;
  fixed in 1.31.2.
- 2026-90439: nginx 1.29.2–1.31.5, with OpenSSL <= 3.5.0 required by the
  [vendor record](https://www.cve.org/CVERecord?id=CVE-2026-90439). Both pinned
  image architectures report OpenSSL 3.5.8 in their registry config labels,
  outside that prerequisite; CI also logs the runtime build information.
- 2026-42926: nginx 1.29.4–1.30.0; neither old nor new core is in range.
  Client HTTP/2 is enabled, but upstream `proxy_http_version` is 1.1.
- 2026-93479 and 2026-28755: neither old nor new core is in range.

Older MP4 advisories 2022-41741/41742, resolver 2021-23017 and the 2019
HTTP/2 advisories were already fixed before nginx 1.25.3. Do not count them
as reasons this specific old version is vulnerable.

Configuration prerequisites above come from the vendor CVE records, notably
[rewrite](https://www.cve.org/CVERecord?id=CVE-2026-9256),
[OCSP resolver](https://www.cve.org/CVERecord?id=CVE-2026-40701),
[regex map](https://www.cve.org/CVERecord?id=CVE-2026-42533),
[HTTP/2 upstream](https://www.cve.org/CVERecord?id=CVE-2026-42055), and
[charset conversion](https://www.cve.org/CVERecord?id=CVE-2026-42934).

## GitHub validation

The `proxy/**` change triggers the existing GitHub workflows:

- `proxy`: rebuild, assert the OpenResty release, log `openresty -V`, parse the
  generated config, and check container health/runtime substitutions.
- `unit-image`: build the production arm64 unit image (OpenResty included),
  check OpenResty in it and publish it to GHCR.
- `integration`: routing, compression/Brotli, disk cache, request matrix and
  parity, wildcard certificates, ACME/sockproc, Redis outages, graceful
  proxy handover and Node swaps. Protocol checks assert no QUIC configuration
  or live UDP 443 listener, no HTTP/3 advertisements, and successful HTTP/1.1
  and HTTP/2 requests across all public vhosts, repeated with the Redis
  wildcard certificate. Parity permits only the expected Alt-Svc change.
- `app-e2e` and `proxy-deploy-e2e`: real application requests and deployment
  exercises on GitHub runners.

No image builds, tests or CI are run locally for this upgrade. CI results
belong to the PR; this file describes coverage rather than claiming a pass.
Review stricter Host/:authority parsing failures against the
[OpenResty upgrade notes](https://openresty.org/en/ann-1031001001.html).
HTTP/1.1 and upstream keepalive are already explicitly configured here.
