#!/usr/bin/env python3
"""Serves one directory over HTTPS on 127.0.0.1:443 for the Safari capture (macos.sh).
usage: browser-server.py <dir> <cert.pem> <key.pem>   (needs root for port 443)"""
import http.server
import ssl
import sys

root, cert, key = sys.argv[1:4]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


server = http.server.ThreadingHTTPServer(("127.0.0.1", 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.minimum_version = ssl.TLSVersion.TLSv1_2
context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
