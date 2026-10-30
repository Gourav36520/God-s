import assert from "node:assert/strict";
import test from "node:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { antiNukeService } from "../lib/registry.js";
import { createDefaultAntiNukeConfig } from "../security/antinuke/defaults.js";
import { execute } from "./antinuke.js";

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
