import { EmbedBuilder } from "discord.js";
import type { GuildMember, MessageCreateOptions } from "discord.js";
import type {
  SavedWelcomeGoodbyeEmbed,
  WelcomeGoodbyeEmbedDefinition,
  WelcomeGoodbyeFlowConfig,
} from "./types.js";
import { MEMBER_AVATAR_VARIABLE, renderImageUrl, renderMessageText } from "./variables.js";

const FIELD_LIMITS: Partial<Record<keyof WelcomeGoodbyeEmbedDefinition, number>> = {
  content: 2000,
  title: 256,
  authorName: 256,
  description: 4096,
  footerText: 2048,
};

const URL_FIELDS: Array<keyof WelcomeGoodbyeEmbedDefinition> = [
  "titleUrl",
  "authorUrl",
  "authorIconUrl",
  "thumbnailUrl",
  "imageUrl",
  "footerIconUrl",
  "footerUrl",
];

export class GreetingOutputError extends Error {}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && value.length <= 2048;
  } catch {
    return false;
  }
}

export function validateEmbedDefinition(
  definition: WelcomeGoodbyeEmbedDefinition,
): string | null {
  for (const [field, limit] of Object.entries(FIELD_LIMITS) as [
    keyof WelcomeGoodbyeEmbedDefinition,
    number,
  ][]) {
    const value = definition[field];
    if (typeof value === "string" && value.length > limit) {
      return `${fieldLabel(field)} is ${value.length} characters; Discord allows up to ${limit}.`;
    }
  }

  for (const field of URL_FIELDS) {
    const value = definition[field];
    if (typeof value !== "string" || value.length === 0) continue;
    if (field === "authorIconUrl" || field === "thumbnailUrl" || field === "imageUrl" || field === "footerIconUrl") {
      if (value === MEMBER_AVATAR_VARIABLE) continue;
    }
    if (!isWebUrl(value)) {
      return `${fieldLabel(field)} must be a valid HTTP or HTTPS link.`;
    }
  }

  if (definition.titleUrl && !definition.title) {
    return "Add a Title before setting a Title URL.";
  }
  if ((definition.authorUrl || definition.authorIconUrl) && !definition.authorName) {
    return "Add an Author Name before setting Author URL or Author Icon.";
  }
  if (definition.footerIconUrl && !definition.footerText) {
    return "Add Footer Text before setting a Footer Icon.";
  }

  const embedTextLength =
    definition.title.length +
    definition.description.length +
    definition.authorName.length +
    definition.footerText.length;
  if (embedTextLength > 6000) {
    return `Embed text totals ${embedTextLength} characters; Discord allows up to 6000 across an embed.`;
  }

  return null;
}

function fieldLabel(field: keyof WelcomeGoodbyeEmbedDefinition): string {
  const labels: Partial<Record<keyof WelcomeGoodbyeEmbedDefinition, string>> = {
    content: "Message Content",
    title: "Title",
    titleUrl: "Title URL",
    authorName: "Author Name",
    authorUrl: "Author URL",
    authorIconUrl: "Author Icon",
    description: "Description",
    thumbnailUrl: "Thumbnail",
    imageUrl: "Image",
    footerText: "Footer Text",
    footerIconUrl: "Footer Icon",
    footerUrl: "Footer URL",
    color: "Color",
  };
  return labels[field] ?? field;
}

function resolvedDefinition(
  definition: WelcomeGoodbyeEmbedDefinition,
  member?: GuildMember,
): WelcomeGoodbyeEmbedDefinition {
  return {
    ...definition,
    content: renderMessageText(definition.content, member),
    title: renderMessageText(definition.title, member),
    authorName: renderMessageText(definition.authorName, member),
    description: renderMessageText(definition.description, member),
    footerText: renderMessageText(definition.footerText, member),
    authorIconUrl: renderImageUrl(definition.authorIconUrl, member),
    thumbnailUrl: renderImageUrl(definition.thumbnailUrl, member),
    imageUrl: renderImageUrl(definition.imageUrl, member),
    footerIconUrl: renderImageUrl(definition.footerIconUrl, member),
  };
}

export function buildEmbed(
  definition: WelcomeGoodbyeEmbedDefinition,
  member?: GuildMember,
): EmbedBuilder | null {
  const resolved = resolvedDefinition(definition, member);
  const invalid = validateEmbedDefinition(resolved);
  if (invalid) throw new GreetingOutputError(invalid);

  const hasEmbedContent = Boolean(
    resolved.title ||
      resolved.description ||
      resolved.authorName ||
      resolved.thumbnailUrl ||
      resolved.imageUrl ||
      resolved.footerText,
  );
  if (!hasEmbedContent) return null;

  const embed = new EmbedBuilder();
  if (resolved.title) embed.setTitle(resolved.title);
  if (resolved.titleUrl) embed.setURL(resolved.titleUrl);
  if (resolved.authorName) {
    embed.setAuthor({
      name: resolved.authorName,
      ...(resolved.authorUrl ? { url: resolved.authorUrl } : {}),
      ...(resolved.authorIconUrl ? { iconURL: resolved.authorIconUrl } : {}),
    });
  }
  if (resolved.description) embed.setDescription(resolved.description);
  if (resolved.thumbnailUrl) embed.setThumbnail(resolved.thumbnailUrl);
  if (resolved.imageUrl) embed.setImage(resolved.imageUrl);
  if (resolved.footerText) {
    embed.setFooter({
      text: resolved.footerText,
      ...(resolved.footerIconUrl ? { iconURL: resolved.footerIconUrl } : {}),
    });
  }
  if (resolved.color) {
    const hex = resolved.color.replace(/^#/, "");
    if (!/^[\da-fA-F]{6}$/.test(hex)) {
      throw new GreetingOutputError("Color must be a six-digit hex value, such as #D4AF37.");
    }
    embed.setColor(Number.parseInt(hex, 16));
  }
  if (resolved.timestamp) embed.setTimestamp();
  return embed;
}

export function buildGreetingPayload(
  flow: WelcomeGoodbyeFlowConfig,
  savedEmbed: SavedWelcomeGoodbyeEmbed | undefined,
  member: GuildMember,
): MessageCreateOptions {
  if (flow.embedId && !savedEmbed) {
    throw new GreetingOutputError(
      "The selected saved embed is missing. Create or choose a replacement with `/create embed` and `/welcome embed` or `/goodbye embed`.",
    );
  }

  const pieces: string[] = [];
  if (flow.message) pieces.push(renderMessageText(flow.message, member));

  let embed: EmbedBuilder | null = null;
  if (savedEmbed) {
    const embedContent = renderMessageText(savedEmbed.definition.content, member);
    if (embedContent) pieces.push(embedContent);
    embed = buildEmbed(savedEmbed.definition, member);
    if (savedEmbed.definition.footerUrl) {
      pieces.push(
        `[Footer link](<${savedEmbed.definition.footerUrl}>)`,
      );
    }
  }

  const content = pieces.join("\n");
  if (content.length > 2000) {
    throw new GreetingOutputError(
      `Message Content totals ${content.length} characters after variables are filled; Discord allows up to 2000. Shorten the message or remove a variable.`,
    );
  }
  if (!content && !embed) {
    throw new GreetingOutputError(
      "There is no Welcome/Goodbye output yet. Set it with the matching `/welcome message` or `/goodbye message` command, or create and select an embed.",
    );
  }

  return {
    ...(content ? { content } : {}),
    ...(embed ? { embeds: [embed] } : {}),
    allowedMentions: { users: [member.id], roles: [], parse: [] },
  };
}

export function buildEmbedPreview(
  definition: WelcomeGoodbyeEmbedDefinition,
): EmbedBuilder | null {
  return buildEmbed(definition);
}