import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
} from "discord.js";
import {
  candidateFromAuditEntry,
  listAuditRecoveryCandidates,
  restoreAuditLogResources,
  validAuditRecoveryCandidates,
} from "./audit-recovery.js";

const timestamp = Date.parse("2026-11-08T10:00:00.000Z");

test("audit-log role recovery uses deleted role details and defaults missing permissions safely", () => {
  const candidate = candidateFromAuditEntry("role", {
    id: "audit-role-1",
    targetId: "deleted-role-1",
    createdTimestamp: timestamp,
    executorId: null,
    changes: [
      { key: "name", old: "Helpers" },
      { key: "permissions", old: "8" },
      { key: "color", old: 0x336699 },
      { key: "hoist", old: true },
      { key: "mentionable", old: false },
      { key: "position", old: 4 },
    ],
  });

  assert.ok(candidate);
  assert.equal(candidate.executorId, null);
  assert.equal(candidate.data.kind, "role");
  if (candidate.data.kind !== "role") return;
  assert.equal(candidate.data.name, "Helpers");
  assert.equal(candidate.data.permissions, "8");
  assert.equal(candidate.data.color, 0x336699);
  assert.equal(candidate.data.position, 4);

  const safeDefault = candidateFromAuditEntry("role", {
    id: "audit-role-2",
    targetId: "deleted-role-2",
    createdTimestamp: timestamp,
    executorId: "moderator-1",
    changes: [{ key: "name", old: "Recovered with no permissions" }],
  });
  assert.ok(safeDefault);
  assert.equal(safeDefault.data.kind, "role");
  if (safeDefault.data.kind === "role") {
    assert.equal(safeDefault.data.permissions, "0");
    assert.ok(safeDefault.data.warnings.length > 0);
  }
});

test("audit-log channel recovery retains available channel and overwrite details", () => {
  const candidate = candidateFromAuditEntry("channel", {
    id: "audit-channel-1",
    targetId: "deleted-channel-1",
    createdTimestamp: timestamp,
    executorId: "moderator-1",
    changes: [
      { key: "name", old: "announcements" },
      { key: "type", old: ChannelType.GuildText },
      { key: "position", old: 3 },
      { key: "parent_id", old: "category-1" },
      { key: "topic", old: "Server updates" },
      {
        key: "permission_overwrites",
        old: [
          {
            id: "role-1",
            type: 0,
            allow: "1024",
            deny: "0",
          },
        ],
      },
    ],
  });

  assert.ok(candidate);
  assert.equal(candidate.data.kind, "channel");
  if (candidate.data.kind !== "channel") return;
  assert.equal(candidate.data.name, "announcements");
  assert.equal(candidate.data.parentId, "category-1");
  assert.equal(candidate.data.topic, "Server updates");
  assert.deepEqual(candidate.data.permissionOverwrites, [
    { id: "role-1", type: 0, allow: "1024", deny: "0" },
  ]);
  assert.equal(candidate.data.permissionOverwritesAvailable, true);
});

test("audit-log recovery excludes channels whose type is unavailable or unsupported", () => {
  const missingType = candidateFromAuditEntry("channel", {
    id: "audit-channel-missing-type",
    targetId: "deleted-channel-2",
    createdTimestamp: timestamp,
    executorId: null,
    changes: [{ key: "name", old: "unknown" }],
  });
  const thread = candidateFromAuditEntry("channel", {
    id: "audit-channel-thread",
    targetId: "deleted-thread-1",
    createdTimestamp: timestamp,
    executorId: null,
    changes: [
      { key: "name", old: "thread" },
      { key: "type", old: ChannelType.PublicThread },
    ],
  });
  assert.equal(missingType, null);
  assert.equal(thread, null);
});

test("audit-log recovery can use a deleted target ID when Discord omits targetId", () => {
  const candidate = candidateFromAuditEntry("role", {
    id: "audit-role-target-fallback",
    targetId: null,
    target: { id: "deleted-role-fallback" },
    createdTimestamp: timestamp,
    executorId: null,
    changes: [{ key: "name", old: "Recovered Role" }],
  });
  assert.equal(candidate?.data.originalId, "deleted-role-fallback");
  assert.equal(
    candidateFromAuditEntry("role", {
      id: "audit-role-invalid-date",
      targetId: "deleted-role-invalid",
      createdTimestamp: Number.NaN,
      executorId: null,
      changes: [{ key: "name", old: "Invalid" }],
    }),
    null,
  );
});

test("audit session validation rejects incomplete channel permission data", () => {
  const valid = candidateFromAuditEntry("channel", {
    id: "audit-channel-valid",
    targetId: "deleted-channel-valid",
    createdTimestamp: timestamp,
    executorId: null,
    changes: [
      { key: "name", old: "private-room" },
      { key: "type", old: ChannelType.GuildText },
      {
        key: "permission_overwrites",
        old: [
          { id: "old-role-id", type: 0, allow: "1024", deny: "0" },
        ],
      },
    ],
  });
  assert.ok(valid);
  const corrupted = {
    ...valid,
    data: {
      ...valid.data,
      kind: "channel",
      permissionOverwrites: null,
    },
  };
  assert.deepEqual(validAuditRecoveryCandidates([valid, corrupted]), [valid]);
});

test("restored channels stay hidden if audit-log access settings are incomplete", async () => {
  const candidate = candidateFromAuditEntry("channel", {
    id: "audit-channel-hidden",
    targetId: "deleted-channel-hidden",
    createdTimestamp: timestamp,
    executorId: null,
    changes: [
      { key: "name", old: "private-room" },
      { key: "type", old: ChannelType.GuildText },
      {
        key: "permission_overwrites",
        old: [
          { id: "deleted-role-id", type: 0, allow: "1024", deny: "0" },
        ],
      },
    ],
  });
  assert.ok(candidate);

  let createOptions: Record<string, unknown> | undefined;
  const guild = {
    id: "guild-1",
    members: {
      me: { permissions: { has: () => true } },
      cache: { has: () => false },
    },
    channels: {
      cache: { find: () => undefined },
      create: async (options: Record<string, unknown>) => {
        createOptions = options;
        return { id: "restored-channel" };
      },
    },
  } as unknown as Guild;

  const report = await restoreAuditLogResources(guild, [candidate]);
  assert.equal(report.restored.length, 1);
  const overwrites = createOptions?.permissionOverwrites as
    | { id: string; allow: bigint; deny: bigint }[]
    | undefined;
  assert.equal(overwrites?.length, 1);
  assert.equal(overwrites?.[0]?.id, "guild-1");
  assert.equal(overwrites?.[0]?.allow, 0n);
  assert.equal(overwrites?.[0]?.deny, PermissionFlagsBits.ViewChannel);
});

test("audit recovery reports missing bot permissions without making Discord changes", async () => {
  const candidate = candidateFromAuditEntry("role", {
    id: "audit-role-no-permission",
    targetId: "deleted-role-3",
    createdTimestamp: timestamp,
    executorId: null,
    changes: [
      { key: "name", old: "Staff" },
      { key: "permissions", old: "0" },
    ],
  });
  assert.ok(candidate);

  const guild = {
    members: {
      me: { permissions: { has: () => false } },
    },
  } as unknown as Guild;
  const report = await restoreAuditLogResources(guild, [candidate]);
  assert.equal(report.restored.length, 0);
  assert.match(report.failed[0] ?? "", /Manage Roles/);

  const auditLookup = await listAuditRecoveryCandidates(guild);
  assert.equal(auditLookup.ok, false);
  if (!auditLookup.ok) assert.match(auditLookup.reason, /View Audit Log/);
});
