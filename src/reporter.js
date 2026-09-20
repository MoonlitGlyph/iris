import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DefaultReporter } from "vitest/node";

const ansi = {
  reset: "\u001b[0m",
};
const rainbowColors = [31, 33, 32, 36, 34, 35];
const paletteSetting = process.env.IRIS_BAR_PALETTE ?? process.env.RAINCHECK_BAR_PALETTE ?? "full";
const barColorMode = (process.env.IRIS_BAR_COLOR ?? process.env.RAINCHECK_BAR_COLOR ?? "truecolor").trim().toLowerCase();
const useTrueColor = barColorMode === "truecolor";
const configuredPalette = paletteSetting
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value >= 30 && value <= 97);
const barPalette = configuredPalette.length > 0 ? configuredPalette : rainbowColors;
const trueColorStops = [
  [255, 0, 0],
  [255, 128, 0],
  [255, 255, 0],
  [0, 192, 0],
  [0, 255, 255],
  [0, 128, 255],
  [255, 0, 255],
];
const configuredBarWidth = Number.parseInt(process.env.IRIS_BAR_WIDTH ?? process.env.RAINCHECK_BAR_WIDTH ?? "20", 10);
const inferredBarWidth = process.stdout.isTTY
  ? Math.max(20, (process.stdout.columns ?? 80) - 30)
  : 20;
const barWidth = configuredBarWidth === 0
  ? inferredBarWidth
  : Number.isInteger(configuredBarWidth) && configuredBarWidth > 0
    ? configuredBarWidth
    : 20;

function color(code, value) {
  if (!process.stdout.isTTY) return value;
  return `\u001b[${code}m${value}${ansi.reset}`;
}

function rainbow(value) {
  let index = 0;
  return [...value]
    .map((character) => {
      if (/\s/.test(character)) return character;
      const painted = color(rainbowColors[index % rainbowColors.length], character);
      index += 1;
      return painted;
    })
    .join("");
}

function rainbowBar(progress, width = 20) {
  const levels = [" ", "░", "▒", "▓", "█"];
  const bounded = Math.max(0, Math.min(width, progress));
  const full = Math.floor(bounded);
  const remainder = bounded - full;
  const partial = remainder ? Math.ceil(remainder * (levels.length - 1)) : 0;

  return Array.from({ length: width }, (_, index) => {
    const level = index < full ? levels.length - 1 : index === full ? partial : 0;
    const glyph = levels[level];
    if (!process.stdout.isTTY || level === 0) return glyph;
    if (useTrueColor) {
      const position = width === 1 ? 0 : (index / (width - 1)) * (trueColorStops.length - 1);
      const lower = Math.floor(position);
      const upper = Math.min(trueColorStops.length - 1, lower + 1);
      const amount = position - lower;
      const rgb = trueColorStops[lower].map((channel, channelIndex) =>
        Math.round(channel + (trueColorStops[upper][channelIndex] - channel) * amount),
      );
      return `\u001b[38;2;${rgb.join(";")}m${glyph}${ansi.reset}`;
    }
    const paletteIndex = barColorMode === "single"
      ? 0
      : barColorMode === "legacy"
        ? index % barPalette.length
        : width === 1
          ? 0
          : Math.round((index / (width - 1)) * (barPalette.length - 1));
    return `\u001b[${barPalette[paletteIndex]}m${glyph}${ansi.reset}`;
  }).join("");
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function testCounts(module) {
  const tests = [...module.children.allTests()];
  return {
    failed: tests.filter((test) => test.result().state === "failed").length,
    passed: tests.filter((test) => test.result().state === "passed").length,
    skipped: tests.filter((test) => test.result().state === "skipped").length,
    total: tests.length,
  };
}

function testFileKey(moduleId, root) {
  return relative(root, moduleId)
    .replace(/\\/g, "/")
    .replace(/\.(?:test|spec)\.[^.]+$/, "");
}

function testFileExists(key, root) {
  return ["test", "spec"].some((suffix) =>
    ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"].some((extension) =>
      existsSync(join(root, `${key}.${suffix}.${extension}`)),
    ),
  );
}

export default class IrisReporter extends DefaultReporter {
  startedAt = 0;
  expectedTests = 0;
  cachedTestCounts = {};
  runTestCounts = new Map();
  collectedTestKeys = new Set();
  discoveredTests = 0;
  completedTests = 0;
  completedTestIds = new Set();
  progressPhase = 0;
  root = process.cwd();
  countFile = "";

  constructor() {
    super({ summary: false });
  }

  onInit(vitest) {
    this.ctx = vitest;
    this.root = vitest.config.root;
    this.countFile = join(this.root, "node_modules/.cache/iris/test-counts.json");
    this.silent ??= vitest.config.silent;
  }

  onTestRunStart(specifications) {
    super.onTestRunStart(specifications);
    this.startedAt = performance.now();
    this.cachedTestCounts = this.readExpectedTests();
    this.collectedTestKeys.clear();
    this.runTestCounts = new Map(
      specifications.map((specification) => {
        const key = testFileKey(specification.moduleId, this.root);
        return [key, this.cachedTestCounts[key] ?? 0];
      }),
    );
    this.expectedTests = [...this.runTestCounts.values()].reduce(
      (total, count) => total + count, 0,
    );
    this.discoveredTests = 0;
    this.completedTests = 0;
    this.completedTestIds.clear();
    this.progressPhase = 0;
    this.log();
    this.log(`☂  ${rainbow("I R I S")}`);
    this.log(
      color(
        2,
        `│  ${specifications.length} ${plural(specifications.length, "test file")}`,
      ),
    );
    this.log(color(2, "│"));
    this.writeProgress();
  }

  onTestModuleCollected(module) {
    super.onTestModuleCollected(module);
    const count = [...module.children.allTests()].length;
    const key = testFileKey(module.moduleId, this.root);
    this.discoveredTests += count;
    this.expectedTests += count - (this.runTestCounts.get(key) ?? 0);
    this.runTestCounts.set(key, count);
    this.collectedTestKeys.add(key);
    this.writeProgress();
  }

  onTestCaseResult(test) {
    const state = test.result().state;
    if (state !== "pending" && !this.completedTestIds.has(test.id)) {
      this.completedTestIds.add(test.id);
      this.completedTests += 1;
      this.writeProgress();
    }
    super.onTestCaseResult(test);
  }

  onTestModuleEnd(module) {
    this.clearProgress();
    const counts = testCounts(module);
    const name = this.relative(module.moduleId).replace(/\.(?:test|spec)\.[^.]+$/, "");
    const healthy = module.state() !== "failed" && counts.failed === 0;
    const resting = counts.total > 0 && counts.skipped === counts.total;
    const symbol = healthy ? (resting ? color(2, "◌") : color(32, "✦")) : color(31, "✕");
    const result = healthy && resting
      ? color(2, `${counts.skipped}/${counts.total} resting`)
      : healthy
      ? color(32, `${counts.passed}/${counts.total} blooming`)
      : color(
          31,
          counts.failed
            ? `${counts.failed}/${counts.total} withered`
            : "caught in setup storm",
        );

    const skipped = counts.skipped && !(healthy && resting)
      ? color(2, `, ${counts.skipped} resting`)
      : "";
    this.log(`├─ ${symbol} ${name}  ${result}${skipped}`);
    // Failure details are printed at run end; omit the default per-test list.
    this.writeProgress();
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    const counts = modules.reduce(
      (total, module) => {
        const current = testCounts(module);
        total.failed += current.failed;
        total.passed += current.passed;
        total.skipped += current.skipped;
        total.tests += current.total;
        return total;
      },
      { failed: 0, passed: 0, skipped: 0, tests: 0 },
    );
    const failedModules = modules.filter(
      (module) => module.state() === "failed",
    ).length;
    const failed = failedModules > 0 || unhandledErrors.length > 0;
    const elapsed = ((performance.now() - this.startedAt) / 1000).toFixed(2);
    const skipped = counts.skipped ? `, ${counts.skipped} resting` : "";

    this.clearProgress();
    this.writeExpectedTests(modules);
    this.log(color(2, "│"));
    this.log(
      `├─ 🌈 ${rainbowBar(barWidth, barWidth)}  ${color(1, "100%")} (${counts.tests}/${counts.tests})`,
    );
    if (failed) {
      super.onTestRunEnd(modules, unhandledErrors, reason);
      this.log(
        color(
          31,
          `╰─ ☂ ${counts.failed || failedModules} ${plural(counts.failed || failedModules, counts.failed ? "test" : "suite")} caught in the storm${skipped}.`,
        ),
      );
    } else {
      this.log(
        color(
          counts.passed === 0 && counts.skipped > 0 ? 2 : 32,
          counts.passed === 0 && counts.skipped > 0
            ? `╰─ ◌ All ${counts.skipped} ${plural(counts.skipped, "test")} ${counts.skipped === 1 ? "is" : "are"} resting · ${elapsed}s`
            : `╰─ ❀ All ${counts.passed} ${plural(counts.passed, "test")} ${counts.passed === 1 ? "is" : "are"} blooming${skipped} · ${elapsed}s`,
        ),
      );
    }
    this.log();
  }

  readExpectedTests() {
    try {
      const value = JSON.parse(readFileSync(this.countFile, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter(([key, count]) =>
          key !== "tests" && Number.isInteger(count) && count >= 0,
        ),
      );
    } catch {
      return {};
    }
  }

  writeExpectedTests(modules) {
    try {
      const counts = Object.fromEntries(
        Object.entries(this.cachedTestCounts).filter(([key]) => testFileExists(key, this.root)),
      );
      for (const module of modules) {
        const key = testFileKey(module.moduleId, this.root);
        if (this.collectedTestKeys.has(key)) {
          counts[key] = this.runTestCounts.get(key);
        }
      }
      const sortedCounts = Object.fromEntries(
        Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
      );
      mkdirSync(dirname(this.countFile), { recursive: true });
      writeFileSync(this.countFile, `${JSON.stringify(sortedCounts, null, 2)}\n`);
    } catch (error) {
      const issue = "Could not save the Iris test count;";
      const alleviation = "continuing without updating the cache.";
      console.warn(issue, alleviation, error);
    }
  }

  writeProgress() {
    if (!process.stdout.isTTY || !this.ctx) return;
    const total = this.expectedTests || this.discoveredTests;
    const percentage = total
      ? Math.min(100, Math.round((this.completedTests / total) * 100))
      : 0;
    const bar = total
      ? rainbowBar((percentage / 100) * barWidth, barWidth)
      : " ".repeat(barWidth);
    this.ctx.logger.outputStream.write(
      `\r\u001b[2K│  🌈 ${bar}  ${percentage}% (${this.completedTests}/${total || "…"})`,
    );
  }

  clearProgress() {
    if (!process.stdout.isTTY || !this.ctx) return;
    this.ctx.logger.outputStream.write("\r\u001b[2K");
  }
}
