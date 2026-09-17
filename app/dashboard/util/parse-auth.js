const express = require("express");

// Auth forms only contain a handful of short fields. Keep these requests
// separate from the dashboard's larger parser, which is needed for uploads
// and template editing.
const AUTH_FORM_PATHS = ["/sign-up", "/log-in", "/account/password"];

function isAuthFormPath(path) {
  const normalized = String(path || "").toLowerCase();
  return AUTH_FORM_PATHS.some(function (prefix) {
    return normalized === prefix || normalized.startsWith(prefix + "/");
  });
}

const parseAuth = express.urlencoded({
  extended: false,
  limit: "4kb",
  parameterLimit: 10,
});

parseAuth.AUTH_FORM_PATHS = AUTH_FORM_PATHS;
parseAuth.isAuthFormPath = isAuthFormPath;

module.exports = parseAuth;
