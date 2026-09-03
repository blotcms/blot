const createUser = require("./createUser");
const removeUser = require("./removeUser");

const createBlog = require("./createBlog");
const removeBlog = require("./removeBlog");

const Server = require("server");
const checkBrokenLinks = require("./checkBrokenLinks");
const build = require("documentation/build");
const templates = require("util").promisify(require("templates"));
const cheerio = require("cheerio");

const clfdate = require("helper/clfdate");

module.exports = function (options = {}) {
  // we must build the views for the documentation
  // and the dashboard before we launch the server
  // we also build the templates into the cache
  beforeAll(async () => {
    console.log(clfdate(), "Test site: Building views");
    await build({ watch: false, skipZip: true });
    console.log(clfdate(), "Test site: Building templates");
    await templates({ watch: false });
  }, 60000);

  beforeEach(createUser);
  afterEach(removeUser);

  beforeEach(createBlog);
  afterEach(removeBlog);

  let server;

  const port = 8919;

  beforeAll(function (done) {
    this.origin = `http://localhost:${port}`;

    const app = require("express")();

    // Override the host header with the x-forwarded-host header
    // it's not possible to override the Host header in fetch for
    // lame security reasons
    // https://github.com/nodejs/node/issues/50305
    app.use((req, res, next) => {
      req.headers["host"] =
        req.headers["x-forwarded-host"] || req.headers["host"];
      req.headers["X-Forwarded-Proto"] =
        req.headers["X-Forwarded-Proto"] || "https";
      req.headers["x-forwarded-proto"] =
        req.headers["x-forwarded-proto"] || "https";
      next();
    });

    app.use(Server);

    server = app.listen(port, () => {
      console.log(clfdate(), "Test site: Server started at", this.origin);
      done();
    });

    server.on("error", (err) => {
      console.log(clfdate(), "Test site: Server error", err);
      done.fail(err);
    });
  });

  // Add this beforeEach hook to define the fetch function
  beforeEach(function () {
    this.cookies = {};

    this.cookieHeader = () =>
      Object.entries(this.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");

    this.storeCookies = (res) => {
      const setCookies =
        typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [];

      for (const raw of setCookies) {
        const pair = raw.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq === -1) continue;

        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1);
        if (!name) continue;

        this.cookies[name] = value;
      }

      // Keep a serialized Cookie string for any legacy readers
      this.Cookie = this.cookieHeader();
    };

    this.fetch = async (input, options = {}) => {
      const url = new URL(input, this.origin);

      options.headers = options.headers || {};

      if (url.hostname !== "localhost") {
        options.headers["Host"] = url.hostname;
        options.headers["x-forwarded-host"] = url.hostname;
        url.hostname = "localhost";
      }

      const cookieHeader = this.cookieHeader();
      if (cookieHeader) {
        options.headers.Cookie = cookieHeader;
      }

      url.protocol = "http:";
      url.port = port;

      const res = await fetch(url.toString(), options);
      this.storeCookies(res);
      return res;
    };

    this.checkBrokenLinks = (url = this.origin, options = {}) =>
      checkBrokenLinks(this.fetch, url, options);

    this.text = (path) => {
      return new Promise((resolve, reject) => {
        this.fetch(path)
          .then((res) => {
            if (res.status !== 200)
              return reject(
                new Error(`Failed to fetch ${path}: ${res.status}`)
              );
            res.text().then((text) => resolve(text));
          })
          .catch((err) => reject(err));
      });
    };

    this.parse = (path) => {
      return new Promise((resolve, reject) => {
        this.text(path)
          .then((text) => {
            let $;
            try {
              $ = cheerio.load(text);
            } catch (e) {
              return reject(new Error(`Failed to parse HTML: ${e.message}`));
            }
            resolve($);
          })
          .catch((err) => reject(err));
      });
    };
    // can be used like so:
    // await this.submit('/sites/example/title', { title: 'New Title' });
    // will first GET the form to get the CSRF token then POST the form
    // with the provided data
    this.submit = (path, data) => {
      return new Promise(async (resolve, reject) => {
        try {
          // first fetch the page to get the csrf token
          const page = await this.fetch(path, {
            redirect: "manual",
          });

          // the response status should be 200
          expect(page.status).toEqual(200);

          const pageText = await page.text();
          const csrfTokenMatch = pageText.match(/name="_csrf" value="([^"]+)"/);

          let formPath = path;

          // determine the form path in case it is different
          const formMatch = cheerio
            .load(pageText)('form[action][method="post"]')
            .attr("action");

          if (formMatch) {
            formPath = formMatch;
          }

          if (!csrfTokenMatch) {
            return reject(new Error("CSRF token not found in form"));
          }

          if (this.cookies["__Host-csrf"] !== csrfTokenMatch[1]) {
            return reject(
              new Error("CSRF token mismatch between form and cookie")
            );
          }

          const params = new URLSearchParams();

          for (const key in data) {
            params.append(key, data[key]);
          }

          params.append("_csrf", csrfTokenMatch[1]);

          const res = await this.fetch(formPath, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: params.toString(),
          });

          if (res.status >= 400) {
            return reject(new Error(`Failed to submit form: ${res.status}`));
          }

          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
    };
  });

  afterAll(function () {
    server.close();
  });

  if (options.login) {
    beforeEach(async function (done) {
      // first fetch the login page to get the csrf token
      const loginPage = await this.fetch("/sites/log-in", {
        redirect: "manual",
      });

      // the response status should be 200
      expect(loginPage.status).toEqual(200);

      const loginPageText = await loginPage.text();
      const csrfTokenMatch = loginPageText.match(
        /name="_csrf" value="([^"]+)"/
      );

      if (!csrfTokenMatch) {
        return done(new Error("CSRF token not found in login page"));
      }

      if (this.cookies["__Host-csrf"] !== csrfTokenMatch[1]) {
        return done(
          new Error("CSRF token mismatch between login form and cookie")
        );
      }

      const email = this.user.email;
      const password = this.user.fakePassword;

      const params = new URLSearchParams();

      params.append("email", email);
      params.append("password", password);
      params.append("_csrf", csrfTokenMatch[1]);

      const res = await this.fetch("/sites/log-in", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        redirect: "manual",
      });

      const location = res.headers.get("location");

      // the response status should be 302
      // and redirect to the dashboard
      expect(res.status).toEqual(302);

      if (res.status !== 302) {
        return done(
          new Error(`Failed to log in: expected status 302, got ${res.status}`)
        );
      }

      expect(this.cookies["connect.sid"]).toBeDefined();
      expect(location).toEqual("/sites");

      // Check that we are logged in by requesting /sites and checking the response
      // for the user's email address
      const dashboard = await this.fetch("/sites", {
        redirect: "manual",
      });

      // the response status should be 200
      expect(dashboard.status).toEqual(200);

      const dashboardText = await dashboard.text();

      expect(dashboardText).toMatch(email);

      done();
    });
  }
};
