/**
 * @author Briguy37
 * @license MIT license
 * @link http://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript
 **/

function generate() {
  // This produces convenient, non-security-sensitive identifiers only. It is
  // Math.random-based and must not be used for secrets, tokens, signatures, or
  // any value whose unpredictability is a security requirement. Use crypto's
  // randomBytes/randomUUID APIs for those purposes instead.
  var d = Date.now();

  //use high-precision timer if available
  if (process.hrtime && typeof process.hrtime === "function") {
    d += process.hrtime()[0];
  }

  var guid = "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = ((d + Math.random() * 16) % 16) | 0;
    d = Math.floor(d / 16);
    return (c == "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

  return guid;
}

module.exports = generate;
