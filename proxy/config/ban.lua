-- Bans scanners inside the proxy, before they can cost another TLS handshake.
--
-- A request that ends in 444 is a scanner (see blot-blogs.conf). 444 closes the
-- connection, so the scanner reconnects for its next request and each time we
-- send a full certificate chain (~5 KB). fail2ban bans too slowly to stop that:
-- one scanner made 22k requests in 68 minutes. So:
--
--   record()    log phase: counts 444s per client IP, bans on the third in 2 min
--   handshake() ssl_client_hello_by_lua: aborts the handshake for a banned IP
--               before any certificate is chosen or sent
--   request()   rewrite phase: closes banned IPs on plain HTTP (and on HTTPS
--               reaching us through Cloudflare, where the handshake check sees
--               only Cloudflare's address)
--
-- Three strikes, not one, because a single 444 can be a mistyped URL; a scanner
-- gets there in a second. The ban lasts an hour. Wired up in http.conf.

local ssl = require "ngx.ssl"

local _M = {}

local STRIKES = 3
local WINDOW = 120 -- seconds the strikes are counted over
local BAN = 3600 -- seconds

local function dict()
  return ngx.shared.banned_ips
end

-- Loopback and private addresses, never banned (the Node containers and the
-- host reach the proxy over these).
local function private(ip)
  return ip == "::1"
    or ip:find("^127%.") ~= nil
    or ip:find("^10%.") ~= nil
    or ip:find("^192%.168%.") ~= nil
    or ip:find("^172%.1[6-9]%.") ~= nil
    or ip:find("^172%.2%d%.") ~= nil
    or ip:find("^172%.3[01]%.") ~= nil
    or ip:find("^[fF][cdCD]") ~= nil
    or ip:find("^[fF][eE]80:") ~= nil
end

-- Bans are keyed by the address in binary (4 or 16 bytes): that is what
-- $binary_remote_addr and ngx.ssl.raw_client_addr() give, and ngx.var.remote_addr
-- cannot be read in the handshake phase.

-- Log phase. $remote_addr is the real client (Cloudflare's CF-Connecting-IP
-- when the peer is Cloudflare), the same address fail2ban reads from the log.
-- $whitelist is the geo in http.conf (macserver, Bunny).
function _M.record()
  if ngx.status ~= 444 then
    return
  end

  local ip = ngx.var.remote_addr
  if ngx.var.whitelist == "1" or private(ip) or dict():get(ngx.var.binary_remote_addr) then
    return
  end

  local key = ngx.var.binary_remote_addr
  local strikes = dict():incr("strikes:" .. key, 1, 0, WINDOW)
  if strikes and strikes >= STRIKES then
    dict():set(key, true, BAN)
  end
end

-- ssl_client_hello_by_lua: the address is the raw TCP peer, as nothing has been
-- read from the connection yet. Bans hold real client IPs, so a Cloudflare edge
-- address (the peer of every proxied visitor) never matches.
function _M.handshake()
  local peer = ssl.raw_client_addr()
  if peer and dict():get(peer) then
    return ngx.exit(ngx.ERROR)
  end
end

-- Not reached by a bare `return` in a location (nginx runs those first), which
-- is only /health.
function _M.request()
  if dict():get(ngx.var.binary_remote_addr) then
    return ngx.exit(444)
  end
end

return _M
