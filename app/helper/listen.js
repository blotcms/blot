// Serves handler on a TCP port and, if socket is set, on a Unix socket too.
// No requires beyond Node built-ins: an e2e stand-in mounts this file alone.
//
// The socket is for the reverse proxy (see scripts/deploy): when nothing is
// listening on it, connecting fails at once and nginx retries the backup
// upstream. Through Docker's published port, docker-proxy accepts the
// connection even when Node isn't listening, then drops it, and nginx can't
// retry a request it has already sent.
const http = require("http");
const fs = require("fs");

// configure(server) sets per-server options (timeouts). Calls onListening once
// every server is listening. Returns the servers, TCP first.
module.exports = function listen(
  handler,
  { port, socket, configure },
  onListening,
) {
  const servers = [http.createServer(handler)];
  if (socket) servers.push(http.createServer(handler));

  let pending = servers.length;
  const listening = () => {
    if (--pending === 0 && onListening) onListening();
  };

  servers.forEach((server) => configure && configure(server));
  servers[0].listen(port, listening);

  if (socket) {
    // A SIGKILLed container leaves its socket file behind and listen would
    // fail with EADDRINUSE
    fs.rmSync(socket, { force: true });
    servers[1].listen(socket, () => {
      // nginx's workers run as a different user
      fs.chmodSync(socket, 0o666);
      listening();
    });
  }

  return servers;
};
