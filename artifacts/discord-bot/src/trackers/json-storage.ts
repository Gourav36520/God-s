import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");

export function loadTrackerJson<T>(fileName: string, createEmpty: () => T): T {
  const filePath = join(DATA_DIR, fileName);
  if (!existsSync(filePath)) return createEmpty();

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    throw new Error(
      `Unable to read tracker data at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function saveTrackerJson(fileName: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const filePath = join(DATA_DIR, fileName);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw new Error(
      `Unable to save tracker data at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}
