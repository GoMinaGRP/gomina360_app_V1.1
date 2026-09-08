// Extracts the @sparticuz/chromium headless browser to /tmp/al2023 for E2E runs.
// Run with: LD_LIBRARY_PATH not needed here; needed when LAUNCHING chromium.
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";

const bin = "/home/user/pgtooling/node_modules/@sparticuz/chromium/bin";
mkdirSync("/tmp/al2023", { recursive: true });
writeFileSync("/tmp/al2023.tar", brotliDecompressSync(readFileSync(`${bin}/al2023.tar.br`)));
execSync("tar -xf /tmp/al2023.tar -C /tmp/al2023");
writeFileSync("/tmp/al2023/chromium", brotliDecompressSync(readFileSync(`${bin}/chromium.br`)));
chmodSync("/tmp/al2023/chromium", 0o755);
writeFileSync("/tmp/swiftshader.tar", brotliDecompressSync(readFileSync(`${bin}/swiftshader.tar.br`)));
execSync("tar -xf /tmp/swiftshader.tar -C /tmp/al2023");
writeFileSync("/tmp/fonts.tar", brotliDecompressSync(readFileSync(`${bin}/fonts.tar.br`)));
execSync("tar -xf /tmp/fonts.tar -C /tmp/al2023");
console.log("chromium ready at /tmp/al2023/chromium (run with LD_LIBRARY_PATH=/tmp/al2023/lib)");
