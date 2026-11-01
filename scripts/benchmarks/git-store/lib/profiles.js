// Network profiles for the git store spike, applied to the toxiproxy in front
// of MinIO. Every number below is an ESTIMATE of what S3 looks like from an
// EC2 host in the same region and availability zone, not a measurement, and
// none of it has been checked against real AWS (the spike uses no AWS at all).
// What the spike measures reliably is request and byte counts; times under a
// profile are the counts multiplied by these guesses, plus this machine's own
// speed.
//
// Latency is added on the downstream side only (the response travelling from
// MinIO to the client). Every request waits for one response, so a request
// pays the latency once; putting it on both sides would count it twice. The
// toxic delays each chunk it sees, so a long body is delayed by the latency
// once rather than once per chunk. Bandwidth is a cap per connection, in both
// directions, as S3 caps a single stream.
//
// Not modelled: TCP and TLS connection setup (the client keeps connections
// alive), S3 request throttling (3,500 PUTs and 5,500 GETs per second per
// prefix, far above anything here), tail latency beyond the jitter, and the
// first-byte slowness of rarely touched S3 objects.

module.exports = {
  // No toxics: MinIO as it is on this machine. The floor for everything else.
  direct: {
    assumptions: "No latency or bandwidth limit: what MinIO and this machine can do.",
    latencyMs: 0,
    jitterMs: 0,
    rateKBps: 0,
  },

  // S3 Standard, same region, from an EC2 host. Small GETs typically return
  // their first byte in 10 to 30 ms and PUTs take 20 to 50 ms; 20 ms with
  // 8 ms of jitter (uniform, so 12 to 28 ms) is the middle of that. A single
  // S3 connection moves about 60 to 90 MB/s, so 80 MB/s each way.
  "s3-standard": {
    assumptions:
      "20 ms downstream latency, 8 ms jitter, 80 MB/s per connection each way. Estimates for S3 Standard from EC2 in the same region.",
    latencyMs: 20,
    jitterMs: 8,
    rateKBps: 80 * 1024,
  },

  // S3 Express One Zone, with the client in the same availability zone. AWS
  // quotes consistent single-digit millisecond requests; 4 ms with 1 ms
  // jitter is a guess in that range. Per-connection throughput is higher
  // than Standard's, taken here as 150 MB/s. Express also has a different
  // request pricing and a session-based auth that the SDK handles, neither of
  // which is modelled here.
  "express-one-zone": {
    assumptions:
      "4 ms downstream latency, 1 ms jitter, 150 MB/s per connection each way. Estimates for S3 Express One Zone from an EC2 host in the same availability zone.",
    latencyMs: 4,
    jitterMs: 1,
    rateKBps: 150 * 1024,
  },
};
