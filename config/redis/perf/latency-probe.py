#!/usr/bin/env python3
"""Redis round-trip latency probe, run from cron every minute.

Usage: latency-probe.py --label LABEL [--host 127.0.0.1] [--port 6379]
         [--duration 55] [--interval 0.05] [--burst-bytes 250000]
         [--hard-timeout 70] [--log PATH|-]

Holds one TCP connection (TCP_NODELAY) to Redis and sends PING every 50ms for
~55s, timing each reply. Then, once, it writes a pipelined burst of PINGs
(~250KB by default, the size of the write that stalled in blotcms/blot#2041),
reads every reply, and times the whole thing. Appends one summary line to
~/perf/latency-<label>.log: an ISO UTC timestamp (of the start of the run, so it
lines up with the same minute of redis-sample.log), then key=value pairs:

  n err reconn conn_ms p50 p90 p99 p999 max (ms) max_sec gt10 gt50 gt100 gt1000
  burst_ms burst_n

Plain Python 3 stdlib, speaking RESP by hand over a raw socket. It sends only
PING (about 1,100 a minute, 14 bytes each) and never AUTH or anything else.
A run that finds the previous one still going exits quietly (file lock), and
SIGALRM ends it after --hard-timeout seconds whatever it is stuck on, logging
what it has with timeout=1. Exit status is always 0, so cron stays quiet.
"""
import argparse
import fcntl
import os
import signal
import socket
import sys
import time

PING = b"*1\r\n$4\r\nPING\r\n"
PONG = b"+PONG\r\n"
PING_TIMEOUT = 3.0  # a reply later than this counts as an error (and as a 3s+ sample)
BURST_TIMEOUT = 4.0


class HardTimeout(Exception):
    pass


def on_alarm(signum, frame):
    raise HardTimeout()


def connect(host, port, timeout):
    s = socket.create_connection((host, port), timeout=timeout)
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    s.settimeout(timeout)
    return s


def read_exact(s, n, deadline):
    """Read exactly n bytes, giving up at the monotonic deadline."""
    buf = b""
    while len(buf) < n:
        left = deadline - time.monotonic()
        if left <= 0:
            raise socket.timeout()
        s.settimeout(left)
        chunk = s.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def percentile(sorted_ms, q):
    """Nearest-rank percentile of an ascending list."""
    if not sorted_ms:
        return None
    k = max(0, min(len(sorted_ms) - 1, int(-(-q * len(sorted_ms) // 100)) - 1))
    return sorted_ms[k]


def fmt(v):
    return "x" if v is None else "%.3f" % v


def burst(s, nbytes):
    """Write nbytes of PINGs in one go, read every reply; return (ms, n) or (None, n)."""
    n = nbytes // len(PING)
    payload = PING * n
    t0 = time.perf_counter()
    deadline = time.monotonic() + BURST_TIMEOUT
    try:
        # Redis queues replies in memory while we are still writing, so writing
        # everything first and reading afterwards cannot deadlock.
        s.settimeout(BURST_TIMEOUT)
        s.sendall(payload)
        want = n * len(PONG)
        got = 0
        while got < want:
            left = deadline - time.monotonic()
            if left <= 0:
                raise socket.timeout()
            s.settimeout(left)
            chunk = s.recv(min(65536, want - got))
            if not chunk:
                raise ConnectionError("closed")
            got += len(chunk)
        return (time.perf_counter() - t0) * 1000.0, n
    except (OSError, socket.timeout):
        return None, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=6379)
    ap.add_argument("--duration", type=float, default=55.0)
    ap.add_argument("--interval", type=float, default=0.05)
    ap.add_argument("--burst-bytes", type=int, default=250000)
    ap.add_argument("--hard-timeout", type=int, default=70)
    ap.add_argument("--log", default=None, help="log file, or - for stdout (default ~/perf/latency-<label>.log)")
    args = ap.parse_args()

    perf_dir = os.environ.get("PERF_DIR", os.path.expanduser("~/perf"))
    log = args.log or os.path.join(perf_dir, "latency-%s.log" % args.label)
    if log != "-":
        os.makedirs(os.path.dirname(log) or ".", exist_ok=True)

    # One run at a time: if the previous minute's run is still going, skip this one.
    os.makedirs(perf_dir, exist_ok=True)
    lock = open(os.path.join(perf_dir, ".latency-%s.lock" % args.label), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.stderr.write("latency-probe: previous run still going, skipped\n")
        return

    signal.signal(signal.SIGALRM, on_alarm)
    signal.alarm(args.hard_timeout)

    start_wall = time.time()
    lat = []  # (ms, wall second of the minute when it was sent)
    errors = reconnects = 0
    connected_before = False
    conn_ms = None
    burst_ms = burst_n = None
    timed_out = 0
    s = None
    try:
        t_end = time.monotonic() + args.duration
        next_at = time.monotonic()
        while time.monotonic() < t_end:
            if s is None:
                t0 = time.perf_counter()
                try:
                    s = connect(args.host, args.port, PING_TIMEOUT)
                    if connected_before:
                        reconnects += 1
                    else:
                        conn_ms = (time.perf_counter() - t0) * 1000.0
                    connected_before = True
                except OSError:
                    errors += 1
                    s = None
                    time.sleep(min(args.interval * 4, 0.2))
                    continue
            sent_wall = time.time()
            t0 = time.perf_counter()
            try:
                s.sendall(PING)
                reply = read_exact(s, len(PONG), time.monotonic() + PING_TIMEOUT)
                ms = (time.perf_counter() - t0) * 1000.0
                if reply != PONG:
                    raise ConnectionError("unexpected reply")
                lat.append((ms, time.gmtime(sent_wall).tm_sec))
            except (OSError, socket.timeout, ConnectionError):
                # A slow or lost reply still counts as a sample: it is the stall we are after.
                lat.append(((time.perf_counter() - t0) * 1000.0, time.gmtime(sent_wall).tm_sec))
                errors += 1
                try:
                    s.close()
                except OSError:
                    pass
                s = None
            # Fixed schedule; after a stall, do not fire a catch-up burst of pings.
            next_at += args.interval
            now = time.monotonic()
            if next_at < now:
                next_at = now
            else:
                time.sleep(next_at - now)

        if args.burst_bytes > 0:
            if s is None:
                try:
                    s = connect(args.host, args.port, PING_TIMEOUT)
                except OSError:
                    s = None
            if s is not None:
                burst_ms, burst_n = burst(s, args.burst_bytes)
            else:
                burst_n = args.burst_bytes // len(PING)
    except HardTimeout:
        timed_out = 1
    finally:
        signal.alarm(0)
        if s is not None:
            try:
                s.close()
            except OSError:
                pass

    ms = sorted(v for v, _ in lat)
    worst = max(lat) if lat else None
    fields = [
        "n=%d" % len(lat),
        "err=%d" % errors,
        "reconn=%d" % reconnects,
        "conn_ms=%s" % fmt(conn_ms),
        "p50=%s" % fmt(percentile(ms, 50)),
        "p90=%s" % fmt(percentile(ms, 90)),
        "p99=%s" % fmt(percentile(ms, 99)),
        "p999=%s" % fmt(percentile(ms, 99.9)),
        "max=%s" % fmt(worst[0] if worst else None),
        "max_sec=%s" % (worst[1] if worst else "x"),
        "gt10=%d" % sum(1 for v in ms if v > 10),
        "gt50=%d" % sum(1 for v in ms if v > 50),
        "gt100=%d" % sum(1 for v in ms if v > 100),
        "gt1000=%d" % sum(1 for v in ms if v > 1000),
        "burst_ms=%s" % fmt(burst_ms),
        "burst_n=%s" % ("x" if burst_n is None else burst_n),
    ]
    if timed_out:
        fields.append("timeout=1")
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start_wall)) + " label=%s " % args.label + " ".join(fields)

    if log == "-":
        print(line)
    else:
        with open(log, "a") as f:
            f.write(line + "\n")
        # Keep the previous file as .1 once it passes 20MB (about a year at this rate).
        if os.path.getsize(log) > 20000000:
            os.replace(log, log + ".1")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never let cron mail a traceback
        sys.stderr.write("latency-probe: %r\n" % (e,))
    sys.exit(0)
