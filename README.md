# Iris

Named after **Iris, the Greek goddess of the rainbow**.

Iris is the shared testing framework extracted from Moon: a lazy Vitest runner,
comment-based test tracks, and the rainbow reporter. It runs in the consuming
project's directory and uses that project's Vitest configuration and dependencies.
Requires Node.js 22.23.1 or later and Vitest 5.

## Use in a project

Install Iris alongside Vitest:

```sh
npm install --save-dev @raincheck/iris vitest@5
```

The package contains compiled JavaScript and declarations. It runs from
`node_modules` without TypeScript stripping or a checkout of Moon or Iris.
The lockfile pins the registry release for reproducible installs and builds.

Use `iris` in package scripts:

```json
{
  "scripts": {
    "test": "iris",
    "test:all": "iris --force",
    "test:primes": "iris --track primes"
  }
}
```

The reporter is optional and also works with Vitest directly:

```js
import IrisReporter from "@raincheck/iris/reporter";

export default {
  test: { reporters: [new IrisReporter()] },
};
```

## Selection and caching

`npm test` runs new or changed test files. `npm run test:all` forces the whole
suite. File filters and Vitest options pass through, such as
`npm test -- prime-height` or `npm test -- --reporter=dot`.
Append `--list` to inspect the selection without running tests or writing the
registry. `PRE_COMMIT_RECHECK=1` also forces a fresh run, for use in Git hooks.
Watch mode uses Vitest directly and accepts file filters rather than tracks.

Add project-specific tracks in a test file:

```ts
// track: primes ui
```

Pass `--track` more than once to select the union of those tracks. A selection
that matches no tests fails. New files without tracks still run with `npm test`.
All tracks share the registry at `node_modules/.cache/iris/test-registry.json`
under the configured Vitest root. The reporter keeps progress estimates in
`node_modules/.cache/iris/test-counts.json` under the same root.

Fingerprints cover each test's transitive Vite import graph, aliases, re-exports,
static dynamic imports, glob membership, virtual output, raw assets, setup files,
configuration and plugin sources, package locks, Iris itself, Node version,
environment values, and local `.env` files. Environment values are hashed and
never stored in the registry. Use `--force` after manually changing installed
dependencies.

Declare filesystem inputs outside imports using project-relative globs:

```ts
// test-input: fixtures/**/*.json
```

Tests depending on live services, time, or other untracked state can opt out:

```ts
// test-cache: never
```

Failures, interruptions, focused (`only`) runs, partial selections, coverage,
and inputs changed during execution never establish a cached pass. Declared
`skip` and `todo` cases are respected. Forced runs invalidate previous passes
before execution. Missing or corrupt registries cause tests to run again.
Concurrent commands serialize registry access and replace it atomically;
locks left by terminated processes can be recovered.

## Reporter

The reporter displays per-file results, a rainbow progress bar in terminals,
and failure diagnostics. Its heading defaults to `R A I N C H E C K`. Pass
`name` to change the heading and `spaceLetters: false` to disable letter spacing:

```js
new IrisReporter(); // R A I N C H E C K
new IrisReporter({ name: "IRIS" }); // I R I S
new IrisReporter({ spaceLetters: false }); // RAINCHECK
new IrisReporter({ name: "IRIS", spaceLetters: false }); // IRIS
```

`name` defaults to `"RAINCHECK"` and preserves the supplied capitalization;
`spaceLetters` defaults to `true`. Rainbow coloring applies in terminals with
either spacing setting.

Configure the bar with `IRIS_BAR_WIDTH` (0 fits the
terminal), `IRIS_BAR_COLOR` (`truecolor`, `single`, or `legacy`), and
`IRIS_BAR_PALETTE` (comma-separated ANSI color codes). The corresponding
`RAINCHECK_BAR_*` variables remain supported as fallbacks.

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

`src/cli.ts` owns selection and execution; `src/testRegistry.ts` owns fingerprints,
locking, and cached passes; `src/reporter.js` owns presentation. Tests run the
compiled package from fixture projects to exercise consumer behavior. The
framework's own tests use Vitest directly so they always validate the runner.

## Publishing

The scoped package publishes publicly to npm. From this checkout:

```sh
npm ci
npm publish --dry-run
npm publish
```

`prepublishOnly` type-checks and runs the regression suite before publication;
`prepack` compiles the package. Only `dist/`, the README, and the package manifest
are shipped. Bump the version before subsequent releases, then update consuming
projects with `npm install --save-dev @raincheck/iris@latest`.
