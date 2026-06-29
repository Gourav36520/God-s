import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { securityManager } from "../lib/registry.js";
import type { GodsJudgment } from "../security/modules/GodsJudgment.js";
import { logger } from "../lib/logger.js";

export const data = new SlashCommandBuilder()
  .setName("judgment")
  .setDescription("God's Judgment system")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand((sub) =>
    sub.setName("setup").setDescription("Create the God's Judgment role and channel (Administrator only)")
  )
  .addSubcommand((sub) =>
    sub
      .setName("user")
      .setDescription("Place a user under God's Judgment")
      .addUserOption((opt) => opt.setName("user").setDescription("The user to judge").setRequired(true))
      .addStringOption((opt) => opt.setName("reason").setDescription("Reason for judgment").setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Show the God's Judgment configuration and active judgments")
  );

export const releaseData = new SlashCommandBuilder()
  .setName("release")
  .setDescription("Release a user from God's Judgment and restore their roles")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addUserOption((opt) => opt.setName("user").setDescription("The user to release").setRequired(true))
  .addStringOption((opt) => opt.setName("reason").setDescription("Reason for release").setRequired(false));

export const data2 = releaseData;

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "setup":  await handleSetup(interaction);    break;
    case "user":   await handleJudgeUser(interaction); break;
    case "status": await handleStatus(interaction);   break;
  }
}

export async function executeRelease(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return;
  }
  await handleRelease(interaction);
}

async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  logger.info(`judgment setup: invoked by ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guildId}`);

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    logger.warn(`judgment setup: rejected — ${interaction.user.tag} lacks Administrator`);
    await interaction.reply({ content: "⛔ Only Administrators can run `/judgment setup`.", ephemeral: true });
    return;
  }

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    logger.error("judgment setup: deferReply failed — " + (err instanceof Error ? err.stack : String(err)));
    return;
  }

  try {
    const module = securityManager.getModule<GodsJudgment>("godsJudgment");
    if (!module) {
      await interaction.editReply("❌ God's Judgment module is not loaded. Contact the bot owner.");
      return;
    }

    const result = await module.setup(interaction.guild!);

    if (!result.success) {
      await interaction.editReply(`❌ Setup failed: ${result.reason}`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("⚖️ God's Judgment — Setup Complete")
      .setColor(0xfee75c)
      .setDescription("The God's Judgment system is ready.")
      .addFields(
        { name: "Role", value: `<@&${result.roleId}> ${result.roleCreated ? "*(created)*" : "*(already existed)*"}`, inline: true },
        { name: "Channel", value: `<#${result.channelId}> ${result.channelCreated ? "*(created)*" : "*(already existed)*"}`, inline: true },
        { name: "Next Steps", value: "• Set a log channel with `/security setlog #channel`\n• Use `/judgment user @user` to judge members\n• Use `/release @user` to free them", inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const stack = err instanceof Error ? err.stack : String(err);
    logger.error(`judgment setup: uncaught exception —\n${stack}`);
    try {
      await interaction.editReply(`❌ An unexpected error occurred during setup:\n\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``);
    } catch (replyErr) {
      logger.error("judgment setup: also failed to send error reply — " + String(replyErr));
    }
  }
}

async function handleJudgeUser(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    logger.error("judgment user: deferReply failed — " + String(err));
    return;
  }

  try {
    const target = interaction.options.getMember("user") as GuildMember | null;
    const reason = interaction.options.getString("reason") ?? "No reason provided";

    if (!target) { await interaction.editReply("Could not find that member in this server."); return; }
    if (target.id === interaction.user.id) { await interaction.editReply("You cannot place yourself under God's Judgment."); return; }
    if (target.permissions.has(PermissionFlagsBits.Administrator)) { await interaction.editReply("You cannot judge an Administrator."); return; }

    logger.info(`judgment user: placing ${target.user.tag} under judgment — reason: ${reason}`);
    const result = await securityManager.placeInJudgment(target, reason, interaction.user.id);

    if (!result.success) { await interaction.editReply(`❌ ${result.reason}`); return; }

    const embed = new EmbedBuilder()
      .setTitle("⚖️ User Placed Under Judgment")
      .setColor(0xed4245)
      .addFields(
        { name: "User", value: `${target.user.tag} (<@${target.id}>)`, inline: true },
        { name: "Reason", value: reason, inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const stack = err instanceof Error ? err.stack : String(err);
    logger.error(`judgment user: uncaught exception —\n${stack}`);
    await interaction.editReply("❌ An unexpected error occurred.").catch(() => null);
  }
}

async function handleRelease(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    logger.error("release: deferReply failed — " + String(err));
    return;
  }

  try {
    const target = interaction.options.getMember("user") as GuildMember | null;
    const reason = interaction.options.getString("reason") ?? "No reason provided";

    if (!target) { await interaction.editReply("Could not find that member in this server."); return; }

    logger.info(`release: releasing ${target.user.tag} — reason: ${reason}`);
    const result = await securityManager.releaseFromJudgment(target, reason, interaction.user.id);

    if (!result.success) { await interaction.editReply(`❌ ${result.reason}`); return; }

    const restored = result.record?.savedRoles.length ?? 0;

    const embed = new EmbedBuilder()
      .setTitle("✅ User Released from Judgment")
      .setColor(0x57f287)
      .addFields(
        { name: "User", value: `${target.user.tag} (<@${target.id}>)`, inline: true },
        { name: "Reason", value: reason, inline: false },
        { name: "Roles Restored", value: `${restored} role(s)`, inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const stack = err instanceof Error ? err.stack : String(err);
    logger.error(`release: uncaught exception —\n${stack}`);
    await interaction.editReply("❌ An unexpected error occurred.").catch(() => null);
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    logger.error("judgment status: deferReply failed — " + String(err));
    return;
  }

  try {
    const module = securityManager.getModule<GodsJudgment>("godsJudgment");
    if (!module) { await interaction.editReply("❌ God's Judgment module is not loaded."); return; }
    const embed = module.buildStatusEmbed(interaction.guildId!, interaction.guild!.name);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const stack = err instanceof Error ? err.stack : String(err);
    logger.error(`judgment status: uncaught exception —\n${stack}`);
    await interaction.editReply("❌ An unexpected error occurred.").catch(() => null);
  }
}
