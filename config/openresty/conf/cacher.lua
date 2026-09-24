local cacher = {
    _VERSION     = "cacher.lua 1.0.0",
    _DESCRIPTION = "Purgable cache for OpenResty",
    _URL         = "",
    _LICENSE     = ""
  }

-- The host -> cache file index lives in shared_dictionary and is rebuilt from
-- the cache directory in the background after a start (see cacher_start), so
-- nginx listens and serves cached files straight away. /purge and /inspect
-- answer 503 until the index is complete: flushCache records a failed purge
-- and retries it. The index survives `nginx -s reload` (shared dicts do), so
-- a reload does not walk the cache again.
--
-- Readiness is two numbers. GENERATION is taken (incremented) whenever the
-- index stops being trustworthy: when a walk starts, and when a cache file
-- could not be added. A walk that completes stores the generation it took in
-- READY. The index is ready while READY equals GENERATION, so a single incr
-- makes it not ready, and a walk that was superseded cannot publish.
--
-- These share the dictionary with the index so that they disappear with it
-- (a restart, or a reload that resizes the zone). Host names never start with
-- "__", so they cannot collide.
local GENERATION = "__cacher_generation"
local READY = "__cacher_ready"

-- The walk lock: one walk at a time, to avoid duplicate work (correctness
-- comes from the generation). It holds a token naming its owner and is
-- renewed as the walk goes, so it only expires if the worker holding it dies
-- or stalls for longer than this (find output is read with a 60s timeout).
local BUILDING = "__cacher_building"
local BUILDING_TTL = 120

-- Hand control back to the event loop this often during a walk
local YIELD_EVERY = 200

local function is_flag(key)
    return key:sub(1, 2) == "__"
end

-- The current generation if the index is ready, else nil. GENERATION is read
-- first: a caller that sees the same generation again after its work knows
-- no walk started and no cache file went unindexed in between.
local function ready_generation(shared_dictionary)
    local generation = shared_dictionary:get(GENERATION)

    if generation ~= nil and shared_dictionary:get(READY) == generation then
        return generation
    end
end

local function cacher_is_ready(self)
    return ready_generation(self.shared_dictionary) ~= nil
end

-- Add a cache file to a host's list. rpush fails (it does not evict) when the
-- dictionary is full, and the index is then missing a file that a purge of
-- that host would leave behind, so it stops being ready until a walk rebuilds it.
local function index_push(shared_dictionary, host, hash)
    local ok, err = shared_dictionary:rpush(host, hash)

    if not ok then
        shared_dictionary:incr(GENERATION, 1, 0)
        ngx.log(ngx.ERR, "cacher: could not add to index (", err,
            "), rebuilding; increase lua_shared_dict cacher_dictionary if this repeats")
    end

    return ok, err
end

local function respond_rebuilding(ngx)
    ngx.status = ngx.HTTP_SERVICE_UNAVAILABLE
    ngx.header["Retry-After"] = "30"
    ngx.say("cache index is being rebuilt, retry later")
    ngx.exit(ngx.OK)
end

-- Answer 503 unless the index is ready; returns its generation
local function require_ready(self, ngx)
    local generation = ready_generation(self.shared_dictionary)

    if generation == nil then
        respond_rebuilding(ngx)
    end

    return generation
end

-- Answer 503 if the index changed since require_ready: the lists read may
-- have been cleared by a walk, or be missing a file that could not be added.
local function require_unchanged(self, ngx, generation)
    if self.shared_dictionary:get(GENERATION) ~= generation then
        respond_rebuilding(ngx)
    end
end

local function cacher_add (self, host, cache_key) 
    local shared_dictionary = self.shared_dictionary
    local cache_key_hash = ngx.md5(cache_key)
    ngx.log(ngx.NOTICE, "add hash=" .. cache_key_hash .. " host=" .. host .. " key=" .. cache_key)
    index_push(shared_dictionary, host, cache_key_hash)
end  

local function cacher_inspect (self, ngx)
    local cache_directory = self.cache_directory
    local shared_dictionary = self.shared_dictionary

    if (cache_directory == nil) then
        ngx.say("please set cache_directory")
        ngx.exit(ngx.OK)
    end

    if (shared_dictionary == nil) then
        ngx.say("please set shared_dictionary")
        ngx.exit(ngx.OK)
    end

    -- the host is passed in ?host=example.com
    local host = ngx.var.arg_host

    if (host == nil) then
        ngx.say("please pass host to inspect as an argument")
        ngx.exit(ngx.OK)
    end

    local generation = require_ready(self, ngx)

    ngx.log(ngx.NOTICE, "inspecting host: " .. host)

    local hash_list = {};
    local total_keys = shared_dictionary:llen(host)

    ngx.log(ngx.NOTICE, "found cache keys: " .. total_keys)

    local cache_key_hash = shared_dictionary:lpop(host)

    while cache_key_hash do
        table.insert(hash_list, cache_key_hash)
        cache_key_hash = shared_dictionary:lpop(host)
    end

    -- reinstate the keys in the list
    for _, hash in ipairs(hash_list) do
        index_push(shared_dictionary, host, hash)
    end

    require_unchanged(self, ngx, generation)

    -- append the list of cache keys to the message seperated by newlines
    local message = table.concat(hash_list, "\n")

    ngx.say(message)
    ngx.exit(ngx.OK)
end

-- A cache miss recorded while a walk is running can also be found on disk by
-- that walk, so the list for a host can hold the same hash twice.
local function deduplicate_key_list_by_host (host, shared_dict)

    local deduplicated_key_list = {}

    -- we lpop from the list until we get nil
    local cache_key_hash = shared_dict:lpop(host)

    while cache_key_hash do

        if (deduplicated_key_list[cache_key_hash] == nil) then
            table.insert(deduplicated_key_list, cache_key_hash)
            deduplicated_key_list[cache_key_hash] = true
        end

        cache_key_hash = shared_dict:lpop(host)
    end

    -- reinsert the keys into the list
    for _, cache_key_hash in ipairs(deduplicated_key_list) do
        index_push(shared_dict, host, cache_key_hash)
    end
end

-- Returns the host from the cache file's "KEY: http://example.com/xyz/abc"
-- header line, or nil if the file is gone or has no parsable key.
local function extractHostFromCacheFile (cache_file_path)

    local file = io.open(cache_file_path, "r")

    -- purged or evicted since it was listed
    if (file == nil) then
        return nil
    end

    local line = file:read()
    local number_of_lines_read = 1

    -- keep reading the file until we get a line that contains "KEY: ", up to a max of 10 lines
    while (line ~= nil and number_of_lines_read < 10 and string.match(line, "KEY: ") == nil) do
        line = file:read()
        number_of_lines_read = number_of_lines_read + 1
    end

    file:close()

    local key = line and string.match(line, "KEY: (.*)")

    if (key == nil) then
        return nil
    end

    -- the protocol is included in the uri so we need to remove it
    local uri_without_protocol = string.match(key, "://(.*)")

    if (uri_without_protocol == nil) then
        return nil
    end

    -- the host is the first part of the uri, up to question mark or slash or colon if there is one
    return string.match(uri_without_protocol, "([^/?#:]+)")
end

-- Remove every host list, leaving the flags
local function clear_hosts(shared_dictionary)
    for _, key in ipairs(shared_dictionary:get_keys(0)) do
        if not is_flag(key) then
            shared_dictionary:delete(key)
        end
    end
end

-- Renew the walk lock if this walk still owns it. The check and the renewal
-- are separate operations, so at worst two walks overlap after a lease
-- expires; only the one holding the current generation can publish.
local function renew_lock(shared_dictionary, token)
    if shared_dictionary:get(BUILDING) ~= token then
        return false
    end

    shared_dictionary:set(BUILDING, token, BUILDING_TTL)
    return true
end

-- Release the walk lock unless it expired and another walk took it
local function release_lock(shared_dictionary, token)
    if shared_dictionary:get(BUILDING) == token then
        shared_dictionary:delete(BUILDING)
    end
end

-- Rebuilds the index from the files in the cache directory. Returns the
-- sorted list of files whose host could not be parsed, or nil and an error:
-- "busy" if another walk holds the lock, "exiting" if this worker is shutting
-- down (a reload or stop), "superseded" if the index changed during the
-- walk (a newer walk started, or a cache file could not be added), or why
-- the directory could not be listed.
--
-- The host lists are emptied first, which is safe while cache misses keep
-- arriving: a miss recorded before the clear already has its file on disk
-- (log_by_lua runs after nginx has stored it), so the walk finds it again,
-- and one recorded after the clear is added by cacher_add. So a walk can be
-- rerun at any time, e.g. by a worker respawned after one died mid-walk.
local function build_index (self)
    local cache_directory = self.cache_directory
    local shared_dictionary = self.shared_dictionary

    local token = ngx.worker.pid() .. ":" .. ngx.now() .. ":" .. math.random()

    if not shared_dictionary:add(BUILDING, token, BUILDING_TTL) then
        return nil, "busy"
    end

    local started = ngx.now()

    -- stop the walk, releasing the lock, and return why
    local function abandon (proc, err)
        if proc then
            proc:kill(9)
        end
        release_lock(shared_dictionary, token)
        return nil, err
    end

    -- Taking a generation makes the index not ready before any list is
    -- cleared (see ready_generation). incr only needs memory the first time,
    -- when the index has never been ready, so clearing first is then safe.
    local generation = shared_dictionary:incr(GENERATION, 1, 0)

    if not generation then
        clear_hosts(shared_dictionary)
        generation = shared_dictionary:incr(GENERATION, 1, 0)

        if not generation then
            return abandon(nil, "could not start a walk: cacher_dictionary is full")
        end
    end

    clear_hosts(shared_dictionary)

    ngx.log(ngx.NOTICE, "rehydrate: " .. cache_directory)

    -- One child process lists the whole tree. ngx.pipe reads it without
    -- blocking the worker, which keeps serving requests during the walk.
    local proc, err = require("ngx.pipe").spawn({"find", cache_directory, "-type", "f"})

    if not proc then
        return abandon(nil, "find failed: " .. tostring(err))
    end

    -- a cold disk can take a while to list a large tree
    proc:set_timeouts(nil, 60000, 60000, 60000)

    local prefix_length = #cache_directory + 2
    local hosts = {}
    local unparsed = {}
    local count = 0

    while true do
        local path, read_err = proc:stdout_read_line()

        if not path then
            if read_err ~= "closed" then
                return abandon(proc, "reading find output failed: " .. tostring(read_err))
            end
            break
        end

        local name = path:match("[^/]+$")

        -- with use_temp_path=off, a response being written sits in the same
        -- tree as <hash>.<number> until nginx renames it; cacher_add records
        -- it once it is stored
        if not name:match("^%x+%.%d+$") then
            local host = extractHostFromCacheFile(path)

            if (host == nil) then
                table.insert(unparsed, path:sub(prefix_length))
            else
                if (hosts[host] == nil) then
                    table.insert(hosts, host)
                    hosts[host] = true
                end

                if not index_push(shared_dictionary, host, name) then
                    return abandon(proc, "could not add to index, increase lua_shared_dict cacher_dictionary")
                end
            end
        end

        count = count + 1

        if count % YIELD_EVERY == 0 then
            -- the next process (a reload, or a respawned worker) rebuilds
            if ngx.worker.exiting() then
                return abandon(proc, "exiting")
            end

            if shared_dictionary:get(GENERATION) ~= generation then
                return abandon(proc, "superseded")
            end

            if not renew_lock(shared_dictionary, token) then
                return abandon(proc, "walk lock expired")
            end

            ngx.sleep(0)
        end
    end

    local stderr = proc:stderr_read_all() or ""
    local ok, reason, status = proc:wait()

    -- e.g. a directory the worker cannot read: an index missing those files
    -- must not be marked ready, or purges would succeed without removing them
    if not ok then
        return abandon(nil, "find " .. tostring(reason) .. " " .. tostring(status) .. ": " .. stderr:sub(1, 500))
    end

    for _, host in ipairs(hosts) do
        deduplicate_key_list_by_host(host, shared_dictionary)
    end

    -- Publish. If the generation moved on (a newer walk, or a cache miss that
    -- could not be added) this READY no longer matches it, so it has no effect.
    shared_dictionary:set(READY, generation)
    release_lock(shared_dictionary, token)

    if shared_dictionary:get(GENERATION) ~= generation then
        return nil, "superseded"
    end

    ngx.log(ngx.NOTICE, "rehydrate: complete files=", count, " hosts=", #hosts,
        " unparsed=", #unparsed, " seconds=", ngx.now() - started)

    table.sort(unparsed)

    return unparsed
end

-- Called from init_worker_by_lua. Worker 0 rebuilds the index unless it is
-- already complete (after `nginx -s reload`), then checks it periodically so
-- a failed walk is retried.
local function cacher_start (self)
    local id = ngx.worker.id()

    if id ~= nil and id ~= 0 then
        return
    end

    local function check (premature)
        if premature or cacher_is_ready(self) then
            return
        end

        local unparsed, err = build_index(self)

        if not unparsed and err ~= "busy" and err ~= "exiting" then
            ngx.log(ngx.ERR, "rehydrate: ", err)
        end
    end

    ngx.timer.at(0, check)
    ngx.timer.every(30, check)
end

-- The /rehydrate endpoint. Returns "OK" or the files whose host could not be
-- parsed, one per line.
local function cacher_rehydrate (self)
    local unparsed, err = build_index(self)

    if unparsed == nil then
        if err == "busy" then
            ngx.status = ngx.HTTP_SERVICE_UNAVAILABLE
            ngx.header["Retry-After"] = "30"
            return "cache index is being rebuilt, retry later"
        end

        -- the host lists may be partial: purges wait for cacher_start's
        -- periodic check to rebuild them
        ngx.status = ngx.HTTP_INTERNAL_SERVER_ERROR
        return "rehydrate failed: " .. err
    end

    if #unparsed == 0 then
        return "OK"
    end

    return table.concat(unparsed, "\n")
end

local function cacher_purge (self, ngx)

    local cache_directory = self.cache_directory
    local shared_dictionary = self.shared_dictionary

    local message = ''

    if (cache_directory == nil) then
        ngx.say("please set cache_directory")
        ngx.exit(ngx.OK)
    end

    if (shared_dictionary == nil) then
        ngx.say("please set shared_dictionary")
        ngx.exit(ngx.OK)
    end

    -- prevent an error if the args are nil
    if (ngx.var.args == nil) then
        ngx.say("please pass host to purge as an argument")
        ngx.exit(ngx.OK)
    end

    local generation = require_ready(self, ngx)

    for host in string.gmatch(ngx.var.args, "host=([^&]+)") do
        ngx.log(ngx.NOTICE, "purging host: " .. host)
        local total_keys = purge_host(host, shared_dictionary, cache_directory)
        message = message .. host .. ": " .. total_keys .. "\n"
    end

    -- A walk that started while this purge ran may have cleared the lists
    -- before they were read, and will add back files this purge did not see;
    -- the caller retries after the rebuild.
    require_unchanged(self, ngx, generation)

    -- if message is empty then replace it with a message saying that no hosts were purged
    if (message == '') then
        message = "no hosts were purged"
    end
    
    ngx.say(message)
    ngx.exit(ngx.OK)
end

function purge_host (host, shared_dictionary, cache_directory)
    local total_keys = shared_dictionary:llen(host)
    local cache_key_hash = shared_dictionary:lpop(host)
    while cache_key_hash do
        -- the cache file path is in the following format: $x/$y/$cache_key_hash
        -- where x is the last character of the cache_key_hash
        -- and y are the two characters before x
        local x = cache_key_hash:sub(-1)
        local y = cache_key_hash:sub(-3,-2)
        local cached_file_path = cache_directory .. "/" .. x .. "/" .. y .. "/" .. cache_key_hash
        local f = io.open(cached_file_path, "r")
        
        if f ~= nil then
            io.close(f) 
            os.remove(cached_file_path)
        end

        cache_key_hash = shared_dictionary:lpop(host)            
    end

    return total_keys
end

function purge_lru_hosts (self) 
    -- returns all the keys in the dictionary, the least recently used at the very end of the list
    local hosts = self.shared_dictionary:get_keys(0)
    local maximum_hosts_to_purge = 500

    -- we want to create a list of hosts that we can purge from the end of the list of hosts
    local number_of_hosts_purged = 0

    -- we want to purge the least recently used hosts first
    for i = #hosts, 1, -1 do
        local host = hosts[i]
        if not is_flag(host) then
            purge_host(host, self.shared_dictionary, self.cache_directory)
            number_of_hosts_purged = number_of_hosts_purged + 1
            if (number_of_hosts_purged >= maximum_hosts_to_purge) then
                break
            end
        end
    end    
end

function cacher_check_free_space (self, ngx) 
    local minimum_free_space = self.minimum_free_space

    -- until the index is complete, evicting by it could miss files and a
    -- running walk would add back the hosts it removed
    if not cacher_is_ready(self) then
        return
    end

    -- if minimum_free_space is not nil then we need to check if we need to purge the lru hosts
    if (minimum_free_space ~= nil) then
        local free_space = self.shared_dictionary:free_space()
        
        if (free_space < minimum_free_space) then
            ngx.log(ngx.NOTICE, "dictionary_free_space=" .. free_space .. " is less than " .. minimum_free_space .. ", purging lru hosts")
            purge_lru_hosts(self)
            ngx.log(ngx.NOTICE, "purge of lru hosts complete")
        else
            ngx.log(ngx.NOTICE, "dictionary_free_space=" .. free_space .. " is greater than " .. minimum_free_space .. ", no need to purge lru hosts")
        end
    end
end

function cacher_monitor_free_space (self, ngx, monitor_interval)
    
    if (monitor_interval == nil) then
        monitor_interval = 60
    end

    ngx.timer.every(monitor_interval, function (premature)
        if premature then
            return
        end

        -- if both cache_directory and shared_dictionary are set then we can rehydrate
        if (self.shared_dictionary ~= nil) then
            local free_space = self.shared_dictionary:free_space()
            
            local capacity = self.shared_dictionary:capacity()

            -- calculate the memory usage in megabytes, rounded down
            local usage = math.floor((capacity - free_space) / 1024 / 1024)
            local free_space_mb = math.floor(free_space / 1024 / 1024)
            
            -- retrieve the disk usage of the cache directory
            local cache_directory = self.cache_directory
            local handle = io.popen("du -sh " .. cache_directory)
            local output = handle:read('*a')

            if (output == nil) then
                output = "n/a"
            else 
                output = string.match(output, "([^\t]+)")
            end

            handle:close()
            ngx.log(ngx.NOTICE, "dictionary_usage=" .. usage .. "M disk_usage=" .. output .. " dictionary_free_space=" .. free_space_mb .. "M")
            
            cacher_check_free_space(self, ngx)
        end
    end, self)
end

-- Compare two strings without returning early on the first differing byte
local function constant_time_equal(a, b)
    if type(a) ~= "string" or type(b) ~= "string" or #a ~= #b then
        return false
    end

    local diff = 0

    for i = 1, #a do
        diff = bit.bor(diff, bit.bxor(a:byte(i), b:byte(i)))
    end

    return diff == 0
end

-- Whether the request may use the internal purge / inspect / rehydrate
-- endpoints. If the BLOT_PURGE_TOKEN environment variable is set (nginx must
-- pass it through with `env BLOT_PURGE_TOKEN;`) the request must send the same
-- value in X-Blot-Purge-Token. If it is unset, everything is allowed.
local function cacher_authorized (self, ngx)
    local token = os.getenv("BLOT_PURGE_TOKEN")

    if token == nil or token == "" then
        return true
    end

    return constant_time_equal(ngx.var.http_x_blot_purge_token, token)
end

--- Create a new cacher instance.
function cacher.new()
    
    local function cacher_set(self, key, value)
        self[key] = value
    end

    return {
        purge = cacher_purge,
        authorized = cacher_authorized,
        set = cacher_set,
        start = cacher_start,
        add = cacher_add,
        inspect = cacher_inspect,
        rehydrate = cacher_rehydrate,
        monitor_free_space = cacher_monitor_free_space,
        check_free_space = cacher_check_free_space
    }
end

return cacher