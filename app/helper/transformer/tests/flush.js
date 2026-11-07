describe("transformer", function () {
  // Creates test environment
  require("./setup")({});

  it("flushes its cache of existing transformations", async function () {
    var firstTransform = jasmine.createSpy().and.callFake(this.transform);
    var secondTransform = jasmine.createSpy().and.callFake(this.transform);

    const firstResult = await this.transformer.lookup(
      this.path,
      firstTransform
    );

    await this.transformer.flush();

    const secondResult = await this.transformer.lookup(
      this.path,
      secondTransform
    );

    expect(firstTransform).toHaveBeenCalled();
    expect(secondTransform).toHaveBeenCalled();
    expect(firstResult).toEqual(secondResult);
  });
});
