// Mutating an Application spec in place.
//
// THE RULE THAT MATTERS: never reconstruct a spec, only mutate it.
//
// PUT /api/v1/applications/{name}/spec is a FULL REPLACE -- the server overwrites .spec
// wholesale with the request body, so any field missing from the body is DELETED. Our
// ApplicationSpec type models about six fields out of twenty, but that is a compile-time
// view only: JSON.parse keeps everything, so mutating the parsed object is lossless while
// rebuilding one from typed fields would silently destroy a user's ignoreDifferences, info,
// syncPolicy.retry, plugin configuration and so on.
//
// Everything here therefore works on an opaque record and mutates in place. The
// no-field-loss test is the one that guards this property.
//
// These functions also replicate Argo CD's own merge semantics, which are not uniform:
//   * Helm parameters UPSERT by name.
//   * valueFiles is a WHOLE-ARRAY REPLACE.
//   * Kustomize images merge by a key with delimiter precedence (see kustomizeImageKey).

export type OpaqueSpec = Record<string, unknown>;
export type OpaqueSource = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
    return Array.isArray(value) ? value : undefined;
}

/** Get or create a nested object, mutating the parent. */
function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
    const existing = asRecord(parent[key]);
    if (existing !== undefined) {
        return existing;
    }
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
}

/**
 * Pick the source to mutate.
 *
 * An application is multi-source whenever `sources` is non-empty -- even with a single
 * entry -- and positions are 1-BASED. Getting that wrong would edit the wrong source of a
 * multi-source app, so a position is required rather than guessed.
 */
export function selectSource(spec: OpaqueSpec, position?: number | undefined): OpaqueSource {
    const sources = asArray(spec['sources']);

    if (sources !== undefined && sources.length > 0) {
        if (position === undefined) {
            if (sources.length > 1) {
                throw new Error(
                    `This application has ${sources.length} sources. Set "sourcePosition" to choose ` +
                        'which one to modify (1 for the first).',
                );
            }
            const only = asRecord(sources[0]);
            if (only === undefined) {
                throw new Error('The application\'s first source is not an object.');
            }
            return only;
        }
        if (position < 1 || position > sources.length) {
            throw new Error(
                `"sourcePosition" ${position} is out of range: this application has ${sources.length} source(s), ` +
                    'numbered from 1.',
            );
        }
        const selected = asRecord(sources[position - 1]);
        if (selected === undefined) {
            throw new Error(`Source at position ${position} is not an object.`);
        }
        return selected;
    }

    if (position !== undefined && position !== 1) {
        throw new Error(
            `"sourcePosition" ${position} was given, but this application has a single source. ` +
                'Omit it, or use 1.',
        );
    }
    const source = asRecord(spec['source']);
    if (source === undefined) {
        throw new Error('This application has no source to modify.');
    }
    return source;
}

// ---- Helm parameters ----

export interface HelmParameterInput {
    name: string;
    value: string;
    forceString?: boolean;
}

/** Upsert by name: replace the matching entry in place, else append. */
export function upsertHelmParameter(source: OpaqueSource, parameter: HelmParameterInput): void {
    const helm = ensureRecord(source, 'helm');
    const parameters = asArray(helm['parameters']) ?? [];
    helm['parameters'] = parameters;

    const entry: Record<string, unknown> = { name: parameter.name, value: parameter.value };
    if (parameter.forceString === true) {
        entry['forceString'] = true;
    }

    const index = parameters.findIndex((item) => asRecord(item)?.['name'] === parameter.name);
    if (index >= 0) {
        parameters[index] = entry;
    } else {
        parameters.push(entry);
    }
}

/** Remove by name. Returns whether anything was removed. */
export function removeHelmParameter(source: OpaqueSource, name: string): boolean {
    const helm = asRecord(source['helm']);
    const parameters = asArray(helm?.['parameters']);
    if (helm === undefined || parameters === undefined) {
        return false;
    }
    const index = parameters.findIndex((item) => asRecord(item)?.['name'] === name);
    if (index < 0) {
        return false;
    }
    parameters.splice(index, 1);
    return true;
}

// ---- Helm value files ----

/** Whole-array replace, matching `argocd app set --values`, which does not append. */
export function setHelmValueFiles(source: OpaqueSource, files: readonly string[]): void {
    ensureRecord(source, 'helm')['valueFiles'] = [...files];
}

export function removeHelmValueFile(source: OpaqueSource, file: string): boolean {
    const helm = asRecord(source['helm']);
    const files = asArray(helm?.['valueFiles']);
    if (files === undefined) {
        return false;
    }
    const index = files.indexOf(file);
    if (index < 0) {
        return false;
    }
    files.splice(index, 1);
    return true;
}

// ---- Kustomize images ----

/**
 * The key an image merges on.
 *
 * Argo CD takes everything before the FIRST delimiter, checking `=`, then `:`, then `@`.
 * So `nginx:1.2` and `nginx:1.3` share the key `nginx` and replace one another, while
 * `old=new:tag` keys on `old` because `=` is checked first.
 *
 * A quirk worth knowing, faithfully reproduced: because `:` is checked before `@`, a
 * digest image `nginx@sha256:abc` keys on `nginx@sha256`, not `nginx`. Two digests of the
 * same image therefore replace one another, but moving an image from a tag to a digest
 * APPENDS instead of replacing. Diverging from this would make our merge disagree with
 * the argocd CLI operating on the same application.
 */
export function kustomizeImageKey(image: string): string {
    for (const delimiter of ['=', ':', '@']) {
        if (image.includes(delimiter)) {
            return image.split(delimiter)[0] as string;
        }
    }
    return image;
}

export function kustomizeImageMatches(existing: string, candidate: string): boolean {
    return kustomizeImageKey(existing) === kustomizeImageKey(candidate);
}

/** Replace the entry with a matching key IN PLACE, preserving order, else append. */
export function mergeKustomizeImage(source: OpaqueSource, image: string): void {
    const kustomize = ensureRecord(source, 'kustomize');
    const images = asArray(kustomize['images']) ?? [];
    kustomize['images'] = images;

    const index = images.findIndex(
        (item) => typeof item === 'string' && kustomizeImageMatches(item, image),
    );
    if (index >= 0) {
        images[index] = image;
    } else {
        images.push(image);
    }
}

export function removeKustomizeImage(source: OpaqueSource, image: string): boolean {
    const kustomize = asRecord(source['kustomize']);
    const images = asArray(kustomize?.['images']);
    if (images === undefined) {
        return false;
    }
    const index = images.findIndex(
        (item) => typeof item === 'string' && kustomizeImageMatches(item, image),
    );
    if (index < 0) {
        return false;
    }
    images.splice(index, 1);
    return true;
}

// ---- Target revision ----

export function setTargetRevision(source: OpaqueSource, revision: string): void {
    source['targetRevision'] = revision;
}

// ---- Normalisation ----

/** True when an object has no meaningful content left. */
function isEmptyBlock(value: unknown): boolean {
    const record = asRecord(value);
    if (record === undefined) {
        return false;
    }
    return Object.values(record).every(
        (entry) =>
            entry === undefined ||
            entry === null ||
            entry === '' ||
            entry === false ||
            (Array.isArray(entry) && entry.length === 0) ||
            (asRecord(entry) !== undefined && Object.keys(entry as object).length === 0),
    );
}

/**
 * Drop `helm` / `kustomize` blocks that have become empty.
 *
 * The server normalizes these away itself, so leaving `{}` behind means the next read
 * differs from what was written -- a spurious diff that looks like drift.
 */
export function normalizeSource(source: OpaqueSource): void {
    for (const key of ['helm', 'kustomize']) {
        if (source[key] !== undefined && isEmptyBlock(source[key])) {
            delete source[key];
        }
    }
}
