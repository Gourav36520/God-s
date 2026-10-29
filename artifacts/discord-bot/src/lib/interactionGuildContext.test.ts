import assert from "node:assert/strict";
import test from "node:test";
import type { ChatInputCommandInteraction, Guild } from "discord.js";
import { resolveInteractionGuild } from "./interactionGuildContext.js";

function makeGuild(id: string, hasBotMember: boolean) {
  const botMember = { id: "bot-user" };
  let fetchMeCalls = 0;
  const members = {
    me: hasBotMember ? botMember : null,
    fetchMe: async () => {
      fetchMeCalls += 1;
      members.me = botMember;
      return botMember;
    },
  };

  return {
    guild: { id, members } as unknown as Guild,
    getFetchMeCalls: () => fetchMeCalls,
  };
}

function makeInteraction(
  guildId: string | null,
  guild: Guild | null,
  fetchGuild: (id: string) => Promise<Guild>,
): ChatInputCommandInteraction {
  return {
    guildId,
    guild,
    client: { guilds: { fetch: fetchGuild } },
  } as unknown as ChatInputCommandInteraction;
}

test("uses a cached guild when its ID matches the interaction", async () => {
  const { guild, getFetchMeCalls } = makeGuild("guild-1", true);
  let fetchGuildCalls = 0;
  const interaction = makeInteraction("guild-1", guild, async () => {
    fetchGuildCalls += 1;
    throw new Error("cached guild should be used");
  });

  const context = await resolveInteractionGuild(interaction);

  assert.equal(context.kind, "guild");
  if (context.kind === "guild") assert.strictEqual(context.guild, guild);
  assert.equal(fetchGuildCalls, 0);
  assert.equal(getFetchMeCalls(), 0);
});

test("fetches a guild and bot member when interaction guild is uncached", async () => {
  const { guild, getFetchMeCalls } = makeGuild("guild-2", false);
  const fetchedIds: string[] = [];
  const interaction = makeInteraction("guild-2", null, async (id) => {
    fetchedIds.push(id);
    return guild;
  });

  const context = await resolveInteractionGuild(interaction);

  assert.equal(context.kind, "guild");
  if (context.kind === "guild") assert.strictEqual(context.guild, guild);
  assert.deepEqual(fetchedIds, ["guild-2"]);
  assert.equal(getFetchMeCalls(), 1);
});

test("keeps genuine DM interactions out of guild context", async () => {
  let fetchGuildCalls = 0;
  const interaction = makeInteraction(null, null, async () => {
    fetchGuildCalls += 1;
    throw new Error("DM interactions must not fetch a guild");
  });

  assert.deepEqual(await resolveInteractionGuild(interaction), { kind: "dm" });
  assert.equal(fetchGuildCalls, 0);
});

test("reports unavailable when Discord cannot fetch the interaction guild", async () => {
  const interaction = makeInteraction("guild-3", null, async () => {
    throw new Error("guild is unavailable");
  });

  assert.deepEqual(await resolveInteractionGuild(interaction), {
    kind: "unavailable",
  });
});

test("rejects a fetched guild whose ID does not match the interaction", async () => {
  const { guild } = makeGuild("wrong-guild", false);
  const interaction = makeInteraction("guild-4", null, async () => guild);

  assert.deepEqual(await resolveInteractionGuild(interaction), {
    kind: "unavailable",
  });
});
