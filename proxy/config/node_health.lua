-- Routes blog and dashboard reads around a blocked node-a (#2990).
--
-- Each unit's OpenResty sends blog requests to its own node-a, with the other
-- unit's node-a as `backup`. nginx only tries the backup when the connection
-- fails, which is when node-a is dead. A node-a whose event loop is blocked
-- still accepts connections (the kernel queues them), so requests waited on
-- it for up to the 15s read timeout: on 26 Nov 2026 a build blocked node-a
-- for 17s at a time and sites slowed on both units.
--
-- So worker 0 asks both node-a processes for /health every second, with a
-- one second timeout. Two failures in a row mark a process down, and one
-- answer marks it up again. pick() sends a request to the other unit's
-- node-a while this unit's is down and the other's isn't. When both are down,
-- or the probe has stopped, routing is as it was without it. Requests already
-- waiting on the blocked process still wait: this only spares new ones.

local _M = {}
local mt = { __index = _M }

local INTERVAL = 1
local TIMEOUT_MS = 1000
local FAILURES_TO_DOWN = 2
-- A result older than this is ignored, so a probe that stopped can't hold a
-- process down
local STALE = 10

-- options: dict (a lua_shared_dict), local_main and peer_main (upstream
-- addresses as in http.conf: "unix:/run/blot/blue-a.sock" or "host:port")
function _M.new(options)
  return setmetatable({
    dict = options.dict,
    targets = { ["local"] = options.local_main, peer = options.peer_main },
    interval = options.interval or INTERVAL,
    timeout = options.timeout or TIMEOUT_MS,
  }, mt)
end

local function connect(sock, address)
  if address:sub(1, 5) == "unix:" then return sock:connect(address) end
  local host, port = address:match("^(.+):(%d+)$")
  if not host then return nil, "bad address " .. address end
  return sock:connect(host, tonumber(port))
end

-- true if address answers /health with a 200 within the timeout
function _M:probe(address)
  local sock = ngx.socket.tcp()
  sock:settimeouts(self.timeout, self.timeout, self.timeout)
  local ok, err = connect(sock, address)
  if not ok then return false, err end
  ok, err = sock:send(
    "GET /health HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n"
  )
  if not ok then
    sock:close()
    return false, err
  end
  local line
  line, err = sock:receive("*l")
  sock:close()
  if not line then return false, err end
  return line:match("^HTTP/%d%.%d 200") ~= nil, line
end

function _M:record(name, healthy, detail)
  local key = "failures:" .. name
  local failures = healthy and 0 or ((self.dict:get(key) or 0) + 1)
  local was = (self.dict:get(key) or 0) >= FAILURES_TO_DOWN
  self.dict:set(key, failures, STALE)
  local is = failures >= FAILURES_TO_DOWN
  if is ~= was then
    ngx.log(
      ngx.WARN,
      "node health: ",
      name,
      " node-a (",
      self.targets[name],
      ") is ",
      is and "down" or "up",
      is and (": " .. tostring(detail)) or ""
    )
  end
end

function _M:down(name)
  return (self.dict:get("failures:" .. name) or 0) >= FAILURES_TO_DOWN
end

function _M:check()
  local threads = {}
  for name, address in pairs(self.targets) do
    if address and address ~= "" then
      threads[name] = ngx.thread.spawn(function()
        return self:probe(address)
      end)
    end
  end
  for name, thread in pairs(threads) do
    local ran, healthy, detail = ngx.thread.wait(thread)
    self:record(name, ran and healthy, detail)
  end
end

-- Called from init_worker_by_lua in every worker; only worker 0 probes. Each
-- check is scheduled when the last has finished, so they never overlap.
function _M:start()
  if ngx.worker.id() ~= 0 then return end
  local function run(premature)
    if premature then return end
    local ok, err = pcall(self.check, self)
    if not ok then ngx.log(ngx.ERR, "node health: check failed: ", err) end
    local scheduled, timer_err = ngx.timer.at(self.interval, run)
    if not scheduled then
      ngx.log(ngx.ERR, "node health: cannot schedule the check: ", timer_err)
    end
  end
  local ok, err = ngx.timer.at(0, run)
  if not ok then ngx.log(ngx.ERR, "node health: cannot start: ", err) end
end

-- The upstream for a request: peer while this unit's node-a is down and the
-- other unit's isn't, otherwise primary
function _M:pick(primary, peer)
  if self:down("local") and not self:down("peer") then return peer end
  return primary
end

return _M
