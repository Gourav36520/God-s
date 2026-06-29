import {
  ChatInputCommandInteraction,
  Events,
  Interaction,
} from "discord.js";
import { commands } from "../lib/registry.js";
import { logger } from "../lib/logger.js";

export const name = Events.InteractionCreate;
export const once = false;

export async function execute(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction as ChatInputCommandInteraction;
  const sub = cmd.options.getSubcommand(false);
  const label = sub ? `/${cmd.commandName} ${sub}` : `/${cmd.commandName}`;

  const command = commands.get(cmd.commandName);

  if (!command) {
    logger.warn(`Unknown command received: ${label} from ${interaction.user.tag}`);
    await cmd.reply({ content: "Unknown command.", ephemeral: true }).catch(() => null);
    return;
  }

  logger.info(`CMD START  ${label}  user=${interaction.user.tag} (${interaction.user.id})  guild=${interaction.guildId ?? "DM"}`);

  try {
    await command.execute(cmd);
    logger.info(`CMD OK     ${label}  user=${interaction.user.tag}`);
  } catch (err) {
    const stack = err instanceof Error ? err.stack : String(err);
    logger.error(`CMD ERROR  ${label}  user=${interaction.user.tag}\n${stack}`);

    try {
      const isAcknowledged = cmd.replied || cmd.deferred;
      if (isAcknowledged) {
        await cmd.followUp({ content: "⚠️ An unexpected error occurred. Check the bot logs.", ephemeral: true });
      } else {
        await cmd.reply({ content: "⚠️ An unexpected error occurred. Check the bot logs.", ephemeral: true });
      }
    } catch (replyErr) {
      logger.error(`CMD ERROR  Failed to send error reply for ${label}:`, replyErr instanceof Error ? replyErr.message : replyErr);
    }
  }
}
