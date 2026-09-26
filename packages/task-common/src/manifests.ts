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
                `Document ${index + 1} of "${fileName}" has kind "${String(kind ?? 'none')}", not ` +
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

/** Name of a manifest, for logging. */
export function manifestName(manifest: Record<string, unknown>): string {
    return String((manifest['metadata'] as Record<string, unknown> | undefined)?.['name'] ?? '');
}
