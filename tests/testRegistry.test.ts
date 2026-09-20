import { execFile } from "node:child_process";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { environmentHash, testMetadata } from "../src/testRegistry.js";

const execute = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const fixtures: string[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "iris-test-registry-"));
  fixtures.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(
    path.resolve("node_modules/vitest"),
    path.join(root, "node_modules/vitest")
  );
  const installed = path.join(root, "node_modules/@raincheck/iris");
  await mkdir(installed, { recursive: true });
  await cp(path.join(packageRoot, "dist"), path.join(installed, "dist"), { recursive: true });
  await cp(path.join(packageRoot, "package.json"), path.join(installed, "package.json"));
  await mkdir(path.join(root, "fixtures"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module" }),
    "vitest.config.mjs": `
      import { readFileSync } from 'node:fs';
      export default {
        resolve: { alias: { '@subject': new URL('./alpha.js', import.meta.url).pathname } },
        plugins: [{ name: 'fixture',
          resolveId(id) { if (id === 'virtual:message') return '\\0virtual:message'; },
          load(id) { if (id === '\\0virtual:message') return 'export default ' + JSON.stringify(readFileSync(new URL('./message.txt', import.meta.url), 'utf8')); },
        }],
        test: { reporters: ['dot'], maxWorkers: 1 },
      };
    `,
    "helper.js": "export const value = 1;",
    "alpha.js": "export { value } from './helper.js';",
    "beta.js": "export const value = 2;",
    "dynamic.js": "export const value = 3;",
    "shader.glsl": "in vec2 position;",
    "message.txt": "hello",
    "fixtures/first.json": "{}",
    "alpha.test.js": `// track: auth ui
      import { test, expect } from 'vitest';
      import { existsSync } from 'node:fs';
      import { value } from '@subject';
      import shader from './shader.glsl?raw';
      import message from 'virtual:message';
      const fixtures = import.meta.glob('./fixtures/*.json', { eager: true });
      test('alpha', async () => {
        expect(existsSync(new URL('./fail.flag', import.meta.url))).toBe(false);
        expect(value).toBe(1);
        expect(shader).toContain('vec2');
        expect(typeof message).toBe('string');
        expect(Object.keys(fixtures).length).toBeGreaterThan(0);
        expect((await import('./dynamic.js')).value).toBe(3);
      });
      test('second assertion', () => expect(value).toBe(1));
    `,
    "beta.test.js": `// track: ui
      import { test, expect } from 'vitest';
      import { value } from './beta.js';
      test('beta', () => expect(value).toBe(2));
    `,
  };
  for (const [filename, source] of Object.entries(files)) {
    await writeFile(path.join(root, filename), source);
  }
  return root;
}

async function run(root: string, args: string[] = [], environment = {}, cwd = root) {
  const runner = path.join(root, "node_modules/@raincheck/iris/dist/cli.js");
  try {
    const result = await execute(process.execPath, [runner, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, output: result.stdout + result.stderr };
  }
}

function expectRun(
  result: Awaited<ReturnType<typeof run>>,
  pending: number,
  cached: number
) {
  expect(result.output).not.toContain("Could not fingerprint");
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain(
    `Test registry: ${pending} to run, ${cached} unchanged.`
  );
}

describe("test registry", () => {
  test("invalidates passes when the installed Iris runner changes", async () => {
    const root = await fixture();
    expectRun(await run(root), 2, 0);
    expectRun(await run(root), 0, 2);
    await appendFile(
      path.join(root, "node_modules/@raincheck/iris/dist/cli.js"),
      "\n// updated runner\n"
    );
    expectRun(await run(root), 2, 0);
  }, 30_000);

  test("lists selections without establishing cached passes", async () => {
    const root = await fixture();
    expectRun(await run(root, ["--list"]), 2, 0);
    await expect(
      readFile(path.join(root, "node_modules/.cache/iris/test-registry.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expectRun(await run(root), 2, 0);
    expectRun(await run(root, ["--list"]), 0, 2);
  }, 30_000);

  test.each([
    { label: "default name and spacing", options: undefined, heading: "R A I N C H E C K" },
    { label: "custom name", options: { name: "Iris" }, heading: "I r i s" },
    { label: "spacing disabled", options: { spaceLetters: false }, heading: "RAINCHECK" },
    { label: "custom name and spacing disabled", options: { name: "Moon research", spaceLetters: false }, heading: "Moon research" },
  ])("loads the packaged reporter with $label and keeps its counts in the configured root", async ({ options, heading }) => {
    const root = await fixture();
    const cwd = await fixture();
    const config = path.join(root, "vitest.config.mjs");
    const source = await readFile(config, "utf8");
    await writeFile(config,
      "import IrisReporter from '@raincheck/iris/reporter';\n" +
      source.replace("reporters: ['dot']", `reporters: [new IrisReporter(${options === undefined ? "" : JSON.stringify(options)})]`)
    );
    const result = await run(root, ["--root", root, "--config", config], {}, cwd);
    expectRun(result, 2, 0);
    expect(result.output).toContain(`☂  ${heading}\n`);
    const counts = JSON.parse(await readFile(
      path.join(root, "node_modules/.cache/iris/test-counts.json"), "utf8"
    ));
    expect(counts).toEqual({ alpha: 2, beta: 1 });
    await expect(
      readFile(path.join(cwd, "node_modules/.cache/iris/test-counts.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  test("reads tracks and explicit inputs from comments only", () => {
    expect(
      testMetadata(`
      // track: auth ui
      /** track: posts */
       * test-input: fixtures/**/*.json
      // test-cache: never
      const unrelated = 'track: primes';
    `)
    ).toEqual({
      tracks: ["auth", "ui", "posts"],
      inputs: ["fixtures/**/*.json"],
      cache: false,
    });
  });

  test("hashes environment values while ignoring npm invocation bookkeeping", () => {
    const initial = environmentHash({
      TOKEN: "private",
      npm_lifecycle_event: "test",
    });
    expect(
      environmentHash({ TOKEN: "private", npm_lifecycle_event: "test:auth" })
    ).toBe(initial);
    expect(environmentHash({ TOKEN: "changed" })).not.toBe(initial);
    expect(initial).not.toContain("private");
  });

  test("shares passes across tracks and reruns only changed tests or transitive subjects", async () => {
    const root = await fixture();
    expectRun(await run(root, ["--track", "auth"]), 1, 0);
    expectRun(await run(root, ["--track", "ui"]), 1, 1);
    expectRun(await run(root), 0, 2);
    await appendFile(path.join(root, "helper.js"), "\n// changed subject\n");
    expectRun(await run(root), 1, 1);
    await appendFile(path.join(root, "beta.test.js"), "\n// changed test\n");
    expectRun(await run(root), 1, 1);
    await writeFile(path.join(root, "unrelated.txt"), "unrelated");
    expectRun(await run(root), 0, 2);
  }, 30_000);

  test("fingerprints raw assets, virtual output, dynamic imports and glob membership", async () => {
    const root = await fixture();
    expectRun(await run(root), 2, 0);
    for (const filename of ["shader.glsl", "message.txt", "dynamic.js"]) {
      await appendFile(path.join(root, filename), "\n// changed\n");
      expectRun(await run(root), 1, 1);
    }
    await writeFile(path.join(root, "fixtures/second.json"), "{}");
    expectRun(await run(root), 1, 1);
    await rm(path.join(root, "fixtures/second.json"));
    expectRun(await run(root), 1, 1);
  }, 30_000);

  test("invalidates a forced failure and retries it until it passes", async () => {
    const root = await fixture();
    expectRun(await run(root), 2, 0);
    await writeFile(path.join(root, "fail.flag"), "flaky external condition");
    expect((await run(root, ["alpha.test.js", "--force"])).code).toBe(1);
    expect((await run(root, ["alpha.test.js"])).code).toBe(1);
    await rm(path.join(root, "fail.flag"));
    expectRun(await run(root), 1, 1);
    expectRun(await run(root), 0, 2);
    expectRun(await run(root, [], { PRE_COMMIT_RECHECK: "1" }), 2, 0);
  }, 30_000);

  test("partial selections never stand in for a complete test file", async () => {
    const root = await fixture();
    expectRun(
      await run(root, ["alpha.test.js", "-t", "second assertion"]),
      1,
      0
    );
    expectRun(await run(root, ["alpha.test.js"]), 1, 0);
    expectRun(await run(root, ["alpha.test.js"]), 0, 1);
  }, 30_000);

  test("declared skips can be cached but focused runs cannot", async () => {
    const root = await fixture();
    await appendFile(
      path.join(root, "beta.test.js"),
      "\ntest.skip('deliberately disabled', () => {});\ntest.todo('later');\n"
    );
    expectRun(await run(root), 2, 0);
    expectRun(await run(root), 0, 2);
    await appendFile(
      path.join(root, "beta.test.js"),
      "\ntest.only('focused', () => expect(1).toBe(1));\n"
    );
    expectRun(await run(root, ["beta.test.js"]), 1, 0);
    expectRun(await run(root, ["beta.test.js"]), 1, 0);
  }, 30_000);

  test("configuration, environment and declared filesystem inputs invalidate passes", async () => {
    const root = await fixture();
    await appendFile(
      path.join(root, "beta.test.js"),
      "\n// test-input: data/*.txt\n"
    );
    expectRun(await run(root), 2, 0);
    await mkdir(path.join(root, "data"));
    await writeFile(path.join(root, "data/value.txt"), "data");
    expectRun(await run(root), 1, 1);
    await appendFile(
      path.join(root, "vitest.config.mjs"),
      "\n// changed config\n"
    );
    expectRun(await run(root), 2, 0);
    expectRun(await run(root, [], { TEST_SUBJECT_MODE: "different" }), 2, 0);
  }, 30_000);

  test("does not cache inputs changed during execution", async () => {
    const root = await fixture();
    await appendFile(
      path.join(root, "beta.test.js"),
      `
      import { appendFileSync } from 'node:fs';
      test('changes its subject', () => appendFileSync(new URL('./beta.js', import.meta.url), '\\n// mutation'));
    `
    );
    expectRun(await run(root), 2, 0);
    expectRun(await run(root), 1, 1);
  }, 30_000);

  test("recovers corrupt registries and respects cache opt-outs", async () => {
    const root = await fixture();
    await appendFile(
      path.join(root, "beta.test.js"),
      "\n// test-cache: never\n"
    );
    expectRun(await run(root), 2, 0);
    expectRun(await run(root), 1, 1);
    await writeFile(
      path.join(root, "node_modules/.cache/iris/test-registry.json"),
      "not json"
    );
    expectRun(await run(root), 2, 0);
    expect((await run(root, ["--track", "unknown"])).code).toBe(1);
  }, 30_000);

  test("parallel invocations preserve results from both tracks", async () => {
    const root = await fixture();
    const results = await Promise.all([
      run(root, ["--track", "auth"]),
      run(root, ["beta.test.js"]),
    ]);
    for (const result of results) expectRun(result, 1, 0);
    expectRun(await run(root), 0, 2);
    const registry = JSON.parse(
      await readFile(
        path.join(root, "node_modules/.cache/iris/test-registry.json"),
        "utf8"
      )
    );
    expect(Object.keys(registry.tests)).toHaveLength(2);
  }, 30_000);
});
