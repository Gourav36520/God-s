import type { EmbedBuilder } from "discord.js";
import { buildEmbed, validateEmbedDefinition } from "./render.js";
import { createDefaultEmbedDefinition } from "./types.js";
import type { WelcomeGoodbyeEmbedDefinition } from "./types.js";

const MODAL_JSON_LIMIT = 4000;
const EMBED_KEYS = [
  "type",
  "title",
  "url",
  "description",
  "color",
  "timestamp",
  "author",
  "footer",
  "thumbnail",
  "image",
  "fields",
] as const;

export class RawEmbedImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawEmbedImportError";
  }
}

export interface RawEmbedImportResult {
  definition: WelcomeGoodbyeEmbedDefinition;
  preview: EmbedBuilder;
  name: string;
  fieldsFlattened: boolean;
  timestampIncluded: boolean;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RawEmbedImportError(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function rejectUnknownKeys(
  value: JsonRecord,
  allowed: readonly string[],
  label: string,
): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) {
    throw new RawEmbedImportError(
      `Unsupported property in the ${label} object. Remove unsupported properties and try again.`,
    );
  }
}

function readString(
  value: JsonRecord,
  key: string,
  label: string,
  limit: number,
  required = false,
): string {
  const raw = value[key];
  if (raw === undefined) {
    if (required) throw new RawEmbedImportError(`${label} is required.`);
    return "";
  }
  if (typeof raw !== "string") {
    throw new RawEmbedImportError(`${label} must be a string.`);
  }
  if (required && raw.length === 0) {
    throw new RawEmbedImportError(`${label} cannot be empty.`);
  }
  if (raw.length > limit) {
    throw new RawEmbedImportError(
      `${label} is ${raw.length} characters; Discord allows up to ${limit}.`,
    );
  }
  return raw;
}

function readAliasedString(
  value: JsonRecord,
  snakeKey: string,
  camelKey: string,
  label: string,
  limit: number,
): string {
  if (value[snakeKey] !== undefined && value[camelKey] !== undefined) {
    throw new RawEmbedImportError(
      `Use either "${snakeKey}" or "${camelKey}" for ${label}, not both.`,
    );
  }
  return readString(
    value,
    value[snakeKey] !== undefined ? snakeKey : camelKey,
    label,
    limit,
  );
}

function validateHttpUrl(value: string, label: string): void {
  if (!value) return;
  if (value.length > 2048) {
    throw new RawEmbedImportError(`${label} exceeds Discord's 2048-character URL limit.`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new RawEmbedImportError(`${label} must be a valid HTTP or HTTPS URL.`);
  }
}

function isValidIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  return Boolean(
    daysInMonth &&
      day >= 1 &&
      day <= daysInMonth &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59 &&
      offsetHour <= 23 &&
      offsetMinute <= 59,
  );
}

function readMediaUrl(value: unknown, label: string): string {
  const media = asRecord(value, label);
  rejectUnknownKeys(
    media,
    ["url", "proxy_url", "proxyURL", "height", "width"],
    label,
  );
  const url = readString(media, "url", `${label} URL`, 2048, true);
  validateHttpUrl(url, `${label} URL`);

  for (const key of ["proxy_url", "proxyURL"] as const) {
    if (media[key] !== undefined && typeof media[key] !== "string") {
      throw new RawEmbedImportError(`${label} ${key} must be a string.`);
    }
  }
  if (media.proxy_url !== undefined && media.proxyURL !== undefined) {
    throw new RawEmbedImportError(
      `${label} must use only one proxy URL property.`,
    );
  }
  for (const key of ["height", "width"] as const) {
    if (
      media[key] !== undefined &&
      (!Number.isInteger(media[key]) || (media[key] as number) < 0)
    ) {
      throw new RawEmbedImportError(`${label} ${key} must be a non-negative integer.`);
    }
  }
  return url;
}

function formatFields(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new RawEmbedImportError("Embed fields must be a JSON array.");
  }
  if (value.length > 25) {
    throw new RawEmbedImportError(
      `Discord allows up to 25 embed fields; this JSON has ${value.length}.`,
    );
  }
  return value.map((item, index) => {
    const field = asRecord(item, `Field ${index + 1}`);
    rejectUnknownKeys(field, ["name", "value", "inline"], `field ${index + 1}`);
    const name = readString(field, "name", `Field ${index + 1} name`, 256, true);
    const content = readString(field, "value", `Field ${index + 1} value`, 1024, true);
    const inline = field.inline ?? false;
    if (typeof inline !== "boolean") {
      throw new RawEmbedImportError(`Field ${index + 1} inline must be true or false.`);
    }
    return inline ? `**${name}** · ${content}` : `**${name}**\n${content}`;
  });
}

export function convertRawEmbedJson(raw: string): RawEmbedImportResult {
  if (!raw.trim()) {
    throw new RawEmbedImportError("The JSON input is empty.");
  }
  if (raw.length > MODAL_JSON_LIMIT) {
    throw new RawEmbedImportError(
      `The modal accepts up to ${MODAL_JSON_LIMIT} characters. Shorten the JSON and try again.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 180) : "Invalid JSON syntax";
    throw new RawEmbedImportError(`Invalid JSON: ${detail}`);
  }

  const source = asRecord(parsed, "The embed");
  rejectUnknownKeys(source, EMBED_KEYS, "embed");
  if (source.type !== undefined && source.type !== "rich") {
    throw new RawEmbedImportError(
      'Only rich Discord embeds can be imported; set "type" to "rich" or remove it.',
    );
  }

  const definition = createDefaultEmbedDefinition();
  definition.title = readString(source, "title", "Title", 256);
  definition.titleUrl = readString(source, "url", "URL", 2048);
  definition.description = readString(source, "description", "Description", 4096);
  validateHttpUrl(definition.titleUrl, "URL");

  if (source.color !== undefined) {
    if (
      typeof source.color !== "number" ||
      !Number.isInteger(source.color) ||
      source.color < 0 ||
      source.color > 0xffffff
    ) {
      throw new RawEmbedImportError(
        "Color must be a whole number from 0 to 16777215, as in Discord's embed JSON.",
      );
    }
    definition.color = `#${source.color.toString(16).padStart(6, "0")}`;
  }

  if (source.timestamp !== undefined) {
    if (
      typeof source.timestamp !== "string" ||
      !isValidIsoTimestamp(source.timestamp)
    ) {
      throw new RawEmbedImportError("Timestamp must be a valid ISO date string.");
    }
    definition.timestamp = true;
  }

  if (source.author !== undefined) {
    const author = asRecord(source.author, "Author");
    rejectUnknownKeys(
      author,
      ["name", "url", "icon_url", "iconURL", "proxy_icon_url", "proxyIconURL"],
      "author",
    );
    definition.authorName = readString(author, "name", "Author name", 256, true);
    definition.authorUrl = readString(author, "url", "Author URL", 2048);
    definition.authorIconUrl = readAliasedString(
      author,
      "icon_url",
      "iconURL",
      "Author icon URL",
      2048,
    );
    validateHttpUrl(definition.authorUrl, "Author URL");
    validateHttpUrl(definition.authorIconUrl, "Author icon URL");
    for (const key of ["proxy_icon_url", "proxyIconURL"] as const) {
      if (author[key] !== undefined && typeof author[key] !== "string") {
        throw new RawEmbedImportError(`Author ${key} must be a string.`);
      }
    }
  }

  if (source.footer !== undefined) {
    const footer = asRecord(source.footer, "Footer");
    rejectUnknownKeys(
      footer,
      ["text", "icon_url", "iconURL", "proxy_icon_url", "proxyIconURL"],
      "footer",
    );
    definition.footerText = readString(footer, "text", "Footer text", 2048, true);
    definition.footerIconUrl = readAliasedString(
      footer,
      "icon_url",
      "iconURL",
      "Footer icon URL",
      2048,
    );
    validateHttpUrl(definition.footerIconUrl, "Footer icon URL");
    for (const key of ["proxy_icon_url", "proxyIconURL"] as const) {
      if (footer[key] !== undefined && typeof footer[key] !== "string") {
        throw new RawEmbedImportError(`Footer ${key} must be a string.`);
      }
    }
  }

  if (source.thumbnail !== undefined) {
    definition.thumbnailUrl = readMediaUrl(source.thumbnail, "Thumbnail");
  }
  if (source.image !== undefined) {
    definition.imageUrl = readMediaUrl(source.image, "Image");
  }

  let fieldsFlattened = false;
  if (source.fields !== undefined) {
    const fields = formatFields(source.fields);
    fieldsFlattened = fields.length > 0;
    if (fields.length > 0) {
      definition.description = [definition.description, ...fields]
        .filter(Boolean)
        .join("\n\n");
    }
  }

  const invalid = validateEmbedDefinition(definition);
  if (invalid) throw new RawEmbedImportError(invalid);

  let preview: EmbedBuilder | null;
  try {
    preview = buildEmbed(definition);
    if (preview) preview.toJSON();
  } catch {
    throw new RawEmbedImportError(
      "Discord.js rejected one or more embed values. Check the field formats and Discord length limits.",
    );
  }
  if (!preview) {
    throw new RawEmbedImportError(
      "The JSON has no visible embed content. Add a title, description, author, footer, image, thumbnail, or field.",
    );
  }

  const name = definition.title || definition.authorName || "Imported embed";
  return {
    definition,
    preview,
    name: name.slice(0, 80),
    fieldsFlattened,
    timestampIncluded: definition.timestamp,
  };
}