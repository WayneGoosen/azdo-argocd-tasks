// Parsing Kubernetes manifests from a file.
//
// Shared by the `create` commands of ArgoCDApp and ArgoCDAppSet, which differ only in the
// kind they expect. YAML is a superset of JSON, so one parser covers both formats, and
// multi-document YAML is supported so an app-of-apps or multi-appset bootstrap file works
// in a single step.

import * as yaml from 'js-yaml';

export function parseKubernetesManifests(
    content: string,
    fileName: string,
    expectedKind: string,
): Array<Record<string, unknown>> {
    let documents: unknown[];
    try {
        documents = yaml.loadAll(content);
    } catch (error) {
        throw new Error(`Could not parse "${fileName}": ${(error as Error).message}`);
    }

    const manifests = documents.filter(
        (doc): doc is Record<string, unknown> =>
            typeof doc === 'object' && doc !== null && !Array.isArray(doc),
    );

    if (manifests.length === 0) {
        throw new Error(`"${fileName}" contains no manifests.`);
    }

    for (const [index, manifest] of manifests.entries()) {
        const kind = manifest['kind'];
        if (kind !== expectedKind) {
            throw new Error(
                `Document ${index + 1} of "${fileName}" has kind "${describeValue(kind)}", not ` +
                    `"${expectedKind}". This command creates ${expectedKind} resources only.`,
            );
        }
        const metadata = manifest['metadata'] as Record<string, unknown> | undefined;
        if (metadata?.['name'] === undefined || metadata['name'] === '') {
            throw new Error(`Document ${index + 1} of "${fileName}" has no metadata.name.`);
        }
    }

    return manifests;
}

/**
 * Render a parsed-YAML value for an error message.
 *
 * Values here come from user YAML and are `unknown`: `kind: {a: b}` is malformed but
 * perfectly parseable. Plain String() would report it as "[object Object]" -- the least
 * helpful possible message at exactly the moment someone needs to find their typo.
 */
function describeValue(value: unknown): string {
    if (value === undefined || value === null) {
        return 'none';
    }
    switch (typeof value) {
        case 'string':
            return value;
        case 'number':
        case 'boolean':
        case 'bigint':
            return String(value);
        case 'symbol':
            // String(symbol) is legal but `${symbol}` throws; be explicit either way.
            return value.toString();
        default:
            // Objects, arrays and functions. JSON.stringify returns undefined for a
            // function or a bare symbol, hence the fallback.
            return JSON.stringify(value) ?? Object.prototype.toString.call(value);
    }
}

/** Name of a manifest, for logging. */
export function manifestName(manifest: Record<string, unknown>): string {
    const name = (manifest['metadata'] as Record<string, unknown> | undefined)?.['name'];
    return name === undefined ? '' : describeValue(name);
}
