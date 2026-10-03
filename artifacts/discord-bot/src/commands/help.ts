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
import type { Message } from "discord.js";
import { commands } from "../lib/registry.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Open the interactive Help Center");

type HelpComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

type ModuleCommand = {
  usage: string;
  description: string;
};

type HelpEmoji = string | { name: string; id: string };

const ARROW = "<a:arrow_arrow_1:1554486982439079966>";

const CUSTOM_EMOJIS = {
  logo: { name: "Gods_logo", id: "1553644211612553296" },
  security: { name: "Gods_security", id: "1553646039339376660" },
  logs: { name: "security_logs", id: "1553676459489628241" },
  ticket: { name: "Gods_ticket", id: "1553647434498973817" },
  gate: { name: "Gate", id: "1554865259016233001" },
  setting: { name: "Gods_setting", id: "1553647566061830195" },
  judgment: { name: "Judgement", id: "1553680621673521153" },
  antiCaps: { name: "security_anticaps", id: "1553680193812693154" },
  antiInvite: { name: "security_anti_invite", id: "1553679724637716611" },
  heat: { name: "Security_heat", id: "1553680339103129640" },
  reactionRole: { name: "Reaction_role", id: "1554865929391841330" },
  badWord: { name: "security_badword", id: "1553678437191786586" },
  antiMention: { name: "security_antimention", id: "1553678901887369278" },
  antiLink: { name: "security_antilink", id: "1553678253213098014" },
  antiEmoji: { name: "security_antiemoji", id: "1553677117785514035" },
  antiAttachment: { name: "Security_antiattachement", id: "1553677885431226429" },
  autorole: { name: "Autorole", id: "1554865871824883722" },
} satisfies Record<string, { name: string; id: string }>;

function emojiText(emoji: HelpEmoji): string {
  return typeof emoji === "string" ? emoji : `<:${emoji.name}:${emoji.id}>`;
}

const SECURITY_MODULES = {
  security: {
    label: "Security",
    emoji: CUSTOM_EMOJIS.security,
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
    emoji: CUSTOM_EMOJIS.logs,
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
    emoji: CUSTOM_EMOJIS.security,
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
    emoji: CUSTOM_EMOJIS.antiLink,
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
    emoji: CUSTOM_EMOJIS.antiMention,
    description: "Protects the server from unwanted mention activity.",
    commands: [],
  },
  antiCaps: {
    label: "Anti Caps",
    emoji: CUSTOM_EMOJIS.antiCaps,
    description: "Detects excessive capitalization in messages.",
    commands: [],
  },
  antiEmoji: {
    label: "Anti Emoji",
    emoji: CUSTOM_EMOJIS.antiEmoji,
    description: "Detects excessive emoji activity in messages.",
    commands: [],
  },
  antiAttachment: {
    label: "Anti Attachment",
    emoji: CUSTOM_EMOJIS.antiAttachment,
    description: "Detects attachment activity that should be reviewed.",
    commands: [],
  },
  badWord: {
    label: "Bad Word",
    emoji: CUSTOM_EMOJIS.badWord,
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
    emoji: CUSTOM_EMOJIS.antiInvite,
    description: "Protects the server from unwanted invite activity.",
    commands: [],
  },
  heatEngine: {
    label: "Heat Engine",
    emoji: CUSTOM_EMOJIS.heat,
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
    emoji: CUSTOM_EMOJIS.judgment,
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
} satisfies Record<string, { label: string; emoji: HelpEmoji; description: string; commands: ModuleCommand[] }>;

type SecurityModuleKey = keyof typeof SECURITY_MODULES;

type HelpCategoryKey = "security" | "welcomeGoodbye" | "serverManagement" | "tickets";

const HELP_CATEGORY_SELECT = "help:category-select";
const HELP_MODULE_SELECT = "help:module-select";
const HELP_SERVER_MANAGEMENT_SELECT = "help:server-management-select";
const HELP_MODULE_PREFIX = "help:module:";
const HELP_BACK_CATEGORIES = "help:back:categories";
const HELP_BACK_SECURITY = "help:back:security";
const HELP_BACK_SERVER_MANAGEMENT = "help:back:server-management";

const HELP_CATEGORIES: Record<HelpCategoryKey, { label: string; emoji: HelpEmoji }> = {
  security: { label: "Security", emoji: CUSTOM_EMOJIS.security },
  welcomeGoodbye: { label: "Welcome / Goodbye", emoji: CUSTOM_EMOJIS.gate },
  serverManagement: { label: "Server Management", emoji: CUSTOM_EMOJIS.autorole },
  tickets: { label: "Tickets", emoji: CUSTOM_EMOJIS.ticket },
};

const SERVER_MANAGEMENT_MODULES = {
  autoRole: {
    label: "Auto Role",
    emoji: CUSTOM_EMOJIS.autorole,
    description: "Assign a selected role to human members when they join.",
    commands: [
      { usage: "/autorole setup", description: "Choose and enable the Auto Role." },
      { usage: "/autorole role", description: "Show or change the Auto Role." },
      { usage: "/autorole remove", description: "Disable the Auto Role." },
      { usage: "/autorole config", description: "Show Auto Role status and configured role." },
    ],
  },
  reactionRole: {
    label: "Reaction Role",
    emoji: CUSTOM_EMOJIS.reactionRole,
    description: "Grant a role from an emoji reaction, including on an existing message.",
    commands: [
      { usage: "/reactionrole create", description: "Create a new Reaction Role panel." },
      { usage: "/reactionrole add", description: "Add an emoji and role mapping to a panel." },
      { usage: "/reactionrole remove", description: "Remove an emoji and role mapping." },
      { usage: "/reactionrole edit", description: "Edit a panel created by Gods Bot." },
      { usage: "/reactionrole list", description: "List configured panels and their mappings." },
      { usage: "/reactionrole delete", description: "Remove a panel configuration without deleting its message." },
      { usage: "/reactionrole config", description: "Show Reaction Role settings for this server." },
      { usage: "/reactionrole assign", description: "Attach Reaction Roles to an existing Discord message." },
    ],
  },
} satisfies Record<string, { label: string; emoji: HelpEmoji; description: string; commands: ModuleCommand[] }>;

const isSecurityModuleKey = (value: string): value is SecurityModuleKey =>
  value in SECURITY_MODULES;

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.reply(categoriesView());
}

export async function executePrefix(message: Message): Promise<void> {
  await message.reply(categoriesView());
}

export function isHelpComponent(customId: string): boolean {
  return (
    customId === HELP_CATEGORY_SELECT ||
    customId === HELP_MODULE_SELECT ||
    customId === HELP_SERVER_MANAGEMENT_SELECT ||
    customId === HELP_BACK_CATEGORIES ||
    customId === HELP_BACK_SECURITY ||
    customId === HELP_BACK_SERVER_MANAGEMENT ||
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

  if (interaction.customId === HELP_BACK_SERVER_MANAGEMENT) {
    await interaction.update(serverManagementView());
    return;
  }

  if (interaction.customId === HELP_BACK_CATEGORIES) {
    await interaction.update(categoriesView());
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === HELP_CATEGORY_SELECT) {
    const selected = interaction.values[0] as HelpCategoryKey;
    await interaction.update(
      selected === "security"
        ? securityView()
        : selected === "welcomeGoodbye"
          ? welcomeGoodbyeView()
          : selected === "serverManagement"
            ? serverManagementView()
          : emptyCategoryView(selected),
    );
    return;
  }

  if (
    interaction.isStringSelectMenu() &&
    interaction.customId === HELP_SERVER_MANAGEMENT_SELECT
  ) {
    const selected = interaction.values[0];
    if (
      selected &&
      Object.prototype.hasOwnProperty.call(SERVER_MANAGEMENT_MODULES, selected)
    ) {
      await interaction.update(
        serverManagementModuleView(
          selected as keyof typeof SERVER_MANAGEMENT_MODULES,
        ),
      );
    } else {
      await interaction.update(serverManagementView());
    }
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
              : key === "welcomeGoodbye"
                ? "Set up and test Welcome and Goodbye messages"
                  : key === "serverManagement"
                    ? "Configure roles and other server settings"
                : "No modules are currently registered in this category",
          emoji: category.emoji,
        })
      )
    );

  return {
    embeds: [
      baseEmbed(
        "",
        [
          "Welcome to **Gods Bot Centre** — your central hub for exploring everything the bot has to offer.",
          "",
          "Browse through the categories below to discover the bot's available features and tools.",
          "",
          `${emojiText(CUSTOM_EMOJIS.setting)} **Bot Prefix:** \`/\``,
          `${emojiText(CUSTOM_EMOJIS.setting)} **Total Commands:** \`${commands.size}\``,
          "",
          "**Select a category below to get started.**",
          "",
          ...Object.entries(HELP_CATEGORIES).map(
            ([, category]) => `${ARROW} ${emojiText(category.emoji)} **${category.label}**`
          ),
        ].join("\n")
      ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(categoryMenu)],
  };
}

function emptyCategoryView(categoryKey: Exclude<HelpCategoryKey, "security">) {
  const category = HELP_CATEGORIES[categoryKey];
  return {
    embeds: [
      baseEmbed(
        category.label,
        "No modules are currently registered in this category.",
        category.emoji
      ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton(HELP_BACK_CATEGORIES, "← Back")
      ),
    ],
  };
}

function serverManagementView() {
  const moduleMenu = new StringSelectMenuBuilder()
    .setCustomId(HELP_SERVER_MANAGEMENT_SELECT)
    .setPlaceholder("Choose a server management module")
    .addOptions(
      Object.entries(SERVER_MANAGEMENT_MODULES).map(([key, module]) => ({
        label: module.label,
        value: key,
        description: module.description,
        emoji: module.emoji,
      })),
    );

  return {
    embeds: [
      baseEmbed(
        "Server Management",
        "Select a module to configure server features.",
        CUSTOM_EMOJIS.autorole,
      ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(moduleMenu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton(HELP_BACK_CATEGORIES, "← Back"),
      ),
    ],
  };
}

function serverManagementModuleView(
  moduleKey: keyof typeof SERVER_MANAGEMENT_MODULES,
) {
  const module = SERVER_MANAGEMENT_MODULES[moduleKey];
  const commandDescription = module.commands
    .map((command) => `${ARROW} **\`${command.usage}\`**\n${command.description}`)
    .join("\n\n");

  return {
    embeds: [
      baseEmbed(
        module.label,
        `${module.description}\n\n${commandDescription}`,
        module.emoji,
        true,
      ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton(HELP_BACK_SERVER_MANAGEMENT, "← Back"),
      ),
    ],
  };
}

function welcomeGoodbyeView() {
  const commands: ModuleCommand[] = [
    { usage: "/set general prefix <prefix>", description: "Choose the server's message prefix." },
    { usage: "/set welcome channel <channel>", description: "Choose where new-member messages are sent." },
    { usage: "/set goodbye channel <channel>", description: "Choose where leaving-member messages are sent." },
    { usage: "/remove welcome channel", description: "Remove the Welcome channel and turn off that flow; saved message and embeds stay." },
    { usage: "/remove goodbye channel", description: "Remove the Goodbye channel and turn off that flow; saved message and embeds stay." },
    { usage: "/welcome embed", description: "Choose a saved embed for Welcome messages." },
    { usage: "/welcome message", description: "Write or clear the Welcome message." },
    { usage: "/welcome config [enabled]", description: "View settings or turn Welcome messages on or off." },
    { usage: "/welcome test", description: "Send the current Welcome output to its configured channel." },
    { usage: "/goodbye embed", description: "Choose a saved embed for Goodbye messages." },
    { usage: "/goodbye message", description: "Write or clear the Goodbye message." },
    { usage: "/goodbye config [enabled]", description: "View settings or turn Goodbye messages on or off." },
    { usage: "/goodbye test", description: "Send the current Goodbye output to its configured channel." },
    { usage: "/create embed <name>", description: "Build and save a reusable embed for this server." },
    { usage: "/embed list", description: "Browse and preview embeds saved in this server." },
    { usage: "/add raw json", description: "Advanced import: paste raw Discord Embed JSON to save a reusable embed." },
  ];
  return {
    embeds: [
      baseEmbed(
        "Welcome / Goodbye",
        [
          "Configure each flow separately. Choose a channel, write a message, optionally select a saved embed, then test it.",
          "",
          ...commands.map(
            (command) => `${ARROW} **\`${command.usage}\`**\n${command.description}`,
          ),
          "",
          "**Message variables**",
          "`(user)` member mention · `(name)` member name · `(user{avatar})` avatar URL · `(server)` server name · `(membercount)` current member count",
        ].join("\n\n"),
        CUSTOM_EMOJIS.gate,
      ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton(HELP_BACK_CATEGORIES, "← Back"),
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
        "Security Centre",
        "Select a security module to explore its commands and features.",
        CUSTOM_EMOJIS.security
      ),
    ],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(moduleMenu),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton(HELP_BACK_CATEGORIES, "← Back")
      ),
    ],
  };
}

function moduleView(moduleKey: SecurityModuleKey) {
  const module = SECURITY_MODULES[moduleKey];
  const commandDescription =
    module.commands.length > 0
      ? module.commands
          .map((command) => `${ARROW} **\`${command.usage}\`**\n${command.description}`)
          .join("\n\n")
      : "No direct commands are currently registered for this module.";

  return {
    embeds: [
      baseEmbed(module.label, `${module.description}\n\n${commandDescription}`, module.emoji, true),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton(HELP_BACK_SECURITY, "← Back")
      ),
    ],
  };
}

function baseEmbed(
  title: string,
  description: string,
  icon: HelpEmoji = CUSTOM_EMOJIS.logo,
  arrowBefore: boolean = false
): EmbedBuilder {
  const header = title
    ? `${arrowBefore ? `${ARROW} ` : ""}${emojiText(icon)} ${title}`
    : `${emojiText(icon)} Gods Bot Centre`;

  return new EmbedBuilder()
    .setTitle(header)
    .setColor(0xd4af37)
    .setDescription(description)
    .setFooter({
      text: `Gods Bot • Your Server's Guardian\n⏱️ Time at ${new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }).format(new Date())}\nDeveloped by @gourav.s`,
    });
}

function backButton(customId: string, label: string): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary);
}
