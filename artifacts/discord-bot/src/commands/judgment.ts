import {
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { securityManager } from "../lib/registry.js";
import type { GodsJudgment } from "../security/modules/GodsJudgment.js";
import { logger } from "../lib/logger.js";
import {
  arrowLine,
  createGodsEmbed,
  GODS_EMOJI,
  GOLDEN_ARROW,
} from "./ui.js";

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
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Server Required",
          description: "Run Judgment commands inside the server where the member is located.",
          emoji: GODS_EMOJI.judgment,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
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
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Server Required",
          description: "Run this command inside the server where the member is located.",
          emoji: GODS_EMOJI.judgment,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }
  await handleRelease(interaction);
}

async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  logger.info(`judgment setup: invoked by ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guildId}`);

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    logger.warn(`judgment setup: rejected — ${interaction.user.tag} lacks Administrator`);
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Administrator Permission Required",
          description: "Only a server Administrator can run `/judgment setup`.",
          emoji: GODS_EMOJI.judgment,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
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
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Judgment Unavailable",
            description: "God's Judgment is unavailable right now. Ask a server Administrator to check the bot configuration.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
      return;
    }

    const result = await module.setup(interaction.guild!);

    if (!result.success) {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Judgment Setup Incomplete",
            description: "Setup couldn't be completed. Check that the bot can manage roles and channels, then try again.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
      return;
    }

    const embed = createGodsEmbed({
      title: "Judgment Setup Complete",
      emoji: GODS_EMOJI.judgment,
      tone: "success",
      description: "The God's Judgment system is ready.",
    })
      .addFields(
        {
          name: "Judgment Role",
          value: arrowLine(
            "Role",
            `<@&${result.roleId}> ${result.roleCreated ? "*(created)*" : "*(already existed)*"}`
          ),
          inline: false,
        },
        {
          name: "Judgment Channel",
          value: arrowLine(
            "Channel",
            `<#${result.channelId}> ${result.channelCreated ? "*(created)*" : "*(already existed)*"}`
          ),
          inline: false,
        },
        {
          name: "Next Steps",
          value: [
            arrowLine("Set a log channel", "`/security general setlog #channel`"),
            arrowLine("Apply Judgment", "`/judgment user @user`"),
            arrowLine("Release a member", "`/release @user`"),
          ].join("\n"),
          inline: false,
        }
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const stack = err instanceof Error ? err.stack : String(err);
    logger.error(`judgment setup: uncaught exception —\n${stack}`);
    try {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Judgment Setup Failed",
            description: "The setup couldn't be completed. Ask a server Administrator to check the bot's role and channel permissions, then try again.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
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

    if (!target) {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Member Not Found",
            description: "Select a current member of this server and try again.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
      return;
    }
    if (target.id === interaction.user.id) {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Action Not Allowed",
            description: "You cannot place yourself under God's Judgment.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
      return;
    }
    if (target.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Action Not Allowed",
            description: "Administrators cannot be placed under God's Judgment.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
      return;
    }

    logger.info(`judgment user: placing ${target.user.tag} under judgment — reason: ${reason}`);
    const result = await securityManager.placeInJudgment(target, reason, interaction.user.id);

    if (!result.success) {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Judgment Not Applied",
            description: "The request couldn't be completed. Confirm the member is eligible and that the bot can manage their roles, then try again.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
      return;
    }

    const isRepair = result.wasRepaired === true;
    const embed = createGodsEmbed({
      title: isRepair ? "Judgment Protection Restored" : "Member Placed Under Judgment",
      emoji: GODS_EMOJI.judgment,
      tone: isRepair ? "warning" : "error",
      description: arrowLine("Member", `<@${target.id}>`),
    })
      .addFields(
        { name: "Member", value: `${target.user.tag} (<@${target.id}>)`, inline: false },
        { name: "Reason", value: reason.slice(0, 1_000), inline: false },
        ...(isRepair
          ? [{
              name: "Protection Check",
              value:
                "The judgment role was found missing (manually removed). " +
                "It has been automatically re-applied and channel access has been verified.",
              inline: false,
            }]
          : [])
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const stack = err instanceof Error ? err.stack : String(err);
    logger.error(`judgment user: uncaught exception —\n${stack}`);
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Judgment Action Failed",
          description: "The action couldn't be completed. Contact a server Administrator if the issue continues.",
          emoji: GODS_EMOJI.judgment,
          tone: "error",
        }),
      ],
    }).catch(() => null);
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

    if (!target) {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Member Not Found",
            description: "Select a current member of this server and try again.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
      return;
    }

    logger.info(`release: releasing ${target.user.tag} — reason: ${reason}`);
    const result = await securityManager.releaseFromJudgment(target, reason, interaction.user.id);

    if (!result.success) {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Release Not Completed",
            description: "The member couldn't be released. Confirm they are currently under Judgment and that the bot can restore their roles, then try again.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
      return;
    }

    const restored = result.record?.savedRoles.length ?? 0;

    const embed = createGodsEmbed({
      title: "Member Released",
      emoji: GODS_EMOJI.judgment,
      tone: "success",
      description: "The member has been released from God's Judgment.",
    })
      .addFields(
        { name: "Member", value: `${target.user.tag} (<@${target.id}>)`, inline: false },
        { name: "Release Reason", value: reason.slice(0, 1_000), inline: false },
        { name: "Roles Restored", value: arrowLine("Count", `${restored} role(s)`), inline: false }
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const stack = err instanceof Error ? err.stack : String(err);
    logger.error(`release: uncaught exception —\n${stack}`);
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Release Failed",
          description: "The release couldn't be completed. Contact a server Administrator if the issue continues.",
          emoji: GODS_EMOJI.judgment,
          tone: "error",
        }),
      ],
    }).catch(() => null);
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
    if (!module) {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Judgment Unavailable",
            description: "God's Judgment is unavailable right now. Ask a server Administrator to check the bot configuration.",
            emoji: GODS_EMOJI.judgment,
            tone: "error",
          }),
        ],
      });
      return;
    }

    const config = securityManager.getConfig(interaction.guildId!).godsJudgment;
    const active = Object.values(config.activeJudgments);
    const activeFields: { name: string; value: string; inline: boolean }[] = [];
    const visibleActive = active.slice(0, 80);
    for (let index = 0; index < visibleActive.length; index += 4) {
      const records = visibleActive.slice(index, index + 4);
      const lines = records.map((record) => {
      const judgedAt = Math.floor(new Date(record.judgedAt).getTime() / 1_000);
        const reason = record.reason.replace(/\s+/gu, " ").trim().slice(0, 120) || "No reason recorded";
        return [
          `${GOLDEN_ARROW} <@${record.userId}> — ${reason}`,
          `  By <@${record.judgedBy}> · <t:${judgedAt}:R>`,
        ].join("\n");
      });
      activeFields.push({
        name: index === 0
          ? `Currently Under Judgment (${active.length})`
          : "Active Cases — Continued",
        value: lines.join("\n"),
        inline: false,
      });
    }
    if (active.length === 0) {
      activeFields.push({
        name: "Currently Under Judgment (0)",
        value: "No users are currently under Judgment.",
        inline: false,
      });
    } else if (active.length > visibleActive.length) {
      activeFields.push({
        name: "Additional Active Cases",
        value: arrowLine("Not shown", `${active.length - visibleActive.length} more`),
        inline: false,
      });
    }

    const setupIncomplete = !config.judgmentRoleId || !config.judgmentChannelId;
    const nextStep = setupIncomplete
      ? "Run `/judgment setup` to create the role and channel."
      : "Use `/judgment user @user` to place a member under Judgment, or `/release @user` to release them.";
    const embed = createGodsEmbed({
      title: "God's Judgment Status",
      emoji: GODS_EMOJI.judgment,
      tone: "info",
      description: [
        `Current configuration and active cases for **${interaction.guild!.name}**.`,
        "",
        arrowLine("Next step", nextStep),
      ].join("\n"),
    }).addFields(
      {
        name: "System",
        value: arrowLine("Status", config.enabled ? "Enabled" : "Disabled"),
        inline: false,
      },
      {
        name: "Judgment Role",
        value: config.judgmentRoleId
          ? `<@&${config.judgmentRoleId}>`
          : "Not set — run `/judgment setup`",
        inline: false,
      },
      {
        name: "Judgment Channel",
        value: config.judgmentChannelId
          ? `<#${config.judgmentChannelId}>`
          : "Not set — run `/judgment setup`",
        inline: false,
      },
      {
        name: "Direct Message on Action",
        value: config.dmOnAction ? "Yes" : "No",
        inline: false,
      },
      ...activeFields,
    );
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const stack = err instanceof Error ? err.stack : String(err);
    logger.error(`judgment status: uncaught exception —\n${stack}`);
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Status Unavailable",
          description: "The Judgment status couldn't be loaded. Contact a server Administrator if the issue continues.",
          emoji: GODS_EMOJI.judgment,
          tone: "error",
        }),
      ],
    }).catch(() => null);
  }
}
