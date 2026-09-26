import { describe, expect, it } from 'vitest';
import { parseActionParameters } from '../operations/actions';

describe('parseActionParameters', () => {
    it('parses name=value lines', () => {
        expect(parseActionParameters(['replicas=3', 'force=true'])).toEqual([
            { name: 'replicas', value: '3' },
            { name: 'force', value: 'true' },
        ]);
    });

    it('splits on the FIRST equals only, so values may contain one', () => {
        expect(parseActionParameters(['selector=app=payments'])).toEqual([
            { name: 'selector', value: 'app=payments' },
        ]);
    });

    it('trims surrounding whitespace', () => {
        expect(parseActionParameters(['  replicas = 3  '])).toEqual([{ name: 'replicas', value: '3' }]);
    });

    it('skips blank and comment lines', () => {
        expect(parseActionParameters(['', '# why', 'a=b'])).toEqual([{ name: 'a', value: 'b' }]);
    });

    it('allows an empty value', () => {
        expect(parseActionParameters(['a='])).toEqual([{ name: 'a', value: '' }]);
    });

    it('rejects a line with no equals, rather than guessing', () => {
        expect(() => parseActionParameters(['replicas 3'])).toThrow(/Use name=value/);
    });

    it('returns nothing for no input', () => {
        expect(parseActionParameters([])).toEqual([]);
    });
});
