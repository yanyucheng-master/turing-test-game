import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const publicDir = path.resolve("dist/public");
const forbiddenMarkers = [
  "AI 每日学习报告",
  "Local-only culture report",
  "Local companion only",
  "culture-review",
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(target)));
    } else {
      files.push(target);
    }
  }
  return files;
}

const publicFiles = await filesBelow(publicDir);
const inspectableFiles = publicFiles.filter(file =>
  /\.(?:css|html|js|map)$/i.test(file)
);
const leaks = [];

for (const file of inspectableFiles) {
  const contents = await readFile(file, "utf8");
  for (const marker of forbiddenMarkers) {
    if (contents.includes(marker)) {
      leaks.push(`${path.relative(publicDir, file)} contains ${marker}`);
    }
  }
}

if (leaks.length > 0) {
  console.error("[public-build] administrator UI leaked into player assets:");
  for (const leak of leaks) console.error(` - ${leak}`);
  process.exit(1);
}

console.log("[public-build] administrator UI is absent from player assets");
