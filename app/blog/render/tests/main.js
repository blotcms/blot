const main = require('../main');
const Mustache = require('mustache');

describe('template engine main', () => {
    it('bounds Mustache.templateCache instead of growing it forever (#1851)', () => {
        // renderLocals runs every entry field containing '{{' through this
        // render function, so unique entry content must not accumulate in
        // Mustache's process-global template cache forever.
        for (let i = 0; i < 1000; i++) {
            main(`unique entry content ${i} {{x}}`, { x: i }, {});
        }

        expect(Mustache.templateCache.size).toBeLessThan(1000);
    });

    it('should render content with locals and partials', () => {
        const content = 'content {{locals}} {{> partials}}';
        const locals = { locals: 'locals' };
        const partials = { partials: 'partials' };
        expect(main).toBeDefined();
        expect(main(content, locals, partials)).toBe('content locals partials');
    });

    it('should throw error if content is not a string', () => {
        const content = 123;
        const locals = { locals: 'locals' };
        const partials = { partials: 'partials' };
        expect(() => main(content, locals, partials)).toThrow();
    });

    it('should throw error if locals is not an object', () => {
        const content = 'content {{locals}} {{> partials}}';
        const locals = 'locals';
        const partials = { partials: 'partials' };
        expect(() => main(content, locals, partials)).toThrow();
    });

    it('should throw an error if there is an infinite loop of partials', () => {
        const content = 'content {{> partials}}';
        const locals = {};
        const partials = { partials: content };
        expect(() => main(content, locals, partials)).toThrow(new Error('Your template has infinitely nested partials'));
    });

    it('should throw an error if there is an unclosed tag', () => {
        const content = 'content {{> partials}';
        const locals = {};
        const partials = {};
        expect(() => main(content, locals, partials)).toThrow(new Error('Your template has an unclosed tag'));
    });
});