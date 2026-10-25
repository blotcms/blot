# Proxy cache benchmark results

Run: 2026-10-24T09:19:02Z

Machine: Docker 29.8.2, 1 CPUs, 4107534336 bytes memory, Docker Desktop, aarch64 ; host Darwin arm64, 8 logical CPUs

Baseline (nginx proxy_cache): origin/master (736860666). Disk cache: working tree (993416204 + local changes).

wrk: `-t4 -c64 -d20s --latency`, from a separate container on the same network. Proxy limited to `--cpus=1`. The stub upstream and Redis are idle in the hit cases (every request is a cache hit, brotli copies made before timing) and busy in the fill cases (every request a distinct URL).

| Case | Impl | req/s | p50 ms | p99 ms | transfer/s | non-2xx | CPU us/req | proxy cores | wrk cores | stub cores |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| page br+gzip | proxycache | 813.44 | 76.92 | 169.64 | 15.83MB | 0 | 713.8 | 0.58 | 0.01 | 0.00 |
| page br+gzip | diskcache | 14392.56 | 4.17 | 13.57 | 241.52MB | 0 | 28.1 | 0.41 | 0.15 | 0.00 |
| page gzip | proxycache | 559.87 | 110.86 | 252.96 | 10.87MB | 0 | 1033.1 | 0.58 | 0.01 | 0.00 |
| page gzip | diskcache | 529.01 | 124.10 | 275.79 | 10.30MB | 0 | 1033.2 | 0.55 | 0.01 | 0.00 |
| page identity | proxycache | 13552.41 | 4.20 | 19.37 | 800.69MB | 0 | 23.7 | 0.32 | 0.17 | 0.00 |
| page identity | diskcache | 12848.07 | 4.63 | 15.44 | 759.91MB | 0 | 28.3 | 0.36 | 0.17 | 0.00 |
| large br+gzip | proxycache | 29.69 | 1560.00 | 1980.00 | 18.49MB | 0 (Socket errors: connect 0, read 0, write 0, timeout 308) | 22136.6 | 0.66 | 0.01 | 0.00 |
| large br+gzip | diskcache | 5050.90 | 6.93 | 30.44 | 2.29GB | 0 | 40.4 | 0.21 | 0.34 | 0.00 |
| image br+gzip | proxycache | 9379.57 | 5.84 | 47.77 | 1.79GB | 0 | 31.0 | 0.29 | 0.24 | 0.00 |
| image br+gzip | diskcache | 9712.74 | 5.91 | 21.04 | 1.86GB | 0 | 33.1 | 0.32 | 0.26 | 0.00 |
| fill page identity | proxycache | 1434.61 | 32.76 | 983.34 | 84.80MB | 0 | 165.9 | 0.24 | 0.04 | 0.06 |
| fill page identity | diskcache | 1770.44 | 16.35 | 86.59 | 104.66MB | 0 (Socket errors: connect 0, read 0, write 0, timeout 128) | 190.5 | 0.34 | 0.03 | 0.05 |
| fill page br+gzip | proxycache | 472.62 | 120.83 | 284.14 | 9.20MB | 0 | 829.7 | 0.39 | 0.01 | 0.00 |
| fill page br+gzip | diskcache | 764.57 | 73.95 | 515.15 | 14.92MB | 0 | 1014.4 | 0.78 | 0.01 | 0.00 |
| fill large identity | proxycache | 65.82 | 726.73 | 1900.00 | 132.21MB | 0 (Socket errors: connect 0, read 0, write 0, timeout 53) | 2417.5 | 0.16 | 0.02 | 0.03 |
| fill large identity | diskcache | 81.39 | 390.83 | 914.39 | 164.78MB | 0 (Socket errors: connect 0, read 0, write 0, timeout 128) | 4155.1 | 0.34 | 0.02 | 0.03 |
| fill large br+gzip | proxycache | 18.10 | 1070.00 | 1950.00 | 11.27MB | 0 (Socket errors: connect 0, read 0, write 0, timeout 330) | 24473.1 | 0.44 | 0.00 | 0.00 |
| fill large br+gzip | diskcache | 29.82 | 1800.00 | 1990.00 | 18.58MB | 0 (Socket errors: connect 0, read 0, write 0, timeout 284) | 22590.9 | 0.68 | 0.01 | 0.00 |

Ratio diskcache / proxycache:

| Case | req/s | CPU us/req |
| --- | ---: | ---: |
| page br+gzip | 17.69x | 0.04x |
| page gzip | 0.94x | 1.00x |
| page identity | 0.95x | 1.19x |
| large br+gzip | 170.12x | 0.00x |
| image br+gzip | 1.04x | 1.07x |
| fill page identity | 1.23x | 1.15x |
| fill page br+gzip | 1.62x | 1.22x |
| fill large identity | 1.24x | 1.72x |
| fill large br+gzip | 1.65x | 0.92x |

CPU time of one brotli compression, run in the proxy container (what the compressor pays once per entry read twice):

| Page | Size | Level | Compressed | CPU ms |
| --- | ---: | ---: | ---: | ---: |
| /page | 61732 | 4 | 20153 | 1.8 |
| /page | 61732 | 11 | 17309 | 47.0 |
| /large | 2097526 | 4 | 607740 | 26.0 |
| /large | 2097526 | 11 | 486892 | 1881.0 |

Response checks (Blot-Cache HIT, or MISS for fill cases, and expected Content-Encoding, before each wrk run):

- proxycache: page br+gzip ok, page gzip ok, page identity ok, large br+gzip ok, image br+gzip ok, fill page identity ok, fill page br+gzip ok, fill large identity ok, fill large br+gzip ok
- diskcache: page br+gzip ok, page gzip ok, page identity ok, large br+gzip ok, image br+gzip ok, fill page identity ok, fill page br+gzip ok, fill large identity ok, fill large br+gzip ok

Proxy error/crit/alert log lines:

- proxycache: 

```
2026/10/24 09:12:21 [error] 30#30: *559 lua tcp socket read timed out, context: ngx.timer
```

- diskcache: none
