import assert from "node:assert/strict";
import test from "node:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { antiNukeService } from "../lib/registry.js";
import { createDefaultAntiNukeConfig } from "../security/antinuke/defaults.js";
import { data, execute } from "./antinuke.js";
import { execute as executeConfigure } from "./configure.js";
import { executeWhitelist } from "./trust.js";

test("owner can read Anti-Nuke status using the interaction guild context", async () => {
  const service = antiNukeService as unknown as {
    ensureConfig: typeof antiNukeService.ensureConfig;
    getConfig: typeof antiNukeService.getConfig;
  };
  const originalEnsureConfig = service.ensureConfig;
  const originalGetConfig = service.getConfig;
  const ensuredGuildIds: string[] = [];
  let guildFetchCalls = 0;
  let reply: unknown;
  const config = createDefaultAntiNukeConfig();
  config.enabled = false;
  config.detectors["channel-delete"].enabled = false;

  service.ensureConfig = async (guildId) => {
    ensuredGuildIds.push(guildId);
    return config;
  };
  service.getConfig = () => config;

  const interaction = {
    guildId: "guild-b",
    guild: { id: "guild-b", ownerId: "owner-id", members: { me: {} } },
    client: {
      guilds: {
        fetch: async () => {
          guildFetchCalls += 1;
          throw new Error("config-only command must not require a Guild fetch");
        },
      },
    },
    user: { id: "owner-id" },
    memberPermissions: { has: () => true },
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => "status",
    },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => {
      reply = payload;
      return payload;
    },
  } as unknown as ChatInputCommandInteraction;

  try {
    await execute(interaction);
  } finally {
    service.ensureConfig = originalEnsureConfig;
    service.getConfig = originalGetConfig;
  }

  assert.deepEqual(ensuredGuildIds, ["guild-b"]);
  assert.equal(guildFetchCalls, 0);
  const statusEmbed = (
    reply as { embeds: Array<{ data: { title?: string; description?: string } }> }
  ).embeds[0];
  assert.match(statusEmbed.data.title ?? "", /Anti-Nuke Status/u);
  assert.match(
    statusEmbed.data.description ?? "",
    /<:Off:1566035067602735217> \*\*Anti-Nuke\*\*/u,
  );
  assert.match(
    statusEmbed.data.description ?? "",
    /<:Off:1566035067602735217> \*\*channel-delete\*\* · 2 in 5s/u,
  );
  assert.match(
    statusEmbed.data.description ?? "",
    /<:On:1566034940729233560> \*\*member-ban\*\* · 2 in 5s/u,
  );
});

test("provides standalone Anti-Nuke help with arrows before every listed command", async () => {
  const commandJson = data.toJSON();
  assert.ok(commandJson.options?.some((option) => option.name === "help"));
  assert.ok((commandJson.options?.length ?? 0) <= 25);

  const service = antiNukeService as unknown as {
    ensureConfig: typeof antiNukeService.ensureConfig;
  };
  const originalEnsureConfig = service.ensureConfig;
  let ensureConfigCalls = 0;
  let editedReply: unknown;

  service.ensureConfig = async (guildId) => {
    ensureConfigCalls += 1;
    return antiNukeService.getConfig(guildId);
  };

  const interaction = {
    guildId: "guild-help",
    guild: { id: "guild-help", ownerId: "owner-id", members: { me: {} } },
    user: { id: "owner-id" },
    memberPermissions: { has: () => true },
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => "help",
    },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => {
      editedReply = payload;
      return payload;
    },
  } as unknown as ChatInputCommandInteraction;

  try {
    await execute(interaction);
  } finally {
    service.ensureConfig = originalEnsureConfig;
  }

  assert.equal(ensureConfigCalls, 0);
  const embeds = (
    editedReply as {
      embeds: Array<{
        data: {
          title?: string;
          description?: string;
          footer?: { text?: string };
        };
      }>;
    }
  ).embeds;
  assert.equal(embeds.length, 3);
  assert.ok(embeds.every((embed) => embed.data.title?.includes("<:Anti_nuke:1565312687322439730>")));

  const descriptions = embeds.map((embed) => embed.data.description ?? "");
  const commandLines = descriptions.flatMap((description) =>
    description.split("\n").filter((line) => line.includes("/antinuke ")),
  );
  assert.equal(commandLines.length, 42);
  assert.ok(
    commandLines.every((line) =>
      line.startsWith("<a:arrow_arrow_1:1554486982439079966> `/antinuke "),
    ),
  );
  assert.ok(descriptions.join("\n").includes("Only the server owner can use Anti-Nuke commands."));
  assert.ok(descriptions.every((description) => description.length <= 4_096));
  const totalEmbedText = embeds.reduce(
    (total, embed) =>
      total +
      (embed.data.title?.length ?? 0) +
      (embed.data.description?.length ?? 0) +
      (embed.data.footer?.text?.length ?? 0),
    0,
  );
  assert.ok(totalEmbedText <= 6_000, `Combined Anti-Nuke embeds: ${totalEmbedText} characters`);
});

test("an administrator who is not the owner cannot run Anti-Nuke commands", async () => {
  let reply: unknown;
  const interaction = {
    guildId: "guild-owner-check",
    guild: {
      id: "guild-owner-check",
      ownerId: "actual-owner",
      members: { me: {} },
    },
    user: { id: "administrator-id" },
    memberPermissions: { has: () => true },
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => "status",
    },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => {
      reply = payload;
      return payload;
    },
  } as unknown as ChatInputCommandInteraction;

  await execute(interaction);

  assert.equal(reply, "Only the server owner can use Anti-Nuke commands.");
});

test("an administrator who is not the owner cannot change Anti-Nuke bot protection", async () => {
  let reply: unknown;
  const interaction = {
    guildId: "guild-configure-check",
    guild: {
      id: "guild-configure-check",
      ownerId: "actual-owner",
      members: { me: {} },
    },
    user: { id: "administrator-id" },
    memberPermissions: { has: () => true },
    reply: async (payload: unknown) => {
      reply = payload;
      return payload;
    },
  } as unknown as ChatInputCommandInteraction;

  await executeConfigure(interaction);

  assert.deepEqual(reply, {
    content: "Only the server owner can configure Anti-Nuke security.",
    ephemeral: true,
  });
});

test("an administrator who is not the owner cannot manage trust lists", async () => {
  let reply: unknown;
  const interaction = {
    guildId: "guild-trust-check",
    guild: {
      id: "guild-trust-check",
      ownerId: "actual-owner",
      members: { me: {} },
    },
    user: { id: "administrator-id" },
    memberPermissions: { has: () => true },
    reply: async (payload: unknown) => {
      reply = payload;
      return payload;
    },
  } as unknown as ChatInputCommandInteraction;

  await executeWhitelist(interaction);

  assert.deepEqual(reply, {
    content: "Only the server owner can manage Anti-Nuke trust lists.",
    ephemeral: true,
  });
});
