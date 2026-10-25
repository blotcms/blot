-- A response cache on disk that any number of OpenResty instances on the same
-- host can share, with no index. It replaces nginx's proxy_cache, which each
-- instance keeps to itself, so two proxies could not run side by side and a
-- purge only reached the one that received it.
--
-- Layout, under the cache directory:
--
--   <a>/<bc>/<host>/<key>.meta         status, headers, the fill id
--   <a>/<bc>/<host>/<key>.<id>         the body as Node sent it
--   <a>/<bc>/<host>/<key>.<id>.br      a brotli copy, made after the first hit
--   <a>/<bc>/<host>/.tmp/              fills and compressions in progress
--   <a>/<bc>/<host>.purged             time of the host's last purge
--   .trash/                            purged host directories, being removed
--
-- <key> is md5(cache key) and <a>/<bc> are the last characters of md5(host),
-- as nginx's levels=1:2. <id> names one fill, so a body never changes once
-- written and a compression that finishes after a refill cannot be served
-- with the new metadata.
--
-- A hit reads the .meta file, sets its headers and leaves the body to
-- try_files in the same location, which sends it with sendfile; brotli_static
-- picks the .br copy when the client accepts it, so a hit costs no
-- compression. A miss streams Node's response into .tmp and publishes it with
-- rename, which is atomic, so another instance sees either the old entry or
-- the new one.
--
-- A purge writes <host>.purged, then renames the host directory into .trash.
-- Every writer checks <host>.purged after its last rename and deletes what it
-- published if a purge happened since it started, so a response fetched
-- before a purge cannot survive it.

local ffi = require("ffi")
local cjson = require("cjson.safe")
local resty_lock = require("resty.lock")
local ngx_pipe = require("ngx.pipe")
local resty_random = require("resty.random")
local resty_string = require("resty.string")

local diskcache = {}
diskcache.__index = diskcache

-- Statuses cached, as proxy_cache_valid did
local CACHEABLE = { [200] = true, [301] = true, [302] = true, [400] = true, [404] = true }

-- Upstream headers that are not sent again on a hit. Content-Length and
-- Last-Modified come from the file being served (its mtime is Node's
-- Last-Modified, meta.l); ETag is kept apart (meta.e).
local SKIP_HEADERS = {
    ["connection"] = true,
    ["keep-alive"] = true,
    ["transfer-encoding"] = true,
    ["content-length"] = true,
    ["date"] = true,
    ["set-cookie"] = true,
    ["etag"] = true,
    ["last-modified"] = true,
    ["accept-ranges"] = true,
    ["vary"] = true,
    -- set by this proxy, not Node
    ["blot-cache"] = true,
    ["blot-server"] = true,
    ["blot-upstream"] = true,
    ["x-content-type-options"] = true,
}

-- Types worth a brotli copy: brotli_types in static-file.conf, less the ones
-- that hardly shrink
local COMPRESSIBLE = {
    ["text/html"] = true,
    ["text/css"] = true,
    ["text/plain"] = true,
    ["text/xml"] = true,
    ["text/javascript"] = true,
    ["text/markdown"] = true,
    ["text/calendar"] = true,
    ["text/vtt"] = true,
    ["application/javascript"] = true,
    ["application/x-javascript"] = true,
    ["application/json"] = true,
    ["application/ld+json"] = true,
    ["application/manifest+json"] = true,
    ["application/xml"] = true,
    ["application/xhtml+xml"] = true,
    ["application/rss+xml"] = true,
    ["application/atom+xml"] = true,
    ["application/rdf+xml"] = true,
    ["application/wasm"] = true,
    ["image/svg+xml"] = true,
    ["image/x-icon"] = true,
    ["image/vnd.microsoft.icon"] = true,
    ["font/ttf"] = true,
    ["font/otf"] = true,
    ["font/eot"] = true,
}

-- Smaller bodies are not compressed (brotli_min_length)
local MIN_COMPRESS = 256

-- How long a miss waits for another request filling the same key, as
-- proxy_cache_lock_timeout
local LOCK_TIMEOUT = 5

-- A fill releases its lock once the body passes this size. The body filter
-- runs at the pace the client reads, so waiters fetch a large file from Node
-- themselves rather than queue behind one slow download.
local LOCK_MAX_BYTES = 1024 * 1024

function diskcache.new(options)
    return setmetatable({
        directory = options.directory,
        locks = options.locks,
        -- the compression queue's shared dict, and its length limit
        queue = options.queue,
        queue_max = options.queue_max or 10000,
    }, diskcache)
end

local function host_name(host)
    if #host <= 253 and host:match("^[%w%.%-]+$") then
        return host
    end

    return ngx.md5(host)
end

-- The host's directory relative to the cache directory, and its purge marker
local function host_path(host)
    local hash = ngx.md5(host)
    local shard = hash:sub(-1) .. "/" .. hash:sub(-3, -2) .. "/"
    local name = host_name(host)

    return shard .. name, shard .. name .. ".purged"
end

local function read_file(path)
    local file = io.open(path, "rb")

    if not file then
        return nil
    end

    local data = file:read("*a")
    file:close()

    return data
end

local function write_file(path, data)
    local file, err = io.open(path, "wb")

    if not file then
        return nil, err
    end

    local ok, write_err = file:write(data)
    file:close()

    if not ok then
        os.remove(path)
        return nil, write_err
    end

    return true
end

local function file_size(path)
    local file = io.open(path, "rb")

    if not file then
        return nil
    end

    local size = file:seek("end")
    file:close()

    return size
end

local function read_meta(path)
    return cjson.decode(read_file(path) or "")
end

ffi.cdef([[
int mkdir(const char *path, unsigned int mode);
struct utimbuf { long actime; long modtime; };
int utime(const char *path, const struct utimbuf *times);
]])

-- Give a body Node's Last-Modified as its mtime, so the static module sends
-- it on a hit and compares If-Modified-Since and If-Range with it, as
-- proxy_cache did with the stored header (see evict.sh on what an old mtime
-- means to the sweeper).
local function set_mtime(path, time)
    ffi.C.utime(path, ffi.new("struct utimbuf", { ngx.time(), time }))
end

-- mkdir -p without a child process: header filters cannot yield
local function mkdir_p(path)
    local partial = ""

    for part in path:gmatch("[^/]+") do
        partial = partial .. "/" .. part
        -- EEXIST is the common case and fine
        ffi.C.mkdir(partial, 493) -- 0755
    end
end

-- Unique across the containers sharing the cache. Not the worker pid or
-- math.random: each container has its own pid namespace, so worker pids
-- repeat across containers, and nothing seeds math.random.
local function random_id()
    return string.format("%x", ngx.now() * 1000) .. resty_string.to_hex(resty_random.bytes(6))
end

-- Time of the host's last purge, or 0
local function purged_at(self, marker)
    return tonumber(read_file(self.directory .. "/" .. marker)) or 0
end

-- Queue an entry for compress(). The queued: key stays until the compression
-- is done, so hits meanwhile do not queue it again. A full queue drops the
-- entry: a later hit queues it again.
local function enqueue(self, job)
    local queue = ngx.shared[self.queue]

    if queue:llen("jobs") >= self.queue_max then
        return
    end

    if queue:add("queued:" .. job, true, 600) then
        queue:rpush("jobs", job)
    end
end

-- Whether If-None-Match lists etag, compared weakly (RFC 9110 13.1.2)
local function etag_listed(list, etag)
    local bare = etag:gsub("^W/", "")

    for tag in list:gmatch("[^,]+") do
        tag = tag:match("^%s*(.-)%s*$")

        if tag == "*" or tag:gsub("^W/", "") == bare then
            return true
        end
    end

    return false
end

-- The ETag of a hit served from the brotli copy: Node's, weak, as the brotli
-- filter makes it when it compresses on a miss. The plain body keeps Node's
-- own, so If-Range (a strong comparison) still matches it.
local function weak(etag)
    if etag:sub(1, 2) == "W/" then
        return etag
    end

    return "W/" .. etag
end

local function send_headers(meta)
    -- a header Node sent more than once (Link) is set once, as a list:
    -- assigning each value would keep only the last
    local values = {}

    for _, pair in ipairs(meta.h) do
        local name = pair[1]:lower()

        if values[name] then
            table.insert(values[name], pair[2])
        else
            values[name] = { pair[2] }
        end
    end

    for name, list in pairs(values) do
        ngx.header[name] = #list == 1 and list[1] or list
    end

    ngx.header["Blot-Cache"] = "HIT"
end

-- access_by_lua in the cached location (reverse-proxy-cache.conf): serve a
-- hit, otherwise try_files passes the request to @diskcache_fill. A 200 is
-- left for try_files to send; other statuses are printed here.
function diskcache.access(self)
    local method = ngx.req.get_method()

    if method ~= "GET" and method ~= "HEAD" then
        return
    end

    local dir = host_path(ngx.var.host)
    local key = ngx.md5(ngx.var.cache_key)
    local meta = read_meta(self.directory .. "/" .. dir .. "/" .. key .. ".meta")

    if not meta then
        return
    end

    local body = dir .. "/" .. key .. "." .. meta.id

    if meta.s ~= 200 then
        -- redirects and error pages: small, and the static module only
        -- sends a 200, so print them. No body file means the sweeper
        -- removed the entry after its metadata was read: a miss.
        local content = read_file(self.directory .. "/" .. body)

        if not content then
            return
        end

        send_headers(meta)
        ngx.status = meta.s

        if #content > 0 and method ~= "HEAD" then
            ngx.print(content)
        end

        return ngx.exit(ngx.HTTP_OK)
    end

    send_headers(meta)

    if meta.e then
        -- brotli_static sends the .br copy (meta.b) to a client that accepts
        -- br, but not with a 304, which carries Node's own as proxy_cache's did
        local ae = meta.b and ngx.var.http_accept_encoding
        local br = ae and ngx.re.find(ae, [[(?:^|[,\s])br(?:$|[,;\s])]], "jo")
        local inm = br and ngx.var.http_if_none_match
        br = br and not (inm and etag_listed(inm, meta.e))
        ngx.header["ETag"] = br and weak(meta.e) or meta.e
    end

    if not meta.l then
        -- Node sent no Last-Modified, so the file's mtime is the fill's:
        -- send none (hit_header_filter), and let no If-Range date match it.
        -- An If-Modified-Since is left to nginx: no client has that date,
        -- so it answers 200, as it did with no Last-Modified at all.
        ngx.ctx.diskcache_no_last_modified = true

        local if_range = ngx.var.http_if_range

        if if_range and not if_range:find('"', 1, true) then
            ngx.req.set_header("If-Range", '"no-last-modified"')
        end
    end

    -- the entry has been read again since its fill: worth a brotli copy
    if meta.c then
        enqueue(self, dir .. "/" .. key)
    end

    ngx.var.diskcache_path = "/" .. body
end

-- header_filter_by_lua in the cached location: a hit of an entry Node sent
-- without Last-Modified gets none, as proxy_cache sent the stored headers
function diskcache.hit_header_filter()
    if ngx.ctx.diskcache_no_last_modified then
        ngx.header["Last-Modified"] = nil
    end
end

-- Release the fill lock this request holds, if any. Called from the fill's
-- filters and log_by_lua and, for a request error_page redirected, in the
-- error page's location (blot-blogs.conf, blot-site.conf): that redirect
-- clears ngx.ctx but keeps variables.
function diskcache.release(self)
    local key = ngx.var.diskcache_lock

    if key and key ~= "" then
        ngx.shared[self.locks]:delete(key)
        ngx.var.diskcache_lock = ""
    end
end

-- access_by_lua in @diskcache_fill: wait for a fill of the same key in
-- progress and serve that, or let the request through to Node and record it
function diskcache.fill(self)
    -- HEAD has no body to store
    if ngx.req.get_method() ~= "GET" then
        ngx.ctx.diskcache = { skip = true }
        return
    end

    -- see reverse-proxy-fill.conf
    if (ngx.var.http_if_none_match or ngx.var.http_if_modified_since)
        and ngx.var.diskcache_conditional ~= "1"
    then
        return ngx.exec("@diskcache_fill_conditional")
    end

    local dir, marker = host_path(ngx.var.host)
    local key = ngx.md5(ngx.var.cache_key)
    local lock = resty_lock:new(self.locks, { exptime = 60, timeout = LOCK_TIMEOUT })
    local elapsed = lock and lock:lock(dir .. "/" .. key)

    if elapsed and elapsed > 0 then
        -- another request in this instance filled it while we waited:
        -- serve it from the cached location
        lock:unlock()

        if read_file(self.directory .. "/" .. dir .. "/" .. key .. ".meta") then
            return ngx.exec(ngx.var.uri, ngx.var.args)
        end

        elapsed = lock:lock(dir .. "/" .. key)
    end

    if elapsed then
        ngx.var.diskcache_lock = dir .. "/" .. key
    end

    ngx.ctx.diskcache = {
        dir = dir,
        marker = marker,
        key = key,
        started = ngx.now(),
        -- reverse-proxy-fill.conf strips Range so the whole body is stored;
        -- header_filter answers the client's range from it
        range = ngx.var.http_range,
        if_range = ngx.var.http_if_range,
    }
end

-- The bytes [first, last] of a body of length bytes a single-range Range
-- header asks for. Returns nil for a header to ignore (a multi-range or
-- malformed one: the whole body is sent), or false when no byte of the
-- body is in range (416).
local function byte_range(header, length)
    local first, last = header:match("^bytes=(%d*)-(%d*)$")

    if not first or (first == "" and last == "") then
        return nil
    end

    if first == "" then
        -- the last n bytes
        local n = tonumber(last)
        if n == 0 then
            return false
        end
        return math.max(length - n, 0), length - 1
    end

    first = tonumber(first)
    last = last == "" and length - 1 or math.min(tonumber(last), length - 1)

    if first > last then
        return first < length and nil or false
    end

    return first, last
end

-- Answer a conditional GET from a whole 200 from Node, as proxy_cache did on
-- a miss (nginx's not_modified filter, in its order): 304 when an
-- If-Modified-Since is Node's Last-Modified (if_modified_since exact) and an
-- If-None-Match lists Node's ETag, whichever of the two were sent. nginx sends a 304 without passing the body
-- through body_filter, so proxy_store keeps it (fill.store).
local function answer_not_modified(fill)
    local inm = ngx.var.http_if_none_match
    local ims = ngx.var.http_if_modified_since
    local etag = fill.meta.e

    if not inm and not ims then
        return false
    end

    if ims and not (fill.meta.l and ngx.parse_http_time(ims) == fill.meta.l) then
        return false
    end

    if inm and not (etag and etag_listed(inm, etag)) then
        return false
    end

    ngx.status = 304
    -- Node's, not the one the brotli filter weakened for the 200
    ngx.header["ETag"] = etag
    fill.not_modified = true
    ngx.header["Content-Length"] = nil
    ngx.header["Content-Type"] = nil
    ngx.header["Accept-Ranges"] = nil
    fill.first, fill.last = 1, 0
    return true
end

-- Answer the client's Range from a whole 200 from Node, as proxy_cache did
-- on a miss: 206 with the range (body_filter cuts it from the stream) or 416.
-- Like proxy_cache, only when Node offers ranges (Accept-Ranges), with a
-- known length, and if If-Range, when sent, still matches.
local function answer_range(fill)
    if not fill.range or not fill.length or ngx.header["Accept-Ranges"] ~= "bytes" then
        return
    end

    if fill.if_range and fill.if_range ~= ngx.header["ETag"] and fill.if_range ~= ngx.header["Last-Modified"] then
        return
    end

    local first, last = byte_range(fill.range, fill.length)

    if first == nil then
        return
    end

    if first == false then
        ngx.status = 416
        ngx.header["Content-Range"] = "bytes */" .. fill.length
        ngx.header["Content-Length"] = 0
        fill.first, fill.last = 1, 0
        return
    end

    ngx.status = 206
    ngx.header["Content-Range"] = "bytes " .. first .. "-" .. last .. "/" .. fill.length
    ngx.header["Content-Length"] = last - first + 1
    fill.first, fill.last = first, last
end

-- header_filter_by_lua: decide whether the response from Node is stored
function diskcache.header_filter(self)
    local fill = ngx.ctx.diskcache

    if not fill then
        return
    end

    -- add_header in reverse-proxy-base.conf leaves Blot-Cache out, since
    -- $upstream_cache_status is empty without proxy_cache
    ngx.header["Blot-Cache"] = "MISS"

    if fill.skip then
        return
    end

    local status = ngx.status

    -- ngx.var.upstream_status is unset when nginx answered itself (an
    -- intercepted error page)
    -- X-Accel-Buffering: no (helper/sse.js) is a stream: proxy_cache never
    -- stored one, since it needs buffering. nginx consumes the header, so
    -- it is read from the upstream's.
    if not CACHEABLE[status] or ngx.var.upstream_status == nil
        or ngx.var.upstream_http_x_accel_buffering == "no"
    then
        fill.skip = true
        return self:release()
    end

    local headers = {}

    for name, value in pairs(ngx.resp.get_headers(100, true)) do
        if not SKIP_HEADERS[name:lower()] then
            if type(value) == "table" then
                for _, v in ipairs(value) do
                    table.insert(headers, { name, v })
                end
            else
                table.insert(headers, { name, value })
            end
        end
    end

    local directory = self.directory .. "/" .. fill.dir

    fill.id = random_id()
    fill.tmp = directory .. "/.tmp/" .. fill.key .. "." .. fill.id
    fill.length = tonumber(ngx.header["Content-Length"])
    fill.type = (ngx.header["Content-Type"] or ""):match("^[^;%s]+")
    fill.meta = {
        s = status,
        h = headers,
        -- Node's: ngx.header's is weak once the brotli filter has run
        e = ngx.var.upstream_http_etag,
        l = ngx.parse_http_time(ngx.header["Last-Modified"] or ""),
        id = fill.id,
        k = ngx.var.cache_key,
        t = fill.started,
    }

    local file = io.open(fill.tmp, "wb")

    if not file then
        mkdir_p(directory .. "/.tmp")
        file = io.open(fill.tmp, "wb")
    end

    if not file then
        ngx.log(ngx.ERR, "diskcache: cannot write ", fill.tmp)
        fill.skip = true
        return self:release()
    end

    fill.file = file
    fill.size = 0

    if ngx.var.diskcache_conditional == "1" then
        -- proxy_store's copy of the body (reverse-proxy-fill.conf)
        fill.store = fill.tmp .. ".store"
        ngx.var.diskcache_store = fill.store
    end

    -- the conditional first, as nginx's filters run (RFC 9110 13.2.2)
    if status == 200 and not answer_not_modified(fill) then
        answer_range(fill)
    end

    if fill.length and fill.length > LOCK_MAX_BYTES then
        self:release()
    end
end

-- body_filter_by_lua: stream the body into the temporary file, whatever its
-- size. Writes go to the page cache, so they do not wait on the disk.
function diskcache.body_filter(self)
    local fill = ngx.ctx.diskcache

    if not fill or fill.skip then
        return
    end

    local chunk, eof = ngx.arg[1], ngx.arg[2]

    if chunk and #chunk > 0 then
        local offset = fill.size
        fill.size = fill.size + #chunk

        -- a range request gets only its bytes; the file gets them all
        if fill.first then
            local from = math.max(fill.first - offset, 0) + 1
            local to = math.min(fill.last - offset + 1, #chunk)
            ngx.arg[1] = from <= to and chunk:sub(from, to) or ""
        end

        if not fill.failed and not fill.file:write(chunk) then
            fill.failed = true
            os.remove(fill.tmp)
        end

        if fill.size > LOCK_MAX_BYTES then
            self:release()
        end
    end

    if eof then
        fill.complete = true
    end
end

-- log_by_lua: publish a complete fill and release the lock
function diskcache.log(self)
    local fill = ngx.ctx.diskcache

    -- published or not, requests waiting on the lock then go ahead: they
    -- find the entry or fetch it themselves
    self:release()

    if not fill or fill.skip or not fill.file then
        return
    end

    -- writes are buffered: the last of them can fail only here
    if not fill.file:close() and not fill.not_modified then
        fill.failed = true
    end
    fill.file = nil

    if fill.not_modified then
        -- proxy_store wrote the body, and only if it was whole: a 200 of the
        -- length Node announced
        os.remove(fill.tmp)
        fill.tmp = fill.store
        fill.size = file_size(fill.tmp)
        fill.complete = fill.size ~= nil
    elseif fill.store then
        os.remove(fill.store)
    end

    local directory = self.directory .. "/" .. fill.dir
    local body = directory .. "/" .. fill.key .. "." .. fill.id
    local meta_path = directory .. "/" .. fill.key .. ".meta"

    -- a response cut short (Node or the client went away) is not stored
    local truncated = not fill.complete or fill.failed
        or (fill.length and fill.length ~= fill.size)
        -- the last upstream tried, after a retry ("502, 200")
        or (ngx.var.upstream_status or ""):match("(%d+)$") ~= tostring(fill.meta.s)

    if truncated then
        os.remove(fill.tmp)
        return
    end

    -- the entry this fill replaces, if another instance filled the key too
    local previous = read_meta(meta_path)

    -- c: compress after the first hit (diskcache:access)
    if fill.size >= MIN_COMPRESS and COMPRESSIBLE[fill.type] then
        fill.meta.c = true
    end

    local tmp_meta = fill.tmp .. ".meta"

    if fill.meta.l then
        set_mtime(fill.tmp, fill.meta.l)
    end

    -- the body first, then the metadata that points at it
    if not os.rename(fill.tmp, body)
        or not write_file(tmp_meta, cjson.encode(fill.meta))
        or not os.rename(tmp_meta, meta_path)
    then
        os.remove(fill.tmp)
        os.remove(tmp_meta)
        os.remove(body)
        return
    end

    if purged_at(self, fill.marker) >= fill.started then
        os.remove(meta_path)
        os.remove(body)
        return
    end

    if previous and previous.id and previous.id ~= fill.id then
        local old = directory .. "/" .. fill.key .. "." .. previous.id
        os.remove(old)
        os.remove(old .. ".br")
    end
end

-- Make the brotli copy of an entry's body, then mark the entry done. job is
-- the entry's path under the cache directory without .meta:
-- <a>/<bc>/<host>/<key>. Called by worker 0's compressor.
local function compress(self, job)
    local base = self.directory .. "/" .. job
    local meta = read_meta(base .. ".meta")

    -- purged, evicted, or done already
    if not meta or not meta.c then
        return
    end

    local body = base .. "." .. meta.id
    -- its own name: another instance sharing the cache can compress the same
    -- entry at the same time, and brotli -f truncates an existing output
    local tmp = base:match("^(.*)/") .. "/.tmp/" .. job:match("[^/]+$") .. "." .. meta.id .. "." .. random_id() .. ".br"

    -- niced, so serving wins when the CPU is busy. Level 11 costs ~40 times
    -- level 9's CPU for pages 10-13% smaller, paid once per entry that is
    -- read at least twice, against every hit's egress. Above 1 MB it would
    -- hold up the queue for seconds (~2s for 2 MB), so level 9.
    local size = file_size(body)

    -- no body: refilled or evicted since the metadata was read
    if not size then
        return
    end

    local level = size > 1024 * 1024 and "9" or "11"
    local proc = ngx_pipe.spawn({ "nice", "-n", "10", "brotli", "-q", level, "-f", "-o", tmp, body })

    if not proc then
        return
    end

    proc:set_timeouts(nil, nil, nil, 300000)

    local done = proc:wait()

    -- brotli_static sends the copy's mtime as Last-Modified
    if done and meta.l then
        set_mtime(tmp, meta.l)
    end

    if not done or not os.rename(tmp, body .. ".br") then
        proc:kill(9)
        os.remove(tmp)
        -- the body can go mid-compression (a refill): not an error
        if file_size(body) then
            ngx.log(ngx.ERR, "diskcache: could not compress ", body)
        end
        return
    end

    -- a purge after the metadata was read moved the host directory away;
    -- the rename above may have landed in a new one
    if purged_at(self, job:match("^(.*)/") .. ".purged") >= meta.t then
        os.remove(body .. ".br")
        return
    end

    -- Mark it done if the metadata still names the same fill. A refill
    -- landing between the read and the rename loses its metadata, which is a
    -- miss, not a stale page.
    local current = read_meta(base .. ".meta")

    if not current or current.id ~= meta.id then
        return
    end

    current.c = nil
    -- b: there is a brotli copy, whose ETag is weak (diskcache:access)
    current.b = true

    local tmp_meta = tmp .. ".meta"

    if not write_file(tmp_meta, cjson.encode(current)) or not os.rename(tmp_meta, base .. ".meta") then
        os.remove(tmp_meta)
    end
end

-- Worker 0's compressor: takes entries off the queue until the worker exits.
-- The queue is a shared dict, so it survives a reload and the new worker 0
-- carries on with it. A restart loses it; the next hit queues an entry again.
local function compressor(premature, self)
    if premature then
        return
    end

    local queue = ngx.shared[self.queue]

    while not ngx.worker.exiting() do
        local job = queue:lpop("jobs")

        if job then
            local ok, err = pcall(compress, self, job)

            if not ok then
                ngx.log(ngx.ERR, "diskcache: compressing ", job, ": ", err)
            end

            queue:delete("queued:" .. job)
        else
            ngx.sleep(0.25)
        end
    end
end

-- Empty .trash in the background, one removal at a time per instance. A
-- directory purged during a removal waits for the next purge or sweep.
local function empty_trash(premature, self, trash)
    if premature or not ngx.shared[self.queue]:add("emptying", true, 3600) then
        return
    end

    local proc = ngx_pipe.spawn({ "find", trash, "-mindepth", "1", "-maxdepth", "1", "-exec", "rm", "-rf", "{}", "+" })

    if proc then
        proc:set_timeouts(nil, nil, nil, 3600000)
        proc:wait()
    end

    ngx.shared[self.queue]:delete("emptying")
end

-- The /purge endpoint, ?host=a&host=b. Every instance sharing the cache sees
-- the purge at once, so it only needs to reach one of them.
function diskcache.purge(self)
    local args = ngx.var.args

    if not args then
        ngx.say("please pass host to purge as an argument")
        return ngx.exit(ngx.OK)
    end

    local message = {}
    local failed = false
    local trash = self.directory .. "/.trash"

    for host in args:gmatch("host=([^&]+)") do
        local dir, marker = host_path(host)

        -- ngx.now() is cached for the event loop pass; a stamp earlier than
        -- the purge could let a fill that started before it through
        ngx.update_time()
        local stamp = string.format("%.3f", ngx.now())

        -- the marker first, so a fill that publishes after the rename below
        -- finds it. The shard directory may not exist yet, with a fill of
        -- this host in flight that must still find the marker.
        mkdir_p(self.directory .. "/" .. marker:match("^(.*)/"))

        local tmp_marker = self.directory .. "/" .. marker .. "." .. random_id()
        local ok = write_file(tmp_marker, stamp)
            and os.rename(tmp_marker, self.directory .. "/" .. marker)

        if not ok then
            os.remove(tmp_marker)
            ngx.log(ngx.ERR, "diskcache: could not write the purge marker for ", host)
            table.insert(message, host .. ": failed")
            -- not ok, so flushCache.js keeps the purge and retries it
            failed = true
        else
            local target = trash .. "/" .. host_name(host) .. "." .. random_id()
            local moved = os.rename(self.directory .. "/" .. dir, target)

            if not moved then
                mkdir_p(trash)
                moved = os.rename(self.directory .. "/" .. dir, target)
            end

            table.insert(message, host .. ": " .. (moved and "purged" or "0"))
        end
    end

    ngx.timer.at(0, empty_trash, self, trash)

    if failed then
        ngx.status = ngx.HTTP_INTERNAL_SERVER_ERROR
    end

    if #message == 0 then
        ngx.say("no hosts were purged")
    else
        ngx.say(table.concat(message, "\n"))
    end

    return ngx.exit(ngx.OK)
end

-- Called from init_worker_by_lua. Worker 0 runs the compressor and, every
-- options.interval seconds, the sweeper (proxy/evict.sh). Each container
-- sharing the cache runs one sweeper; the script's flock lets one sweep at a
-- time, so a sweep that outlasts an interval is left to finish.
function diskcache.start(self, options)
    if ngx.worker.id() ~= 0 then
        return
    end

    ngx.timer.at(0, compressor, self)

    local command = {
        options.sweeper,
        self.directory,
        tostring(options.max_bytes),
        tostring(options.max_filesystem_percent),
    }

    local function sweep(premature)
        if premature then
            return
        end

        local proc, err = ngx_pipe.spawn(command)

        if not proc then
            ngx.log(ngx.ERR, "diskcache: could not start the sweeper: ", err)
            return
        end

        local timeout = options.interval * 1000
        proc:set_timeouts(nil, timeout, timeout, timeout)

        local output, read_err = proc:stdout_read_all()

        if not output then
            ngx.log(ngx.ERR, "diskcache: reading the sweeper failed: ", read_err)
            return
        end

        local ok, reason, status = proc:wait()

        if ok then
            ngx.log(ngx.NOTICE, "diskcache: ", output)
        else
            local stderr = proc:stderr_read_all() or ""
            ngx.log(ngx.ERR, "diskcache: sweeper ", tostring(reason), " ", tostring(status), ": ", output, stderr:sub(1, 500))
        end
    end

    ngx.timer.every(options.interval, sweep)
end

return diskcache
