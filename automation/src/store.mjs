import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(resolve(filePath), "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value) {
  const path = resolve(filePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function fileExists(filePath) {
  return existsSync(resolve(filePath));
}
