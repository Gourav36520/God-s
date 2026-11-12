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

function makeRole(id: string, initialPermissions = 0n): Role {
  let bitfield = initialPermissions;
  const role = {
    id,
    name: id,
    editable: true,
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
  const channel = {
    id,
    guild,
    guildId: guild.id,
    name: id,
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
      },
    },
  } as unknown as Guild;

  const member = {
    id: "punished-user",
    user: { tag: "punished#0001" },
    guild,
    permissions: { has: () => false },
    roles: {
      cache: new Collection([[everyoneRole.id, everyoneRole]]),
      set: async () => undefined,
      add: async () => undefined,
      remove: async () => undefined,
    },
    send: async () => undefined,
  } as unknown as GuildMember;
  (guild.members.cache as Map<string, GuildMember>).set(member.id, member);

  for (const spec of channelSpecs) {
    channels.set(
      spec.id,
      makeChannel(
        guild,
        spec.id,
        spec.type,
        spec.memberState ?? "unset",
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

  return { module: new GodsJudgment(manager), config, guild, member, channels, judgmentRole };
}

function stateFor(channel: NonThreadGuildBasedChannel, targetId: string) {
  const entry = channel.permissionOverwrites.cache.get(targetId);
  if (entry?.allow.has(PermissionFlagsBits.ViewChannel)) return "allow";
  if (entry?.deny.has(PermissionFlagsBits.ViewChannel)) return "deny";
  return "unset";
}

test("member-specific isolation overrides role and explicit user allows across channel kinds", async () => {
  const fixture = makeFixture([
    { id: "general-category", type: ChannelType.GuildCategory, memberState: "allow" },
    { id: "general-text", type: ChannelType.GuildText },
    { id: "general-voice", type: ChannelType.GuildVoice },
    { id: "general-stage", type: ChannelType.GuildStageVoice },
    { id: "general-forum", type: ChannelType.GuildForum },
    { id: "judgment-channel", type: ChannelType.GuildText, memberState: "deny" },
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
  }

  const judgmentChannel = fixture.channels.get("judgment-channel")!;
  assert.equal(stateFor(judgmentChannel, fixture.member.id), "allow");
  assert.deepEqual(
    fixture.config.activeJudgments[fixture.member.id].savedChannelViewPermissions,
    {
      "general-category": "allow",
      "general-text": "unset",
      "general-voice": "unset",
      "general-stage": "unset",
      "general-forum": "unset",
      "judgment-channel": "deny",
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
});

test("release restores the user's prior per-channel view permissions", async () => {
  const fixture = makeFixture([
    { id: "general-text", type: ChannelType.GuildText, memberState: "allow" },
    { id: "judgment-channel", type: ChannelType.GuildText, memberState: "deny" },
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
  assert.equal(stateFor(fixture.channels.get("judgment-channel")!, fixture.member.id), "deny");
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

test("targets with Administrator are rejected because Discord bypasses channel overwrites", async () => {
  const fixture = makeFixture([]);
  const adminMember = {
    ...fixture.member,
    permissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.Administrator,
    },
  } as unknown as GuildMember;
  let configWrites = 0;
  const originalUpdate = (
    fixture.module as unknown as { manager: SecurityManager }
  ).manager.updateModuleConfig;
  (
    fixture.module as unknown as { manager: SecurityManager }
  ).manager.updateModuleConfig = async (...args) => {
    configWrites++;
    return originalUpdate.apply(
      (fixture.module as unknown as { manager: SecurityManager }).manager,
      args,
    );
  };

  const result = await fixture.module.placeInJudgment(
    adminMember,
    "test",
    "administrator",
  );
  assert.equal(result.success, false);
  assert.match(result.reason, /bypasses channel overwrites/u);
  assert.equal(configWrites, 0);
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
