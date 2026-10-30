import assert from "node:assert/strict";
import test from "node:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { antiNukeService } from "../lib/registry.js";
import { createDefaultAntiNukeConfig } from "../security/antinuke/defaults.js";
import { data, execute } from "./antinuke.js";

test("runs a guild-scoped status command without a cached Guild object", async () => {
  const service = antiNukeService as unknown as {
    ensureConfig: typeof antiNukeService.ensureConfig;
    getConfig: typeof antiNukeService.getConfig;
  };
  const originalEnsureConfig = service.ensureConfig;
  const originalGetConfig = service.getConfig;
  const ensuredGuildIds: string[] = [];
  let guildFetchCalls = 0;
  let reply = "";

  service.ensureConfig = async (guildId) => {
    ensuredGuildIds.push(guildId);
    return createDefaultAntiNukeConfig();
  };
  service.getConfig = () => createDefaultAntiNukeConfig();

  const interaction = {
    guildId: "guild-b",
    guild: null,
    client: {
      guilds: {
        fetch: async () => {
          guildFetchCalls += 1;
          throw new Error("config-only command must not require a Guild fetch");
        },
      },
    },
    user: { id: "admin-user" },
    memberPermissions: { has: () => true },
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => "status",
    },
    deferReply: async () => undefined,
    editReply: async (message: string) => {
      reply = message;
      return message;
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
  assert.match(reply, /channel-delete: on · 3 in 3s/u);
  assert.match(reply, /member-ban: on · 3 in 5s/u);
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
    user: { id: "admin-user" },
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
  assert.ok(descriptions.join("\n").includes("Administrator permission is required"));
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
