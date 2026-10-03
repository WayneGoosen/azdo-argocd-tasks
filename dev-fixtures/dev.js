// Drives the tab against fixture files, with no Azure DevOps present.
//
// tab.js exposes its exports on window.ArgoCDTab (webpack `library`), so the orchestrator
// exercised here is exactly the one production uses -- only the fetcher differs.

(function () {
    var FIXTURES = [
        { name: 'ArgoCDApp-sync-1', file: 'sample-sync.json' },
        { name: 'ArgoCDAppSet-generate-1', file: 'sample-appset.json' },
        { name: 'ArgoCDProject-list-tokens-1', file: 'sample-tokens.json' },
        { name: 'ArgoCDApp-sync-2 (failed)', file: 'sample-failed.json' },
    ];

    var refs = FIXTURES.map(function (f) {
        return { name: f.name, timelineId: 'dev', recordId: f.file };
    });

    // ?start=N opens on that fixture. renderRuns always shows refs[0], so rotate rather than
    // filter -- that keeps the selector populated and exercises it the same way.
    var start = Number(new URLSearchParams(location.search).get('start') || 0);
    if (start > 0 && start < refs.length) {
        refs = refs.slice(start).concat(refs.slice(0, start));
    }

    // ?slow=N pads each fetch so the loading state is visible long enough to inspect.
    var slow = Number(new URLSearchParams(location.search).get('slow') || 0);

    var fetcher = function (ref) {
        return fetch(ref.recordId)
            .then(function (r) { return r.json(); })
            .then(function (json) {
                return slow > 0 ? new Promise(function (ok) { setTimeout(function () { ok(json); }, slow); }) : json;
            });
    };

    document.getElementById('dark').addEventListener('change', function (e) {
        if (e.target.checked) {
            document.documentElement.setAttribute('data-dev-dark', '');
        } else {
            document.documentElement.removeAttribute('data-dev-dark');
        }
    });

    window.ArgoCDTab.renderRuns(refs, fetcher, document.getElementById('container'));
})();
