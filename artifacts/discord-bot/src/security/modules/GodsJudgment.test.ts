import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  Collection,
  Events,
  PermissionFlagsBits,
} from "discord.js";
import type { Client, Guild, GuildMember, NonThreadGuildBasedChannel, Role } from "discord.js";
import { loggingService } from "../../lib/registry.js";
import type { SecurityManager } from "../SecurityManager.js";
import type { GodsJudgmentConfig, JudgmentRecord } from "../types.js";
import { GodsJudgment } from "./GodsJudgment.js";

type FakeOverwrite = {
  allow: { has(permission: bigint): boolean };
  deny: { has(permission: bigint): boolean };
};

function overwrite(allowBits = 0n, denyBits = 0n): FakeOverwrite {
  return {
    allow: {
      has: (permission) => (allowBits & permission) === permission,
    },
    deny: {
      has: (permission) => (denyBits & permission) === permission,
    },
  };
}

function makeRole(
  id: string,
  initialPermissions = 0n,
  editable = true,
): Role {
  let bitfield = initialPermissions;
  const role = {
    id,
    name: id,
    editable,
    managed: false,
    get permissions() {
      return {
        bitfield,
        has: (permission: bigint) => (bitfield & permission) === permission,
      };
    },
    setPermissions: async (permissions: bigint) => {
      bitfield = permissions;
      return role;
    },
  };
  return role as unknown as Role;
}

function makeChannel(
  guild: Guild,
  id: string,
  type: ChannelType,
  initialMemberState: "allow" | "deny" | "unset" = "unset",
  initialRoleState: "allow" | "deny" | "unset" = "unset",
): NonThreadGuildBasedChannel {
  const cache = new Map<string, FakeOverwrite>();
  const viewFlag = PermissionFlagsBits.ViewChannel;
  if (initialMemberState !== "unset") {
    cache.set(
      "punished-user",
      initialMemberState === "allow"
        ? overwrite(viewFlag)
        : overwrite(0n, viewFlag),
    );
  }
  if (initialRoleState !== "unset") {
    cache.set(
      "existing-role",
      initialRoleState === "allow"
        ? overwrite(viewFlag)
        : overwrite(0n, viewFlag),
    );
  }
  const channel = {
    id,
    guild,
    guildId: guild.id,
    name: id,
    send: async () => undefined,
    type,
    isThread: () => false,
    permissionOverwrites: {
      cache,
      edit: async (
        target: string | { id: string },
        permissions: Record<string, boolean | null>,
      ) => {
        const targetId = typeof target === "string" ? target : target.id;
        const current = cache.get(targetId) ?? overwrite();
        let allowBits = 0n;
        let denyBits = 0n;
        for (const permission of Object.values(PermissionFlagsBits)) {
          if (current.allow.has(permission)) allowBits |= permission;
          if (current.deny.has(permission)) denyBits |= permission;
        }
        for (const [name, value] of Object.entries(permissions)) {
          const bit = PermissionFlagsBits[name as keyof typeof PermissionFlagsBits];
          if (typeof bit !== "bigint") continue;
          allowBits &= ~bit;
          denyBits &= ~bit;
          if (value === true) allowBits |= bit;
          if (value === false) denyBits |= bit;
        }
        cache.set(targetId, overwrite(allowBits, denyBits));
      },
    },
  };
  return channel as unknown as NonThreadGuildBasedChannel;
}

function makeFixture(
  channelSpecs: Array<{
    id: string;
    type: ChannelType;
    memberState?: "allow" | "deny" | "unset";
    roleState?: "allow" | "deny" | "unset";
  }>,
  record?: Partial<JudgmentRecord>,
) {
  const judgmentRole = makeRole("judgment-role");
  const savedRole = makeRole("saved-role");
  const everyoneRole = makeRole("guild");
  const channels = new Map<string, NonThreadGuildBasedChannel>();
  const guild = {
    id: "guild",
    name: "test-guild",
    ownerId: "server-owner",
    roles: {
      cache: new Map([
        [judgmentRole.id, judgmentRole],
        [savedRole.id, savedRole],
        [everyoneRole.id, everyoneRole],
      ]),
      everyone: everyoneRole,
      fetch: async (id: string) => {
        const role = id === judgmentRole.id ? judgmentRole : null;
        return role;
      },
    },
    channels: {
      cache: channels,
      fetch: async () => channels,
    },
    members: {
      cache: new Map<string, GuildMember>(),
      fetch: async (id: string) => (id === "punished-user" ? member : null),
      me: {
        permissions: { has: () => true },
        roles: { highest: { comparePositionTo: () => 1 } },
      },
    },
  } as unknown as Guild;

  let member: GuildMember;
  const memberRoleCache = new Collection([
    [everyoneRole.id, everyoneRole],
  ]);
  const memberRoles = {
    cache: memberRoleCache,
    highest: { comparePositionTo: () => -1 },
    set: async (roleIds: string[]) => {
      memberRoleCache.clear();
      memberRoleCache.set(everyoneRole.id, everyoneRole);
      for (const roleId of roleIds) {
        const role = guild.roles.cache.get(roleId);
        if (role) memberRoleCache.set(role.id, role);
      }
      return member;
    },
    add: async (role: Role) => {
      memberRoleCache.set(role.id, role);
      return member;
    },
    remove: async (roleIds: string[] | string | Role) => {
      const ids = Array.isArray(roleIds)
        ? roleIds
        : [typeof roleIds === "string" ? roleIds : roleIds.id];
      for (const roleId of ids) memberRoleCache.delete(roleId);
      return member;
    },
  };
  member = {
    id: "punished-user",
    user: { tag: "punished#0001" },
    guild,
    permissions: { has: () => false },
    roles: memberRoles,
    send: async () => undefined,
  } as unknown as GuildMember;
  (
    member.permissions as unknown as {
      has: (permission: bigint) => boolean;
    }
  ).has = (permission) =>
    member.roles.cache.some((role) => role.permissions.has(permission));
  (guild.members.cache as Map<string, GuildMember>).set(member.id, member);

  for (const spec of channelSpecs) {
    channels.set(
      spec.id,
      makeChannel(
        guild,
        spec.id,
        spec.type,
        spec.memberState ?? "unset",
        spec.roleState ?? "unset",
      ),
    );
  }

  const activeRecord: JudgmentRecord = {
    userId: member.id,
    savedRoles: ["saved-role"],
    judgedAt: "2026-01-01T00:00:00.000Z",
    reason: "test",
    judgedBy: "server-owner",
    ...record,
  };
  const config: GodsJudgmentConfig = {
    enabled: true,
    logChannelId: null,
    dmOnAction: false,
    judgmentRoleId: judgmentRole.id,
    judgmentChannelId: "judgment-channel",
    activeJudgments: { [member.id]: activeRecord },
  };
  const manager = {
    getConfig: () => ({ godsJudgment: config }),
    updateModuleConfig: async (
      _guildId: string,
      _module: string,
      patch: Partial<GodsJudgmentConfig>,
    ) => {
      Object.assign(config, patch);
      return { godsJudgment: config };
    },
  } as unknown as SecurityManager;

  return {
    module: new GodsJudgment(manager),
    manager,
    config,
    guild,
    member,
    channels,
    judgmentRole,
  };
}

function stateFor(channel: NonThreadGuildBasedChannel, targetId: string) {
  const entry = channel.permissionOverwrites.cache.get(targetId);
  if (entry?.allow.has(PermissionFlagsBits.ViewChannel)) return "allow";
  if (entry?.deny.has(PermissionFlagsBits.ViewChannel)) return "deny";
  return "unset";
}

test("all channel kinds, including the Judgment channel, are hidden from judged members", async () => {
  const fixture = makeFixture([
    {
      id: "general-category",
      type: ChannelType.GuildCategory,
      memberState: "allow",
      roleState: "allow",
    },
    { id: "general-text", type: ChannelType.GuildText },
    { id: "general-voice", type: ChannelType.GuildVoice },
    { id: "general-stage", type: ChannelType.GuildStageVoice },
    { id: "general-forum", type: ChannelType.GuildForum },
    {
      id: "judgment-channel",
      type: ChannelType.GuildText,
      memberState: "allow",
      roleState: "allow",
    },
  ]);

  const stats = await fixture.module.applyOverwritesToAllChannels(
    fixture.guild,
    fixture.judgmentRole.id,
    "judgment-channel",
  );

  assert.equal(stats.errors, 0);
  for (const channelId of [
    "general-category",
    "general-text",
    "general-voice",
    "general-stage",
    "general-forum",
    "judgment-channel",
  ]) {
    const channel = fixture.channels.get(channelId)!;
    assert.equal(
      channel.permissionOverwrites.cache
        .get(fixture.judgmentRole.id)
        ?.deny.has(PermissionFlagsBits.ViewChannel),
      true,
      `${channelId} should deny the Judgment role`,
    );
    assert.equal(stateFor(channel, fixture.member.id), "deny", `${channelId} should deny the member`);
    if (channelId === "general-category" || channelId === "judgment-channel") {
      assert.equal(
        channel.permissionOverwrites.cache
          .get("existing-role")
          ?.allow.has(PermissionFlagsBits.ViewChannel),
        true,
        `${channelId} should retain the existing role allow while the member deny takes precedence`,
      );
    }
  }

  assert.deepEqual(
    fixture.config.activeJudgments[fixture.member.id].savedChannelViewPermissions,
    {
      "general-category": "allow",
      "general-text": "unset",
      "general-voice": "unset",
      "general-stage": "unset",
      "general-forum": "unset",
      "judgment-channel": "allow",
    },
  );
});

test("new and updated channels reapply member-specific isolation", async () => {
  const fixture = makeFixture([], { savedChannelViewPermissions: {} });
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const client = {
    on: (event: string, listener: (...args: unknown[]) => Promise<void>) => {
      handlers.set(event, listener);
      return client;
    },
  } as unknown as Client;
  fixture.module.register(client);

  const newChannel = makeChannel(
    fixture.guild,
    "new-forum",
    ChannelType.GuildForum,
    "allow",
    "allow",
  );
  fixture.channels.set(newChannel.id, newChannel);
  await handlers.get(Events.ChannelCreate)!(newChannel);
  assert.equal(stateFor(newChannel, fixture.member.id), "deny");
  assert.equal(
    fixture.config.activeJudgments[fixture.member.id]
      .savedChannelViewPermissions?.[newChannel.id],
    "allow",
  );

  await newChannel.permissionOverwrites.edit(fixture.member, { ViewChannel: true });
  assert.equal(stateFor(newChannel, fixture.member.id), "allow");
  await handlers.get(Events.ChannelUpdate)!(newChannel, newChannel);
  assert.equal(stateFor(newChannel, fixture.member.id), "deny");

  const judgmentChannel = makeChannel(
    fixture.guild,
    "judgment-channel",
    ChannelType.GuildText,
    "allow",
    "allow",
  );
  fixture.channels.set(judgmentChannel.id, judgmentChannel);
  fixture.member.roles.cache.set(
    fixture.judgmentRole.id,
    fixture.judgmentRole,
  );
  let leakedMessageDeleted = false;
  await handlers.get(Events.MessageCreate)!({
    inGuild: () => true,
    author: {
      bot: false,
      id: fixture.member.id,
      tag: "punished#0001",
    },
    guildId: fixture.guild.id,
    guild: fixture.guild,
    member: fixture.member,
    channelId: judgmentChannel.id,
    channel: judgmentChannel,
    deletable: true,
    delete: async () => {
      leakedMessageDeleted = true;
    },
  });
  assert.equal(
    leakedMessageDeleted,
    true,
    "the configured Judgment channel must not be a message leak exception",
  );
  assert.equal(stateFor(judgmentChannel, fixture.member.id), "deny");
});

test("release restores the user's prior per-channel view permissions", async () => {
  const fixture = makeFixture([
    { id: "general-text", type: ChannelType.GuildText, memberState: "allow" },
    { id: "judgment-channel", type: ChannelType.GuildText, memberState: "allow" },
  ]);
  await fixture.module.applyOverwritesToAllChannels(
    fixture.guild,
    fixture.judgmentRole.id,
    "judgment-channel",
  );

  const originalLogRelease = loggingService.logRelease;
  loggingService.logRelease = async () => undefined;
  try {
    const result = await fixture.module.release(
      fixture.member,
      "owner release",
      "server-owner",
    );
    assert.equal(result.success, true);
  } finally {
    loggingService.logRelease = originalLogRelease;
  }

  assert.equal(stateFor(fixture.channels.get("general-text")!, fixture.member.id), "allow");
  assert.equal(stateFor(fixture.channels.get("judgment-channel")!, fixture.member.id), "allow");
  assert.equal(
    fixture.config.activeJudgments[fixture.member.id],
    undefined,
  );
});

test("service-level release rejects non-owners before changing roles", async () => {
  const module = new GodsJudgment({} as SecurityManager);
  let roleRestoreCalls = 0;
  const member = {
    id: "punished-user",
    user: { tag: "punished#0001" },
    guild: { id: "guild", ownerId: "server-owner" },
    roles: { set: async () => { roleRestoreCalls++; } },
  } as unknown as GuildMember;

  const result = await module.release(member, "admin attempt", "administrator");

  assert.equal(result.success, false);
  assert.match(result.reason, /actual owner/u);
  assert.equal(roleRestoreCalls, 0);
});

test("Administrator members are isolated after snapshotting and removing dangerous roles", async () => {
  const fixture = makeFixture([
    { id: "general-text", type: ChannelType.GuildText },
    { id: "judgment-channel", type: ChannelType.GuildText },
  ]);
  fixture.config.activeJudgments = {};
  const adminRole = makeRole(
    "admin-role",
    PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageChannels,
  );
  fixture.guild.roles.cache.set(adminRole.id, adminRole);
  fixture.member.roles.cache.set("saved-role", makeRole("saved-role"));
  fixture.member.roles.cache.set(adminRole.id, adminRole);

  let removeCalls = 0;
  fixture.member.roles.remove = async (roleIds: string[] | string | Role) => {
    removeCalls++;
    assert.deepEqual(
      fixture.config.activeJudgments[fixture.member.id].savedRoles,
      ["saved-role", "admin-role"],
      "the complete original role snapshot must be persisted before mutation",
    );
    for (const channel of fixture.channels.values()) {
      assert.equal(
        stateFor(channel, fixture.member.id),
        "deny",
        "member-specific denies must be ready before Administrator is removed",
      );
    }
    const ids = Array.isArray(roleIds)
      ? roleIds
      : [typeof roleIds === "string" ? roleIds : roleIds.id];
    for (const id of ids) fixture.member.roles.cache.delete(id);
    return fixture.member;
  };

  const manager = fixture.manager as SecurityManager;
  let configWrites = 0;
  const originalUpdate = manager.updateModuleConfig.bind(manager);
  manager.updateModuleConfig = async (...args) => {
    configWrites++;
    return originalUpdate(...args);
  };

  const originalLogJudgment = loggingService.logJudgment;
  const originalLogRelease = loggingService.logRelease;
  loggingService.logJudgment = async () => undefined;
  loggingService.logRelease = async () => undefined;
  try {
    const result = await fixture.module.placeInJudgment(
      fixture.member,
      "test",
      "administrator",
    );
    assert.equal(result.success, true);
    assert.equal(result.partial, false);
    assert.equal(removeCalls, 1);
    assert.equal(
      fixture.member.permissions.has(PermissionFlagsBits.Administrator),
      false,
    );
    assert.equal(fixture.member.roles.cache.has(fixture.judgmentRole.id), true);
    assert.deepEqual(
      fixture.config.activeJudgments[fixture.member.id].savedRoles,
      ["saved-role", "admin-role"],
    );

    const writesAfterFirstSnapshot = configWrites;
    const duplicate = await fixture.module.placeInJudgment(
      fixture.member,
      "duplicate attempt",
      "administrator",
    );
    assert.equal(duplicate.success, false);
    assert.match(duplicate.reason, /already under/u);
    assert.equal(configWrites, writesAfterFirstSnapshot);
    assert.equal(removeCalls, 1);

    const released = await fixture.module.release(
      fixture.member,
      "owner release",
      "server-owner",
    );
    assert.equal(released.success, true);
    assert.equal(fixture.member.roles.cache.has(adminRole.id), true);
    assert.equal(fixture.member.roles.cache.has("saved-role"), true);
    assert.equal(
      fixture.member.roles.cache.has(fixture.judgmentRole.id),
      false,
    );
  } finally {
    loggingService.logJudgment = originalLogJudgment;
    loggingService.logRelease = originalLogRelease;
  }
});

test("unmanageable Administrator roles fail before snapshot or role mutation", async () => {
  for (const failureMode of [
    "uneditable-role",
    "target-hierarchy",
    "bot-permission",
    "everyone-permission",
  ] as const) {
    const fixture = makeFixture([
      { id: "general-text", type: ChannelType.GuildText },
    ]);
    fixture.config.activeJudgments = {};
    const adminRole = makeRole(
      "managed-admin-role",
      PermissionFlagsBits.Administrator,
      failureMode !== "uneditable-role",
    );
    if (failureMode === "target-hierarchy") {
      fixture.member.roles.highest.comparePositionTo = () => 0;
    }
    if (failureMode === "bot-permission") {
      (
        fixture.guild.members.me!.permissions as unknown as {
          has: (permission: bigint) => boolean;
        }
      ).has = (permission) => permission !== PermissionFlagsBits.ManageRoles;
    }
    if (failureMode === "everyone-permission") {
      await fixture.guild.roles.everyone.setPermissions(
        PermissionFlagsBits.ManageChannels,
      );
    }
    fixture.guild.roles.cache.set(adminRole.id, adminRole);
    fixture.member.roles.cache.set(adminRole.id, adminRole);

    let configWrites = 0;
    let roleMutations = 0;
    const manager = fixture.manager as SecurityManager;
    const originalUpdate = manager.updateModuleConfig.bind(manager);
    manager.updateModuleConfig = async (...args) => {
      configWrites++;
      return originalUpdate(...args);
    };
    fixture.member.roles.remove = async () => {
      roleMutations++;
      return fixture.member;
    };
    fixture.member.roles.add = async () => {
      roleMutations++;
      return fixture.member;
    };

    const result = await fixture.module.placeInJudgment(
      fixture.member,
      "test",
      "server-owner",
    );
    assert.equal(result.success, false, failureMode);
    assert.match(result.reason, /isolation was not completed/u, failureMode);
    assert.equal(configWrites, 0, failureMode);
    assert.equal(roleMutations, 0, failureMode);
    assert.equal(
      fixture.config.activeJudgments[fixture.member.id],
      undefined,
      failureMode,
    );
  }
});

test("repair preserves the original snapshot instead of saving later-added roles", async () => {
  const fixture = makeFixture(
    [
      { id: "general-text", type: ChannelType.GuildText },
      { id: "judgment-channel", type: ChannelType.GuildText },
    ],
    { savedRoles: ["saved-role"], savedChannelViewPermissions: {} },
  );
  const adminRole = makeRole("later-admin-role", PermissionFlagsBits.Administrator);
  fixture.guild.roles.cache.set(adminRole.id, adminRole);
  fixture.member.roles.cache.set("saved-role", fixture.guild.roles.cache.get("saved-role")!);
  fixture.member.roles.cache.set(adminRole.id, adminRole);

  const originalLogJudgment = loggingService.logJudgment;
  const originalLogRelease = loggingService.logRelease;
  loggingService.logJudgment = async () => undefined;
  loggingService.logRelease = async () => undefined;
  try {
    const repaired = await fixture.module.placeInJudgment(
      fixture.member,
      "repair existing judgment",
      "server-owner",
    );
    assert.equal(repaired.success, true);
    assert.equal(fixture.member.roles.cache.has(adminRole.id), false);
    assert.equal(fixture.member.roles.cache.has(fixture.judgmentRole.id), true);
    assert.deepEqual(
      fixture.config.activeJudgments[fixture.member.id].savedRoles,
      ["saved-role"],
    );

    const released = await fixture.module.release(
      fixture.member,
      "owner release",
      "server-owner",
    );
    assert.equal(released.success, true);
    assert.equal(fixture.member.roles.cache.has("saved-role"), true);
    assert.equal(fixture.member.roles.cache.has(adminRole.id), false);
  } finally {
    loggingService.logJudgment = originalLogJudgment;
    loggingService.logRelease = originalLogRelease;
  }
});

test("owner release removes a later-added Administrator role using the saved snapshot", async () => {
  const fixture = makeFixture(
    [
      {
        id: "general-text",
        type: ChannelType.GuildText,
        memberState: "allow",
      },
      { id: "judgment-channel", type: ChannelType.GuildText },
    ],
    {
      savedRoles: ["saved-role"],
      savedChannelViewPermissions: {
        "general-text": "allow",
        "judgment-channel": "unset",
      },
    },
  );
  const laterAdminRole = makeRole(
    "later-admin-role",
    PermissionFlagsBits.Administrator,
  );
  fixture.guild.roles.cache.set(laterAdminRole.id, laterAdminRole);
  fixture.member.roles.cache.set(
    fixture.judgmentRole.id,
    fixture.judgmentRole,
  );
  fixture.member.roles.cache.set(laterAdminRole.id, laterAdminRole);

  fixture.member.roles.set = async (roleIds: string[]) => {
    for (const channel of fixture.channels.values()) {
      assert.equal(
        stateFor(channel, fixture.member.id),
        "deny",
        "channel denies must be in place before replacing roles",
      );
    }
    fixture.member.roles.cache.clear();
    fixture.member.roles.cache.set(
      fixture.guild.roles.everyone.id,
      fixture.guild.roles.everyone,
    );
    for (const roleId of roleIds) {
      const role = fixture.guild.roles.cache.get(roleId);
      if (role) fixture.member.roles.cache.set(role.id, role);
    }
    return fixture.member;
  };

  const originalLogRelease = loggingService.logRelease;
  loggingService.logRelease = async () => undefined;
  try {
    const result = await fixture.module.release(
      fixture.member,
      "owner release",
      "server-owner",
    );
    assert.equal(result.success, true);
    assert.equal(fixture.member.roles.cache.has("saved-role"), true);
    assert.equal(fixture.member.roles.cache.has(laterAdminRole.id), false);
    assert.equal(
      stateFor(fixture.channels.get("general-text")!, fixture.member.id),
      "allow",
    );
    assert.equal(
      fixture.config.activeJudgments[fixture.member.id],
      undefined,
    );
  } finally {
    loggingService.logRelease = originalLogRelease;
  }
});

test("snapshot persistence failure changes neither roles nor channel overwrites", async () => {
  const fixture = makeFixture([
    { id: "general-text", type: ChannelType.GuildText },
  ]);
  fixture.config.activeJudgments = {};
  const adminRole = makeRole("admin-role", PermissionFlagsBits.Administrator);
  fixture.guild.roles.cache.set(adminRole.id, adminRole);
  fixture.member.roles.cache.set(adminRole.id, adminRole);

  let channelEdits = 0;
  let roleMutations = 0;
  const channel = fixture.channels.get("general-text")!;
  channel.permissionOverwrites.edit = async () => {
    channelEdits++;
    return channel;
  };
  fixture.member.roles.remove = async () => {
    roleMutations++;
    return fixture.member;
  };
  fixture.member.roles.add = async () => {
    roleMutations++;
    return fixture.member;
  };
  fixture.manager.updateModuleConfig = async () => {
    throw new Error("snapshot storage unavailable");
  };

  const result = await fixture.module.placeInJudgment(
    fixture.member,
    "test",
    "server-owner",
  );
  assert.equal(result.success, false);
  assert.match(result.reason, /snapshot could not be saved/u);
  assert.equal(channelEdits, 0);
  assert.equal(roleMutations, 0);
  assert.equal(fixture.member.roles.cache.has(adminRole.id), true);
});

test("failed dangerous-role removal leaves a saved snapshot for owner-only release", async () => {
  const fixture = makeFixture([
    { id: "general-text", type: ChannelType.GuildText },
    { id: "judgment-channel", type: ChannelType.GuildText },
  ]);
  fixture.config.activeJudgments = {};
  const adminRole = makeRole("admin-role", PermissionFlagsBits.Administrator);
  fixture.guild.roles.cache.set(adminRole.id, adminRole);
  fixture.member.roles.cache.set(
    "saved-role",
    fixture.guild.roles.cache.get("saved-role")!,
  );
  fixture.member.roles.cache.set(adminRole.id, adminRole);
  fixture.member.roles.remove = async () => {
    fixture.member.roles.cache.delete("saved-role");
    throw new Error("Discord denied role change");
  };

  const result = await fixture.module.placeInJudgment(
    fixture.member,
    "test",
    "server-owner",
  );
  assert.equal(result.success, false);
  assert.equal(result.roleAssigned, false);
  assert.match(result.reason, /isolation was not completed/u);
  assert.equal(fixture.member.roles.cache.has(adminRole.id), true);
  assert.equal(fixture.member.roles.cache.has(fixture.judgmentRole.id), false);
  assert.deepEqual(
    fixture.config.activeJudgments[fixture.member.id].savedRoles,
    ["saved-role", "admin-role"],
  );

  const originalLogRelease = loggingService.logRelease;
  let restoreCalls = 0;
  fixture.member.roles.set = async (roleIds: string[]) => {
    restoreCalls++;
    fixture.member.roles.cache.clear();
    fixture.member.roles.cache.set(
      fixture.guild.roles.everyone.id,
      fixture.guild.roles.everyone,
    );
    for (const roleId of roleIds) {
      const role = fixture.guild.roles.cache.get(roleId);
      if (role) fixture.member.roles.cache.set(role.id, role);
    }
    return fixture.member;
  };
  loggingService.logRelease = async () => undefined;
  try {
    const released = await fixture.module.release(
      fixture.member,
      "owner cleanup",
      "server-owner",
    );
    assert.equal(released.success, true);
    assert.equal(fixture.member.roles.cache.has(adminRole.id), true);
    assert.equal(
      stateFor(fixture.channels.get("general-text")!, fixture.member.id),
      "unset",
    );
    assert.equal(
      fixture.config.activeJudgments[fixture.member.id],
      undefined,
    );

    const duplicateRelease = await fixture.module.release(
      fixture.member,
      "duplicate cleanup",
      "server-owner",
    );
    assert.equal(duplicateRelease.success, false);
    assert.equal(restoreCalls, 1);
  } finally {
    loggingService.logRelease = originalLogRelease;
  }
});

test("God's Judgment never changes the server owner's roles", async () => {
  const fixture = makeFixture([]);
  const owner = {
    ...fixture.member,
    id: fixture.guild.ownerId,
    user: { tag: "owner#0001" },
  } as unknown as GuildMember;
  let roleMutations = 0;
  owner.roles.remove = async () => {
    roleMutations++;
    return owner;
  };
  owner.roles.set = async () => {
    roleMutations++;
    return owner;
  };

  const punishment = await fixture.module.placeInJudgment(
    owner,
    "test",
    "server-owner",
  );
  const release = await fixture.module.release(
    owner,
    "test",
    "server-owner",
  );
  assert.equal(punishment.success, false);
  assert.equal(release.success, false);
  assert.equal(roleMutations, 0);
});

test("validation clears dangerous permissions from the Judgment role", async () => {
  const fixture = makeFixture([
    { id: "general-text", type: ChannelType.GuildText },
    { id: "judgment-channel", type: ChannelType.GuildText },
  ]);
  await fixture.judgmentRole.setPermissions(
    PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageChannels,
  );

  const stats = await fixture.module.validateAndRepair(fixture.guild);

  assert.equal(fixture.judgmentRole.permissions.bitfield, 0n);
  assert.equal(stats.errors, 0);
});

test("placement fails before mutation when Discord's overwrite cap blocks isolation", async () => {
  const fixture = makeFixture([
    { id: "full-channel", type: ChannelType.GuildText },
  ]);
  fixture.config.activeJudgments = {};
  const channel = fixture.channels.get("full-channel")!;
  const overwriteCache =
    channel.permissionOverwrites.cache as unknown as Map<string, FakeOverwrite>;
  for (let index = 0; index < 100; index++) {
    overwriteCache.set(`other-${index}`, overwrite());
  }

  let roleAddCalls = 0;
  fixture.member.roles.add = async () => {
    roleAddCalls++;
    return fixture.member;
  };
  const result = await fixture.module.placeInJudgment(
    fixture.member,
    "test",
    "server-owner",
  );

  assert.equal(result.success, false);
  assert.match(result.reason, /100 permission overwrites/u);
  assert.equal(roleAddCalls, 0);
});
