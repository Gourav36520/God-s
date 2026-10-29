import type { ChatInputCommandInteraction, Guild } from "discord.js";

export type InteractionGuildContext =
  | { kind: "dm" }
  | { kind: "unavailable" }
  | { kind: "guild"; guild: Guild };

type GuildContextInteraction = Pick<
  ChatInputCommandInteraction,
  "client" | "guild" | "guildId"
>;

export async function resolveInteractionGuild(
  interaction: GuildContextInteraction,
): Promise<InteractionGuildContext> {
  const { guildId } = interaction;
  if (!guildId) return { kind: "dm" };

  let guild =
    interaction.guild?.id === guildId ? interaction.guild : null;
  if (!guild) {
    try {
      guild = await interaction.client.guilds.fetch(guildId);
    } catch {
      return { kind: "unavailable" };
    }
  }
  if (guild.id !== guildId) return { kind: "unavailable" };

  if (!guild.members.me) {
    try {
      await guild.members.fetchMe();
    } catch {
      return { kind: "unavailable" };
    }
  }

  return { kind: "guild", guild };
}
