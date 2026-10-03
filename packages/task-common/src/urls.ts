import { trimSlashes } from '@azdo-argocd/argocd-client';
// Deep links into the Argo CD UI.
//
// Kept free of azure-pipelines-task-lib so the summary renderer stays pure: importing
// task-lib runs its module-level initialisation, which emits agent debug output and
// reads pipeline environment variables the moment the module loads.

/** Deep link into the Argo CD UI for an application. */
export function applicationUrl(serverUrl: string, name: string, appNamespace?: string): string {
    const base = trimSlashes(serverUrl);
    // Argo CD routes app-in-any-namespace applications under /applications/<ns>/<name>.
    return appNamespace === undefined || appNamespace === ''
        ? `${base}/applications/${encodeURIComponent(name)}`
        : `${base}/applications/${encodeURIComponent(appNamespace)}/${encodeURIComponent(name)}`;
}
