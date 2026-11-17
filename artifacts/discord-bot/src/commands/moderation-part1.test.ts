import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import type {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import { loggingService } from "../lib/registry.js";
import { createModerationRoleConfigCommands } from "./moderation-role-config.js";
import {
  execute,
  handleModerationConfirmation,
} from "./moderation.js";

function embedTitle(response: unknown): string | undefined {
  const title = (
    response as {
      embeds?: Array<{ data?: { title?: string } }>;
    }
  )?.embeds?.[0]?.data?.title;
  return title?.replace(/^<:[^>]+>\s*/u, "");
}

function makeAdminCommandInteraction(commandName: string) {
  let response: unknown;
  let deferred = false;
  let memberFetches = 0;
  let moderationActions = 0;
  const moderator = {
    id: "administrator",
    permissions: { has: () => true },
    roles: { cache: new Map(), highest: { comparePositionTo: () => 1 } },
    user: { tag: "administrator#0001", username: "administrator" },
  } as unknown as GuildMember;
  const botMember = {
    id: "bot",
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: () => 1 } },
  } as unknown as GuildMember;
  const guild = {
    id: "guild",
    ownerId: "actual-owner",
    members: {
      me: botMember,
      fetch: async (id: string) => {
        memberFetches++;
        return id === moderator.id ? moderator : null;
      },
      ban: async () => {
        moderationActions++;
      },
    },
  };
  const interaction = {
    commandName,
    guild,
    user: { id: moderator.id },
    options: {
      getUser: () => ({ id: "target" }),
      getString: () => null,
    },
    deferReply: async () => {
      deferred = true;
    },
    editReply: async (payload: unknown) => {
      response = payload;
      return payload;
    },
    reply: async (payload: unknown) => {
      response = payload;
      return payload;
    },
    get deferred() {
      return deferred;
    },
    get replied() {
      return response !== undefined;
    },
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    getResponse: () => response,
    getMemberFetches: () => memberFetches,
    getModerationActions: () => moderationActions,
  };
}

test("kick, ban, softban, and unban reject administrators who are not the owner", async () => {
  for (const commandName of ["kick", "ban", "softban", "unban"]) {
    const attempt = makeAdminCommandInteraction(commandName);
    await execute(attempt.interaction);

    assert.equal(
      embedTitle(attempt.getResponse()),
      "Server Owner Only",
      `/${commandName} must reject an administrator who is not the owner`,
    );
    assert.equal(attempt.getMemberFetches(), 1);
    assert.equal(attempt.getModerationActions(), 0);
  }
});

test("moderation role settings reject non-owners before reading or changing settings", async () => {
  let databaseCalls = 0;
  const commands = createModerationRoleConfigCommands({
    getModerationRoleConfig: async () => {
      databaseCalls++;
      return null;
    },
    setModerationRoleConfig: async () => {
      databaseCalls++;
    },
  });
  const managerCommand = commands.find(
    (command) => command.data.name === "manager",
  );
  assert.ok(managerCommand);

  let response: unknown;
  const interaction = {
    guild: {
      id: "guild",
      ownerId: "actual-owner",
      roles: { fetch: async () => ({ id: "manager-role", managed: false }) },
    },
    user: { id: "administrator" },
    options: {
      getSubcommand: () => "add",
      getRole: () => ({ id: "manager-role" }),
    },
    reply: async (payload: unknown) => {
      response = payload;
    },
  } as unknown as ChatInputCommandInteraction;

  await managerCommand.execute(interaction);

  assert.equal(embedTitle(response), "Server Owner Only");
  assert.equal(databaseCalls, 0);
});

test("Manager role configuration refuses a role already assigned to Admin", async () => {
  let savedField: string | undefined;
  const commands = createModerationRoleConfigCommands({
    getModerationRoleConfig: async () =>
      ({
        guildId: "guild",
        adminRoleId: "shared-role",
      }) as never,
    setModerationRoleConfig: async (_guildId, field) => {
      savedField = field;
    },
  });
  const managerCommand = commands.find(
    (command) => command.data.name === "manager",
  );
  assert.ok(managerCommand);

  let response: unknown;
  const interaction = {
    guild: {
      id: "guild",
      ownerId: "owner",
      roles: {
        fetch: async (roleId: string) => ({
          id: roleId,
          managed: false,
        }),
      },
    },
    user: { id: "owner" },
    options: {
      getSubcommand: () => "add",
      getRole: () => ({ id: "shared-role" }),
    },
    reply: async (payload: unknown) => {
      response = payload;
    },
  } as unknown as ChatInputCommandInteraction;

  await managerCommand.execute(interaction);

  assert.equal(embedTitle(response), "Role Already In Use");
  assert.equal(savedField, undefined);
});

function makePurgeFixture() {
  const roleCache = new Map<string, unknown>([["manager-role", { id: "manager-role" }]]);
  const moderator = {
    id: "manager",
    permissions: { has: () => false },
    roles: {
      cache: roleCache,
      highest: { comparePositionTo: () => 1 },
    },
    user: { tag: "manager#0001", username: "manager" },
  } as unknown as GuildMember;
  const botPermissions = new Set<bigint>([
    PermissionFlagsBits.ManageMessages,
  ]);
  const botMember = {
    id: "bot",
    permissions: { has: (permission: bigint) => botPermissions.has(permission) },
    roles: { highest: { comparePositionTo: () => 1 } },
  } as unknown as GuildMember;
  const channelPermissions = new Set<bigint>([
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
  let channelFetches = 0;
  let messageFetches = 0;
  const channel = {
    id: "channel",
    name: "general",
    type: ChannelType.GuildText,
    permissionsFor: () => ({
      has: (permission: bigint) => channelPermissions.has(permission),
    }),
    messages: {
      fetch: async () => {
        messageFetches++;
        return new Map();
      },
    },
    bulkDelete: async () => ({ size: 0 }),
  };
  const guild = {
    id: "guild",
    ownerId: "owner",
    members: {
      me: botMember,
      fetch: async (id: string) => (id === moderator.id ? moderator : null),
    },
    roles: {
      fetch: async (roleId: string) => ({ id: roleId }),
    },
    channels: {
      fetch: async () => {
        channelFetches++;
        return channel;
      },
    },
  };
  const loadRoleConfig = async () =>
    ({
      guildId: "guild",
      managerRoleId: "manager-role",
    }) as never;

  return {
    guild,
    moderator,
    botPermissions,
    channel,
    loadRoleConfig,
    getChannelFetches: () => channelFetches,
    getMessageFetches: () => messageFetches,
  };
}

async function startPurgeConfirmation(fixture: ReturnType<typeof makePurgeFixture>) {
  let response: unknown;
  let deferred = false;
  const commandInteraction = {
    commandName: "purge",
    guild: fixture.guild,
    channel: fixture.channel,
    user: { id: "manager" },
    options: {
      getInteger: () => 5,
      getString: () => "cleanup",
    },
    deferReply: async () => {
      deferred = true;
    },
    editReply: async (payload: unknown) => {
      response = payload;
      return payload;
    },
    reply: async (payload: unknown) => {
      response = payload;
      return payload;
    },
    get deferred() {
      return deferred;
    },
    get replied() {
      return false;
    },
  } as unknown as ChatInputCommandInteraction;

  await execute(commandInteraction, { loadRoleConfig: fixture.loadRoleConfig });
  const rows = (
    response as {
      components: Array<ActionRowBuilder<ButtonBuilder>>;
    }
  ).components;
  const buttonData = rows[0]?.components[0]?.toJSON() as
    | { custom_id?: string }
    | undefined;
  const customId = buttonData?.custom_id;
  assert.ok(customId);
  return customId;
}

function makePurgeButtonInteraction(
  fixture: ReturnType<typeof makePurgeFixture>,
  customId: string,
) {
  let response: unknown;
  const interaction = {
    customId,
    guild: fixture.guild,
    guildId: "guild",
    user: { id: "manager" },
    update: async (payload: unknown) => {
      response = payload;
    },
    reply: async (payload: unknown) => {
      response = payload;
    },
    deferUpdate: async () => undefined,
    editReply: async (payload: unknown) => {
      response = payload;
      return payload;
    },
  } as unknown as ButtonInteraction;
  return { interaction, getResponse: () => response };
}

test("purge confirmation rechecks that the Manager role is still assigned", async () => {
  const fixture = makePurgeFixture();
  const customId = await startPurgeConfirmation(fixture);
  fixture.moderator.roles.cache.delete("manager-role");
  const confirmation = makePurgeButtonInteraction(fixture, customId);

  await handleModerationConfirmation(confirmation.interaction, {
    loadRoleConfig: fixture.loadRoleConfig,
  });

  assert.equal(embedTitle(confirmation.getResponse()), "Role Required");
  assert.equal(fixture.getChannelFetches(), 0);
  assert.equal(fixture.getMessageFetches(), 0);
});

test("purge confirmation rechecks the bot's current server permission", async () => {
  const fixture = makePurgeFixture();
  const customId = await startPurgeConfirmation(fixture);
  fixture.botPermissions.delete(PermissionFlagsBits.ManageMessages);
  const confirmation = makePurgeButtonInteraction(fixture, customId);

  await handleModerationConfirmation(confirmation.interaction, {
    loadRoleConfig: fixture.loadRoleConfig,
  });

  assert.equal(embedTitle(confirmation.getResponse()), "Bot Permission Missing");
  assert.equal(fixture.getChannelFetches(), 0);
  assert.equal(fixture.getMessageFetches(), 0);
});

test("the third active warning applies the fixed 10-minute timeout", async () => {
  const moderator = {
    id: "warn-moderator",
    permissions: { has: () => false },
    roles: {
      cache: new Map([["warn-role", { id: "warn-role" }]]),
      highest: { comparePositionTo: () => 1 },
    },
    user: { tag: "moderator#0001", username: "moderator" },
  } as unknown as GuildMember;
  const timeoutCalls: Array<[number | null, string | undefined]> = [];
  const target = {
    id: "target",
    user: { id: "target", tag: "target#0001", username: "target" },
    permissions: { has: () => false },
    roles: { highest: { comparePositionTo: () => -1 } },
    timeout: async (duration: number | null, reason?: string) => {
      timeoutCalls.push([duration, reason]);
    },
  } as unknown as GuildMember;
  const botMember = {
    id: "bot",
    permissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.ModerateMembers,
    },
    roles: { highest: { comparePositionTo: () => 1 } },
  } as unknown as GuildMember;
  const guild = {
    id: "guild",
    ownerId: "owner",
    members: {
      me: botMember,
      fetch: async (id: string) =>
        id === moderator.id ? moderator : id === target.id ? target : null,
    },
    roles: { fetch: async (roleId: string) => ({ id: roleId }) },
  };
  const savedCases: Array<{
    action: string;
    durationSeconds?: number | null;
    reason: string;
  }> = [];
  let response: unknown;
  let deferred = false;
  const interaction = {
    commandName: "warn",
    guild,
    user: { id: moderator.id },
    options: {
      getUser: () => ({ id: target.id }),
      getString: () => "repeat behavior",
    },
    deferReply: async () => {
      deferred = true;
    },
    editReply: async (payload: unknown) => {
      response = payload;
      return payload;
    },
    reply: async (payload: unknown) => {
      response = payload;
      return payload;
    },
    get deferred() {
      return deferred;
    },
    get replied() {
      return response !== undefined;
    },
  } as unknown as ChatInputCommandInteraction;
  const originalLog = loggingService.logModerationCommand;
  loggingService.logModerationCommand = async () => undefined;

  try {
    await execute(interaction, {
      loadRoleConfig: async () =>
        ({
          guildId: "guild",
          warnRoleId: "warn-role",
        }) as never,
      countActiveWarnings: async () => 2,
      saveModerationCase: async ({ action, durationSeconds, reason }) => {
        savedCases.push({ action, durationSeconds, reason });
        return savedCases.length;
      },
    });
  } finally {
    loggingService.logModerationCommand = originalLog;
  }

  assert.deepEqual(timeoutCalls, [
    [
      10 * 60 * 1_000,
      "Automatic 10-minute timeout after the third active warning",
    ],
  ]);
  assert.deepEqual(
    savedCases.map(({ action, durationSeconds }) => [action, durationSeconds]),
    [
      ["warn", undefined],
      ["timeout", 600],
    ],
  );
  assert.match(JSON.stringify(response), /fixed 10-minute timeout was applied/u);
});
