import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { createBackupInteractionSession } from "@workspace/db";
import type { Command } from "../lib/registry.js";

export const data = new SlashCommandBuilder()
  .setName("recover")
  .setDescription("Open saved-backup, audit-log, or kicked-member recovery.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export const recoveryTargets = [
  {
    label: "Restore a saved server backup",
    value: "backup",
    description: "Preview and selectively restore saved server data.",
  },
  {
    label: "Recover deleted channels or roles",
    value: "audit",
    description: "Use available Discord audit-log details without a saved backup.",
  },
  {
    label: "Recover a kicked member",
    value: "kicks",
    description: "Review kick evidence and provide an invite after confirmation.",
  },
] as const;

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (
    !interaction.guildId ||
    !interaction.channelId ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({
      content: "Recovery is available to server administrators only.",
      ephemeral: true,
    });
    return;
  }

  const id = randomUUID();
  await createBackupInteractionSession({
    id,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    kind: "recovery",
    state: { step: "target" },
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`gods:recover:target:${id}`)
    .setPlaceholder("Choose what to recover")
    .addOptions(
      recoveryTargets.map(({ label, value, description }) => ({
        label,
        value,
        description,
      })),
    );
  await interaction.reply({
    content:
      "Choose a recovery path. Every restore shows a preview and requires a separate administrator confirmation.",
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    ],
    ephemeral: true,
  });
}

export const command: Command = { data, execute };
