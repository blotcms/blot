// Self-contained: node scripts/development/translate/tests/handle.js
//
// Deliberately not wired into the docker jasmine suite — this is a pure function
// with no dependencies, and being able to run it instantly is worth more here.

const assert = require("assert");
const handle = require("../handle");
const { deriveHandle, withSuffix, resolve, MAX_LENGTH } = handle;

let failures = 0;

function check(description, fn) {
  try {
    fn();
    console.log("  ok  " + description);
  } catch (error) {
    failures++;
    console.log("FAIL  " + description);
    console.log("      " + error.message);
  }
}

console.log("deriveHandle");

const cases = [
  // [input, expected]
  ["https://example.com", "example"],
  ["https://www.example.com", "example"],
  ["http://example.com", "example"],
  ["https://example.com/", "example"],
  ["https://example.com/blog/posts", "example"],
  ["https://example.com:8443/", "example"],
  ["https://example.com?utm_source=x#frag", "example"],

  // Multi-part TLDs must not leak into the handle
  ["https://example.co.uk", "example"],
  ["https://www.example.org.uk", "example"],
  ["https://example.com.au", "example"],

  // Meaningful subdomains are kept, noise ones dropped
  ["https://notes.example.com", "notesexample"],
  ["https://blog.example.com", "example"],
  ["https://en.example.com", "example"],
  ["https://m.example.com", "example"],

  // Hosting platforms: the interesting part is the subdomain
  ["https://someone.github.io", "someone"],
  ["https://someone.substack.com", "someone"],
  ["https://someone.blot.im", "someone"],
  ["https://someone.github.io/project", "someone"],

  // Punctuation and case are stripped
  ["https://My-Site.example.com", "mysiteexample"],
  ["https://foo_bar.com", "foobar"],
  ["https://123.com", "123"],

  // Accents fold to their base letter rather than disappearing
  ["https://josé.com", "jose"],

  // Bare hostnames are tolerated
  ["example.com", "example"],
];

cases.forEach(([input, expected]) => {
  check(`${input} -> ${expected}`, () => {
    assert.strictEqual(deriveHandle(input), expected);
  });
});

console.log("\ndeterminism");

check("same URL always gives the same handle", () => {
  const urls = [
    "https://www.example.com/blog",
    "https://josé.com",
    "https://a.github.io",
  ];
  urls.forEach((url) => {
    assert.strictEqual(deriveHandle(url), deriveHandle(url));
  });
});

check("trailing slash and query do not change the result", () => {
  assert.strictEqual(
    deriveHandle("https://example.com"),
    deriveHandle("https://example.com/?ref=twitter")
  );
});

console.log("\nvalidity");

check("output is always alphanumeric and lowercase", () => {
  cases.forEach(([input]) => {
    const result = deriveHandle(input);
    assert.ok(
      /^[a-z0-9]+$/.test(result),
      `${input} produced ${JSON.stringify(result)}`
    );
  });
});

check("output respects the length limit", () => {
  const long = "https://" + "a".repeat(200) + ".com";
  assert.ok(deriveHandle(long).length <= MAX_LENGTH);
});

check("output meets the two character minimum", () => {
  cases.forEach(([input]) => {
    assert.ok(deriveHandle(input).length >= 2, input);
  });
});

check("a path segment rescues an otherwise empty handle", () => {
  assert.strictEqual(deriveHandle("https://www.com/mysite"), "mysite");
});

console.log("\nunparseable input");

["", null, undefined, "not a url", "https://"].forEach((input) => {
  check(`${JSON.stringify(input)} -> ""`, () => {
    assert.strictEqual(deriveHandle(input), "");
  });
});

console.log("\nwithSuffix");

check("n=1 is the bare base", () => {
  assert.strictEqual(withSuffix("example", 1), "example");
});

check("n>1 appends the number", () => {
  assert.strictEqual(withSuffix("example", 2), "example2");
  assert.strictEqual(withSuffix("example", 17), "example17");
});

check("suffixing never exceeds the length limit", () => {
  const base = "a".repeat(MAX_LENGTH);
  const result = withSuffix(base, 12);
  assert.strictEqual(result.length, MAX_LENGTH);
  assert.ok(result.endsWith("12"));
});

console.log("\nresolve");

check("returns the base when it is free", () => {
  assert.strictEqual(
    resolve("example", () => false),
    "example"
  );
});

check("skips taken handles", () => {
  const taken = new Set(["example", "example2"]);
  assert.strictEqual(
    resolve("example", (h) => taken.has(h)),
    "example3"
  );
});

check("returns null when everything is taken", () => {
  assert.strictEqual(
    resolve("example", () => true, 5),
    null
  );
});

console.log("");

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}

console.log("All handle tests passed.");
