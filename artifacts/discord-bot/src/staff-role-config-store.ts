import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const staffRoleConfigPath = resolve(
  process.cwd(),
  "data",
  "staff-role-configs.json",
);
const roleIdPattern = /^\d{16,20}$/u;

let writeQueue: Promise<void> = Promise.resolve();

async function readConfigs(): Promise<Record<string, string>> {
  let contents: string;
  try {
    contents = await readFile(staffRoleConfigPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Staff role settings must be a JSON object.");
  }

  const configs: Record<string, string> = {};
  for (const [guildId, roleId] of Object.entries(parsed)) {
    if (!roleIdPattern.test(guildId) || typeof roleId !== "string" || !roleIdPattern.test(roleId)) {
      throw new Error("Staff role settings contain an invalid guild or role ID.");
    }
    configs[guildId] = roleId;
  }
  return configs;
}

async function writeConfigs(configs: Record<string, string>): Promise<void> {
  await mkdir(dirname(staffRoleConfigPath), { recursive: true });
  const temporaryPath = `${staffRoleConfigPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(configs, null, 2)}\n`, "utf8");
  await rename(temporaryPath, staffRoleConfigPath);
}

export async function getStaffGrantRoleId(
  guildId: string,
): Promise<string | null> {
  await writeQueue;
  const configs = await readConfigs();
  return configs[guildId] ?? null;
}

export function setStaffGrantRoleId(
  guildId: string,
  roleId: string | null,
): Promise<void> {
  const write = writeQueue.then(async () => {
    if (!roleIdPattern.test(guildId) || (roleId !== null && !roleIdPattern.test(roleId))) {
      throw new Error("Invalid guild or role ID.");
    }
    const configs = await readConfigs();
    if (roleId === null) {
      delete configs[guildId];
    } else {
      configs[guildId] = roleId;
    }
    await writeConfigs(configs);
  });
  writeQueue = write.catch(() => undefined);
  return write;
}
