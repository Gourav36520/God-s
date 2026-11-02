import type { ChatInputCommandInteraction, Guild } from "discord.js";
import { logger } from "./logger.js";

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
    } catch (error) {
      logger.warn(
        `AntiNuke: guild context resolution failed reason=discord_guild_fetch_failed guild=${guildId} (${summarizeDiscordError(error)}).`,
      );
      return { kind: "unavailable" };
    }
  }
  if (guild.id !== guildId) {
    logger.warn(
      `AntiNuke: guild context resolution failed reason=guild_id_mismatch interactionGuild=${guildId} resolvedGuild=${guild.id}.`,
    );
    return { kind: "unavailable" };
  }

  if (!guild.members.me) {
    try {
      await guild.members.fetchMe();
    } catch (error) {
      // A missing bot-member cache must not block guild-ID-scoped configuration
      // reads/writes. Operations that need bot permissions still fail closed.
      logger.warn(
        `AntiNuke: bot member lookup failed reason=bot_member_fetch_failed guild=${guildId} (${summarizeDiscordError(error)}); continuing with guild context.`,
      );
    }
  }

  return { kind: "guild", guild };
}

function summarizeDiscordError(error: unknown): string {
  if (!error || typeof error !== "object") return `type=${typeof error}`;

  const value = error as { name?: unknown; code?: unknown; status?: unknown };
  const details = [
    typeof value.name === "string" ? `name=${value.name}` : null,
    typeof value.code === "string" || typeof value.code === "number"
      ? `code=${value.code}`
      : null,
    typeof value.status === "number" ? `status=${value.status}` : null,
  ].filter((detail): detail is string => detail !== null);

  return details.join(" ") || "type=unknown";
}
