// Serves handler on a TCP port and, if socket is set, on a Unix socket too.
// With port null it serves on the socket alone (a forked worker child, see
// helper/workerChild); port 0 still picks a free one.
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
// every server is listening. Returns the servers, TCP first if there is one.
module.exports = function listen(
  handler,
  { port, socket, configure },
  onListening,
) {
  const tcp = port != null && port !== "" ? http.createServer(handler) : null;
  const unix = socket ? http.createServer(handler) : null;
  const servers = [tcp, unix].filter(Boolean);

  let pending = servers.length;
  const listening = () => {
    if (--pending === 0 && onListening) onListening();
  };

  servers.forEach((server) => configure && configure(server));
  if (tcp) tcp.listen(port, listening);

  if (unix) {
    // A SIGKILLed container leaves its socket file behind and listen would
    // fail with EADDRINUSE
    fs.rmSync(socket, { force: true });
    unix.listen(socket, () => {
      // nginx's workers run as a different user
      fs.chmodSync(socket, 0o666);
      listening();
    });
  }

  return servers;
};
