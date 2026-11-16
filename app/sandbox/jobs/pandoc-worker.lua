-- The pandoc job as a long-running worker: `pandoc lua pandoc-worker.lua`,
-- in a jail the broker keeps for many documents (proxy/unit/sandbox/broker.js),
-- so a document doesn't pay for a jail, Node and pandoc's start-up each time.
-- It converts exactly as ./pandoc.js does with the pandoc CLI, from the same
-- checked args, and answers in the same format, so the client can't tell the
-- two apart: app/sandbox/tests/pandoc-worker.js compares them on every
-- converter fixture. A change to the options in one must be made in the other.
--
-- A request is the job's stdin, as main.js would read it (a line of JSON args,
-- then the input), sent in chunks: "<length>\n<bytes>", ended by "0\n". The
-- reply is "<length>\n" and then what main.js would write to stdout, or "E\n"
-- for arguments the job refuses. A document pandoc can't convert is meta.error,
-- as with the CLI. The broker enforces the time limit, by killing the worker.

local json = pandoc.json

local FORMATS = { markdown = true, docx = true, odt = true, rtf = true, org = true }
local EXTENSION = "^%.[A-Za-z0-9]+$"
local MAX_MEDIA = 1000
-- Where the HTML's image paths start, as --extract-media=<dir>/media would
-- make them. Nothing is written there: the media go back as outputs. It is as
-- long as the job's mkdtemp directory (/tmp/pandoc-XXXXXX), so pandoc wraps
-- the HTML's lines in the same places.
local MEDIA_DIR = "/tmp/pandoc-worker/media"
local SCRATCH = "/tmp/pandoc-worker"

local HERE = arg[0]:match("^(.*)/[^/]*$") or "."
local function read_file(name)
  local f = assert(io.open(HERE .. "/" .. name, "rb"))
  local data = f:read("a")
  f:close()
  return data
end

-- The callouts filter defines a global BlockQuote function
dofile(HERE .. "/callouts.lua")
local CALLOUTS = { BlockQuote = BlockQuote }
local TITLE_TEMPLATE = pandoc.template.compile(read_file("title-only.html"))

-- The CLI reads pandoc's default data file of abbreviations (which the
-- markdown reader follows with a non-breaking space); pandoc.read's own
-- default is shorter. This is that file, from the pinned pandoc
-- (`pandoc --print-default-data-file abbreviations`), as the set pandoc wants.
local ABBREVIATIONS = {}
for line in read_file("pandoc-abbreviations"):gmatch("[^\n]+") do
  ABBREVIATIONS[line] = true
end
local READER = { abbreviations = ABBREVIATIONS }

local function read(document, format)
  return pandoc.read(document, format, READER)
end

-- As markdownArgs in ./pandoc.js
local MARKDOWN = "markdown+mark-native_divs+fenced_divs+autolink_bare_uris"
  .. "+wikilinks_title_after_pipe-simple_tables-multiline_tables-raw_tex"
  .. "-yaml_metadata_block-implicit_figures+lists_without_preceding_blankline"
  .. "-blank_before_header-blank_before_blockquote"

local function check_file(file)
  if file == nil or file == json.null then return nil end
  if type(file) ~= "table" then error("invalid file") end
  -- JSON numbers may decode as floats: a length must be a whole one
  local length, extension = math.tointeger(file.length), file.extension
  if not length or length < 0 then error("invalid file length") end
  if type(extension) ~= "string" or #extension > 17 or not extension:match(EXTENSION) then
    error("invalid file extension")
  end
  return { length = length, extension = extension }
end

-- As check() in ./pandoc.js
local function check(args)
  if type(args) ~= "table" then error("invalid arguments") end
  if not FORMATS[args.from] then error("invalid format") end
  local checked = { from = args.from, katex = false, callouts = false }
  if args.from ~= "markdown" then return checked end
  for _, flag in ipairs({ "katex", "callouts" }) do
    if type(args[flag]) ~= "boolean" then error("invalid " .. flag) end
    checked[flag] = args[flag]
  end
  checked.bibliography = check_file(args.bibliography)
  checked.csl = check_file(args.csl)
  return checked
end

-- The document, then the bibliography and CSL, as split() in ./pandoc.js.
-- The input is the request from its byte start on, taken in place: a copy of
-- it first would hold the document twice more.
local function split(request, start, options)
  local extra = (options.bibliography and options.bibliography.length or 0)
    + (options.csl and options.csl.length or 0)
  if extra > #request - start + 1 then error("invalid file lengths") end
  local offset = #request - extra
  local files = {}
  for _, name in ipairs({ "bibliography", "csl" }) do
    local file = options[name]
    if file then
      files[name] = request:sub(offset + 1, offset + file.length)
      offset = offset + file.length
    end
  end
  return request:sub(start, #request - extra), files
end

local function write_scratch(name, data)
  local path = SCRATCH .. "-" .. name
  local f = assert(io.open(path, "wb"))
  f:write(data)
  f:close()
  return path
end

-- A docx or odt is a zip archive, and most of its bytes are its images, which
-- pandoc only copies into its media bag. So before pandoc reads it, each file
-- other than its XML is replaced by a marker naming it, and the reply names
-- the archive's file for each image instead of carrying its bytes: the caller
-- takes them from the archive itself, in batches (build/converters/pandoc.js).
-- The HTML is the same either way, and the worker holds the document's bytes
-- only once or twice, however many images it has. As markers() in ./pandoc.js.
local MARKER = "blot-media:"

local function kept(path)
  local lower = path:lower()
  return path:sub(-1) == "/"
    or lower == "mimetype"
    or lower:match("%.xml$") ~= nil
    or lower:match("%.rels$") ~= nil
end

-- The document with markers, and the set of the files they replaced; nil for a
-- document that isn't an archive, which pandoc then reads as it is, to fail
-- with its own error
local function with_markers(document)
  local ok, slim, replaced = pcall(function()
    local entries, replaced = {}, {}
    for _, entry in ipairs(pandoc.zip.Archive(document).entries) do
      if kept(entry.path) then
        entries[#entries + 1] = entry
      else
        replaced[entry.path] = true
        entries[#entries + 1] = pandoc.zip.Entry(entry.path, MARKER .. entry.path, entry.modtime)
      end
    end
    return pandoc.zip.Archive(entries):bytestring(), replaced
  end)
  if not ok then return nil end
  return slim, replaced
end

-- The document's media, as --extract-media does it: each image whose source
-- is in the media bag points into MEDIA_DIR. Returns the bag's names, the
-- archive file each is (or null, for one that isn't a marker), and the bytes
-- of those that aren't.
local function extract_media(doc, replaced)
  local names, entries, outputs = {}, {}, {}
  for _, item in ipairs(pandoc.mediabag.list()) do
    if #names >= MAX_MEDIA then error("too many media files") end
    local _, contents = pandoc.mediabag.lookup(item.path)
    names[#names + 1] = item.path
    local entry = contents:sub(1, #MARKER) == MARKER and contents:sub(#MARKER + 1)
    if entry and replaced and replaced[entry] then
      entries[#entries + 1] = entry
    else
      entries[#entries + 1] = json.null
      outputs[#outputs + 1] = contents
    end
  end
  local known = {}
  for _, name in ipairs(names) do known[name] = true end
  doc = doc:walk({
    Image = function(image)
      if known[image.src] then
        image.src = MEDIA_DIR .. "/" .. image.src
        return image
      end
    end,
  })
  return doc, names, entries, outputs
end

-- Lua frees nothing until it collects, and pandoc's heap (+RTS -M) doesn't
-- count Lua's strings, so a big document's copies (its frames, the request,
-- the document, its media) could take the jail past its memory limit together.
-- Each is dropped and collected once the next step has what it needs.
local function collect()
  collectgarbage("collect")
end

-- input is { document, files }; the document is taken out of it once read
local function convert(options, input)
  local from = options.from
  local html, names, entries, media = nil, {}, {}, {}
  local files = input.files

  if from == "docx" or from == "odt" then
    local slim, replaced = with_markers(input.document)
    if slim then input.document = nil end
    collect()
    local doc = read(slim or input.document, from)
    input.document, slim = nil, nil
    collect()
    doc, names, entries, media = extract_media(doc, replaced)
    pandoc.mediabag.empty()
    html = pandoc.write(doc, "html5", { template = TITLE_TEMPLATE, columns = 72, wrap_text = "auto" })
  elseif from == "rtf" or from == "org" then
    local doc = read(input.document, from)
    input.document = nil
    html = pandoc.write(doc, "html5", {
      columns = 72,
      wrap_text = "auto",
      highlight_style = false,
      html_math_method = "katex",
      email_obfuscation = "none",
    })
  else
    local citations = files.bibliography ~= nil or files.csl ~= nil
    local extensions = MARKDOWN
      .. (options.katex and "+tex_math_dollars" or "-tex_math_dollars")
      .. (citations and "" or "-citations")
    local doc = read(input.document, extensions)
    input.document = nil
    if options.callouts then doc = doc:walk(CALLOUTS) end
    if citations then
      local written = {}
      if files.bibliography then
        written[#written + 1] = write_scratch("bibliography" .. options.bibliography.extension, files.bibliography)
        doc.meta.bibliography = written[#written]
      end
      if files.csl then
        written[#written + 1] = write_scratch("style" .. options.csl.extension, files.csl)
        doc.meta.csl = written[#written]
      end
      local ok, result = pcall(pandoc.utils.citeproc, doc)
      for _, path in ipairs(written) do os.remove(path) end
      if not ok then error(result, 0) end
      doc = result
    end
    html = pandoc.write(doc, "html5", {
      columns = 1000,
      wrap_text = "auto",
      highlight_style = false,
      html_math_method = options.katex and "katex" or "plain",
      email_obfuscation = "none",
    })
  end

  -- As the CLI writes it: a fragment gets a final newline, a template's
  -- output ends with its own
  if from ~= "docx" and from ~= "odt" then html = html .. "\n" end
  return html, names, entries, media
end

-- json.encode writes an empty table as {}, so arrays are written here
local function array(list)
  local parts = {}
  for i, value in ipairs(list) do parts[i] = json.encode(value) end
  return "[" .. table.concat(parts, ",") .. "]"
end

-- meta is a JSON string; outputs are the HTML and the media. Written one
-- after another rather than joined, which would hold the media twice more.
local function reply(meta, outputs)
  local lengths = {}
  for i, output in ipairs(outputs) do lengths[i] = #output end
  local head = '{"meta":' .. meta .. ',"lengths":' .. array(lengths) .. "}\n"
  local length = #head
  for _, n in ipairs(lengths) do length = length + n end
  io.stdout:write(length, "\n", head)
  for _, output in ipairs(outputs) do io.stdout:write(output) end
  io.stdout:flush()
end

-- One request's bytes, or nil when the broker has closed stdin
local function read_request()
  local chunks = {}
  while true do
    local line = io.stdin:read("l")
    if not line then return nil end
    local length = tonumber(line)
    if not length then error("bad frame") end
    if length == 0 then return table.concat(chunks) end
    chunks[#chunks + 1] = io.stdin:read(length)
  end
end

while true do
  local request = read_request()
  if not request then break end
  -- The frames
  collect()

  local ok, options, document, files = pcall(function()
    local newline = request:find("\n", 1, true)
    if not newline then error("no arguments line") end
    local options = check(json.decode(request:sub(1, newline - 1)))
    return options, split(request, newline + 1, options)
  end)
  request = nil
  collect()

  if not ok then
    io.stdout:write("E\n")
    io.stdout:flush()
  else
    pandoc.mediabag.empty()
    local started = os.clock()
    local input = { document = document, files = files }
    document = nil
    local converted, html, names, entries, media = pcall(convert, options, input)
    input = nil
    if converted then
      local outputs = { html }
      html = nil
      for _, contents in ipairs(media) do outputs[#outputs + 1] = contents end
      media = nil
      reply(
        '{"dir":' .. json.encode(MEDIA_DIR) .. ',"media":' .. array(names)
          .. ',"entries":' .. array(entries) .. "}",
        outputs
      )
      outputs = nil
    else
      reply(json.encode({
        error = {
          code = 1,
          signal = json.null,
          timedOut = false,
          ms = math.floor((os.clock() - started) * 1000),
          stderr = tostring(html):sub(1, 16 * 1024),
        },
      }), {})
    end
  end
end
