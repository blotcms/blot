-- Serves the wildcard certificate (BLOT_HOST and *.BLOT_HOST) from Redis, so a
-- renewal that writes the new certificate there takes effect without anyone
-- reloading the proxy.
--
-- Redis holds two keys (written by whatever renews the certificate):
--   blot:openresty:ssl:pem   the full chain, PEM
--   blot:openresty:ssl:key   the private key, PEM
--
-- The static `ssl_certificate` file stays configured (nginx needs it to start)
-- and is the fallback: serve() changes nothing when there is no usable copy in
-- Redis, so the handshake carries on with the file.
--
-- One worker (id 0) reads Redis from a timer, every few seconds,
-- validates what it read and publishes it to the shared dict as one value, so
-- no worker can pair a new certificate with an old key. serve() only reads the
-- shared dict: a handshake never opens a connection, because yielding in
-- ssl_certificate_by_lua breaks HTTP/3 handshakes
-- (https://github.com/openresty/openresty/issues/1049).
--
-- If a read fails, the previous Redis copy keeps being served when there is one
-- (it is newer than the file), the next attempt comes a few seconds later, and
-- one line is logged per run of failures.
--
-- Used from proxy/config/wildcard-cert.conf and set up in init.conf.

local ssl = require "ngx.ssl"
local redis = require "resty.redis"

local _M = {}
local mt = { __index = _M }

local CERT_KEY = "blot:openresty:ssl:pem"
local PRIV_KEY = "blot:openresty:ssl:key"

-- The only key in the shared dict: the DER certificate chain and private key
-- as one value, "<length of the chain>:<chain><key>", so they are published and
-- read together. Absent means serve the file.
local PAIR = "pair"

-- Seconds between reads of Redis, after a success and after a failure alike.
-- A read is one MGET of two small keys from worker 0 per container, so 10s
-- costs Redis nothing, a renewal is served within 10s, and a Redis outage
-- is noticed (and logged, once) just as fast. Short enough for the CI check
-- (proxy/e2e/wildcard-cert-checks.sh, which repeats this value) to wait out.
local INTERVAL = 10

-- Connects red to host, which is a hostname or IP (TCP, on port) or, when it
-- starts with "unix:", a socket path (PROXY_REDIS_HOST=unix:/run/blot/redis/redis.sock).
-- resty.redis reads connect's second argument as the options table for a
-- socket and raises an error for a port number, so the port is left out
-- there. Failing to connect returns nil, err either way (a missing socket
-- included), which the callers rely on to fall back or back off. Also used
-- for auto-ssl's connection in init.conf, so both agree.
function _M.connect(red, host, port, opts)
  if string.sub(host, 1, 5) == "unix:" then
    return red:connect(host, opts)
  end

  return red:connect(host, port, opts)
end

function _M.new(options)
  return setmetatable({
    dict = options.dict,
    host = options.host,
    port = options.port or 6379,
    timeout = options.timeout or 500,
    failing = false,
  }, mt)
end

-- Returns the PEM chain and key. When it cannot, returns nil, why, and true if
-- Redis answered but has no (or an empty) certificate or key.
function _M:read_redis()
  local red = redis:new()
  red:set_timeouts(self.timeout, self.timeout, self.timeout)

  local ok, err = _M.connect(red, self.host, self.port)
  if not ok then
    return nil, "cannot connect to redis: " .. tostring(err)
  end

  local res, get_err = red:mget(CERT_KEY, PRIV_KEY)
  if not res then
    -- A connection that errored or timed out is never pooled
    red:close()
    return nil, "cannot read the certificate from redis: " .. tostring(get_err)
  end

  local pooled, pool_err = red:set_keepalive(10000, 4)
  if not pooled then
    ngx.log(ngx.WARN, "wildcard cert: set_keepalive: ", pool_err)
    red:close()
  end

  local pem, key = res[1], res[2]
  if pem == ngx.null or key == ngx.null or pem == "" or key == "" then
    return nil, "no certificate or key in redis", true
  end

  return pem, key
end

-- Checks that the PEM parses and returns its DER form (which is what is
-- cached, and what each handshake sets), or nil and why.
local function parse(pem, key)
  local cert, cert_err = ssl.parse_pem_cert(pem)
  if not cert then
    return nil, "the certificate does not parse: " .. tostring(cert_err)
  end

  local priv, key_err = ssl.parse_pem_priv_key(key)
  if not priv then
    return nil, "the private key does not parse: " .. tostring(key_err)
  end

  local der_cert, der_cert_err = ssl.cert_pem_to_der(pem)
  if not der_cert then
    return nil, "the certificate does not convert: " .. tostring(der_cert_err)
  end

  local der_key, der_key_err = ssl.priv_key_pem_to_der(key)
  if not der_key then
    return nil, "the private key does not convert: " .. tostring(der_key_err)
  end

  return der_cert, der_key
end

-- Whether the key belongs to the certificate, when lua-resty-openssl happens to
-- be installed (it is not a dependency). Returns false only on a proven
-- mismatch.
local function key_matches(pem, key)
  local has_x509, x509 = pcall(require, "resty.openssl.x509")
  local has_pkey, pkey = pcall(require, "resty.openssl.pkey")
  if not (has_x509 and has_pkey) then
    return true
  end
  local ok, same = pcall(function()
    local cert = x509.new(pem)
    local priv = pkey.new(key)
    return cert:get_pubkey():to_PEM("public") == priv:to_PEM("public")
  end)
  return not (ok and same == false)
end

-- Reads Redis and publishes the result. Returns true if the copy is current.
function _M:refresh()
  local dict = self.dict

  local pem, key, missing = self:read_redis()
  local reason = key
  local der_cert, der_key

  if pem then
    der_cert, der_key = parse(pem, key)
    if not der_cert then
      reason = der_key
    elseif not key_matches(pem, key) then
      der_cert = nil
      reason = "the private key does not match the certificate"
    end
  end

  if der_cert then
    dict:set(PAIR, #der_cert .. ":" .. der_cert .. der_key)
    if self.failing then
      ngx.log(ngx.NOTICE, "wildcard cert: read from redis again")
    end
    self.failing = false
    return true
  end

  if missing then
    -- Redis answered and has no wildcard certificate: do not keep serving an
    -- old copy of one, use the file
    dict:delete(PAIR)
  end

  if not self.failing then
    local serving = "the certificate file"
    if dict:get(PAIR) then
      serving = "the last copy read from redis"
    end
    ngx.log(missing and ngx.WARN or ngx.ERR, "wildcard cert: ", reason, "; serving ", serving)
  end
  self.failing = true
  return false
end

local function run(premature, self)
  if premature then
    return
  end

  local ok, current = pcall(self.refresh, self)
  if not ok then
    if not self.failing then
      ngx.log(ngx.ERR, "wildcard cert: ", current, "; serving the certificate file")
    end
    self.failing = true
    current = false
  end

  local timer_ok, timer_err = ngx.timer.at(INTERVAL, run, self)
  if not timer_ok and not ngx.worker.exiting() then
    ngx.log(ngx.ERR, "wildcard cert: cannot schedule the next read: ", timer_err)
  end
end

-- Call from init_worker_by_lua in every worker; only worker 0 reads Redis.
-- Reads now, then again every INTERVAL seconds.
function _M:start()
  if ngx.worker.id() ~= 0 then
    return
  end
  local ok, err = ngx.timer.at(0, run, self)
  if not ok then
    ngx.log(ngx.ERR, "wildcard cert: cannot start the timer: ", err)
  end
end

-- ssl_certificate_by_lua: swap in the certificate from Redis if there is one.
-- Shared dict reads only: no cosockets, so the handshake never yields.
function _M:serve()
  local pair = self.dict:get(PAIR)
  if not pair then
    return
  end

  local length, start = pair:match("^(%d+):()")
  length = tonumber(length)
  local der_cert = length and pair:sub(start, start + length - 1)
  local der_key = length and pair:sub(start + length)
  if not der_cert or der_key == "" then
    self.dict:delete(PAIR)
    ngx.log(ngx.ERR, "wildcard cert: cached copy is malformed; serving the certificate file")
    return
  end

  -- From clear_certs the static certificate is dropped. If the cached one then
  -- cannot be set, forget it, so later handshakes use the file rather than
  -- fail until the next read.
  local ok, err = ssl.clear_certs()
  if not ok then
    ngx.log(ngx.ERR, "wildcard cert: clear_certs: ", err)
    return
  end

  ok, err = ssl.set_der_cert(der_cert)
  if ok then
    ok, err = ssl.set_der_priv_key(der_key)
  end
  if not ok then
    self.dict:delete(PAIR)
    ngx.log(ngx.ERR, "wildcard cert: cannot use the cached copy (", err, "); serving the certificate file")
  end
end

return _M
