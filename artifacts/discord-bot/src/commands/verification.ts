import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  VERIFICATION_BUTTON_ID,
  checkVerificationApiHealth,
  type VerificationDiagnostics,
  type VerificationGuildConfig,
  verificationAdminRequest,
} from "../verification/api.js";

interface ConfigResponse {
  config: VerificationGuildConfig | null;
}

interface StatsResponse {
  counts: Record<string, number>;
  total: number;
}

interface ResetResponse {
  reset?: boolean;
  invalidated?: number;
}

export const data = new SlashCommandBuilder()
  .setName("verification")
  .setDescription("Configure and inspect Discord account verification")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("configure")
      .setDescription("Set this server's verification channel and role")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel where the verification panel will be posted")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Role granted after successful verification")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("panel")
      .setDescription("Post the verification panel in the configured channel"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("config")
      .setDescription("Display this server's verification configuration"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("display")
      .setDescription("Display this server's verification configuration"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("test")
      .setDescription("Run safe verification service and permission diagnostics"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("stats")
      .setDescription("Show verification session counts for this server"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reset")
      .setDescription("Reset this server's configuration or pending sessions")
      .addStringOption((option) =>
        option
          .setName("scope")
          .setDescription("What to reset")
          .setRequired(true)
          .addChoices(
            { name: "Verification configuration", value: "configuration" },
            { name: "Pending CAPTCHA sessions", value: "pending" },
          ),
      )
      .addBooleanOption((option) =>
        option
          .setName("confirm")
          .setDescription("Confirm this server-scoped reset")
          .setRequired(true),
      ),
  );

function isAdministrator(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(
    interaction.inGuild() &&
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );
}

async function getDiagnostics(
  interaction: ChatInputCommandInteraction,
): Promise<VerificationDiagnostics> {
  return verificationAdminRequest<VerificationDiagnostics>(
    interaction.user.id,
    interaction.guildId!,
    "diagnostics",
  );
}

function formatConfiguration(
  diagnostics: VerificationDiagnostics,
): string {
  const config = diagnostics.guildConfig;
  const lines = [
    `Enabled: ${config?.enabled ? "yes" : "no"}`,
    `Channel: ${config ? `<#${config.channelId}>` : "not configured"}`,
    `Verified role: ${config ? `<@&${config.verifiedRoleId}>` : "not configured"}`,
    `Verification service: ${diagnostics.verificationConfigured ? "ready" : "missing settings"}`,
    `Database: ${diagnostics.databaseConnected ? "connected" : "unavailable"}`,
  ];
  if (diagnostics.missingSettings.length > 0) {
    lines.push(
      `Missing settings: ${diagnostics.missingSettings.join(", ").slice(0, 900)}`,
    );
  }
  return lines.join("\n");
}

async function configure(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild!;
  const channelOption = interaction.options.getChannel("channel", true);
  const roleOption = interaction.options.getRole("role", true);
  const channel = await guild.channels.fetch(channelOption.id);
  const role = await guild.roles.fetch(roleOption.id);
  const botMember = await guild.members.fetchMe();

  if (
    !channel ||
    !channel.isTextBased() ||
    !("guildId" in channel) ||
    channel.guildId !== guild.id ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    await interaction.editReply("Choose a text channel from this server.");
    return;
  }
  if (
    !role ||
    role.guild.id !== guild.id ||
    role.id === guild.id ||
    role.managed
  ) {
    await interaction.editReply("Choose a manageable role from this server.");
    return;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.editReply("The bot needs Manage Roles permission.");
    return;
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    await interaction.editReply(
      "Move the bot's highest role above the selected verified role.",
    );
    return;
  }
  const channelPermissions = channel.permissionsFor(botMember);
  if (
    !channelPermissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ])
  ) {
    await interaction.editReply(
      "The bot needs View Channel and Send Messages permission in the selected channel.",
    );
    return;
  }

  await verificationAdminRequest<ConfigResponse>(
    interaction.user.id,
    guild.id,
    "config:set",
    { channelId: channel.id, verifiedRoleId: role.id },
  );
  await interaction.editReply(
    `Verification is configured for <#${channel.id}> with <@&${role.id}>.`,
  );
}

async function postPanel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild!;
  const { config } = await verificationAdminRequest<ConfigResponse>(
    interaction.user.id,
    guild.id,
    "config:get",
  );
  if (!config?.enabled) {
    await interaction.editReply(
      "Verification is not configured. Run `/verification configure` first.",
    );
    return;
  }

  const channel = await guild.channels.fetch(config.channelId);
  if (
    !channel ||
    !channel.isTextBased() ||
    !("guildId" in channel) ||
    channel.guildId !== guild.id
  ) {
    await interaction.editReply(
      "The configured verification channel is unavailable. Run `/verification configure` again.",
    );
    return;
  }
  const botMember = await guild.members.fetchMe();
  if (
    !channel
      .permissionsFor(botMember)
      ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
  ) {
    await interaction.editReply(
      "The bot needs View Channel and Send Messages permission in the configured channel.",
    );
    return;
  }

  const button = new ButtonBuilder()
    .setCustomId(VERIFICATION_BUTTON_ID)
    .setLabel("Verify with Discord")
    .setStyle(ButtonStyle.Primary);
  await channel.send({
    content:
      "**Discord account verification**\nPress the button to open a private verification link. Review the privacy notice before continuing.",
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
  });
  await interaction.editReply(
    `Verification panel posted in <#${channel.id}>.`,
  );
}

async function showConfiguration(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const diagnostics = await getDiagnostics(interaction);
  await interaction.editReply(formatConfiguration(diagnostics));
}

async function runDiagnostics(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const healthOk = await checkVerificationApiHealth();
  let diagnostics: VerificationDiagnostics;
  try {
    diagnostics = await getDiagnostics(interaction);
  } catch {
    await interaction.editReply(
      `API health: ${healthOk ? "ok" : "unavailable"}\nSigned API/DB diagnostics: unavailable. Check API configuration and database schema.`,
    );
    return;
  }

  let manageRoles = false;
  let configuredChannelPermissions = false;
  let roleHierarchy = false;
  try {
    const guild = interaction.guild!;
    const botMember = await guild.members.fetchMe();
    manageRoles = botMember.permissions.has(PermissionFlagsBits.ManageRoles);
    const config = diagnostics.guildConfig;
    if (config) {
      const channel = await guild.channels.fetch(config.channelId);
      const role = await guild.roles.fetch(config.verifiedRoleId);
      if (
        channel &&
        channel.isTextBased() &&
        "guildId" in channel &&
        channel.guildId === guild.id
      ) {
        configuredChannelPermissions = Boolean(
          channel
            .permissionsFor(botMember)
            ?.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
            ]),
        );
      }
      roleHierarchy = Boolean(
        role &&
          role.guild.id === guild.id &&
          !role.managed &&
          botMember.roles.highest.comparePositionTo(role) > 0,
      );
    }
  } catch {
    // Discord cache/API errors are reported as failed permission diagnostics.
  }

  const lines = [
    `API health: ${healthOk ? "ok" : "unavailable"}`,
    `Database: ${diagnostics.databaseConnected ? "connected" : "unavailable"}`,
    `Verification database schema: ${diagnostics.verificationSchemaReady ? "ready" : "missing"}`,
    `Signed HMAC request: ${diagnostics.hmacAuthenticated ? "ok" : "failed"}`,
    `Verification configuration: ${diagnostics.verificationConfigured ? "ready" : "incomplete"}`,
    `Bot Manage Roles: ${manageRoles ? "ok" : "missing"}`,
    `Configured channel permissions: ${configuredChannelPermissions ? "ok" : "missing or not configured"}`,
    `Verified-role hierarchy: ${roleHierarchy ? "ok" : "missing or not configured"}`,
    `CAPTCHA rendering: ${diagnostics.captchaRendering.supported ? "available" : "not applicable; Cloudflare Turnstile is used and no local bitmap renderer exists"}`,
  ];
  if (diagnostics.missingSettings.length > 0) {
    lines.push(
      `Missing settings: ${diagnostics.missingSettings.join(", ").slice(0, 700)}`,
    );
  }
  await interaction.editReply(lines.join("\n"));
}

async function showStats(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const result = await verificationAdminRequest<StatsResponse>(
    interaction.user.id,
    interaction.guildId!,
    "stats",
  );
  const statuses = Object.entries(result.counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}: ${count}`);
  await interaction.editReply(
    [`Sessions: ${result.total}`, ...statuses].join("\n"),
  );
}

async function reset(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const scope = interaction.options.getString("scope", true);
  if (!interaction.options.getBoolean("confirm", true)) {
    await interaction.editReply(
      "No changes made. Rerun with `confirm: True` to confirm this server-scoped reset.",
    );
    return;
  }
  const action =
    scope === "configuration" ? "config:reset" : "sessions:reset";
  const result = await verificationAdminRequest<ResetResponse>(
    interaction.user.id,
    interaction.guildId!,
    action,
  );
  if (scope === "configuration") {
    await interaction.editReply(
      result.reset
        ? "This server's verification configuration was reset. No member roles were changed."
        : "This server had no saved verification configuration. No member roles were changed.",
    );
  } else {
    await interaction.editReply(
      `Invalidated ${result.invalidated ?? 0} pending CAPTCHA session(s) for this server. No member roles were changed.`,
    );
  }
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "Use this command in a server.",
      ephemeral: true,
    });
    return;
  }
  if (!isAdministrator(interaction)) {
    await interaction.reply({
      content: "Administrator permission is required.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    switch (interaction.options.getSubcommand()) {
      case "configure":
        await configure(interaction);
        return;
      case "panel":
        await postPanel(interaction);
        return;
      case "config":
      case "display":
        await showConfiguration(interaction);
        return;
      case "test":
        await runDiagnostics(interaction);
        return;
      case "stats":
        await showStats(interaction);
        return;
      case "reset":
        await reset(interaction);
        return;
      default:
        await interaction.editReply("Unknown verification command.");
    }
  } catch {
    await interaction.editReply(
      "Verification is temporarily unavailable. Check the service configuration and database.",
    );
  }
}
