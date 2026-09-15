# Server-sent event connection baseline

The draft-preview and preview-reload endpoints intentionally use one Redis
subscriber client per open browser tab. In the representative local check, the
Redis `CLIENT LIST` subscription count increased by one for each draft stream
and by one for each preview-reload stream, then returned to baseline when each
tab's HTTP request was aborted or its response was closed. This is the expected
relationship: **open subscription connections = open editor/preview tabs**.

The lifecycle regression tests exercise the two disconnect signals produced by
Node when an nginx/OpenResty downstream disappears (`req.aborted` followed by
one or more `close` events). All signals reach the same idempotent cleanup path.
The setup-race test also closes a stream while Redis `connect()` is pending and
verifies that the client is quit without creating a late subscription.

The preview virtual host includes `reverse-proxy-preview.conf`, whose
`proxy_read_timeout` is 15 seconds. The heartbeat therefore remains at 10
seconds. The general SSE include has a 24-hour timeout, but it is not used by
the preview virtual host. The local per-tab client overhead was not material
relative to rendering and application memory, so the simpler isolated-client
design is retained rather than adding process-level multiplexing and its shared
failure domain.
