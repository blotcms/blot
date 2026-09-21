const fs = require("fs");
const path = require("path");

describe("proxy authentication body limits", function () {
  const contents = fs.readFileSync(
    path.join(__dirname, "../../config/openresty/conf/blot-site.conf"),
    "utf8"
  );

  it("matches authentication locations case-insensitively", function () {
    expect(contents).toMatch(
      /location ~\* \^\/sites\/\(log-in\|sign-up\|account\/password\)\(\/\|\$\)/
    );
  });

  it("caps the authentication location's body size", function () {
    const auth = contents.match(
      /location ~\* \^\/sites\/\(log-in\|sign-up\|account\/password\)\(\/\|\$\) \{[\s\S]*?\n\}/
    )[0];

    expect(auth).toMatch(/reverse-proxy\.conf/);
    expect(auth).toMatch(/client_max_body_size 4k;/);
  });
});
