// Webpack config for the "Argo CD" build-results tab.
//
// WHY WEBPACK AND NOT ESBUILD, which bundles every task in this repo:
// `azure-devops-extension-api` ships ONLY AMD modules. esbuild cannot consume AMD inputs at
// all; webpack handles them natively. This is the one part of the build that does not use the
// repo's normal toolchain, and it is not a preference.
//
// Output is an IIFE exposing tab.ts's named exports on `window.ArgoCDTab`, so the local dev
// harness can drive rendering directly against fixtures with no Azure DevOps present.

const path = require('path');

module.exports = (_env, argv) => ({
    mode: argv.mode === 'development' ? 'development' : 'production',
    entry: './tab/tab.ts',
    devtool: 'source-map',
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: {
                    loader: 'ts-loader',
                    // tsconfig.tab.json sets noEmit for the standalone typecheck script;
                    // webpack needs the emit, so flip it back here rather than keeping two
                    // near-identical configs.
                    options: { configFile: 'tsconfig.tab.json', compilerOptions: { noEmit: false } },
                },
            },
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {
            // FORCE A SINGLE SDK COPY.
            //
            // The api package's AMD modules `define([...])` their own dependency on
            // 'azure-devops-extension-sdk', and that package's `exports` map can resolve our
            // ESM `import` and their AMD require to two DIFFERENT files. Two SDK instances in
            // one bundle means the second trips the SDK's "already loaded" guard, after which
            // SDK.init()/getService() never resolve -- the tab sits on its loading state
            // forever with nothing logged. Aliasing both at the real file bypasses the
            // exports map and keeps one instance.
            'azure-devops-extension-sdk$': path.resolve(__dirname, 'node_modules/azure-devops-extension-sdk/SDK.js'),
        },
    },
    output: {
        path: path.resolve(__dirname, 'dist/tab'),
        filename: 'tab.js',
        library: { name: 'ArgoCDTab', type: 'window' },
    },
    performance: {
        // The bundled SDK is ~100 KiB on its own, past webpack's default budget. Expected.
        hints: false,
    },
});
