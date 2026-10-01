import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { arrowLine, createGodsEmbed, GODS_EMOJI } from "../commands/ui.js";
import { welcomeGoodbyeStore } from "./config-store.js";
import { buildEmbedPreview, validateEmbedDefinition } from "./render.js";
import type { EmbedDraftSession } from "./drafts.js";
import type {
  GreetingKind,
  WelcomeGoodbyeGuildConfig,
} from "./types.js";
import { VARIABLE_GUIDE } from "./variables.js";

export type EmbedPickerKind = GreetingKind | "list";

const EDIT_GROUPS = [
  { value: "basics", label: "Message & text", description: "Content, title, title link and description" },
  { value: "author", label: "Author", description: "Author name, link and icon" },
  { value: "media", label: "Images", description: "Thumbnail and large image" },
  { value: "footer", label: "Footer", description: "Footer text, icon and link" },
  { value: "color", label: "Color", description: "Embed color" },
];

export function buildMessageEditorPrompt(
  kind: GreetingKind,
  guildId: string,
  userId: string,
  currentMessage: string,
) {
  const label = kind === "welcome" ? "Welcome" : "Goodbye";
  const button = new ButtonBuilder()
    .setCustomId(`wg:message:open:${kind}:${guildId}:${userId}`)
    .setLabel(`Edit ${label} message`)
    .setStyle(ButtonStyle.Primary);

  return {
    embeds: [
      createGodsEmbed({
        title: `${label} Message Editor`,
        description: [
          "**Available variables**",
          VARIABLE_GUIDE,
          "",
          `Current message: ${currentMessage ? `Set (${currentMessage.length} characters)` : "Not set yet."}`,
          "Discord allows up to 2000 characters in a message.",
        ].join("\n"),
        emoji: GODS_EMOJI.settings,
        tone: "info",
      }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(button),
    ],
  };
}

export function buildEmbedBuilderPanel(
  draft: EmbedDraftSession,
) {
  const selector = new StringSelectMenuBuilder()
    .setCustomId(`wg:builder:group:${draft.id}:${draft.userId}`)
    .setPlaceholder("Choose what to edit")
    .addOptions(
      EDIT_GROUPS.map((group) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(group.label)
          .setValue(group.value)
          .setDescription(group.description),
      ),
    );
  const timestamp = new ButtonBuilder()
    .setCustomId(`wg:builder:timestamp:${draft.id}:${draft.userId}`)
    .setLabel(`Timestamp: ${draft.definition.timestamp ? "On" : "Off"}`)
    .setStyle(ButtonStyle.Secondary);
  const save = new ButtonBuilder()
    .setCustomId(`wg:builder:save:${draft.id}:${draft.userId}`)
    .setLabel("Save embed")
    .setStyle(ButtonStyle.Success);
  const cancel = new ButtonBuilder()
    .setCustomId(`wg:builder:cancel:${draft.id}:${draft.userId}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);

  const description = [
    `**Saved as:** ${draft.name}`,
    "",
    "**Available variables**",
    VARIABLE_GUIDE,
    "",
    "Choose a field group, edit it, then save the embed for this server.",
    "Discord does not support a URL directly on footer text. Footer URL is sent as a clickable link beneath the embed.",
    "",
    arrowLine("Message Content", `${draft.definition.content.length}/2000 characters`),
    arrowLine("Description", `${draft.definition.description.length}/4096 characters`),
  ].join("\n");
  const panel = createGodsEmbed({
    title: "Embed Builder",
    description,
    emoji: GODS_EMOJI.settings,
    tone: "info",
  });

  let preview;
  if (!validateEmbedDefinition(draft.definition)) {
    try {
      preview = buildEmbedPreview(draft.definition) ?? undefined;
    } catch {
      preview = undefined;
    }
  }

  return {
    embeds: preview ? [panel, preview] : [panel],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector),
      new ActionRowBuilder<ButtonBuilder>().addComponents(timestamp, save, cancel),
    ],
  };
}

export function buildSavedEmbedPicker(options: {
  kind: EmbedPickerKind;
  guildId: string;
  userId: string;
  page: number;
  config?: WelcomeGoodbyeGuildConfig;
}) {
  const { kind, guildId, userId } = options;
  const config = options.config ?? welcomeGoodbyeStore.get(guildId);
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(config.embeds.length / pageSize));
  const page = Math.min(Math.max(0, options.page), pageCount - 1);
  const entries = config.embeds.slice(page * pageSize, (page + 1) * pageSize);
  const label = kind === "welcome" ? "Welcome" : kind === "goodbye" ? "Goodbye" : "Saved";
  const selectedId = kind === "list" ? null : config[kind].embedId;

  if (config.embeds.length === 0) {
    return {
      embeds: [
        createGodsEmbed({
          title: kind === "list" ? "Saved Embeds" : `${label} Embed`,
          description: kind === "list"
            ? "This server has no saved embeds yet. Create one with `/create embed`."
            : `This server has no saved embeds yet. Create one with \`/create embed\`, then choose it here.`,
          emoji: GODS_EMOJI.settings,
          tone: "info",
        }),
      ],
      components: [],
    };
  }

  const selector = new StringSelectMenuBuilder()
    .setCustomId(`wg:picker:select:${kind}:${page}:${userId}`)
    .setPlaceholder(kind === "list" ? "Choose an embed to preview" : "Choose an embed")
    .addOptions(
      entries.map((embed) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(embed.name.slice(0, 100))
          .setValue(embed.id)
          .setDescription(
            `${embed.definition.title || embed.definition.description || "Saved embed"}`.slice(0, 100),
          );
        if (selectedId === embed.id) option.setDefault(true);
        return option;
      }),
    );

  const components: Array<
    ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
  > = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector),
  ];
  if (pageCount > 1) {
    const previous = new ButtonBuilder()
      .setCustomId(`wg:picker:page:${kind}:${page - 1}:${userId}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0);
    const next = new ButtonBuilder()
      .setCustomId(`wg:picker:page:${kind}:${page + 1}:${userId}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1);
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(previous, next),
    );
  }

  const currentText =
    kind !== "list" && selectedId
      ? config.embeds.find((embed) => embed.id === selectedId)?.name ??
        "The current selection is missing; choose a replacement."
      : null;
  const description = [
    kind === "list"
      ? "Choose a saved embed to preview. Only embeds saved in this server are shown."
      : `Choose which saved embed to use for ${label.toLowerCase()} messages.`,
    currentText ? `\n${arrowLine("Currently selected", currentText)}` : "",
    pageCount > 1 ? `\nPage ${page + 1} of ${pageCount}` : "",
  ].join("");

  return {
    embeds: [
      createGodsEmbed({
        title: kind === "list" ? "Saved Embeds" : `${label} Embed`,
        description,
        emoji: GODS_EMOJI.settings,
        tone: "info",
      }),
    ],
    components,
  };
}

export function buildSavedEmbedPreview(
  embedId: string,
  guildId: string,
) {
  const saved = welcomeGoodbyeStore
    .get(guildId)
    .embeds.find((embed) => embed.id === embedId);
  if (!saved) return null;
  const preview = buildEmbedPreview(saved.definition);
  const content = saved.definition.content;
  const summary = createGodsEmbed({
    title: saved.name,
    description: content
      ? `**Message Content**\n${content.slice(0, 1800)}`
      : "Embed preview below.",
    emoji: GODS_EMOJI.settings,
    tone: "info",
  });
  return preview ? [summary, preview] : [summary];
}