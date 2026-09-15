describe("templates rebuild subscription", function () {
  const templatesPath = require.resolve("templates");
  const subscriberPath = require.resolve("helper/redisSubscriber");
  const chokidarPath = require.resolve("chokidar");
  const fsExtra = require("fs-extra");
  const Template = require("models/template");

  let originalSubscriber;
  let originalChokidar;
  let originalTemplates;
  let originalReaddirSync;
  let originalGetTemplateList;
  let originalStdinResume;
  let redisSubscriber;

  beforeEach(function () {
    originalSubscriber = require.cache[subscriberPath];
    originalChokidar = require.cache[chokidarPath];
    originalTemplates = require.cache[templatesPath];
    originalReaddirSync = fsExtra.readdirSync;
    originalGetTemplateList = Template.getTemplateList;
    originalStdinResume = process.stdin.resume;

    fsExtra.readdirSync = function () {
      return [];
    };
    Template.getTemplateList = function (_owner, callback) {
      callback(null, []);
    };
    process.stdin.resume = function () {};

    redisSubscriber = jasmine.createSpy("redisSubscriber").and.returnValue({
      cleanup: function () {},
      setupPromise: Promise.resolve(),
    });
    require.cache[subscriberPath] = { exports: redisSubscriber };
    require.cache[chokidarPath] = {
      exports: {
        watch: function () {
          return {
            on: function () {
              return this;
            },
          };
        },
      },
    };
    delete require.cache[templatesPath];
  });

  afterEach(function () {
    fsExtra.readdirSync = originalReaddirSync;
    Template.getTemplateList = originalGetTemplateList;
    process.stdin.resume = originalStdinResume;
    delete require.cache[templatesPath];
    if (originalSubscriber) require.cache[subscriberPath] = originalSubscriber;
    else delete require.cache[subscriberPath];
    if (originalChokidar) require.cache[chokidarPath] = originalChokidar;
    else delete require.cache[chokidarPath];
    if (originalTemplates) require.cache[templatesPath] = originalTemplates;
  });

  it("opens a templates:rebuild subscriber only when watching", function (done) {
    const templates = require("templates");

    templates({ watch: false }, function (err) {
      expect(err).toBeFalsy();
      expect(redisSubscriber).not.toHaveBeenCalled();

      templates({ watch: true }, function (err) {
        expect(err).toBeFalsy();
        expect(redisSubscriber).toHaveBeenCalledTimes(1);
        expect(redisSubscriber.calls.mostRecent().args[0].channel).toBe(
          "templates:rebuild"
        );
        done();
      });
    });
  });
});
