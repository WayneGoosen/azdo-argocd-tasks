// Parsing human token lifetimes into seconds.
//
// Argo CD's API takes `expiresIn` as an int64 number of SECONDS. The friendly "90d" form
// is CLI-side sugar -- the CLI parses it and sends seconds -- so a task offering the same
// convenience has to do the conversion itself.
//
// Why this rejects rather than defaults: `expiresIn: 0` means the token NEVER EXPIRES. A
// lenient parser that returned 0 for an unrecognised value would silently mint permanent
// credentials from a typo, which is the worst possible failure for this particular field.

const UNIT_SECONDS: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
};

const DURATION_PATTERN = /^(\d+)([smhdw]?)$/i;

/** A bare number is seconds, matching the API's own unit. */
export function parseDurationSeconds(raw: string): number {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === '') {
        throw new Error('No duration was given.');
    }

    const match = DURATION_PATTERN.exec(trimmed);
    if (match === null) {
        throw new Error(
            `"${raw}" is not a valid duration. Use a number of seconds, or a number with a unit: ` +
                's (seconds), m (minutes), h (hours), d (days), w (weeks). For example "90d".',
        );
    }

    const amount = Number.parseInt(match[1] as string, 10);
    const unit = (match[2] as string) === '' ? 's' : (match[2] as string);
    return amount * (UNIT_SECONDS[unit] as number);
}

/** Render seconds back for logging, so the task echoes what it actually requested. */
export function describeDurationSeconds(seconds: number): string {
    if (seconds <= 0) {
        return 'never expires';
    }
    for (const [unit, size] of [
        ['week', UNIT_SECONDS['w'] as number],
        ['day', UNIT_SECONDS['d'] as number],
        ['hour', UNIT_SECONDS['h'] as number],
        ['minute', UNIT_SECONDS['m'] as number],
    ] as Array<[string, number]>) {
        if (seconds % size === 0) {
            const amount = seconds / size;
            return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
        }
    }
    return `${seconds} seconds`;
}

/** Format a unix timestamp from a token, where 0 means no expiry. */
export function describeExpiry(unixSeconds: number | undefined): string {
    if (unixSeconds === undefined || unixSeconds === 0) {
        return 'never';
    }
    return new Date(unixSeconds * 1000).toISOString();
}
