import { describe, expect, it } from 'vitest';
import {
    OpaqueSpec,
    kustomizeImageKey,
    kustomizeImageMatches,
    mergeKustomizeImage,
    normalizeSource,
    removeHelmParameter,
    removeHelmValueFile,
    removeKustomizeImage,
    selectSource,
    setHelmValueFiles,
    setTargetRevision,
    upsertHelmParameter,
} from '../src/spec-mutation';

/**
 * A spec containing plenty of fields the narrow ApplicationSpec type does NOT model.
 * If any mutation rebuilds the spec instead of mutating it, these disappear -- and the
 * server would then delete them, because PUT /spec is a full replace.
 */
function richSpec(): OpaqueSpec {
    return {
        project: 'payments',
        source: {
            repoURL: 'https://example.com/gitops',
            path: 'apps/payments',
            targetRevision: 'HEAD',
            helm: { valueFiles: ['values.yaml'], parameters: [{ name: 'image.tag', value: '1.0.0' }] },
        },
        destination: { server: 'https://kubernetes.default.svc', namespace: 'payments' },
        syncPolicy: {
            automated: { prune: true, selfHeal: true },
            retry: { limit: 5, backoff: { duration: '5s', factor: 2 } },
            syncOptions: ['CreateNamespace=true'],
        },
        ignoreDifferences: [{ group: 'apps', kind: 'Deployment', jsonPointers: ['/spec/replicas'] }],
        info: [{ name: 'owner', value: 'payments-team' }],
        revisionHistoryLimit: 20,
        managedNamespaceMetadata: { labels: { team: 'payments' } },
    };
}

/** Everything except the source, which mutations legitimately change. */
function untouchedParts(spec: OpaqueSpec): Record<string, unknown> {
    const { source, sources, ...rest } = spec as Record<string, unknown>;
    void source;
    void sources;
    return rest;
}

describe('no field loss (the property that matters)', () => {
    it.each([
        ['upsertHelmParameter', (s: OpaqueSpec) => upsertHelmParameter(selectSource(s), { name: 'a', value: 'b' })],
        ['removeHelmParameter', (s: OpaqueSpec) => removeHelmParameter(selectSource(s), 'image.tag')],
        ['setHelmValueFiles', (s: OpaqueSpec) => setHelmValueFiles(selectSource(s), ['prod.yaml'])],
        ['removeHelmValueFile', (s: OpaqueSpec) => removeHelmValueFile(selectSource(s), 'values.yaml')],
        ['mergeKustomizeImage', (s: OpaqueSpec) => mergeKustomizeImage(selectSource(s), 'nginx:1.2')],
        ['setTargetRevision', (s: OpaqueSpec) => setTargetRevision(selectSource(s), 'v2')],
        ['normalizeSource', (s: OpaqueSpec) => normalizeSource(selectSource(s))],
    ])('%s preserves every unmodelled spec field', (_name, mutate) => {
        const spec = richSpec();
        const before = JSON.parse(JSON.stringify(untouchedParts(spec)));

        mutate(spec);

        expect(untouchedParts(spec)).toEqual(before);
    });

    it('preserves unmodelled fields INSIDE the source it edits', () => {
        const spec = richSpec();
        (spec['source'] as Record<string, unknown>)['plugin'] = { name: 'my-plugin', env: [{ name: 'A', value: '1' }] };
        (spec['source'] as Record<string, unknown>)['ref'] = 'values';

        upsertHelmParameter(selectSource(spec), { name: 'image.tag', value: '2.0.0' });

        const source = spec['source'] as Record<string, unknown>;
        expect(source['plugin']).toEqual({ name: 'my-plugin', env: [{ name: 'A', value: '1' }] });
        expect(source['ref']).toBe('values');
        expect(source['repoURL']).toBe('https://example.com/gitops');
    });

    it('preserves unrelated helm fields when changing parameters', () => {
        const spec = richSpec();
        const helm = (spec['source'] as Record<string, unknown>)['helm'] as Record<string, unknown>;
        helm['releaseName'] = 'payments';
        helm['passCredentials'] = true;

        upsertHelmParameter(selectSource(spec), { name: 'new', value: 'x' });

        expect(helm['releaseName']).toBe('payments');
        expect(helm['passCredentials']).toBe(true);
        expect(helm['valueFiles']).toEqual(['values.yaml']);
    });
});

describe('selectSource', () => {
    it('returns the single source when there is one', () => {
        expect(selectSource(richSpec())['path']).toBe('apps/payments');
    });

    it('uses 1-BASED positions for multi-source apps', () => {
        const spec: OpaqueSpec = { sources: [{ path: 'first' }, { path: 'second' }] };
        expect(selectSource(spec, 1)['path']).toBe('first');
        expect(selectSource(spec, 2)['path']).toBe('second');
    });

    it('treats a single-entry sources array as multi-source', () => {
        // An app with sources:[one] is still multi-source upstream.
        const spec: OpaqueSpec = { sources: [{ path: 'only' }] };
        expect(selectSource(spec)['path']).toBe('only');
    });

    it('requires a position when several sources exist', () => {
        const spec: OpaqueSpec = { sources: [{ path: 'a' }, { path: 'b' }] };
        expect(() => selectSource(spec)).toThrow(/sourcePosition/);
    });

    it('rejects an out-of-range position', () => {
        const spec: OpaqueSpec = { sources: [{ path: 'a' }] };
        expect(() => selectSource(spec, 2)).toThrow(/out of range/);
        expect(() => selectSource(spec, 0)).toThrow(/out of range/);
    });

    it('rejects a position on a single-source app', () => {
        expect(() => selectSource(richSpec(), 2)).toThrow(/single source/);
    });

    it('fails clearly when there is no source at all', () => {
        expect(() => selectSource({ project: 'x' })).toThrow(/no source/);
    });
});

describe('helm parameters', () => {
    it('replaces an existing parameter by name, in place', () => {
        const spec = richSpec();
        upsertHelmParameter(selectSource(spec), { name: 'image.tag', value: '2.0.0' });
        const parameters = ((spec['source'] as any).helm.parameters as unknown[]);
        expect(parameters).toHaveLength(1);
        expect(parameters[0]).toEqual({ name: 'image.tag', value: '2.0.0' });
    });

    it('appends a parameter with a new name', () => {
        const spec = richSpec();
        upsertHelmParameter(selectSource(spec), { name: 'replicas', value: '3' });
        expect((spec['source'] as any).helm.parameters).toHaveLength(2);
    });

    it('sets forceString only when asked', () => {
        const spec = richSpec();
        upsertHelmParameter(selectSource(spec), { name: 'a', value: '1', forceString: true });
        const added = ((spec['source'] as any).helm.parameters as any[]).find((p) => p.name === 'a');
        expect(added.forceString).toBe(true);

        upsertHelmParameter(selectSource(spec), { name: 'b', value: '1' });
        const plain = ((spec['source'] as any).helm.parameters as any[]).find((p) => p.name === 'b');
        expect(plain).not.toHaveProperty('forceString');
    });

    it('creates the helm block when absent', () => {
        const spec: OpaqueSpec = { source: { repoURL: 'x' } };
        upsertHelmParameter(selectSource(spec), { name: 'a', value: '1' });
        expect((spec['source'] as any).helm.parameters).toEqual([{ name: 'a', value: '1' }]);
    });

    it('removes by name and reports whether it did', () => {
        const spec = richSpec();
        expect(removeHelmParameter(selectSource(spec), 'image.tag')).toBe(true);
        expect((spec['source'] as any).helm.parameters).toEqual([]);
        expect(removeHelmParameter(selectSource(spec), 'missing')).toBe(false);
    });
});

describe('helm value files', () => {
    it('REPLACES the whole array rather than appending', () => {
        const spec = richSpec();
        setHelmValueFiles(selectSource(spec), ['prod.yaml', 'secrets.yaml']);
        expect((spec['source'] as any).helm.valueFiles).toEqual(['prod.yaml', 'secrets.yaml']);
    });

    it('removes one file by exact match', () => {
        const spec = richSpec();
        expect(removeHelmValueFile(selectSource(spec), 'values.yaml')).toBe(true);
        expect((spec['source'] as any).helm.valueFiles).toEqual([]);
        expect(removeHelmValueFile(selectSource(spec), 'nope.yaml')).toBe(false);
    });
});

describe('kustomize image keys', () => {
    it.each([
        ['nginx:1.2', 'nginx'],
        // Upstream checks ':' BEFORE '@', so a digest image keys on "name@sha256".
        ['nginx@sha256:abc', 'nginx@sha256'],
        ['old=new:1.0', 'old'],
        ['registry.io/team/app:1.0', 'registry.io/team/app'],
        ['plain', 'plain'],
    ])('keys %s on %s', (image, key) => {
        expect(kustomizeImageKey(image)).toBe(key);
    });

    it('prefers = over : and @, matching upstream precedence', () => {
        // `old=new:tag` keys on `old`, not `old=new`.
        expect(kustomizeImageKey('old=new:tag')).toBe('old');
        expect(kustomizeImageKey('old=new@sha256:abc')).toBe('old');
    });

    it('matches two digests of the same image', () => {
        expect(kustomizeImageMatches('nginx@sha256:aaa', 'nginx@sha256:bbb')).toBe(true);
    });

    it('does NOT match a tag against a digest, faithfully to upstream', () => {
        // Keys are "nginx" vs "nginx@sha256", so moving an image from a tag to a digest
        // APPENDS rather than replaces. Surprising, but it is what Argo CD does, and
        // diverging here would make our merge disagree with the CLI's.
        expect(kustomizeImageMatches('nginx:1.2', 'nginx@sha256:abc')).toBe(false);
    });

    it('matches images sharing a key', () => {
        expect(kustomizeImageMatches('nginx:1.2', 'nginx:1.3')).toBe(true);
        expect(kustomizeImageMatches('nginx:1.2', 'redis:1.2')).toBe(false);
    });
});

describe('kustomize images', () => {
    it('replaces a matching image in place, preserving order', () => {
        const spec: OpaqueSpec = { source: { kustomize: { images: ['redis:1.0', 'nginx:1.2'] } } };
        mergeKustomizeImage(selectSource(spec), 'nginx:1.3');
        expect((spec['source'] as any).kustomize.images).toEqual(['redis:1.0', 'nginx:1.3']);
    });

    it('appends an image with a new key', () => {
        const spec: OpaqueSpec = { source: { kustomize: { images: ['redis:1.0'] } } };
        mergeKustomizeImage(selectSource(spec), 'nginx:1.3');
        expect((spec['source'] as any).kustomize.images).toEqual(['redis:1.0', 'nginx:1.3']);
    });

    it('creates the kustomize block when absent', () => {
        const spec: OpaqueSpec = { source: { repoURL: 'x' } };
        mergeKustomizeImage(selectSource(spec), 'nginx:1.3');
        expect((spec['source'] as any).kustomize.images).toEqual(['nginx:1.3']);
    });

    it('removes by key, not by exact string', () => {
        const spec: OpaqueSpec = { source: { kustomize: { images: ['nginx:1.2'] } } };
        expect(removeKustomizeImage(selectSource(spec), 'nginx')).toBe(true);
        expect((spec['source'] as any).kustomize.images).toEqual([]);
    });
});

describe('normalizeSource', () => {
    it('drops a helm block that has become empty', () => {
        const spec: OpaqueSpec = { source: { repoURL: 'x', helm: { parameters: [], valueFiles: [] } } };
        normalizeSource(selectSource(spec));
        expect((spec['source'] as any).helm).toBeUndefined();
    });

    it('drops an empty kustomize block', () => {
        const spec: OpaqueSpec = { source: { repoURL: 'x', kustomize: { images: [] } } };
        normalizeSource(selectSource(spec));
        expect((spec['source'] as any).kustomize).toBeUndefined();
    });

    it('keeps a block that still has content', () => {
        const spec = richSpec();
        normalizeSource(selectSource(spec));
        expect((spec['source'] as any).helm).toBeDefined();
    });

    it('leaves other source fields alone', () => {
        const spec: OpaqueSpec = { source: { repoURL: 'x', path: 'p', helm: {} } };
        normalizeSource(selectSource(spec));
        expect(spec['source']).toEqual({ repoURL: 'x', path: 'p' });
    });
});
