import assert from "node:assert/strict";
import test from "node:test";
import { data as backupCommand } from "../commands/backup.js";
import {
  autobackupComponents,
  data as autobackupCommand,
} from "../commands/autobackup.js";
import { data as recoverCommand } from "../commands/recover.js";
import { isBackupComponent } from "./interactions.js";
import { classifyMemberRemoval } from "./events.js";

test("backup command keeps the requested create, list, and load subcommands", () => {
  const command = backupCommand.toJSON();
  assert.equal(command.name, "backup");
  assert.deepEqual(
    command.options?.map((option) => option.name),
    ["create", "list", "load"],
  );
});

test("autobackup controls render the saved state with the requested ON/OFF emojis", () => {
  const config = {
    autoBackupOn: true,
    archiveOn: false,
    kickTrackingOn: true,
  } as Parameters<typeof autobackupComponents>[0];
  const components = autobackupComponents(config).flatMap(
    (row) =>
      row.toJSON().components as unknown as {
        custom_id: string;
        emoji?: { id?: string };
        type: number;
      }[],
  );
  assert.deepEqual(
    components.map((component) => component.custom_id),
    [
      "autobackup:toggle:auto",
      "autobackup:toggle:archive",
      "autobackup:toggle:kicks",
    ],
  );
  assert.deepEqual(
    components.map((component) => component.emoji?.id),
    [
      "1566034940729233560",
      "1566035067602735217",
      "1566034940729233560",
    ],
  );
  assert.ok(components.every((component) => component.type === 2));
});

test("administrator backup commands and component routes are registered", () => {
  assert.equal(autobackupCommand.toJSON().name, "autobackup");
  assert.equal(recoverCommand.toJSON().name, "recover");
  assert.equal(isBackupComponent("autobackup:toggle:archive"), true);
  assert.equal(isBackupComponent("gods:recover:confirm-backup:session"), true);
  assert.equal(isBackupComponent("unrelated:component"), false);
});

test("member removals are kicks only with one unique kick audit match", () => {
  assert.equal(classifyMemberRemoval(0, 1), "kick");
  assert.equal(classifyMemberRemoval(1, 0), "ban");
  assert.equal(classifyMemberRemoval(0, 0), "leave");
  assert.equal(classifyMemberRemoval(1, 1), "unknown");
  assert.equal(classifyMemberRemoval(0, 2), "unknown");
});
