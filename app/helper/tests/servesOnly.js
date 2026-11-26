describe("helper/servesOnly", function () {
  const config = require("config");
  const servesOnly = require("../servesOnly");

  let saved;

  beforeEach(function () {
    saved = {
      worker_socket: config.worker_socket,
      worker_child: config.worker_child,
    };
  });

  afterEach(function () {
    Object.assign(config, saved);
  });

  it("is true for a process with a worker child (node-a in a unit)", function () {
    config.worker_socket = "/run/blot/blue-b.sock";
    config.worker_child = false;
    expect(servesOnly()).toBe(true);
  });

  it("is false for the worker child itself (node-b)", function () {
    config.worker_socket = "";
    config.worker_child = true;
    expect(servesOnly()).toBe(false);
  });

  it("is false for a single process with no worker child", function () {
    config.worker_socket = "";
    config.worker_child = false;
    expect(servesOnly()).toBe(false);
  });
});
