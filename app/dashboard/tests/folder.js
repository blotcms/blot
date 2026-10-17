describe("folder", function () {
  global.test.site({ login: true });

  const testCases = [
    // Basic names
    "a.txt", // Simple file
    "a/normal/file.txt", // Simple nested file

    // Whitespace edge cases
    " leading-space", // Leading space
    "trailing-space ", // Trailing space
    "multiple    spaces", // Multiple consecutive spaces
    "tab\ttab", // Tab character
    "space\t\ttab", // Mixed spaces and tabs
    "new\nline", // Newline character

    // Common special characters
    "semi;colon", // Semicolon
    "asterisk*star", // Asterisk
    'quote"marks"', // Double quotes
    "single'quote", // Single quote
    "pipe|pipe", // Pipe
    "question?mark", // Question mark
    "<>anglebrackets", // Angle brackets
    "[brackets]", // Square brackets
    "{curly}", // Curly braces
    "(parentheses)", // Parentheses
    "colon:colon", // Colon
    "dash-start", // Dash at start
    "end-dash-", // Dash at end
    "_underscore_", // Underscore
    "@at-sign", // At sign
    "#hashtag", // Hashtag
    "!exclaim!", // Exclamation mark
    "$dollar$", // Dollar sign
    "percent%", // Percent sign
    "caret^", // Caret
    "tilde~", // Tilde

    // Windows reserved words and device files
    "CON", // Reserved device name (Windows)
    "nul", // Reserved device name (Windows)

    // Special/encoded characters and percent-encoding
    "20% luck/30% skill.txt/99% will.txt", // Percent sign and nested path

    // File and folder names with dots and slashes
    "app/bar.txt", // Slash in path
    "slash/forward", // Forward slash
    "slash\\backward", // Backslash
    "file.name.with.dots", // Multiple dots

    // Accented and Unicode
    "tést", // Accented character
    "accentèd", // Another accented
    "𝓤𝓷𝓲𝓬𝓸𝓭𝓮", // Unicode fancy letters

    // Emoji and symbols
    "emoji-💾", // Emoji in name
    "emoji/文件夹/😀/файл", // Emoji + CJK + Cyrillic (nested)
  ];

  for (const path of testCases) {
    it(`handles path ${path}`, async function () {
      await this.write({ path, content: "test content here" });

      let $ = await this.parse(`/sites/${this.blog.handle}`);
      const pathComponents = path.split("/").filter(Boolean);

      // Navigate through each directory in the path
      for (const [index, component] of pathComponents.entries()) {
        const link = findElementByText(".directory-list a", component, $);
        if (!link) {
          throw new Error(
            `Link not found for "${component}" in path "${path}"`
          );
        }

        $ = await this.parse(link.attr("href"));

        // Handle the final component (file)
        if (index === pathComponents.length - 1) {
          const fileHeader = findElementByText("h1", component, $);
          if (!fileHeader) {
            throw new Error(`Header not found for file "${component}"`);
          }

          const downloadLink = $("a:contains('Download file')").attr("href");
          if (!downloadLink) {
            throw new Error("Download link not found");
          }

          const fileContent = await this.text(downloadLink);
          expect(fileContent).toBe("test content here");
        }
      }
    });
  }

  function findElementByText(selector, text, $) {
    return $(selector)
      .filter(function () {
        return $(this).text().includes(text);
      })
      .first();
  }
});
