import assert from "node:assert/strict";
import test from "node:test";
import { data as backupCommand } from "../commands/backup.js";
import {
  autobackupComponents,
  data as autobackupCommand,
} from "../commands/autobackup.js";
import {
  data as recoverCommand,
  recoveryTargets,
} from "../commands/recover.js";
import {
  isBackupComponent,
  RECOVERY_BACKUP_SCOPES,
} from "./interactions.js";
import {
  classifyMemberRemoval,
  isRecentRemovalAuditMatch,
} from "./events.js";

test("backup command keeps the requested create, list, and load subcommands", () => {
  const command = backupCommand.toJSON();
  assert.equal(command.name, "backup");
  assert.deepEqual(
    command.options?.map((option) => option.name),
    ["create", "list", "load"],
  );
  const load = command.options?.find((option) => option.name === "load") as
    | {
        options?: {
          name: string;
          choices?: { value: string | number }[];
        }[];
      }
    | undefined;
  const scope = load?.options?.find((option) => option.name === "scope");
  assert.ok(scope?.choices?.some((choice) => choice.value === "messages"));
});

test("autobackup keeps settings, status, configuration, and manual run commands", () => {
  const command = autobackupCommand.toJSON();
  assert.deepEqual(
    command.options?.map((option) => option.name),
    ["settings", "status", "configure", "run"],
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
  assert.deepEqual(
    recoveryTargets.map((target) => target.value),
    ["backup", "audit", "kicks"],
  );
  assert.equal(RECOVERY_BACKUP_SCOPES.includes("messages"), false);
  assert.equal(isBackupComponent("autobackup:toggle:archive"), true);
  assert.equal(isBackupComponent("gods:recover:confirm-backup:session"), true);
  assert.equal(isBackupComponent("gods:recover:audit:session"), true);
  assert.equal(isBackupComponent("unrelated:component"), false);
});

test("member removals are kicks only with one unique kick audit match", () => {
  assert.equal(classifyMemberRemoval(0, 1), "kick");
  assert.equal(classifyMemberRemoval(1, 0), "ban");
  assert.equal(classifyMemberRemoval(0, 0), "leave");
  assert.equal(classifyMemberRemoval(1, 1), "unknown");
  assert.equal(classifyMemberRemoval(0, 2), "unknown");
});

test("kick audit correlation rejects other members and stale or future entries", () => {
  const observedAt = 100_000;
  assert.equal(
    isRecentRemovalAuditMatch(
      { targetId: "member-1", createdTimestamp: observedAt - 1_000 },
      "member-1",
      observedAt,
      observedAt + 1_500,
    ),
    true,
  );
  assert.equal(
    isRecentRemovalAuditMatch(
      { targetId: "member-2", createdTimestamp: observedAt },
      "member-1",
      observedAt,
      observedAt + 1_500,
    ),
    false,
  );
  assert.equal(
    isRecentRemovalAuditMatch(
      { targetId: "member-1", createdTimestamp: observedAt - 15_001 },
      "member-1",
      observedAt,
      observedAt + 1_500,
    ),
    false,
  );
  assert.equal(
    isRecentRemovalAuditMatch(
      { targetId: "member-1", createdTimestamp: observedAt + 5_001 },
      "member-1",
      observedAt,
      observedAt + 1_500,
    ),
    false,
  );
});
