import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, SharedSlashCommand } from "discord.js";
import { antiNukeService } from "../lib/registry.js";
import type { TrustEntry } from "../security/antinuke/types.js";
import { resolveTrust } from "../security/antinuke/policy.js";

export const whitelistData = buildTrustCommand("whitelist");
export const blacklistData = buildTrustCommand("blacklist");

export async function executeWhitelist(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await executeTrust(interaction, "whitelist");
}

export async function executeBlacklist(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await executeTrust(interaction, "blacklist");
}

function buildTrustCommand(name: "whitelist" | "blacklist"): SharedSlashCommand {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(`Manage the server ${name}`)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription(`Add a user or bot ID to the ${name}`)
        .addStringOption((option) =>
          option
            .setName("target")
            .setDescription("Discord user or bot ID; mentions are also accepted")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription(`Remove an ID from the ${name}`)
        .addStringOption((option) =>
          option
            .setName("target")
            .setDescription("Discord user or bot ID")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription(`List the server ${name}`))
    .addSubcommand((sub) =>
      sub
        .setName("check")
        .setDescription("Check whitelist and blacklist status for an ID")
        .addStringOption((option) =>
          option.setName("target").setDescription("Discord user or bot ID").setRequired(true),
        ),
    );
}

async function executeTrust(
  interaction: ChatInputCommandInteraction,
  listName: "whitelist" | "blacklist",
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
    return;
  }
  if (
    interaction.user.id !== guild.ownerId &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({ content: "Administrator permission is required.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const config = antiNukeService.getConfig(guild.id);
  const sub = interaction.options.getSubcommand();
  if (sub === "list") {
    const entries = Object.values(config[listName]).sort((a, b) =>
      b.addedAt.localeCompare(a.addedAt),
    );
    await interaction.editReply(
      entries.length
        ? entries
            .slice(0, 30)
            .map((entry) => `\`${entry.id}\` · ${entry.kind} · added by \`${entry.addedBy}\` · ${entry.addedAt}`)
            .join("\n")
            .slice(0, 1_900)
        : `The ${listName} is empty.`,
    );
    return;
  }

  const id = parseSnowflake(interaction.options.getString("target", true));
  if (!id) {
    await interaction.editReply("Enter a numeric Discord user or bot ID, or a user mention.");
    return;
  }

  if (sub === "check") {
    const current = antiNukeService.getConfig(guild.id);
    const state = resolveTrust(current, id);
    const whitelistEntry = current.whitelist[id];
    const blacklistEntry = current.blacklist[id];
    await interaction.editReply(
      [
        `ID: \`${id}\``,
        `Effective status: **${state}**${whitelistEntry && blacklistEntry ? " (blacklist takes precedence)" : ""}`,
        `Whitelist record: ${formatEntry(whitelistEntry)}`,
        `Blacklist record: ${formatEntry(blacklistEntry)}`,
      ].join("\n"),
    );
    return;
  }

  if (sub === "add") {
    const user = await guild.client.users.fetch(id).catch(() => null);
    const entry: TrustEntry = {
      id,
      kind: user ? (user.bot ? "bot" : "human") : "unknown",
      addedBy: interaction.user.id,
      addedAt: new Date().toISOString(),
    };
    await antiNukeService.updateConfig(guild.id, (current) => ({
      ...current,
      [listName]: { ...current[listName], [id]: entry },
    }));
    await antiNukeService.recordSystemIncident({
      guild,
      action: `${listName}-add`,
      executorId: interaction.user.id,
      targetId: id,
      outcome: `${listName} entry added.`,
      details: { kind: entry.kind, addedAt: entry.addedAt },
    });
    await interaction.editReply(
      `Added \`${id}\` to the ${listName} as ${entry.kind}. ${
        listName === "whitelist" && config.blacklist[id]
          ? "It remains blacklisted until the blacklist entry is removed."
          : ""
      }`,
    );
    return;
  }

  const existing = config[listName][id];
  if (!existing) {
    await interaction.editReply(`\`${id}\` is not in the ${listName}.`);
    return;
  }
  await antiNukeService.updateConfig(guild.id, (current) => {
    const next = { ...current[listName] };
    delete next[id];
    return { ...current, [listName]: next };
  });
  await antiNukeService.recordSystemIncident({
    guild,
    action: `${listName}-remove`,
    executorId: interaction.user.id,
    targetId: id,
    outcome: `${listName} entry removed.`,
    details: { originalKind: existing.kind, addedBy: existing.addedBy, addedAt: existing.addedAt },
  });
  await interaction.editReply(`Removed \`${id}\` from the ${listName}.`);
}

function formatEntry(entry: TrustEntry | undefined): string {
  return entry
    ? `${entry.kind}, added by \`${entry.addedBy}\` at ${entry.addedAt}`
    : "not listed";
}

function parseSnowflake(value: string): string | null {
  return value.match(/^(?:<@!?)?(\d{17,20})>?$/u)?.[1] ?? null;
}
