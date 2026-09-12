describe("amountInWords", function () {
  const amountInWords = require("helper/amountInWords");

  it("returns 'zero' for 0", function () {
    expect(amountInWords(0)).toBe("zero");
  });

  it("converts single digits", function () {
    expect(amountInWords(1)).toBe("one");
    expect(amountInWords(2)).toBe("two");
    expect(amountInWords(3)).toBe("three");
    expect(amountInWords(4)).toBe("four");
    expect(amountInWords(5)).toBe("five");
    expect(amountInWords(6)).toBe("six");
    expect(amountInWords(7)).toBe("seven");
    expect(amountInWords(8)).toBe("eight");
    expect(amountInWords(9)).toBe("nine");
  });

  it("converts teens", function () {
    expect(amountInWords(10)).toBe("ten");
    expect(amountInWords(11)).toBe("eleven");
    expect(amountInWords(12)).toBe("twelve");
    expect(amountInWords(13)).toBe("thirteen");
    expect(amountInWords(14)).toBe("fourteen");
    expect(amountInWords(15)).toBe("fifteen");
    expect(amountInWords(16)).toBe("sixteen");
    expect(amountInWords(17)).toBe("seventeen");
    expect(amountInWords(18)).toBe("eighteen");
    expect(amountInWords(19)).toBe("nineteen");
  });

  it("converts tens", function () {
    expect(amountInWords(20)).toBe("twenty");
    expect(amountInWords(30)).toBe("thirty");
    expect(amountInWords(40)).toBe("forty");
    expect(amountInWords(50)).toBe("fifty");
    expect(amountInWords(60)).toBe("sixty");
    expect(amountInWords(70)).toBe("seventy");
    expect(amountInWords(80)).toBe("eighty");
    expect(amountInWords(90)).toBe("ninety");
  });

  it("converts compound tens", function () {
    expect(amountInWords(21)).toBe("twenty-one");
    expect(amountInWords(42)).toBe("forty-two");
    expect(amountInWords(99)).toBe("ninety-nine");
  });

  it("converts hundreds", function () {
    expect(amountInWords(100)).toBe("one hundred");
    expect(amountInWords(200)).toBe("two hundred");
    expect(amountInWords(500)).toBe("five hundred");
  });

  it("converts compound hundreds", function () {
    expect(amountInWords(101)).toBe("one hundred one");
    expect(amountInWords(110)).toBe("one hundred ten");
    expect(amountInWords(111)).toBe("one hundred eleven");
    expect(amountInWords(125)).toBe("one hundred twenty-five");
    expect(amountInWords(999)).toBe("nine hundred ninety-nine");
  });

  it("converts thousands", function () {
    expect(amountInWords(1000)).toBe("one thousand");
    expect(amountInWords(2000)).toBe("two thousand");
    expect(amountInWords(5000)).toBe("five thousand");
  });

  it("converts compound thousands", function () {
    expect(amountInWords(1001)).toBe("one thousand one");
    expect(amountInWords(1100)).toBe("one thousand one hundred");
    expect(amountInWords(1234)).toBe(
      "one thousand two hundred thirty-four"
    );
    expect(amountInWords(9999)).toBe(
      "nine thousand nine hundred ninety-nine"
    );
  });

  it("converts millions", function () {
    expect(amountInWords(1000000)).toBe("one million");
    expect(amountInWords(2500000)).toBe("two million five hundred thousand");
  });

  it("converts billions", function () {
    expect(amountInWords(1000000000)).toBe("one billion");
  });

  it("converts trillions", function () {
    expect(amountInWords(1000000000000)).toBe("one trillion");
  });

  it("handles complex numbers", function () {
    expect(amountInWords(123456)).toBe(
      "one hundred twenty-three thousand four hundred fifty-six"
    );
  });
});
