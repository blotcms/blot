local cacher = {
    _VERSION     = "cacher.lua 1.0.0",
    _DESCRIPTION = "Purgable cache for OpenResty",
    _URL         = "",
    _LICENSE     = ""
  }

local ffi = require("ffi")

ffi.cdef[[
  typedef struct DIR DIR;
  DIR *opendir(const char *name);
  struct dirent *readdir(DIR *dirp);
  int closedir(DIR *dirp);
  typedef unsigned int uid_t;
  typedef unsigned int gid_t;
  struct passwd {
    char *pw_name;
    char *pw_passwd;
    uid_t pw_uid;
    gid_t pw_gid;
    char *pw_gecos;
    char *pw_dir;
    char *pw_shell;
  };
  struct passwd *getpwnam(const char *name);
  int chown(const char *pathname, uid_t owner, gid_t group);
  int mkdir(const char *pathname, int mode);
  int chmod(const char *pathname, int mode);
  int open(const char *pathname, int flags);
  int fsync(int fd);
  int close(int fd);
  int kill(int pid, int sig);
]]

-- readdir's struct dirent is not the same shape on every OS. A Linux layout
-- on macOS reads d_namlen as d_type/d_name, so a cold walk can index nothing
-- and then report a purge of an empty host while the files are still there.
local DIRENT_KNOWN = true

if jit.os == "Linux" then
    -- glibc and musl, x86_64 and aarch64: d_name begins at byte 19.
    ffi.cdef[[
      struct dirent {
        uint64_t d_ino;
        int64_t d_off;
        uint16_t d_reclen;
        uint8_t d_type;
        char d_name[256];
      };
    ]]
elseif jit.os == "OSX" then
    -- 64-bit ino_t dirent from bsd/sys/dirent.h. d_name begins at byte 21.
    ffi.cdef[[
      struct dirent {
        uint64_t d_ino;
        uint64_t d_seekoff;
        uint16_t d_reclen;
        uint16_t d_namlen;
        uint8_t d_type;
        char d_name[1024];
      };
    ]]
else
    DIRENT_KNOWN = false
end

local O_RDONLY = 0
local O_DIRECTORY = 65536
local EEXIST = 17
local EPERM = 1
-- 0755 for parents that are missing. The index directory itself is tightened
-- to 0700 after creation so another local user cannot plant a snapshot.
local DIR_MODE = 493
local INDEX_MODE = 448
local DT_DIR = 4
local DT_REG = 8
local DT_UNKNOWN = 0
-- Yield the worker this often while reading a large cache, so it can
-- keep serving. yield_delay (seconds) is an optional extra pause used
-- by tests to widen the "not ready" window.
local YIELD_EVERY = 32
local KEY_PREFIX_BYTES = 16384

local function pid_alive(pid)
    if type(pid) ~= "number" then
        return false
    end

    if ffi.C.kill(pid, 0) == 0 then
        return true
    end

    return ffi.errno() == EPERM
end

local function worker_exiting()
    local ok, exiting = pcall(function()
        return ngx.worker.exiting()
    end)

    return ok and exiting
end

local function mkdir_p(path)
    if type(path) ~= "string" or path:sub(1, 1) ~= "/" then
        return false, "path must be absolute"
    end

    local acc = ""

    for part in string.gmatch(path, "[^/]+") do
        acc = acc .. "/" .. part

        local mode = acc == path and INDEX_MODE or DIR_MODE

        if ffi.C.mkdir(acc, mode) ~= 0 and ffi.errno() ~= EEXIST then
            return false, "mkdir " .. acc .. " failed: " .. ffi.errno()
        end
    end

    return true
end

-- Master creates the directory as root; workers (the nginx user) write the
-- snapshot on shutdown. 0700 owned by that user: root can still read it, and
-- no other account can replace the snapshot with one that omits cache files.
-- chmod/chown by an unprivileged worker returns EPERM and is ignored.
local function secure_index_directory(path, username)
    if ffi.C.chmod(path, INDEX_MODE) ~= 0 and ffi.errno() ~= EPERM then
        return false, "chmod " .. path .. " failed: " .. ffi.errno()
    end

    if type(username) ~= "string" or username == "" then
        return true
    end

    local pwd = ffi.C.getpwnam(username)

    if pwd == nil then
        return false, "unknown worker user " .. username
    end

    if ffi.C.chown(path, pwd.pw_uid, pwd.pw_gid) ~= 0 and ffi.errno() ~= EPERM then
        return false, "chown " .. path .. " failed: " .. ffi.errno()
    end

    return true
end

local function fsync_path(path, flags)
    local fd = ffi.C.open(path, flags)

    if fd < 0 then
        return false
    end

    local rc = ffi.C.fsync(fd)
    ffi.C.close(fd)
    return rc == 0
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

local function file_size(path)
    local file = io.open(path, "rb")

    if not file then
        return nil
    end

    local size = file:seek("end")
    file:close()
    return size
end

local function random_hex(nbytes)
    local file = io.open("/dev/urandom", "rb")

    if not file then
        return string.format("%x%x", os.time(), math.random(0, 1e9))
    end

    local data = file:read(nbytes)
    file:close()

    if not data or #data ~= nbytes then
        return string.format("%x%x", os.time(), math.random(0, 1e9))
    end

    return (data:gsub(".", function(char)
        return string.format("%02x", string.byte(char))
    end))
end

-- Sibling of the cache directory, never inside it. nginx's cache manager
-- deletes files under proxy_cache_path that are not cache entries.
-- Bare metal: /var/instance-ssd/cache -> /var/instance-ssd/cacher-index.
-- Container: /var/cache/openresty -> /var/cache/cacher-index, which
-- proxy/deploy bind-mounts from that same sibling so a replaced container
-- still sees a snapshot the previous process published.
local function index_directory(cache_directory)
    local parent = cache_directory:match("^(.*)/[^/]+/?$")

    if not parent or parent == "" then
        return nil
    end

    return parent .. "/cacher-index"
end

local function index_paths(directory)
    return {
        directory = directory,
        snapshot = directory .. "/snapshot",
        marker = directory .. "/clean",
        generation = directory .. "/generation",
    }
end

local function dict_has_keys(dict)
    local keys = dict:get_keys(1)
    return keys ~= nil and #keys > 0
end

local function cacher_is_ready(self)
    local state = self.state_dictionary
    return state ~= nil and state:get("ready") == "1"
end

-- Reject the purge/inspect instead of deleting from a partial index.
-- flushCache treats any non-2xx as a failed purge and retries it.
-- Headers are sent by ngx.say; exit 200 here finalizes without resetting
-- the 503 status already stored in ngx.status.
local function reject_if_unready(self, ngx)
    if cacher_is_ready(self) then
        return false
    end

    ngx.status = ngx.HTTP_SERVICE_UNAVAILABLE
    ngx.header["Content-Type"] = "text/plain"
    ngx.header["Retry-After"] = "30"
    ngx.say("cache index is not ready")
    return ngx.exit(ngx.OK)
end

local function try_lock(self)
    local state = self.state_dictionary

    if not state then
        return true
    end

    local pid = ngx.worker.pid()

    if state:add("building", pid) then
        return true
    end

    local holder = state:get("building")

    if holder == nil then
        return state:add("building", pid) and true or false
    end

    if pid_alive(holder) then
        return false
    end

    -- delete then add is not a swap. Two contenders can both observe the
    -- dead pid; the second delete removes the pid the first one just stored,
    -- and both walk. One can mark the index ready while the other has popped
    -- a host list for dedupe. building_steal admits only one of them.
    if not state:add("building_steal", pid, 10) then
        return false
    end

    holder = state:get("building")

    if holder ~= nil and pid_alive(holder) then
        state:delete("building_steal")
        return false
    end

    state:delete("building")

    local got = state:add("building", pid)

    state:delete("building_steal")
    return got and true or false
end

local function unlock(self)
    local state = self.state_dictionary

    if state and state:get("building") == ngx.worker.pid() then
        state:delete("building")
    end
end

local function maybe_yield(self, count)
    if count % YIELD_EVERY ~= 0 then
        return
    end

    ngx.sleep(self.yield_delay or 0)
end

local function cacher_add (self, host, cache_key)
    local shared_dictionary = self.shared_dictionary
    local cache_key_hash = ngx.md5(cache_key)
    ngx.log(ngx.NOTICE, "add hash=" .. cache_key_hash .. " host=" .. host .. " key=" .. cache_key)
    shared_dictionary:rpush(host, cache_key_hash)
end

local function cacher_inspect (self, ngx)
    if reject_if_unready(self, ngx) then
        return
    end

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
        shared_dictionary:rpush(host, hash)
    end

    -- append the list of cache keys to the message seperated by newlines
    local message = table.concat(hash_list, "\n")

    ngx.say(message)
    ngx.exit(ngx.OK)
end

-- I'm not sure why we need to deduplicate the keys?--
local function deduplicate_key_list_by_host (host, shared_dict)

    local deduplicated_key_list = {}
    local duplicates = 0

    -- we lpop from the list until we get nil
    local cache_key_hash = shared_dict:lpop(host)

    while cache_key_hash do

        if (deduplicated_key_list[cache_key_hash] == nil) then
            table.insert(deduplicated_key_list, cache_key_hash)
            deduplicated_key_list[cache_key_hash] = true
        else
            duplicates = duplicates + 1
        end

        cache_key_hash = shared_dict:lpop(host)
    end

    -- reinsert the keys into the list
    for _, cache_key_hash in ipairs(deduplicated_key_list) do
        shared_dict:rpush(host, cache_key_hash)
    end

    if duplicates > 0 then
        ngx.log(ngx.NOTICE, "deduplicated ", duplicates, " hashes for ", host)
    end
end

local function extractHostFromCacheFile (cache_file_path)

    -- nginx cache files start with a binary header, then a text line
    -- "KEY: http://host/path". Read only a prefix: the header is a few
    -- hundred bytes, and scanning the whole body made rehydrate O(cache size).
    local file = io.open(cache_file_path, "rb")

    if not file then
        return nil
    end

    local chunk = file:read(KEY_PREFIX_BYTES)
    file:close()

    if not chunk then
        return nil
    end

    local key = string.match(chunk, "KEY: ([^\r\n]*)")

    if (key == nil or key == "") then
        return nil
    end

    -- the protocol is included in the uri so we need to remove it
    local uri_without_protocol = string.match(key, "://(.*)")

    if (uri_without_protocol == nil) then
        return nil
    end

    -- the host is the first part of the uri, up to question mark or slash or colon if there is one
    local host = string.match(uri_without_protocol, "([^/?#:]+)")

    if (host == nil or host == "") then
        return nil
    end

    return host
end

local function remember_host(host_list, host_set, host)
    if host_set[host] == nil then
        host_set[host] = true
        table.insert(host_list, host)
    end
end

local function dedupe_hosts(host_list, shared_dictionary)
    for _, host in ipairs(host_list) do
        if worker_exiting() then
            return false
        end

        deduplicate_key_list_by_host(host, shared_dictionary)
    end

    return true
end

-- Read a directory without forking. Yielding while an io.popen pipe is open
-- makes LuaJIT report a failed find(1), so the startup walk never finishes.
local function list_directory(path)
    if not DIRENT_KNOWN then
        return nil, "unsupported dirent for " .. tostring(jit.os)
    end

    local handle = ffi.C.opendir(path)

    if handle == nil then
        return nil, ffi.errno()
    end

    local entries = {}

    while true do
        ffi.errno(0)
        local ent = ffi.C.readdir(handle)

        if ent == nil then
            local err = ffi.errno()
            ffi.C.closedir(handle)

            if err ~= 0 then
                return nil, err
            end

            return entries
        end

        local name = ffi.string(ent.d_name)

        if name ~= "." and name ~= ".." then
            table.insert(entries, { name = name, type = tonumber(ent.d_type) })
        end
    end
end

-- "ok" indexed the file, "bad" it has no host, "fail" the index cannot be trusted
local function consider_cache_file(self, path, hash, prefix, bad, host_list, host_set)
    local host = extractHostFromCacheFile(path)

    if host == nil or hash == nil then
        table.insert(bad, string.sub(path, prefix))
        return "bad"
    end

    local _, err = self.shared_dictionary:rpush(host, hash)

    if err then
        ngx.log(ngx.ERR, "cacher: rpush failed: ", err)
        return "fail"
    end

    remember_host(host_list, host_set, host)
    return "ok"
end

-- Walk levels=1:2 cache files. Returns message, count, failed.
-- failed means the index must not be marked ready.
local function walk_cache(self, yield)
    -- A failed attempt leaves a prefix of the tree in the dictionary. The
    -- retry walks from the first file again; the copies can fill the
    -- dictionary, and then every retry fails the same way. Disk is the
    -- source of truth for this walk. Misses that arrive after the flush are
    -- pushed as the responses are logged and folded in by the dedupe below.
    if self.shared_dictionary then
        self.shared_dictionary:flush_all()
    end

    local cache_directory = self.cache_directory
    local shared_dictionary = self.shared_dictionary
    local bad = {}
    local host_list = {}
    local host_set = {}
    local count = 0
    local failed = false
    local prefix = #cache_directory + 2

    local function walk_level(directory, depth)
        if failed or (yield and worker_exiting()) then
            failed = true
            return
        end

        local entries, err = list_directory(directory)

        if not entries then
            ngx.log(ngx.ERR, "cacher: opendir ", directory, " failed: ", err)
            failed = true
            return
        end

        for _, entry in ipairs(entries) do
            if failed or (yield and worker_exiting()) then
                failed = true
                return
            end

            local path = directory .. "/" .. entry.name

            if depth < 3 then
                if entry.type == DT_DIR or entry.type == DT_UNKNOWN then
                    walk_level(path, depth + 1)
                end
            elseif entry.type == DT_REG or entry.type == DT_UNKNOWN then
                local result = consider_cache_file(self, path, entry.name, prefix, bad, host_list, host_set)

                if result == "fail" then
                    failed = true
                    return
                end

                if result == "ok" then
                    count = count + 1

                    if count % 10000 == 0 then
                        ngx.log(ngx.NOTICE, "cacher: walked ", count, " cache files")
                    end

                    if yield then
                        maybe_yield(self, count)
                    end
                end
            end
        end
    end

    walk_level(cache_directory, 1)

    if not failed then
        if not dedupe_hosts(host_list, shared_dictionary) then
            failed = true
        end
    end

    table.sort(bad)

    local message = "OK"

    if #bad > 0 then
        message = table.concat(bad, "\n")
    end

    return message, count, failed
end

local function snapshot_is_trusted(marker, snapshot_path)
    local size = marker and string.match(marker, "^(%d+)\n$")

    if not size then
        return false
    end

    if file_size(snapshot_path) ~= tonumber(size) then
        return false
    end

    local file = io.open(snapshot_path, "rb")

    if not file then
        return false
    end

    local header = file:read("*l")
    file:close()
    return header == "v1"
end

local function load_snapshot(self)
    local file = io.open(self._trusted_snapshot, "rb")

    if not file then
        return false, 0
    end

    local header = file:read("*l")

    if header ~= "v1" then
        file:close()
        return false, 0
    end

    local shared_dictionary = self.shared_dictionary
    local host_list = {}
    local host_set = {}
    local count = 0

    while true do
        if worker_exiting() then
            file:close()
            return false, count
        end

        local line = file:read("*l")

        if line == nil then
            break
        end

        if line ~= "" then
            local host, hash = string.match(line, "^([^\t]+)\t([0-9a-fA-F]+)$")

            if not host then
                file:close()
                ngx.log(ngx.ERR, "cacher: corrupt snapshot line")
                return false, count
            end

            local _, err = shared_dictionary:rpush(host, hash)

            if err then
                file:close()
                ngx.log(ngx.ERR, "cacher: snapshot rpush failed: ", err)
                return false, count
            end

            remember_host(host_list, host_set, host)
            count = count + 1
            maybe_yield(self, count)
        end
    end

    file:close()

    if not dedupe_hosts(host_list, shared_dictionary) then
        return false, count
    end

    return true, count
end

local function mark_ready(self, source, count)
    local state = self.state_dictionary
    state:set("managed", "1")
    state:set("ready", "1")
    ngx.log(ngx.NOTICE, "cacher: index ready source=", source, " entries=", count)
end

-- Rebuild the host -> hash index. Content keeps being served; /purge stays
-- 503 until this sets ready, because a partial index cannot purge a host.
local function build_index(self)
    local state = self.state_dictionary

    if cacher_is_ready(self) then
        ngx.log(ngx.NOTICE, "cacher: index already ready, skipping rebuild")
        return true
    end

    if not try_lock(self) then
        ngx.log(ngx.NOTICE, "cacher: index build already in progress")
        return false
    end

    local built = false
    local ok, err = pcall(function()
        local source = "walk"
        local count = 0
        local failed = false

        if self._trusted_snapshot then
            local loaded, n = load_snapshot(self)

            if loaded then
                source = "snapshot"
                count = n
            else
                ngx.log(ngx.WARN, "cacher: snapshot unusable, walking the cache directory")
                self._trusted_snapshot = nil
            end
        end

        if source ~= "snapshot" then
            ngx.log(ngx.NOTICE, "cacher: walking cache directory ", self.cache_directory)
            local message, n, walk_failed = walk_cache(self, true)
            count = n or 0
            failed = walk_failed or message == nil

            if not failed and message ~= "OK" then
                local bad = 1

                for _ in string.gmatch(message, "\n") do
                    bad = bad + 1
                end

                ngx.log(ngx.NOTICE, "cacher: unparsable cache files: ", bad)
            end
        end

        if failed or worker_exiting() then
            return
        end

        mark_ready(self, source, count)
        built = true
    end)

    unlock(self)

    if not ok then
        ngx.log(ngx.ERR, "cacher: index build error: ", err)
        return false
    end

    return built
end

local function write_snapshot(self)
    local paths = self._index_paths

    if not paths then
        return false, "no index directory"
    end

    local ok, err = mkdir_p(paths.directory)

    if not ok then
        return false, err
    end

    local secured, secure_err = secure_index_directory(paths.directory, self.worker_user)

    if not secured then
        return false, secure_err
    end

    local tmp = paths.snapshot .. ".tmp"
    local file = io.open(tmp, "wb")

    if not file then
        return false, "open " .. tmp .. " failed"
    end

    file:write("v1\n")

    local hosts = self.shared_dictionary:get_keys(0)

    for _, host in ipairs(hosts) do
        if string.find(host, "[\t\r\n]") then
            file:close()
            os.remove(tmp)
            return false, "host contains whitespace"
        end

        local hash = self.shared_dictionary:lpop(host)

        while hash do
            if not string.match(hash, "^[0-9a-fA-F]+$") then
                file:close()
                os.remove(tmp)
                return false, "bad hash"
            end

            file:write(host, "\t", hash, "\n")
            hash = self.shared_dictionary:lpop(host)
        end
    end

    file:flush()
    file:close()

    if not fsync_path(tmp, O_RDONLY) then
        os.remove(tmp)
        return false, "fsync snapshot failed"
    end

    if not os.rename(tmp, paths.snapshot) then
        os.remove(tmp)
        return false, "rename snapshot failed"
    end

    local size = file_size(paths.snapshot)

    if not size then
        return false, "stat snapshot failed"
    end

    local marker_tmp = paths.marker .. ".tmp"
    local marker = io.open(marker_tmp, "wb")

    if not marker then
        return false, "open marker failed"
    end

    marker:write(tostring(size), "\n")
    marker:flush()
    marker:close()

    if not fsync_path(marker_tmp, O_RDONLY) then
        os.remove(marker_tmp)
        return false, "fsync marker failed"
    end

    if not os.rename(marker_tmp, paths.marker) then
        os.remove(marker_tmp)
        return false, "rename marker failed"
    end

    fsync_path(paths.directory, bit.bor(O_RDONLY, O_DIRECTORY))
    return true
end

-- Resizing cacher_dictionary on reload throws away its keys and leaves
-- cacher_state in place. ready would still be "1", and /purge would
-- report success while every cache file stayed on disk.
local function dictionary_was_reset(self)
    local state = self.state_dictionary
    local capacity = self.shared_dictionary:capacity()
    local recorded = state:get("dict_capacity")

    if recorded == capacity then
        return false
    end

    local ok, err = state:set("dict_capacity", capacity)

    if not ok then
        ngx.log(ngx.ERR, "cacher: could not record dictionary capacity: ", err)
    end

    -- Nil means this state zone has never recorded a capacity (first start,
    -- or the zone itself is new). A number that no longer matches means
    -- cacher_dictionary was resized and its keys were dropped.
    if recorded == nil then
        return false
    end

    state:delete("ready")
    ngx.log(ngx.NOTICE, "cacher: shared dictionary capacity changed, index will be rebuilt")
    return true
end

local function cacher_prepare(self)
    if not self.cache_directory or not self.state_dictionary or not self.shared_dictionary then
        ngx.log(ngx.ERR, "cacher: prepare missing configuration")
        return
    end

    local directory = index_directory(self.cache_directory)

    if not directory then
        ngx.log(ngx.ERR, "cacher: cache_directory must be absolute")
        return
    end

    local created, mkdir_err = mkdir_p(directory)

    if not created then
        ngx.log(ngx.ERR, "cacher: ", mkdir_err)
    else
        local secured, secure_err = secure_index_directory(directory, self.worker_user)

        if not secured then
            ngx.log(ngx.ERR, "cacher: ", secure_err)
        end
    end

    local paths = index_paths(directory)
    self._index_paths = paths

    -- Captured in the master before workers accept. A later cacher_add must
    -- not be mistaken for an index that survived from the previous process.
    local preexisting = dict_has_keys(self.shared_dictionary)
    local state = self.state_dictionary
    local generation = random_hex(16)

    local gen_tmp = paths.generation .. ".tmp"
    local gen_file = io.open(gen_tmp, "wb")

    if gen_file then
        gen_file:write(generation)
        gen_file:flush()
        gen_file:close()

        if fsync_path(gen_tmp, O_RDONLY) and os.rename(gen_tmp, paths.generation) then
            self._generation = generation
        else
            os.remove(gen_tmp)
            ngx.log(ngx.ERR, "cacher: could not publish generation file")
        end
    else
        ngx.log(ngx.ERR, "cacher: could not write generation file")
    end

    local marker = read_file(paths.marker)

    if snapshot_is_trusted(marker, paths.snapshot) then
        self._trusted_snapshot = paths.snapshot
        ngx.log(ngx.NOTICE, "cacher: clean snapshot found")
    else
        self._trusted_snapshot = nil
    end

    -- Drop the marker immediately. A crash before the next clean shutdown
    -- must not reload a snapshot that missed later cache misses.
    os.remove(paths.marker)

    dictionary_was_reset(self)

    if state:get("ready") == "1" then
        -- Shared dict survived a reload. The in-memory index is still authoritative.
        return
    end

    if preexisting and not state:get("managed") then
        -- First reload after this code is installed. The previous process
        -- refused to listen until rehydrate finished, so its dict is complete.
        state:set("managed", "1")
        state:set("ready", "1")
        ngx.log(ngx.NOTICE, "cacher: trusting pre-existing shared-dict index")
        return
    end

    state:set("managed", "1")
end

local function schedule_build(self, delay)
    local ok, err = ngx.timer.at(delay, function(premature)
        if premature or worker_exiting() then
            return
        end

        local built = build_index(self)

        if not built and not cacher_is_ready(self) and not worker_exiting() then
            schedule_build(self, 1)
        end
    end)

    if not ok then
        ngx.log(ngx.ERR, "cacher: failed to schedule index build: ", err)
    end
end

local function cacher_start_worker(self, ngx)
    if ngx.worker.id() ~= 0 then
        return
    end

    schedule_build(self, 0)
end

local function cacher_on_worker_exit(self, ngx)
    unlock(self)

    local state = self.state_dictionary

    if not state or not self._generation or not self._index_paths then
        return
    end

    if not cacher_is_ready(self) then
        return
    end

    -- The last worker to exit has seen every in-flight cacher_add. On reload
    -- the generation file already belongs to the new master, so the old
    -- workers must not publish a snapshot that the new process will trust.
    local key = "exiting:" .. self._generation
    local n, err = state:incr(key, 1, 0)

    if not n then
        ngx.log(ngx.ERR, "cacher: could not count exiting workers: ", err)
        return
    end

    if n < ngx.worker.count() then
        return
    end

    state:delete(key)

    local current = read_file(self._index_paths.generation)

    if current ~= self._generation then
        ngx.log(ngx.NOTICE, "cacher: reload in progress, not writing snapshot")
        return
    end

    local wrote, write_err = write_snapshot(self)

    if not wrote then
        ngx.log(ngx.ERR, "cacher: snapshot not written: ", write_err)
        return
    end

    ngx.log(ngx.NOTICE, "cacher: snapshot written")
end

local function cacher_rehydrate (self)
    if not try_lock(self) then
        ngx.status = ngx.HTTP_SERVICE_UNAVAILABLE
        return "cache index build already in progress"
    end

    if self.state_dictionary then
        -- dedupe empties each host list mid-flight; don't serve purges against that
        self.state_dictionary:delete("ready")
    end

    -- A retry must read the disk. The snapshot from the previous shutdown
    -- does not include files written since this process started.
    self._trusted_snapshot = nil

    local message, _, failed = walk_cache(self, false)
    unlock(self)

    if failed or message == nil then
        schedule_build(self, 1)
        ngx.status = ngx.HTTP_SERVICE_UNAVAILABLE
        return "cache index rebuild failed"
    end

    if self.state_dictionary then
        self.state_dictionary:set("managed", "1")
        self.state_dictionary:set("ready", "1")
    end

    return message
end

local function cacher_purge (self, ngx)
    if reject_if_unready(self, ngx) then
        return
    end

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

    for host in string.gmatch(ngx.var.args, "host=([^&]+)") do
        ngx.log(ngx.NOTICE, "purging host: " .. host)
        local total_keys = purge_host(host, shared_dictionary, cache_directory)
        message = message .. host .. ": " .. total_keys .. "\n"
    end

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
    if not cacher_is_ready(self) then
        ngx.log(ngx.NOTICE, "cacher: skipping lru purge until the index is ready")
        return
    end

    -- returns all the keys in the dictionary, the least recently used at the very end of the list
    local hosts = self.shared_dictionary:get_keys(0)
    local maximum_hosts_to_purge = 500

    -- we want to create a list of hosts that we can purge from the end of the list of hosts
    local number_of_hosts_purged = 0

    -- we want to purge the least recently used hosts first
    for i = #hosts, 1, -1 do
        local host = hosts[i]
        purge_host(host, self.shared_dictionary, self.cache_directory)
        number_of_hosts_purged = number_of_hosts_purged + 1
        if (number_of_hosts_purged >= maximum_hosts_to_purge) then
            break
        end
    end
end

function cacher_check_free_space (self, ngx)
    local minimum_free_space = self.minimum_free_space

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
        add = cacher_add,
        inspect = cacher_inspect,
        rehydrate = cacher_rehydrate,
        prepare = cacher_prepare,
        start_worker = cacher_start_worker,
        on_worker_exit = cacher_on_worker_exit,
        monitor_free_space = cacher_monitor_free_space,
        check_free_space = cacher_check_free_space
    }
end

return cacher
