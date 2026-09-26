// Extracts the @sparticuz/chromium headless browser to /tmp/al2023 for E2E runs.
// Run with: LD_LIBRARY_PATH not needed here; needed when LAUNCHING chromium.
// Self-healing: pgtooling lives outside the repo and does NOT survive sandbox
// resets — reinstall puppeteer deps on demand (same pattern as start-pg.mjs).
import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";

const TOOLS = "/home/user/pgtooling";
const E2E_DEPS = ["@sparticuz/chromium", "puppeteer-core", "pg"];
if (!E2E_DEPS.every((d) => existsSync(`${TOOLS}/node_modules/${d}`))) {
  console.log("· E2E tooling deps missing (snapshot reset?) — reinstalling…");
  execSync(`mkdir -p ${TOOLS}`);
  if (!existsSync(`${TOOLS}/package.json`)) execSync("npm init -y", { cwd: TOOLS, stdio: "ignore" });
  execSync(`npm install ${E2E_DEPS.join(" ")}`, { cwd: TOOLS, stdio: "inherit" });
}

// Launcher shim: prepends the bundled AL2023 libs to LD_LIBRARY_PATH.
const WRAPPER_SH = [
  "#!/bin/sh",
  'export LD_LIBRARY_PATH="/tmp/al2023/lib:/tmp/al2023:${LD_LIBRARY_PATH:-}"',
  'exec /tmp/al2023/chromium.bin "$@"',
  "",
].join("\n");

const bin = `${TOOLS}/node_modules/@sparticuz/chromium/bin`;
mkdirSync("/tmp/al2023", { recursive: true });
writeFileSync("/tmp/al2023.tar", brotliDecompressSync(readFileSync(`${bin}/al2023.tar.br`)));
execSync("tar -xf /tmp/al2023.tar -C /tmp/al2023");
writeFileSync("/tmp/al2023/chromium", brotliDecompressSync(readFileSync(`${bin}/chromium.br`)));
chmodSync("/tmp/al2023/chromium", 0o755);
writeFileSync("/tmp/swiftshader.tar", brotliDecompressSync(readFileSync(`${bin}/swiftshader.tar.br`)));
execSync("tar -xf /tmp/swiftshader.tar -C /tmp/al2023");
writeFileSync("/tmp/fonts.tar", brotliDecompressSync(readFileSync(`${bin}/fonts.tar.br`)));
execSync("tar -xf /tmp/fonts.tar -C /tmp/al2023");
// The @sparticuz build needs its bundled AL2023 shared libs (libnspr4,
// libnss3, ...) which are not installed system-wide in this sandbox — and
// E2E suites launch the binary directly without an LD_LIBRARY_PATH. Wrap
// the real binary so every launcher works unchanged across resets.
if (!existsSync("/tmp/al2023/chromium.bin")) {
  execSync("mv /tmp/al2023/chromium /tmp/al2023/chromium.bin");
  writeFileSync("/tmp/al2023/chromium", WRAPPER_SH);
  chmodSync("/tmp/al2023/chromium", 0o755);
}
console.log("chromium ready at /tmp/al2023/chromium (run with LD_LIBRARY_PATH=/tmp/al2023/lib)");
