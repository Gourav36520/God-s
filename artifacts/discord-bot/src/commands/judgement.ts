import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { SharedSlashCommand } from "discord.js";

export const data: SharedSlashCommand = new SlashCommandBuilder()
  .setName("judgement")
  .setDescription("Use the existing God's Judgment system")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName("user")
      .setDescription("Place a member under God's Judgment")
      .addUserOption((option) =>
        option.setName("user").setDescription("Member to quarantine").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("reason").setDescription("Reason for the action").setMaxLength(1_000),
      ),
  );
