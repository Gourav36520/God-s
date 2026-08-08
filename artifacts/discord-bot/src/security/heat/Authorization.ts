import { PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";

export class Authorization {
  canManageHeat(interaction: ChatInputCommandInteraction): boolean {
    return (
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true
    );
  }
}