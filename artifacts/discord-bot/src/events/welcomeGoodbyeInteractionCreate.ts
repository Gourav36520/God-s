import {
  ActionRowBuilder,
  ButtonInteraction,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type {
  Interaction,
  ModalSubmitInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import { welcomeGoodbyeStore } from "../welcome-goodbye/config-store.js";
import {
  convertRawEmbedJson,
  RawEmbedImportError,
} from "../welcome-goodbye/raw-json.js";
import {
  deleteEmbedDraft,
  getEmbedDraft,
  updateEmbedDraft,
} from "../welcome-goodbye/drafts.js";
import type { EmbedDraftSession } from "../welcome-goodbye/drafts.js";
import {
  buildEmbed,
  validateEmbedDefinition,
} from "../welcome-goodbye/render.js";
import type { GreetingKind } from "../welcome-goodbye/types.js";
import type { WelcomeGoodbyeEmbedDefinition } from "../welcome-goodbye/types.js";
import { MEMBER_AVATAR_VARIABLE } from "../welcome-goodbye/variables.js";
import {
  buildEmbedBuilderPanel,
  buildSavedEmbedPicker,
  buildSavedEmbedPreview,
} from "../welcome-goodbye/views.js";
import { createGodsEmbed, GODS_EMOJI } from "../commands/ui.js";
import { settingSavedEmbed } from "../commands/welcome-goodbye-helpers.js";

export const name = Events.InteractionCreate;
export const once = false;

type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

interface ModalField {
  id: string;
  label: string;
  property: keyof WelcomeGoodbyeEmbedDefinition;
  maxLength: number;
  paragraph?: boolean;
  description?: string;
}

const FIELD_GROUPS: Record<string, ModalField[]> = {
  basics: [
    { id: "content", label: "Message Content", property: "content", maxLength: 2000, paragraph: true },
    { id: "title", label: "Title", property: "title", maxLength: 256 },
    { id: "title-url", label: "Title URL", property: "titleUrl", maxLength: 2048 },
    { id: "description", label: "Description (first 4000)", property: "description", maxLength: 4000, paragraph: true },
    { id: "description-extra", label: "Description extra (up to 96)", property: "description", maxLength: 96, paragraph: true },
  ],
  author: [
    { id: "author-name", label: "Author Name", property: "authorName", maxLength: 256 },
    { id: "author-url", label: "Author URL", property: "authorUrl", maxLength: 2048 },
    { id: "author-icon", label: "Author Icon URL", property: "authorIconUrl", maxLength: 2048, description: "Use (user{avatar}) for the member's avatar." },
  ],
  media: [
    { id: "thumbnail", label: "Thumbnail URL", property: "thumbnailUrl", maxLength: 2048, description: "Use (user{avatar}) for the member's avatar." },
    { id: "image", label: "Image URL", property: "imageUrl", maxLength: 2048, description: "Use (user{avatar}) for the member's avatar." },
  ],
  footer: [
    { id: "footer-text", label: "Footer Text", property: "footerText", maxLength: 2048 },
    { id: "footer-icon", label: "Footer Icon URL", property: "footerIconUrl", maxLength: 2048, description: "Use (user{avatar}) for the member's avatar." },
    { id: "footer-url", label: "Footer URL", property: "footerUrl", maxLength: 2048 },
  ],
  color: [
    { id: "color", label: "Color (hex)", property: "color", maxLength: 7, description: "Enter a six-digit color such as #D4AF37, or leave blank." },
  ],
};

export async function execute(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isButton()) {
      await dispatchButton(interaction);
      return;
    }
    if (interaction.isStringSelectMenu()) {
      await handleSelect(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`Welcome/Goodbye interaction failed: ${detail}`);
    await replyError(interaction, "That action could not be completed. Please try again.");
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(":");

  if (parts[0] === "wg" && parts[1] === "message" && parts[2] === "open") {
    const kind = parts[3] as GreetingKind;
    const guildId = parts[4];
    const ownerId = parts[5];
    if (!isGreetingKind(kind) || !(await validateComponent(interaction, ownerId, guildId))) return;
    const current = welcomeGoodbyeStore.get(guildId)[kind].message;
    const input = new TextInputBuilder()
      .setCustomId("message")
      .setLabel("Message (up to 2000 characters)")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(2000)
      .setRequired(false)
      .setPlaceholder("Type your message. Leave blank to clear it.");
    if (current) input.setValue(current);
    const modal = new ModalBuilder()
      .setCustomId(`wg:message:save:${kind}:${guildId}:${ownerId}`)
      .setTitle(`${kind === "welcome" ? "Welcome" : "Goodbye"} message`)
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (parts[0] !== "wg" || parts[1] !== "builder") return;
  const action = parts[2];
  const draftId = parts[3];
  const ownerId = parts[4];
  const draft = getEmbedDraft(draftId);
  if (!draft || !(await validateComponent(interaction, ownerId, draft.guildId))) {
    if (!draft) {
      await replyError(interaction, "This embed draft expired. Run `/create embed` to start a new one.");
    }
    return;
  }

  if (action === "timestamp") {
    updateEmbedDraft(draft, {
      ...draft.definition,
      timestamp: !draft.definition.timestamp,
    });
    await interaction.update(buildEmbedBuilderPanel(draft));
    return;
  }

  if (action === "cancel") {
    deleteEmbedDraft(draft.id);
    await interaction.update({
      embeds: [
        createGodsEmbed({
          title: "Embed Draft Discarded",
          description: "The unsaved embed draft was discarded.",
          emoji: GODS_EMOJI.settings,
          tone: "info",
        }),
      ],
      components: [],
    });
    return;
  }

  if (action === "save") {
    const invalid = validateEmbedDefinition(draft.definition);
    if (invalid) {
      await replyError(interaction, invalid);
      return;
    }
    const preview = buildEmbed(draft.definition);
    if (!preview && !draft.definition.content) {
      await replyError(
        interaction,
        "Add Message Content or at least one embed field before saving.",
      );
      return;
    }
    await welcomeGoodbyeStore.saveEmbed(draft.guildId, {
      id: randomUUID(),
      name: draft.name,
      definition: draft.definition,
      createdAt: new Date().toISOString(),
    });
    deleteEmbedDraft(draft.id);
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Embed Saved",
          description: `${draft.name} is saved for this server. Choose it with \`/welcome embed\` or \`/goodbye embed\`.`,
          emoji: GODS_EMOJI.settings,
          tone: "success",
        }),
      ],
      ephemeral: true,
    });
  }

}

async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  if (parts[0] === "wg" && parts[1] === "builder" && parts[2] === "group") {
    const draftId = parts[3];
    const ownerId = parts[4];
    const draft = getEmbedDraft(draftId);
    if (!draft) {
      await replyError(interaction, "This embed draft expired. Run `/create embed` to start a new one.");
      return;
    }
    if (!(await validateComponent(interaction, ownerId, draft.guildId))) return;
    const group = interaction.values[0];
    const fields = FIELD_GROUPS[group];
    if (!fields) {
      await replyError(interaction, "Choose a field group from the menu.");
      return;
    }
    await interaction.showModal(buildFieldModal(draft, group, fields));
    return;
  }

  if (parts[0] === "wg" && parts[1] === "picker" && parts[2] === "select") {
    const kind = parts[3] as "welcome" | "goodbye" | "list";
    const ownerId = parts[5];
    if (!isPickerKind(kind) || !(await validateComponent(interaction, ownerId))) return;
    const guildId = interaction.guildId;
    if (!guildId) {
      await replyError(interaction, "Run this picker inside the server where the embeds are saved.");
      return;
    }
    const saved = welcomeGoodbyeStore
      .get(guildId)
      .embeds.find((embed) => embed.id === interaction.values[0]);
    if (!saved) {
      await replyError(interaction, "That saved embed is no longer available. Open the picker again and choose another.");
      return;
    }
    if (kind === "list") {
      const preview = buildSavedEmbedPreview(saved.id, guildId);
      await interaction.reply({
        embeds: preview ?? [
          createGodsEmbed({
            title: saved.name,
            description: "This saved embed has no previewable content.",
            emoji: GODS_EMOJI.settings,
            tone: "info",
          }),
        ],
        ephemeral: true,
      });
      return;
    }

    await welcomeGoodbyeStore.selectEmbed(guildId, kind, saved.id);
    await interaction.update({
      embeds: [
        settingSavedEmbed(kind, "embed", `**${saved.name}**`),
      ],
      components: [],
    });
    return;
  }
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  if (parts[0] !== "wg") return;

  if (parts[1] === "rawjson" && parts[2] === "submit") {
    const guildId = parts[3];
    const ownerId = parts[4];
    if (!guildId || !ownerId) {
      await replyError(interaction, "This import form is incomplete. Run `/add raw json` again.");
      return;
    }
    if (!(await validateComponent(interaction, ownerId, guildId))) return;

    try {
      const raw = interaction.fields.getTextInputValue("json");
      const imported = convertRawEmbedJson(raw);
      const name = imported.name;
      const saved = {
        id: randomUUID(),
        name,
        definition: imported.definition,
        createdAt: new Date().toISOString(),
      };

      try {
        await welcomeGoodbyeStore.saveEmbed(guildId, saved);
      } catch {
        await replyError(
          interaction,
          "The JSON passed validation, but this embed could not be saved for the server. Please try again.",
        );
        return;
      }

      const notes = [
        imported.fieldsFlattened
          ? "Discord fields were converted into formatted description text to match the existing saved-embed format."
          : "",
        imported.timestampIncluded
          ? "The imported timestamp will show the current time when a greeting is sent."
          : "",
      ].filter(Boolean);
      await interaction.reply({
        embeds: [
          createGodsEmbed({
            title: "Raw Embed Imported",
            description: [
              `**${name}** is saved for this server and is available in \`/embed list\`, \`/welcome embed\`, and \`/goodbye embed\`.`,
              ...notes,
            ].join("\n\n"),
            emoji: GODS_EMOJI.settings,
            tone: "success",
          }),
          imported.preview,
        ],
        allowedMentions: { parse: [] },
        ephemeral: true,
      });
    } catch (error) {
      const reason =
        error instanceof RawEmbedImportError
          ? error.message
          : "The embed could not be safely converted.";
      await replyError(
        interaction,
        `${reason}\n\nCorrect the JSON and run \`/add raw json\` again.`,
      );
    }
    return;
  }

  if (parts[1] === "message" && parts[2] === "save") {
    const kind = parts[3] as GreetingKind;
    const guildId = parts[4];
    const ownerId = parts[5];
    if (!isGreetingKind(kind) || !(await validateComponent(interaction, ownerId, guildId))) return;
    const message = interaction.fields.getTextInputValue("message");
    if (message.length > 2000) {
      await replyError(interaction, "Discord allows up to 2000 characters in Message Content.");
      return;
    }
    await welcomeGoodbyeStore.updateFlow(guildId, kind, { message });
    await interaction.reply({
      embeds: [
        settingSavedEmbed(
          kind,
          "message",
          message ? `${message.length} characters saved.` : "Message cleared.",
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  if (parts[1] === "builder" && parts[2] === "fields") {
    const draftId = parts[3];
    const group = parts[4];
    const ownerId = parts[5];
    const draft = getEmbedDraft(draftId);
    if (!draft) {
      await replyError(interaction, "This embed draft expired. Run `/create embed` to start a new one.");
      return;
    }
    if (!(await validateComponent(interaction, ownerId, draft.guildId))) return;
    const fields = FIELD_GROUPS[group];
    if (!fields) {
      await replyError(interaction, "That embed field group is no longer available.");
      return;
    }

    const values: Record<string, string> = {};
    for (const field of fields) {
      values[field.id] = interaction.fields.getTextInputValue(field.id);
      if (values[field.id].length > field.maxLength) {
        await replyError(
          interaction,
          `${field.label} allows up to ${field.maxLength} characters.`,
        );
        return;
      }
    }
    const definition = { ...draft.definition };
    if (group === "basics") {
      definition.content = values.content;
      definition.title = values.title;
      definition.titleUrl = values["title-url"];
      definition.description = values.description + values["description-extra"];
    } else {
      for (const field of fields) {
        const value = values[field.id];
        if (field.property === "description") continue;
        definition[field.property] = value as never;
      }
    }

    const invalid = validateChangedFields(group, definition);
    if (invalid) {
      await replyError(interaction, invalid);
      return;
    }
    updateEmbedDraft(draft, definition);
    await interaction.reply({
      ...buildEmbedBuilderPanel(draft),
      ephemeral: true,
    });
  }
}

function buildFieldModal(
  draft: EmbedDraftSession,
  group: string,
  fields: ModalField[],
): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`wg:builder:fields:${draft.id}:${group}:${draft.userId}`)
    .setTitle(groupTitle(group));
  const rows = fields.map((field) => {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setStyle(field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setMaxLength(field.maxLength)
      .setRequired(false)
      .setPlaceholder(field.description ?? `Leave blank to clear ${field.label}.`);
    const current = currentFieldValue(draft.definition, field);
    if (current) input.setValue(current);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  });
  return modal.addComponents(...rows);
}

function currentFieldValue(
  definition: WelcomeGoodbyeEmbedDefinition,
  field: ModalField,
): string {
  if (field.id === "description") return definition.description.slice(0, 4000);
  if (field.id === "description-extra") return definition.description.slice(4000, 4096);
  return String(definition[field.property] ?? "");
}

function groupTitle(group: string): string {
  const titles: Record<string, string> = {
    basics: "Edit message and text",
    author: "Edit author",
    media: "Edit images",
    footer: "Edit footer",
    color: "Edit color",
  };
  return titles[group] ?? "Edit embed";
}

function validateChangedFields(
  group: string,
  definition: WelcomeGoodbyeEmbedDefinition,
): string | null {
  const urls: Array<keyof WelcomeGoodbyeEmbedDefinition> =
    group === "basics"
      ? ["titleUrl"]
      : group === "author"
        ? ["authorUrl", "authorIconUrl"]
        : group === "media"
          ? ["thumbnailUrl", "imageUrl"]
          : group === "footer"
            ? ["footerIconUrl", "footerUrl"]
            : [];
  for (const field of urls) {
    const value = definition[field];
    if (typeof value !== "string" || !value) continue;
    const avatarAllowed =
      field === "authorIconUrl" ||
      field === "thumbnailUrl" ||
      field === "imageUrl" ||
      field === "footerIconUrl";
    if (avatarAllowed && value === MEMBER_AVATAR_VARIABLE) continue;
    if (!isHttpUrl(value)) {
      return `${fieldLabel(field)} must be a valid HTTP or HTTPS link.`;
    }
  }
  if (group === "color" && definition.color && !/^#?[\da-fA-F]{6}$/.test(definition.color)) {
    return "Color must be a six-digit hex value, such as #D4AF37.";
  }
  return null;
}

function fieldLabel(field: keyof WelcomeGoodbyeEmbedDefinition): string {
  const labels: Partial<Record<keyof WelcomeGoodbyeEmbedDefinition, string>> = {
    titleUrl: "Title URL",
    authorUrl: "Author URL",
    authorIconUrl: "Author Icon",
    thumbnailUrl: "Thumbnail",
    imageUrl: "Image",
    footerIconUrl: "Footer Icon",
    footerUrl: "Footer URL",
  };
  return labels[field] ?? field;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && value.length <= 2048;
  } catch {
    return false;
  }
}

async function handlePickerPage(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(":");
  const kind = parts[3] as "welcome" | "goodbye" | "list";
  const page = Number(parts[4]);
  const ownerId = parts[5];
  if (!isPickerKind(kind) || !(await validateComponent(interaction, ownerId))) return;
  const guildId = interaction.guildId;
  if (!guildId || !Number.isInteger(page) || page < 0) {
    await replyError(interaction, "That embed page is no longer available. Open the picker again.");
    return;
  }
  await interaction.update(
    buildSavedEmbedPicker({
      kind,
      guildId,
      userId: interaction.user.id,
      page,
    }),
  );
}

async function validateComponent(
  interaction: ComponentInteraction | ModalSubmitInteraction,
  ownerId: string | undefined,
  expectedGuildId?: string,
): Promise<boolean> {
  if (ownerId && interaction.user.id !== ownerId) {
    await replyError(interaction, "This control belongs to another user's session.");
    return false;
  }
  if (!interaction.guildId || (expectedGuildId && interaction.guildId !== expectedGuildId)) {
    await replyError(interaction, "Run this control inside the server where it was opened.");
    return false;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyError(interaction, "Only a server Administrator can change these settings.");
    return false;
  }
  return true;
}

async function replyError(
  interaction: Interaction | ModalSubmitInteraction,
  message: string,
): Promise<void> {
  if (!interaction.isRepliable()) return;
  const payload = {
    embeds: [
      createGodsEmbed({
        title: "Could Not Complete That Action",
        description: message,
        emoji: GODS_EMOJI.settings,
        tone: "error" as const,
      }),
    ],
    ephemeral: true,
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => null);
  } else {
    await interaction.reply(payload).catch(() => null);
  }
}

function isGreetingKind(value: string): value is GreetingKind {
  return value === "welcome" || value === "goodbye";
}

function isPickerKind(value: string): value is "welcome" | "goodbye" | "list" {
  return value === "welcome" || value === "goodbye" || value === "list";
}

function isPageButton(customId: string): boolean {
  return customId.startsWith("wg:picker:page:");
}

async function dispatchButton(interaction: ButtonInteraction): Promise<void> {
  if (isPageButton(interaction.customId)) {
    await handlePickerPage(interaction);
    return;
  }
  await handleButton(interaction);
}