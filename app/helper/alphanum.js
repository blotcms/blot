// https://github.com/TrySound/alphanum-sort

// Copyright (c) Bogdan Chadkin <trysound@yandex.ru>

// Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation
// files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to use,
// copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following
// conditions:

// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
// OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
// HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
// WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.

var zero = "0".charCodeAt(0);
var plus = "+".charCodeAt(0);
var minus = "-".charCodeAt(0);

function isWhitespace(code) {
  return code <= 32;
}

function isDigit(code) {
  return 48 <= code && code <= 57;
}

function isSign(code) {
  return code === minus || code === plus;
}

var compare = function (opts, a, b) {
  var checkSign = opts.sign;
  var ia = 0;
  var ib = 0;
  var ma = a.length;
  var mb = b.length;
  var ca, cb; // character code
  var za, zb; // leading zero count
  var na, nb; // number length
  var sa, sb; // number sign
  var ta, tb; // temporary
  var bias;

  while (ia < ma && ib < mb) {
    ca = a.charCodeAt(ia);
    cb = b.charCodeAt(ib);
    za = zb = 0;
    na = nb = 0;
    sa = sb = true;
    bias = 0;

    // skip over leading spaces
    while (isWhitespace(ca)) {
      ia += 1;
      ca = a.charCodeAt(ia);
    }
    while (isWhitespace(cb)) {
      ib += 1;
      cb = b.charCodeAt(ib);
    }

    // skip and save sign
    if (checkSign) {
      ta = a.charCodeAt(ia + 1);
      if (isSign(ca) && isDigit(ta)) {
        if (ca === minus) {
          sa = false;
        }
        ia += 1;
        ca = ta;
      }
      tb = b.charCodeAt(ib + 1);
      if (isSign(cb) && isDigit(tb)) {
        if (cb === minus) {
          sb = false;
        }
        ib += 1;
        cb = tb;
      }
    }

    // compare digits with other symbols
    if (isDigit(ca) && !isDigit(cb)) {
      return -1;
    }
    if (!isDigit(ca) && isDigit(cb)) {
      return 1;
    }

    // compare negative and positive
    if (!sa && sb) {
      return -1;
    }
    if (sa && !sb) {
      return 1;
    }

    // count leading zeros
    while (ca === zero) {
      za += 1;
      ia += 1;
      ca = a.charCodeAt(ia);
    }
    while (cb === zero) {
      zb += 1;
      ib += 1;
      cb = b.charCodeAt(ib);
    }

    // count numbers
    while (isDigit(ca) || isDigit(cb)) {
      if (isDigit(ca) && isDigit(cb) && bias === 0) {
        if (sa) {
          if (ca < cb) {
            bias = -1;
          } else if (ca > cb) {
            bias = 1;
          }
        } else {
          if (ca > cb) {
            bias = -1;
          } else if (ca < cb) {
            bias = 1;
          }
        }
      }
      if (isDigit(ca)) {
        ia += 1;
        na += 1;
        ca = a.charCodeAt(ia);
      }
      if (isDigit(cb)) {
        ib += 1;
        nb += 1;
        cb = b.charCodeAt(ib);
      }
    }

    // compare number length
    if (sa) {
      if (na < nb) {
        return -1;
      }
      if (na > nb) {
        return 1;
      }
    } else {
      if (na > nb) {
        return -1;
      }
      if (na < nb) {
        return 1;
      }
    }

    // compare numbers
    if (bias) {
      return bias;
    }

    // compare leading zeros
    if (sa) {
      if (za > zb) {
        return -1;
      }
      if (za < zb) {
        return 1;
      }
    } else {
      if (za < zb) {
        return -1;
      }
      if (za > zb) {
        return 1;
      }
    }

    // compare ascii codes
    if (ca < cb) {
      return -1;
    }
    if (ca > cb) {
      return 1;
    }

    ia += 1;
    ib += 1;
  }

  // compare length
  if (ma < mb) {
    return -1;
  }
  if (ma > mb) {
    return 1;
  }
};

function mediator(a, b) {
  return compare(this, a.converted, b.converted);
}

module.exports = function (array, opts) {
  if (!Array.isArray(array) || array.length < 2) {
    return array;
  }
  if (typeof opts !== "object") {
    opts = {};
  }
  opts.sign = !!opts.sign;
  var insensitive = !!opts.insensitive;
  var result = Array(array.length);
  var i, max, value;

  for (i = 0, max = array.length; i < max; i += 1) {
    if (opts.property) {
      value = String(array[i][opts.property]);
    } else {
      value = String(array[i]);
    }
    result[i] = {
      value: array[i],
      converted: insensitive ? value.toLowerCase() : value,
    };
  }

  result.sort(mediator.bind(opts));

  for (i = result.length - 1; ~i; i -= 1) {
    result[i] = result[i].value;
  }

  return result;
};

// Comparator form of the same natural-order sort, for callers that need to
// plug it into Array.prototype.sort directly (e.g. paginating a folder
// listing without materialising the whole sorted array first).
module.exports.compare = function (a, b, opts) {
  opts = typeof opts === "object" && opts !== null ? opts : {};
  opts.sign = !!opts.sign;
  var va = String(a);
  var vb = String(b);
  if (opts.insensitive) {
    va = va.toLowerCase();
    vb = vb.toLowerCase();
  }
  // `compare` returns undefined when the two strings are exactly equal.
  return compare(opts, va, vb) || 0;
};
