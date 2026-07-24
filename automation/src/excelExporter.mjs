import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeJson } from "./store.mjs";

export async function exportScanToExcel(scan, config, options = {}) {
  if (!Array.isArray(scan?.records) || scan.records.length === 0) {
    throw new Error("조회된 마감 수급 데이터가 없어 Excel을 만들지 않았습니다. 최신 완료 거래일을 확인한 뒤 다시 실행해 주세요.");
  }
  const modeSuffix = scan.dataMode === "intraday-estimate" ? "-장중추정" : "";
  const suffix = options.compact ? `compact-${scan.date}${modeSuffix}` : `${scan.date}${modeSuffix}`;
  const outputPath = resolve(config.exportDirectory, `수급정리-${suffix}.xlsx`);
  const sourcePath = resolve(config.exportDirectory, `수급정리-${suffix}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeJson(sourcePath, scan);
  await runPython(config.pythonBin, [
    "automation/tools/export_flow_excel.py",
    "--input", sourcePath,
    "--output", outputPath,
  ]);
  return outputPath;
}

function runPython(pythonBin, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonBin, args, { cwd: process.cwd(), windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`Excel 생성기를 실행할 수 없습니다: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`Excel 생성 실패: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}
