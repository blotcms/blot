local aliases = {
  note = "note", abstract = "abstract", summary = "abstract", tldr = "abstract",
  info = "info", todo = "todo", tip = "tip", hint = "tip", important = "tip",
  success = "success", check = "success", done = "success",
  question = "question", help = "question", faq = "question",
  warning = "warning", caution = "warning", attention = "warning",
  failure = "failure", fail = "failure", missing = "failure",
  danger = "danger", error = "danger", bug = "bug", example = "example",
  quote = "quote", cite = "quote"
}

local function title_case(value)
  local words = {}
  for word in value:gmatch("[^_%-]+") do
    words[#words + 1] = word:sub(1, 1):upper() .. word:sub(2):lower()
  end
  return table.concat(words, " ")
end

local function trim_spaces(inlines)
  while #inlines > 0 and inlines[1].t == "Space" do table.remove(inlines, 1) end
  while #inlines > 0 and inlines[#inlines].t == "Space" do table.remove(inlines) end
end

function BlockQuote(blockquote)
  local first = blockquote.content[1]
  if not first or (first.t ~= "Para" and first.t ~= "Plain") then return nil end
  local marker = first.content[1]
  if not marker or marker.t ~= "Str" then return nil end

  local original, fold, remainder = marker.text:match("^%[!([%a][%w_%-]*)%]([+%-]?)(.*)$")
  if not original then return nil end
  original = original:lower()

  local line = {}
  if remainder ~= "" then line[#line + 1] = pandoc.Str(remainder) end
  for i = 2, #first.content do line[#line + 1] = first.content[i] end
  trim_spaces(line)

  local title, body_line, boundary = {}, {}, false
  for _, inline in ipairs(line) do
    if not boundary and (inline.t == "SoftBreak" or inline.t == "LineBreak") then
      boundary = true
    elseif boundary then
      body_line[#body_line + 1] = inline
    else
      title[#title + 1] = inline
    end
  end
  trim_spaces(title)
  trim_spaces(body_line)
  if #title == 0 then title = { pandoc.Str(title_case(original)) } end

  local body = {}
  if #body_line > 0 then body[#body + 1] = pandoc.Para(body_line) end
  for i = 2, #blockquote.content do body[#body + 1] = blockquote.content[i] end

  local title_attr = pandoc.Attr("", { "callout-title" })
  if fold ~= "" then
    title_attr = pandoc.Attr("", { "callout-title" }, {
      { "role", "button" }, { "tabindex", "0" },
      { "aria-expanded", fold == "+" and "true" or "false" }
    })
  end
  local title_div = pandoc.Div({
    pandoc.Plain({
      pandoc.Span({}, pandoc.Attr("", { "callout-icon" }, { { "aria-hidden", "true" } })),
      pandoc.Span(title, pandoc.Attr("", { "callout-title-inner" }))
    })
  }, title_attr)

  local classes = { "callout" }
  local attributes = {
    { "data-callout", aliases[original] or "note" },
    { "data-callout-original", original }
  }
  if fold ~= "" then
    classes[#classes + 1] = fold == "+" and "is-expanded" or "is-collapsed"
    attributes[#attributes + 1] = { "data-callout-fold", fold }
  end

  return pandoc.Div({ title_div, pandoc.Div(body, pandoc.Attr("", { "callout-content" })) },
    pandoc.Attr("", classes, attributes))
end
