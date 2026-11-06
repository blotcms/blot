// by Salvatore Ruiu Irgoli-Sardegna (Italy) ottobre 2010.
// calcola la data degli equinozi e dei solstizi per l'anno indicato nel parametro.
module.exports = function (anno) {
  var Y = anno;
  var y1 = Y / 1000;

  var jd1 =
    1721139.2855 +
    365.2421376 * Y +
    0.067919 * y1 * y1 -
    0.0027879 * y1 * y1 * y1; //  EQUINOZIO DI MARZO

  var jd2 =
    1721233.2486 +
    365.2417284 * Y -
    0.053018 * y1 * y1 +
    0.009332 * y1 * y1 * y1; //  SOLSTIZIO DI GIUGNO

  var jd3 =
    1721325.6978 +
    365.2425055 * Y -
    0.126689 * y1 * y1 +
    0.0019401 * y1 * y1 * y1; //  EQUINOZIO DI SETTEMBRE

  var jd4 =
    1721414.392 +
    365.2428898 * Y -
    0.010965 * y1 * y1 -
    0.0084885 * y1 * y1 * y1; //  SOLSTIZIO DI DICEMBRE

  return [
    { season: "spring", date: julianIntToDate(jd1) },
    { season: "summer", date: julianIntToDate(jd2) },
    { season: "autumn", date: julianIntToDate(jd3) },
    { season: "winter", date: julianIntToDate(jd4) },
  ];
};

function julianIntToDate(JD) {
  var y = 4716;
  var v = 3;
  var j = 1401;
  var u = 5;
  var m = 2;
  var s = 153;
  var n = 12;
  var w = 2;
  var r = 4;
  var B = 274277;
  var p = 1461;
  var C = -38;
  var f = JD + j + Math.floor((Math.floor((4 * JD + B) / 146097) * 3) / 4) + C;
  var e = r * f + v;
  var g = Math.floor((e % p) / r);
  var h = u * g + w;
  var D = Math.floor((h % s) / u) + 1;
  var M = ((Math.floor(h / s) + m) % n) + 1;
  var Y = Math.floor(e / p) - y + Math.floor((n + m - M) / n);
  return new Date(Y, M - 1, D).valueOf();
}
