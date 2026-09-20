import { createHash, randomUUID } from "node:crypto";
import {
  glob,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { experimental_getRunnerTask } from "vitest/node";
import type { TestModule, TestSpecification } from "vitest/node";

export type TestMetadata = {
  tracks: string[];
  inputs: string[];
  cache: boolean;
};

export type TestFingerprint = {
  hash: string;
  files: Record<string, string>;
};

type RegistryEntry = { hash: string; passedAt: string; inputs: string[] };
export type TestRegistry = {
  version: 1;
  tests: Record<string, RegistryEntry>;
};

export function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function testMetadata(source: string): TestMetadata {
  const metadata: TestMetadata = { tracks: [], inputs: [], cache: true };
  for (const line of source.split(/\r?\n/)) {
    const marker = line.match(
      /^\s*(?:\/\/|\/\*+|\*)\s*(track|test-input|test-cache):\s*(.*?)\s*(?:\*\/)?$/
    );
    if (!marker) continue;
    if (marker[1] === "track") {
      metadata.tracks.push(...marker[2].split(/[\s,]+/).filter(Boolean));
    } else if (marker[1] === "test-input") {
      metadata.inputs.push(marker[2]);
    } else if (marker[2] === "never") {
      metadata.cache = false;
    }
  }
  return metadata;
}

export function testKey(spec: TestSpecification) {
  return JSON.stringify([
    spec.project.name,
    spec.pool,
    path.relative(spec.project.config.root, spec.moduleId),
  ]);
}

export function environmentHash(environment: NodeJS.ProcessEnv) {
  // npm command names, shell bookkeeping, and display settings are not subjects.
  // Values are hashed together and are never written to the registry.
  const ignored = /^(?:npm_|IRIS_|RAINCHECK_|GIT_AUTHOR_|GIT_COMMITTER_)/i;
  const ignoredNames = new Set([
    "_",
    "SHLVL",
    "PWD",
    "OLDPWD",
    "INIT_CWD",
    "PRE_COMMIT_RECHECK",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_EDITOR",
    "GIT_REFLOG_ACTION",
    "FORCE_COLOR",
    "NO_COLOR",
    "TERM",
    "COLORTERM",
    "COLUMNS",
    "LINES",
  ]);
  return hash(
    JSON.stringify(
      Object.entries(environment)
        .filter(([name]) => !ignored.test(name) && !ignoredNames.has(name))
        .sort(([left], [right]) => left.localeCompare(right))
    )
  );
}

async function fileHash(filename: string) {
  try {
    return hash(await readFile(filename));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export async function readRegistry(filename: string): Promise<TestRegistry> {
  try {
    const value = JSON.parse(await readFile(filename, "utf8"));
    if (
      value?.version !== 1 ||
      !value.tests ||
      typeof value.tests !== "object" ||
      Array.isArray(value.tests)
    ) {
      throw new Error("Unsupported test registry format.");
    }
    for (const entry of Object.values(value.tests) as RegistryEntry[]) {
      if (
        !entry ||
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        !Array.isArray(entry.inputs)
      ) {
        throw new Error("Invalid test registry entry.");
      }
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const issue = "Could not read the test registry;";
      const alleviation = "running tests without previous results.";
      console.warn(issue, alleviation, error);
    }
    return { version: 1, tests: {} };
  }
}

export async function writeRegistry(filename: string, registry: TestRegistry) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(temporary, JSON.stringify(registry, null, 2) + "\n");
    await rename(temporary, filename);
    return true;
  } catch (error) {
    const issue = "Could not persist the test registry;";
    const alleviation = "continuing with uncached test results.";
    console.warn(issue, alleviation, error);
    return false;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function inputsUnchanged(fingerprint: TestFingerprint) {
  for (const [filename, before] of Object.entries(fingerprint.files)) {
    if ((await fileHash(filename)) !== before) return false;
  }
  return true;
}

/** Serialize registry updates so simultaneous tracks cannot overwrite results. */
export async function lockRegistry(filename: string) {
  const lock = `${filename}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async function release() {
        await unlink(lock);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      const owner = Number(await readFile(lock, "utf8"));
      if (Number.isSafeInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          await unlink(lock);
          continue;
        }
      } else if (Date.now() - (await stat(lock)).mtimeMs > 30_000) {
        await unlink(lock);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (Date.now() - started > 60_000) {
      throw new Error(
        "Another test run is still using the registry. Retry when it finishes."
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Vite resolves aliases, re-exports, dynamic imports, globs, and virtual modules. */
export function createFingerprinter(environment: string, options: unknown) {
  const modules = new Map<
    string,
    Promise<{
      code: string;
      file?: string;
      dependencies: string[];
      watchedFiles: string[];
    }>
  >();

  function importUrl(url: string) {
    return url.replace(/^\/@id\//, "").replace(/__x00__/g, "\0");
  }

  return async function fingerprint(
    spec: TestSpecification,
    metadata: TestMetadata
  ): Promise<TestFingerprint> {
    const root = spec.project.config.root;
    const vite = spec.project.vite;
    const ssr = vite.environments.ssr;
    const files: Record<string, string> = {};
    const parts = new Map<string, string>();
    const seen = new Set<string>();

    async function loadModule(id: string) {
      const result = await ssr.transformRequest(id);
      const node = ssr.moduleGraph.getModuleById(id);
      if (!result || !node) throw new Error(`Cannot fingerprint ${id}`);
      const imports = new Set(
        [...(result.deps ?? []), ...(result.dynamicDeps ?? [])].map(importUrl)
      );
      return {
        code: result.code,
        file: node.file ?? undefined,
        dependencies: [...node.importedModules].flatMap((dependency) => {
          return dependency.id && imports.has(importUrl(dependency.url))
            ? [dependency.id]
            : [];
        }),
        // addWatchFile creates graph edges too. Raw assets are inputs,
        // not JavaScript modules to pass back through the transformer.
        watchedFiles: [...node.importedModules].flatMap((dependency) => {
          return dependency.file &&
            !dependency.file.includes("\0") &&
            !imports.has(importUrl(dependency.url))
            ? [dependency.file]
            : [];
        }),
      };
    }

    async function visit(id: string) {
      if (
        seen.has(id) ||
        id.includes("/node_modules/") ||
        id.startsWith("node:")
      ) {
        return;
      }
      seen.add(id);
      const key = `${spec.project.name}\0${id}`;
      if (!modules.has(key)) {
        modules.set(key, loadModule(id));
      }
      const module = await modules.get(key)!;
      parts.set(id, hash(module.code));
      if (module.file && !module.file.includes("\0")) {
        files[module.file] = await fileHash(module.file);
      }
      for (const filename of module.watchedFiles) {
        files[filename] = await fileHash(filename);
      }
      for (const dependency of module.dependencies) await visit(dependency);
    }

    await visit(spec.moduleId);
    for (const setup of [
      ...spec.project.config.setupFiles,
      ...spec.project.config.globalSetup,
    ]) {
      await visit(setup);
    }
    const common = [
      "package.json",
      "package-lock.json",
      "node_modules/.package-lock.json",
      "tsconfig.json",
      "tsconfig.app.json",
      path.join(import.meta.dirname, "cli.js"),
      import.meta.filename,
      path.join(import.meta.dirname, "reporter.js"),
      // Include Iris itself as well as the consuming project in every fingerprint.
      path.resolve(import.meta.dirname, "../package.json"),
      path.resolve(import.meta.dirname, "../package-lock.json"),
      path.resolve(import.meta.dirname, "../node_modules/.package-lock.json"),
      ...vite.config.configFileDependencies,
    ];
    for (const filename of common) {
      const absolute = path.resolve(root, filename);
      files[absolute] = await fileHash(absolute);
    }
    for (const pattern of [".env", ".env.*", ...metadata.inputs]) {
      const matches = [];
      for await (const filename of glob(pattern, { cwd: root })) {
        const absolute = path.resolve(root, filename);
        files[absolute] = await fileHash(absolute);
        matches.push(filename);
      }
      parts.set(`input:${pattern}`, hash(JSON.stringify(matches.sort())));
    }
    const salt = [
      process.version,
      process.platform,
      process.arch,
      spec.project.vitest.version,
      environment,
      options,
      spec.pool,
      root,
    ];
    return {
      hash: hash(
        JSON.stringify([
          salt,
          [...parts].sort(([left], [right]) => left.localeCompare(right)),
          Object.entries(files).sort(([left], [right]) =>
            left.localeCompare(right)
          ),
        ])
      ),
      files,
    };
  };
}

export function rememberPass(
  registry: TestRegistry,
  key: string,
  fingerprint: TestFingerprint
) {
  registry.tests[key] = {
    hash: fingerprint.hash,
    passedAt: new Date().toISOString(),
    inputs: Object.keys(fingerprint.files).sort(),
  };
}

export function completedTestFile(module: TestModule | undefined) {
  if (!module || module.state() !== "passed" || !module.ok()) return false;
  // The runner replaces .only modes during collection; this flag survives.
  const task = experimental_getRunnerTask(module);
  if ("containsOnly" in task && task.containsOnly) return false;
  const tests = [...module.children.allTests()];
  if (!tests.length) return false;
  if (
    [...module.children.allSuites()].some(
      (suite) => suite.options.mode === "only"
    )
  ) {
    return false;
  }
  return tests.every((test) => {
    if (test.options.mode === "only") return false;
    return (
      test.result().state === "passed" ||
      test.options.mode === "skip" ||
      test.options.mode === "todo"
    );
  });
}
