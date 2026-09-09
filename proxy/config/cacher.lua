local cacher = {
    _VERSION     = "cacher.lua 1.0.0",
    _DESCRIPTION = "Purgable cache for OpenResty",
    _URL         = "",
    _LICENSE     = ""
  }

local function cacher_add (self, host, cache_key) 
    local shared_dictionary = self.shared_dictionary
    local cache_key_hash = ngx.md5(cache_key)
    ngx.log(ngx.NOTICE, "add hash=" .. cache_key_hash .. " host=" .. host .. " key=" .. cache_key)
    shared_dictionary:rpush(host, cache_key_hash)
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

-- this file will read the contents of the cache directory and store them in 
-- the lua shared dict shared_dictionary so we can purge them later 

-- I'm not sure why we need to deduplicate the keys?-- 
local function deduplicate_key_list_by_host (host, shared_dict)

    ngx.log(ngx.NOTICE, "deduplicate_key_list_by_host: " .. host)

    local deduplicated_key_list = {}

    -- we lpop from the list until we get nil
    local cache_key_hash = shared_dict:lpop(host)

    while cache_key_hash do

        if (deduplicated_key_list[cache_key_hash] == nil) then
            table.insert(deduplicated_key_list, cache_key_hash)
            deduplicated_key_list[cache_key_hash] = true
        else
            ngx.log(ngx.NOTICE, "duplicate hash " .. cache_key_hash)
        end

        cache_key_hash = shared_dict:lpop(host)
    end

    -- reinsert the keys into the list
    for _, cache_key_hash in ipairs(deduplicated_key_list) do
        ngx.log(ngx.NOTICE, "reinserting " .. cache_key_hash)
        shared_dict:rpush(host, cache_key_hash)
    end
end

local function extractHostFromCacheFile (ngx, cache_file_path)

    -- we need to read the first line of the cache file to get the host
    -- the first line is in the format:
    -- KEY: http://example.com/xyz/abc
    local file = io.open(cache_file_path, "r")
    local first_line = file:read()

    local number_of_lines_read = 1

    -- keep reading the file until we get a line that contains "KEY: ", up to a max of 10 lines
    while (first_line ~= nil and number_of_lines_read < 10 and string.match(first_line, "KEY: ") == nil) do
        first_line = file:read()
    end

    if (first_line == nil) then
        return nil
    end

    local key = string.match(first_line, "KEY: (.*)")

    if (key == nil) then
        ngx.log(ngx.NOTICE, "key is nil")
        return nil
    end

    -- the protocol is included in the uri so we need to remove it
    local uri_without_protocol = string.match(key, "://(.*)")

    if (uri_without_protocol == nil) then
        return nil
    end
    
    -- the host is the first part of the uri, up to question mark or slash or colon if there is one
    local host = string.match(uri_without_protocol, "([^/?#:]+)")

    if (host == nil) then
        return nil
    end
    
    file:close()

    return host
end

-- returns a list of file or directory names in the given directory
local function readdirectory(directory)
    local i, t, popen = 0, {}, io.popen
    local pfile = popen('ls -a "'..directory..'"')

    -- we want to skip the lines that are . or ..
    for filename in pfile:lines() do
        if (filename ~= "." and filename ~= "..") then
            i = i + 1
            ngx.log(ngx.NOTICE, "found file: " .. filename)
            t[i] = filename
        end
    end

    pfile:close()
    return t
end


local function cacher_rehydrate (self)

    -- we need to read the contents of the cache directory and store them in 
    -- the lua shared dict shared_dictionary so we can purge them later
    local cache_directory = self.cache_directory

    -- local purged_files = purge_host(ngx.var.arg_host)
    local shared_dictionary = self.shared_dictionary

    local message = ''

    ngx.log(ngx.NOTICE, "rehydrate: " .. cache_directory )

    -- first we list all the top level directories in the cache directory
    local top_level_directories = readdirectory(cache_directory)

    -- store a list of hosts
    local hosts = {}

    -- then for each directory we list all the files in that directory
    for _, top_level_directory in ipairs(top_level_directories) do

        local top_level_directory_path = cache_directory .. "/" .. top_level_directory
        local second_level_directories = readdirectory(top_level_directory_path)
  
        for _, second_level_directory in ipairs(second_level_directories) do
            local second_level_directory_path = top_level_directory_path .. "/" .. second_level_directory
            local files = readdirectory(second_level_directory_path)
 
            for _, cache_key_hash in ipairs(files) do
                local cache_file_path = top_level_directory .. "/" .. second_level_directory .. "/" .. cache_key_hash
                local host = extractHostFromCacheFile(ngx, second_level_directory_path .. "/" .. cache_key_hash)
                

                -- if the host was not parsed, log the file
                if (host == nil) then
                    ngx.log(ngx.NOTICE, "rehydrate: failed to parse host: " .. cache_file_path)
                    message = message .. cache_file_path .. "\n"
                else
                    -- add the host to the list of hosts
                    if (hosts[host] == nil) then
                        table.insert(hosts, host)
                        hosts[host] = true
                    end
    
                    ngx.log(ngx.NOTICE, "rehydrate: adding FILE=" .. cache_key_hash  .. " HOST=" .. host )
                    shared_dictionary:rpush(host, cache_key_hash)
                end
            end
        end
    end
 
    for _, host in ipairs(hosts) do
        deduplicate_key_list_by_host(host, shared_dictionary)
    end

    ngx.log(ngx.NOTICE, "rehydrate: complete")

    if (message == '') then
        message = "OK"
    end

    return message
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

--- Create a new cacher instance.
function cacher.new()
    
    local function cacher_set(self, key, value)
        self[key] = value

        -- if both cache_directory and shared_dictionary are set then we can rehydrate
        if (self.cache_directory ~= nil and self.shared_dictionary ~= nil) then
            cacher_rehydrate(self)
        end
    end

    return {
        purge = cacher_purge,
        set = cacher_set,
        add = cacher_add,
        inspect = cacher_inspect,
        rehydrate = cacher_rehydrate,
        monitor_free_space = cacher_monitor_free_space,
        check_free_space = cacher_check_free_space
    }
end

return cacher