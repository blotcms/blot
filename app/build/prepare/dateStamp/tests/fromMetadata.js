var fromMetadata = require("../fromMetadata");

// Blot parses dates according to the 'dateFormat' of the blog.
// This allows Blot to determine what 5.1.2019 means: either
// May 1st or 5th of January. The dateFormat is either:
// - "D/M/YYYY" Day, Month, Year
// - "M/D/YYYY" Month, Day, Year
// - "YYYY/M/D" Year, Month, Day

// The following date strings can be parsed from each of the
// metadata inputs, regardless of the blog's dateFormat.
// For example, the date "2019-01-01T00:00:00Z"
// should be parsed from "2019", "2019-01-01" etc...
var supportedByAllFormats = [
  record(Date.UTC(2019, 0, 1), ["2019", "2019-01-01", "2019 01 01"]),
  record(Date.UTC(2017, 1, 14), ["2017-02-14", "2017/02/14"]),
  record(Date.UTC(2018, 0, 15), ["January 15th, 2018", "JANUARY 15th 2018"]),
  record(Date.UTC(2017, 4, 15), ['"2017-05-15"', "'2017-05-15'"]),
  record(Date.UTC(2019, 3, 3, 12, 33, 15), ["2019-04-03 12:33:15"]),
  record(Date.UTC(2018, 11, 17, 17, 29), ["2018-12-17 17:29"]),
  record(Date.UTC(2019, 10, 15, 14, 45), ["11/15/2019 14:45"]),
  record(Date.UTC(2018, 2, 29), ["March 29, 2018", "March.29.2018"]),
  record(Date.UTC(2015, 1, 10, 7, 26), ["February 10th, 2015 07:26"]),
  record(Date.UTC(2019, 0, 18), ["18 january, 2019"]),
  record(Date.UTC(2018, 3, 18), ["Apr 18, 2018"]),
  record(Date.UTC(2019, 3, 16, 14, 50), ["2019-04-16 02:50 PM"]),
  record(Date.UTC(2018, 5, 24, 14, 59, 27), ["June 24th 2018, 2:59:27 pm"]),
  record(Date.UTC(2015, 0, 4, 5, 8), ["January 4th, 2015 05:08"]),
  record(Date.UTC(2015, 1, 4, 21, 14, 18), ["Wed Feb  4 21:14:18 EST 2015"]),
  record(Date.UTC(2012, 4, 30, 14, 45, 44), [
    "Wed May 30 2012 14:45:44 GMT+0000 (UTC)",
  ]),
  // RFC 3339 timestamps and Blot's timezone-less UTC extension.
  record(1310504436000, ["2011-07-12T21:00:36Z"], true),
  record(1310504436000, ["2011-07-12T21:00:36"], true),
  record(1310504436443, ["2011-07-12T21:00:36.443Z"], true),
  record(1310504436443, ["2011-07-12T21:00:36.443"], true),
  record(1310529636000, ["2011-07-12T21:00:36-07:00"], true),
];

function record(created, inputs, adjusted) {
  return {
    expected: { created: created, adjusted: adjusted || false },
    inputs: inputs,
  };
}

// The following date strings can only be parsed from blogs
// with specific date formats. This is neccessary due to ambiguity
// in the ordering of month and day in the date metadata.
var supportedBySpecficFormat = {
  "D/M/YYYY": {
    "2016-04-18T00:00:00Z": ["18/04/2016"],
    "2018-07-19T00:00:00Z": ["19-07-2018"],
    "2019-02-05T00:00:00Z": ["5.2.2019"],
  },
  "M/D/YYYY": {},
  "YYYY/M/D": {},
};

describe("date metadata", function () {
  // Test the metadata which should be parsed correctly
  // regardless of the dateFormat (e.g. M/D/YYYY) of the blog
  supportedByAllFormats.forEach(function (testCase) {
    testCase.inputs.forEach(function (metadata) {
      Object.keys(supportedBySpecficFormat).forEach(function (format) {
        it(
          'parses "' + metadata + '" using date format ' + format,
          function () {
            expect(fromMetadata(metadata, format)).toEqual(testCase.expected);
          },
        );
      });

      it('parses "' + metadata + '" without passing a format', function () {
        expect(fromMetadata(metadata)).toEqual(testCase.expected);
      });
    });
  });

  // Test the metadata which can only be parsed correctly
  // using a specific dateFormat (e.g. M/D/YYYY) of the blog
  Object.keys(supportedBySpecficFormat).forEach(function (format) {
    Object.keys(supportedBySpecficFormat[format]).forEach(function (result) {
      supportedBySpecficFormat[format][result].forEach(function (metadata) {
        it(
          'parses "' + metadata + '" using date format ' + format,
          function () {
            expect(fromMetadata(metadata, format)).toEqual({
              created: Date.parse(result),
              adjusted: false,
            });
          },
        );
      });
    });
  });
});
