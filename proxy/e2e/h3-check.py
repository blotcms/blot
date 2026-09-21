#!/usr/bin/env python3
"""Fetch a URL over HTTP/3 (QUIC, UDP) and assert on the response.

    h3-check.py <host> <port> <authority> [path]

Needs `pip install aioquic`. The certificate is not verified (the CI proxy
serves a self-signed placeholder). Prints the status and Alt-Svc and exits
non-zero unless the status is 200.
"""
import asyncio
import sys

from aioquic.asyncio import connect
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import HeadersReceived
from aioquic.quic.configuration import QuicConfiguration


class Client(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.h3 = H3Connection(self._quic)
        self.headers = asyncio.get_event_loop().create_future()

    def quic_event_received(self, event):
        for h3_event in self.h3.handle_event(event):
            if isinstance(h3_event, HeadersReceived) and not self.headers.done():
                self.headers.set_result(dict(h3_event.headers))


async def main(host, port, authority, path):
    config = QuicConfiguration(is_client=True, alpn_protocols=H3_ALPN, verify_mode=0)
    # SNI is the address, as with curl to an IP: a custom domain's certificate
    # would otherwise be looked up in Redis, which this job does not run.
    config.server_name = host
    async with connect(host, port, configuration=config, create_protocol=Client) as client:
        stream = client._quic.get_next_available_stream_id()
        client.h3.send_headers(stream, [
            (b":method", b"GET"), (b":scheme", b"https"),
            (b":authority", authority.encode()), (b":path", path.encode()),
        ], end_stream=True)
        client.transmit()
        headers = await asyncio.wait_for(client.headers, 10)
    status = headers[b":status"].decode()
    print("h3 %s%s -> %s alt-svc=%s" % (authority, path, status, headers.get(b"alt-svc", b"").decode()))
    return status == "200"


if __name__ == "__main__":
    ok = asyncio.run(main(sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "/"))
    sys.exit(0 if ok else 1)
