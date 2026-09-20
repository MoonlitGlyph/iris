#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createVitest, parseCLI, startVitest } from "vitest/node";
import {
  completedTestFile,
  createFingerprinter,
  environmentHash,
  inputsUnchanged,
  lockRegistry,
  readRegistry,
  rememberPass,
  testKey,
  testMetadata,
  writeRegistry,
  type TestFingerprint,
} from "./testRegistry.js";

async function main() {
  const args = process.argv.slice(2);
  const tracks: string[] = [];
  const forwarded: string[] = [];
  let force = process.env.PRE_COMMIT_RECHECK === "1";
  let list = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") force = true;
    else if (arg === "--list") list = true;
    else if (arg === "--track") {
      const track = args[++index];
      if (!track || track.startsWith("-")) {
        throw new Error("--track needs a name.");
      }
      tracks.push(track);
    } else forwarded.push(arg);
  }
  const { filter, options } = parseCLI(["vitest", "run", ...forwarded]);
  if (
    forwarded.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))
  ) {
    return;
  }
  const environment = environmentHash(process.env);
  if (options.watch) {
    if (tracks.length) {
      throw new Error("Use file filters with Vitest watch mode.");
    }
    await startVitest(filter, options);
    return;
  }
  const vitest = await createVitest({ ...options, watch: false, run: true });
  let release: (() => Promise<void>) | undefined;
  try {
    const specs = await vitest.getRelevantTestSpecifications(filter);
    const selected = [];
    for (const spec of specs) {
      const metadata = testMetadata(await readFile(spec.moduleId, "utf8"));
      if (
        tracks.length &&
        !tracks.some((track) => metadata.tracks.includes(track))
      ) {
        continue;
      }
      selected.push({ spec, metadata });
    }
    if (!selected.length) {
      throw new Error(
        `No tests matched ${tracks.length ? `track ${tracks.join(", ")}` : "the supplied filters"}.`
      );
    }
    const registryPath = path.join(
      vitest.config.root,
      "node_modules/.cache/iris/test-registry.json"
    );
    if (!list) release = await lockRegistry(registryPath);
    const registry = await readRegistry(registryPath);
    const fingerprint = createFingerprinter(environment, options);
    // Partial runs and coverage always execute and cannot certify a whole file.
    const cacheable =
      !vitest.config.coverage.enabled &&
      !vitest.config.testNamePattern &&
      !vitest.config.update &&
      !vitest.config.shard &&
      !vitest.config.tagsFilter?.length;
    const pending = [];
    let skipped = 0;
    for (const item of selected) {
      const key = testKey(item.spec);
      let before: TestFingerprint | undefined;
      const eligible =
        cacheable && item.metadata.cache && !item.spec.testLines?.length;
      if (eligible) {
        try {
          before = await fingerprint(item.spec, item.metadata);
        } catch (error) {
          const issue = `Could not fingerprint ${item.spec.moduleId};`;
          const alleviation = "running it without a cached result.";
          console.warn(issue, alleviation, error);
        }
      }
      const reuse =
        !force && before && registry.tests[key]?.hash === before.hash;
      if (list) {
        console.log(
          `${reuse ? "cached" : "run"} ${path.relative(vitest.config.root, item.spec.moduleId)}`
        );
      }
      if (reuse) skipped += 1;
      else pending.push({ ...item, key, before });
    }
    console.log(
      `Test registry: ${pending.length} to run, ${skipped} unchanged.`
    );
    if (list || !pending.length) return;
    // Invalidate first: failure or interruption must never reuse an earlier pass.
    for (const item of pending) delete registry.tests[item.key];
    const writable = await writeRegistry(registryPath, registry);
    await vitest.standalone();
    const result = await vitest.runTestSpecifications(
      pending.map((item) => item.spec)
    );
    const failed =
      result.unhandledErrors.length > 0 ||
      result.testModules.some((module) => !module.ok());
    if (failed) process.exitCode = 1;
    if (writable && !result.unhandledErrors.length) {
      for (const item of pending) {
        if (
          item.before &&
          completedTestFile(item.spec.testModule) &&
          (await inputsUnchanged(item.before))
        ) {
          rememberPass(registry, item.key, item.before);
        }
      }
      await writeRegistry(registryPath, registry);
    }
  } finally {
    try {
      await vitest.close();
    } finally {
      await release?.();
    }
  }
}

await main().catch((error) => {
  const issue = "Unable to complete the test run.";
  console.error(issue, error);
  process.exitCode = 1;
});
