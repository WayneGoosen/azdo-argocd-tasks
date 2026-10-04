// Small string helpers shared across the packages.

const SLASH = 47; // '/'

/**
 * Strip slashes from the ends of a string, in linear time.
 *
 * WHY NOT `value.replace(/\/+$/, '')`, which this replaces in six places: that regex is
 * POLYNOMIAL. `/+` is greedy with no possessive form in JavaScript, so when the `$` anchor
 * fails the engine retries the run from every subsequent position -- O(n²) for a string of
 * n slashes followed by anything else. Measured on Node 20:
 *
 *     20,000 slashes -> 168ms      40,000 -> 659ms      80,000 -> 2,618ms
 *
 * Nothing here takes attacker-controlled input today: these are service-connection URLs,
 * task inputs and pipeline variables, so the realistic worst case is a pipeline author
 * hanging their own agent. It is still two loops to avoid entirely, it reads more plainly
 * than the regex, and it clears six standing CodeQL `js/polynomial-redos` alerts.
 */
export function trimSlashes(value: string, ends: 'end' | 'both' = 'end'): string {
    let start = 0;
    let stop = value.length;
    while (stop > start && value.charCodeAt(stop - 1) === SLASH) {
        stop -= 1;
    }
    if (ends === 'both') {
        while (start < stop && value.charCodeAt(start) === SLASH) {
            start += 1;
        }
    }
    return value.slice(start, stop);
}
