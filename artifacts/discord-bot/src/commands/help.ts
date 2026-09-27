import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Open the interactive Help Center");

type HelpComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

type ModuleCommand = {
  usage: string;
  description: string;
};

const SECURITY_MODULES = {
  security: {
    label: "Security",
    emoji: "⚙️",
    description: "Manage global security settings and module state.",
    commands: [
      {
        usage: "/security general status",
        description: "Show all module states and global settings.",
      },
      {
        usage: "/security general enable <module>",
        description: "Enable a security module.",
      },
      {
        usage: "/security general disable <module>",
        description: "Disable a security module.",
      },
      {
        usage: "/security general setlog <channel>",
        description: "Set the channel where security events are logged.",
      },
      {
        usage: "/security general exempt-add <role>",
        description: "Add a Heat Exception Role.",
      },
      {
        usage: "/security general exempt-remove <role>",
        description: "Remove a Heat Exception Role.",
      },
    ],
  },
  logs: {
    label: "Logs",
    emoji: "📝",
    description: "Configure logging channels and category toggles.",
    commands: [
      { usage: "/logging status", description: "Show logging configuration and effective routing." },
      {
        usage: "/logging setchannel <channel> [category]",
        description: "Set a log channel, optionally scoped to a category.",
      },
      {
        usage: "/logging clearchannel [category]",
        description: "Remove a log channel override.",
      },
      { usage: "/logging enable <category>", description: "Enable a log category." },
      { usage: "/logging disable <category>", description: "Disable a log category." },
      { usage: "/logging enableall", description: "Enable all log categories at once." },
      { usage: "/logging disableall", description: "Disable all log categories at once." },
    ],
  },
  antiSpam: {
    label: "Anti Spam",
    emoji: "🚫",
    description: "Detects message bursts and applies the configured response.",
    commands: [
      { usage: "/security antispam enable", description: "Enable Anti Spam." },
      { usage: "/security antispam disable", description: "Disable Anti Spam." },
      { usage: "/security antispam status", description: "Show Anti Spam configuration and live stats." },
      {
        usage: "/security antispam config [threshold] [window]",
        description: "Update the Anti Spam trigger thresholds.",
      },
      {
        usage: "/security antispam bypass-add [role] [user]",
        description: "Add an Anti Spam exception role or user.",
      },
      {
        usage: "/security antispam bypass-remove [role] [user]",
        description: "Remove an Anti Spam exception role or user.",
      },
    ],
  },
  antiLink: {
    label: "Anti Link",
    emoji: "🔗",
    description: "Controls link exceptions for the Anti Link module.",
    commands: [
      {
        usage: "/security antilink bypass-add <role>",
        description: "Add an Anti Link exception role.",
      },
      {
        usage: "/security antilink bypass-remove <role>",
        description: "Remove an Anti Link exception role.",
      },
    ],
  },
  antiMention: {
    label: "Anti Mention",
    emoji: "📢",
    description: "Protects the server from unwanted mention activity.",
    commands: [],
  },
  antiCaps: {
    label: "Anti Caps",
    emoji: "🔠",
    description: "Detects excessive capitalization in messages.",
    commands: [],
  },
  antiEmoji: {
    label: "Anti Emoji",
    emoji: "😀",
    description: "Detects excessive emoji activity in messages.",
    commands: [],
  },
  antiAttachment: {
    label: "Anti Attachment",
    emoji: "📎",
    description: "Detects attachment activity that should be reviewed.",
    commands: [],
  },
  badWord: {
    label: "Bad Word",
    emoji: "🤬",
    description: "Maintains the server's configured blocked-word list.",
    commands: [
      {
        usage: "/security badword add <word>",
        description: "Add a bad word to the guild list.",
      },
      {
        usage: "/security badword remove <word>",
        description: "Remove a bad word from the guild list.",
      },
      {
        usage: "/security badword list",
        description: "Show the configured bad words.",
      },
      {
        usage: "/security badword exception-add <role>",
        description: "Add a Bad Word Exception Role.",
      },
      {
        usage: "/security badword exception-remove <role>",
        description: "Remove a Bad Word Exception Role.",
      },
    ],
  },
  antiInvite: {
    label: "Invite Protection",
    emoji: "📩",
    description: "Protects the server from unwanted invite activity.",
    commands: [],
  },
  heatEngine: {
    label: "Heat Engine",
    emoji: "🌡️",
    description: "Manages a user's heat level and progression.",
    commands: [
      { usage: "/heat view <user>", description: "View a user's heat." },
      { usage: "/heat add <user> <amount> [reason]", description: "Add heat to a user." },
      { usage: "/heat remove <user> <amount> [reason]", description: "Remove heat from a user." },
      { usage: "/heat reset <user>", description: "Reset a user's heat." },
    ],
  },
  godsJudgment: {
    label: "God's Judgment",
    emoji: "👑",
    description: "Places users under judgment and restores them when released.",
    commands: [
      {
        usage: "/judgment setup",
        description: "Create the God's Judgment role and channel (Administrator only).",
      },
      {
        usage: "/judgment user <user> [reason]",
        description: "Place a user under God's Judgment.",
      },
      {
        usage: "/judgment status",
        description: "Show the God's Judgment configuration and active judgments.",
      },
      {
        usage: "/release <user> [reason]",
        description: "Release a user from God's Judgment and restore their roles.",
      },
    ],
  },
} satisfies Record<string, { label: string; emoji: string; description: string; commands: ModuleCommand[] }>;

type SecurityModuleKey = keyof typeof SECURITY_MODULES;

type HelpCategoryKey = "security" | "welcomeGoodbye" | "tickets";

const HELP_CATEGORY_SELECT = "help:category-select";
const HELP_MODULE_SELECT = "help:module-select";
const HELP_MODULE_PREFIX = "help:module:";
const HELP_BACK_CATEGORIES = "help:back:categories";
const HELP_BACK_SECURITY = "help:back:security";

const HELP_CATEGORIES: Record<HelpCategoryKey, { label: string; emoji: string }> = {
  security: { label: "Security", emoji: "🛡️" },
  welcomeGoodbye: { label: "Welcome / Goodbye", emoji: "👋" },
  tickets: { label: "Tickets", emoji: "🎫" },
};

const isSecurityModuleKey = (value: string): value is SecurityModuleKey =>
  value in SECURITY_MODULES;

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.reply(categoriesView());
}

export function isHelpComponent(customId: string): boolean {
  return (
    customId === HELP_CATEGORY_SELECT ||
    customId === HELP_MODULE_SELECT ||
    customId === HELP_BACK_CATEGORIES ||
    customId === HELP_BACK_SECURITY ||
    customId.startsWith(HELP_MODULE_PREFIX)
  );
}

export async function handleHelpInteraction(
  interaction: HelpComponentInteraction
): Promise<void> {
  if (interaction.customId === HELP_BACK_SECURITY) {
    await interaction.update(securityView());
    return;
  }

  if (interaction.customId === HELP_BACK_CATEGORIES) {
    await interaction.update(categoriesView());
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === HELP_CATEGORY_SELECT) {
    const selected = interaction.values[0] as HelpCategoryKey;
    await interaction.update(selected === "security" ? securityView() : emptyCategoryView(selected));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === HELP_MODULE_SELECT) {
    const selected = interaction.values[0];
    if (isSecurityModuleKey(selected)) {
      await interaction.update(moduleView(selected));
    } else {
      await interaction.update(securityView());
    }
    return;
  }

  if (interaction.customId.startsWith(HELP_MODULE_PREFIX)) {
    const moduleKey = interaction.customId.slice(HELP_MODULE_PREFIX.length);
    if (!isSecurityModuleKey(moduleKey)) {
      await interaction.update(securityView());
      return;
    }

    await interaction.update(moduleView(moduleKey));
    return;
  }

  if (interaction.isStringSelectMenu()) {
    const selected = interaction.values[0];
    if (selected === "security") {
      await interaction.update(securityView());
    }
  }
}

function categoriesView() {
  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId(HELP_CATEGORY_SELECT)
    .setPlaceholder("Choose a category")
    .addOptions(
      (Object.entries(HELP_CATEGORIES) as [HelpCategoryKey, (typeof HELP_CATEGORIES)[HelpCategoryKey]][]).map(
        ([key, category]) => ({
          label: category.label,
          value: key,
          description:
            key === "security"
              ? "Explore the available security modules"
              : "No modules are currently registered in this category",
          emoji: category.emoji,
        })
      )
    );

  return {
    embeds: [baseEmbed("Categories", "Choose a category to explore the Help Center.")],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(categoryMenu)],
  };
}

function emptyCategoryView(categoryKey: Exclude<HelpCategoryKey, "security">) {
  const category = HELP_CATEGORIES[categoryKey];
  return {
    embeds: [
      baseEmbed(
        `${category.emoji} ${category.label}`,
        "No modules are currently registered in this category."
      ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton(HELP_BACK_CATEGORIES, "Back to Categories")
      ),
    ],
  };
}

function securityView() {
  const moduleMenu = new StringSelectMenuBuilder()
    .setCustomId(HELP_MODULE_SELECT)
    .setPlaceholder("Choose a security module")
    .addOptions(
      (Object.entries(SECURITY_MODULES) as [SecurityModuleKey, (typeof SECURITY_MODULES)[SecurityModuleKey]][]).map(
        ([key, module]) => ({
          label: module.label,
          value: key,
          description: module.description,
          emoji: module.emoji,
        })
      )
    );

  return {
    embeds: [
      baseEmbed(
        "🛡️ Security Modules",
        "Choose a module to see only the commands currently registered for it."
      ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(moduleMenu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton(HELP_BACK_CATEGORIES, "Back to Categories")
      ),
    ],
  };
}

function moduleView(moduleKey: SecurityModuleKey) {
  const module = SECURITY_MODULES[moduleKey];
  const commandDescription =
    module.commands.length > 0
      ? module.commands
          .map((command) => `**\`${command.usage}\`**\n${command.description}`)
          .join("\n\n")
      : "No direct commands are currently registered for this module.";

  return {
    embeds: [
      baseEmbed(`${module.emoji} ${module.label}`, module.description)
        .addFields({ name: "Commands", value: commandDescription, inline: false }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton(HELP_BACK_SECURITY, "Back to Security"),
        backButton(HELP_BACK_CATEGORIES, "Back to Categories")
      ),
    ],
  };
}

function baseEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`God's Bot Help Center — ${title}`)
    .setColor(0x5865f2)
    .setDescription(description)
    .setFooter({ text: "Use the menus and buttons to navigate." })
    .setTimestamp();
}

function backButton(customId: string, label: string): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary);
}
