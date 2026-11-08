import {
  AuditLogEvent,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildChannelCreateOptions,
} from "discord.js";
import type { RestoreReport } from "./types.js";

export interface AuditOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface AuditRoleData {
  kind: "role";
  originalId: string;
  name: string;
  permissions: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  warnings: string[];
}

export interface AuditChannelData {
  kind: "channel";
  originalId: string;
  name: string;
  type: NonNullable<GuildChannelCreateOptions["type"]>;
  position: number;
  parentId: string | null;
  topic: string | null;
  nsfw: boolean;
  rateLimitPerUser: number | null;
  bitrate: number | null;
  userLimit: number | null;
  rtcRegion: string | null;
  defaultAutoArchiveDuration: number | null;
  permissionOverwrites: AuditOverwrite[];
  permissionOverwritesAvailable: boolean;
  warnings: string[];
}

export interface AuditRecoveryCandidate {
  auditEntryId: string;
  deletedAt: string;
  executorId: string | null;
  data: AuditRoleData | AuditChannelData;
}

export interface AuditRecoveryAuditEntry {
  id: string;
  targetId: string | null;
  createdTimestamp: number;
  executorId: string | null;
  changes: { key: string; old?: unknown; new?: unknown }[];
  target?: unknown;
}

type CandidateResult =
  | { ok: true; candidates: AuditRecoveryCandidate[]; warnings: string[] }
  | { ok: false; reason: string };

const RESTORABLE_CHANNEL_TYPES = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

function isRestorableChannelType(
  type: number,
): type is NonNullable<GuildChannelCreateOptions["type"]> {
  return RESTORABLE_CHANNEL_TYPES.has(type);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function changeValue(
  entry: AuditRecoveryAuditEntry,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const change = entry.changes.find((item) => item.key === key);
    if (change) {
      if (change.old !== undefined) return change.old;
      if (change.new !== undefined) return change.new;
    }
  }

  const target = asRecord(entry.target);
  for (const key of keys) {
    const camelKey = key.replace(/_([a-z])/g, (_match, letter: string) =>
      letter.toUpperCase(),
    );
    if (target?.[camelKey] !== undefined) return target[camelKey];
    if (target?.[key] !== undefined) return target[key];
  }
  return undefined;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  const record = asRecord(value);
  if (record && "bitfield" in record) return stringValue(record.bitfield);
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeOverwrites(value: unknown): AuditOverwrite[] {
  if (!Array.isArray(value)) return [];
  const output: AuditOverwrite[] = [];
  for (const item of value) {
    const overwrite = asRecord(item);
    const id = stringValue(overwrite?.id);
    const type = numberValue(overwrite?.type);
    const allow = stringValue(overwrite?.allow);
    const deny = stringValue(overwrite?.deny);
    if (
      !id ||
      (type !== 0 && type !== 1) ||
      allow === null ||
      deny === null ||
      !/^\d+$/.test(allow) ||
      !/^\d+$/.test(deny)
    ) {
      continue;
    }
    output.push({ id, type, allow, deny });
  }
  return output;
}

export function candidateFromAuditEntry(
  kind: "role" | "channel",
  entry: AuditRecoveryAuditEntry,
): AuditRecoveryCandidate | null {
  const targetId =
    entry.targetId ?? stringValue(asRecord(entry.target)?.id);
  if (
    !entry.id ||
    !targetId ||
    !Number.isFinite(entry.createdTimestamp) ||
    entry.createdTimestamp <= 0
  ) {
    return null;
  }
  const deletedAt = new Date(entry.createdTimestamp).toISOString();
  const name = stringValue(changeValue(entry, ["name"]));
  if (!name?.trim()) return null;
  const warnings: string[] = [];

  if (kind === "role") {
    const rawPermissions = changeValue(entry, ["permissions"]);
    const permissions = stringValue(rawPermissions);
    const color = numberValue(changeValue(entry, ["color"]));
    const hoist = booleanValue(changeValue(entry, ["hoist"]));
    const mentionable = booleanValue(changeValue(entry, ["mentionable"]));
    const position = numberValue(changeValue(entry, ["position"]));
    if (permissions === null || !/^\d+$/.test(permissions)) {
      warnings.push("Audit log did not include permissions; the role will be restored with no permissions.");
    }
    if (color === null) warnings.push("Role color was unavailable and will default to none.");
    if (hoist === null) warnings.push("Role display setting was unavailable and will default off.");
    if (mentionable === null) warnings.push("Role mention setting was unavailable and will default off.");
    if (position === null) warnings.push("Role position was unavailable; Discord will choose the position.");
    return {
      auditEntryId: entry.id,
      deletedAt,
      executorId: entry.executorId,
      data: {
        kind: "role",
        originalId: targetId,
        name,
        permissions:
          permissions !== null && /^\d+$/.test(permissions) ? permissions : "0",
        color: color ?? 0,
        hoist: hoist ?? false,
        mentionable: mentionable ?? false,
        position: position ?? 0,
        warnings,
      },
    };
  }

  const type = numberValue(changeValue(entry, ["type"]));
  if (type === null || !isRestorableChannelType(type)) return null;
  const rawOverwrites = changeValue(entry, ["permission_overwrites", "permissionOverwrites"]);
  const permissionOverwritesAvailable = Array.isArray(rawOverwrites);
  const permissionOverwrites = normalizeOverwrites(rawOverwrites);
  if (!permissionOverwritesAvailable) {
    warnings.push(
      "Audit log omitted permission overwrites; the restored channel will be hidden from @everyone until an administrator configures access.",
    );
  } else if (permissionOverwrites.length !== rawOverwrites.length) {
    warnings.push("Some permission overwrites were incomplete and will be skipped.");
  }
  const position = numberValue(changeValue(entry, ["position"]));
  if (position === null) warnings.push("Channel position was unavailable.");

  const parentId = stringValue(changeValue(entry, ["parent_id", "parentId"]));
  const topic = stringValue(changeValue(entry, ["topic"]));
  const nsfw = booleanValue(changeValue(entry, ["nsfw"]));
  const rateLimitPerUser = numberValue(
    changeValue(entry, ["rate_limit_per_user", "rateLimitPerUser"]),
  );
  const bitrate = numberValue(changeValue(entry, ["bitrate"]));
  const userLimit = numberValue(changeValue(entry, ["user_limit", "userLimit"]));
  const rtcRegion = stringValue(changeValue(entry, ["rtc_region", "rtcRegion"]));
  const defaultAutoArchiveDuration = numberValue(
    changeValue(entry, ["default_auto_archive_duration", "defaultAutoArchiveDuration"]),
  );

  return {
    auditEntryId: entry.id,
    deletedAt,
    executorId: entry.executorId,
    data: {
      kind: "channel",
      originalId: targetId,
      name,
      type,
      position: position ?? 0,
      parentId,
      topic,
      nsfw: nsfw ?? false,
      rateLimitPerUser,
      bitrate,
      userLimit,
      rtcRegion,
      defaultAutoArchiveDuration,
      permissionOverwrites,
      permissionOverwritesAvailable,
      warnings,
    },
  };
}

function fromDiscordEntry(
  kind: "role" | "channel",
  entry: GuildAuditLogsEntry,
): AuditRecoveryCandidate | null {
  return candidateFromAuditEntry(kind, {
    id: entry.id,
    targetId: entry.targetId,
    createdTimestamp: entry.createdTimestamp,
    executorId: entry.executorId,
    changes: entry.changes,
    target: entry.target,
  });
}

export async function listAuditRecoveryCandidates(
  guild: Guild,
): Promise<CandidateResult> {
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    return {
      ok: false,
      reason: "The bot needs View Audit Log permission to inspect deleted channels and roles.",
    };
  }

  const [channelLogs, roleLogs] = await Promise.allSettled([
    guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 25 }),
    guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 25 }),
  ]);
  if (channelLogs.status === "rejected" && roleLogs.status === "rejected") {
    return {
      ok: false,
      reason: "Discord audit logs could not be read. Check the bot's View Audit Log permission and try again.",
    };
  }

  const warnings: string[] = [];
  if (channelLogs.status === "rejected") {
    warnings.push("Deleted channel audit entries could not be read.");
  }
  if (roleLogs.status === "rejected") {
    warnings.push("Deleted role audit entries could not be read.");
  }
  const candidates: AuditRecoveryCandidate[] = [];
  if (roleLogs.status === "fulfilled") {
    for (const entry of roleLogs.value.entries.values()) {
      const candidate = fromDiscordEntry("role", entry);
      if (candidate) candidates.push(candidate);
    }
  }
  if (channelLogs.status === "fulfilled") {
    for (const entry of channelLogs.value.entries.values()) {
      const candidate = fromDiscordEntry("channel", entry);
      if (candidate) candidates.push(candidate);
    }
  }
  candidates.sort(
    (a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime(),
  );
  return { ok: true, candidates: candidates.slice(0, 25), warnings };
}

function isAuditRecoveryCandidate(value: unknown): value is AuditRecoveryCandidate {
  const candidate = asRecord(value);
  const data = asRecord(candidate?.data);
  if (
    !candidate ||
    typeof candidate.auditEntryId !== "string" ||
    !candidate.auditEntryId ||
    typeof candidate.deletedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.deletedAt)) ||
    (candidate.executorId !== null && typeof candidate.executorId !== "string") ||
    !data ||
    typeof data.originalId !== "string" ||
    !data.originalId ||
    typeof data.name !== "string" ||
    !data.name ||
    !Array.isArray(data.warnings) ||
    !data.warnings.every((warning) => typeof warning === "string")
  ) {
    return false;
  }

  if (data.kind === "role") {
    return (
      typeof data.permissions === "string" &&
      /^\d+$/.test(data.permissions) &&
      typeof data.color === "number" &&
      Number.isFinite(data.color) &&
      typeof data.hoist === "boolean" &&
      typeof data.mentionable === "boolean" &&
      typeof data.position === "number" &&
      Number.isFinite(data.position)
    );
  }

  if (data.kind !== "channel" || typeof data.type !== "number") return false;
  if (!isRestorableChannelType(data.type)) return false;
  if (
    typeof data.position !== "number" ||
    !Number.isFinite(data.position) ||
    (data.parentId !== null && typeof data.parentId !== "string") ||
    (data.topic !== null && typeof data.topic !== "string") ||
    typeof data.nsfw !== "boolean" ||
    (data.rateLimitPerUser !== null &&
      (typeof data.rateLimitPerUser !== "number" ||
        !Number.isFinite(data.rateLimitPerUser))) ||
    (data.bitrate !== null &&
      (typeof data.bitrate !== "number" || !Number.isFinite(data.bitrate))) ||
    (data.userLimit !== null &&
      (typeof data.userLimit !== "number" ||
        !Number.isFinite(data.userLimit))) ||
    (data.rtcRegion !== null && typeof data.rtcRegion !== "string") ||
    (data.defaultAutoArchiveDuration !== null &&
      (typeof data.defaultAutoArchiveDuration !== "number" ||
        !Number.isFinite(data.defaultAutoArchiveDuration))) ||
    typeof data.permissionOverwritesAvailable !== "boolean" ||
    !Array.isArray(data.permissionOverwrites)
  ) {
    return false;
  }

  return data.permissionOverwrites.every((value) => {
    const overwrite = asRecord(value);
    return Boolean(
      overwrite &&
        typeof overwrite.id === "string" &&
        (overwrite.type === 0 || overwrite.type === 1) &&
        typeof overwrite.allow === "string" &&
        /^\d+$/.test(overwrite.allow) &&
        typeof overwrite.deny === "string" &&
        /^\d+$/.test(overwrite.deny),
    );
  });
}

export function validAuditRecoveryCandidates(
  value: unknown,
): AuditRecoveryCandidate[] {
  return Array.isArray(value) ? value.filter(isAuditRecoveryCandidate) : [];
}

function report(): RestoreReport {
  return { restored: [], skipped: [], failed: [], warnings: [] };
}

function bitfield(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export async function restoreAuditLogResources(
  guild: Guild,
  candidates: readonly AuditRecoveryCandidate[],
): Promise<RestoreReport> {
  const result = report();
  const resources = candidates.map((candidate) => candidate.data);
  const roles = resources.filter(
    (resource): resource is AuditRoleData => resource.kind === "role",
  );
  const channels = resources.filter(
    (resource): resource is AuditChannelData => resource.kind === "channel",
  );
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    result.failed.push("The bot's current server permissions could not be checked.");
    return result;
  }

  const canManageRoles = botMember.permissions.has(PermissionFlagsBits.ManageRoles);
  const canManageChannels = botMember.permissions.has(PermissionFlagsBits.ManageChannels);
  if (roles.length && !canManageRoles) {
    result.failed.push("Role recovery requires the bot's Manage Roles permission.");
  }
  if (channels.length && !canManageChannels) {
    result.failed.push("Channel recovery requires the bot's Manage Channels permission.");
  }

  const roleIds = new Map<string, string>();
  if (canManageRoles) {
    for (const item of roles) {
      if (item.originalId === guild.id) {
        result.skipped.push("The @everyone role cannot be recreated.");
        continue;
      }
      const existing = guild.roles.cache.find(
        (role) => !role.managed && role.name === item.name,
      );
      if (existing) {
        roleIds.set(item.originalId, existing.id);
        result.skipped.push(`Role "${item.name}" already exists; it was not changed.`);
        continue;
      }
      const permissions = bitfield(item.permissions);
      if (permissions === null) {
        result.failed.push(`Role "${item.name}" has invalid permission data.`);
        continue;
      }
      try {
        const restored = await guild.roles.create({
          name: item.name,
          permissions,
          color: item.color,
          hoist: item.hoist,
          mentionable: item.mentionable,
          reason: "Administrator-confirmed audit-log recovery",
        });
        roleIds.set(item.originalId, restored.id);
        if (item.position > 0) {
          await restored.setPosition(item.position).catch(() => {
            result.warnings.push(`Role "${item.name}" was created but its original position could not be restored.`);
          });
        }
        result.restored.push(`Created role "${item.name}".`);
        result.warnings.push(...item.warnings.map((warning) => `Role "${item.name}": ${warning}`));
      } catch (error) {
        result.failed.push(
          `Role "${item.name}": ${error instanceof Error ? error.message.slice(0, 180) : "Discord request failed."}`,
        );
      }
    }
  }

  if (canManageChannels) {
    const ordered = [...channels].sort(
      (a, b) =>
        Number(a.type !== ChannelType.GuildCategory) -
          Number(b.type !== ChannelType.GuildCategory) ||
        a.position - b.position,
    );
    const channelIds = new Map<string, string>();
    for (const item of ordered) {
      const existingChannel = guild.channels.cache.find(
        (channel) =>
          "name" in channel &&
          channel.name === item.name &&
          channel.type === item.type,
      );
      if (existingChannel) {
        channelIds.set(item.originalId, existingChannel.id);
        result.skipped.push(`Channel "${item.name}" already exists; it was not changed.`);
        continue;
      }

      let parentId: string | undefined;
      if (item.parentId) {
        parentId =
          channelIds.get(item.parentId) ??
          (guild.channels.cache.get(item.parentId)?.type === ChannelType.GuildCategory
            ? item.parentId
            : undefined);
        if (!parentId) {
          result.warnings.push(`Parent category for "${item.name}" was unavailable; the channel will be created without it.`);
        }
      }

      const permissionOverwrites = item.permissionOverwrites.flatMap((overwrite) => {
        const mappedId =
          overwrite.type === 0
            ? roleIds.get(overwrite.id) ?? guild.roles.cache.get(overwrite.id)?.id
            : guild.members.cache.has(overwrite.id)
              ? overwrite.id
              : undefined;
        const allow = bitfield(overwrite.allow);
        const deny = bitfield(overwrite.deny);
        if (!mappedId || allow === null || deny === null) {
          result.warnings.push(`An unavailable permission target on "${item.name}" was skipped.`);
          return [];
        }
        return [{ id: mappedId, type: overwrite.type, allow, deny }];
      });
      const hasEveryoneOverwrite = permissionOverwrites.some(
        (overwrite) => overwrite.type === 0 && overwrite.id === guild.id,
      );
      const cannotSafelyRecreateAccess =
        !item.permissionOverwritesAvailable ||
        (item.permissionOverwrites.length > 0 &&
          permissionOverwrites.length === 0) ||
        (item.parentId !== null && !parentId);
      if (cannotSafelyRecreateAccess && !hasEveryoneOverwrite) {
        permissionOverwrites.push({
          id: guild.id,
          type: 0,
          allow: 0n,
          deny: PermissionFlagsBits.ViewChannel,
        });
      }

      const options: GuildChannelCreateOptions = {
        name: item.name,
        type: item.type,
        position: item.position,
        ...(parentId ? { parent: parentId } : {}),
        permissionOverwrites,
        ...(item.topic !== null ? { topic: item.topic } : {}),
        nsfw: item.nsfw,
        ...(item.rateLimitPerUser !== null
          ? { rateLimitPerUser: item.rateLimitPerUser }
          : {}),
        ...(item.bitrate !== null ? { bitrate: item.bitrate } : {}),
        ...(item.userLimit !== null ? { userLimit: item.userLimit } : {}),
        ...(item.rtcRegion !== null ? { rtcRegion: item.rtcRegion } : {}),
        ...(item.defaultAutoArchiveDuration !== null
          ? { defaultAutoArchiveDuration: item.defaultAutoArchiveDuration as never }
          : {}),
        reason: "Administrator-confirmed audit-log recovery",
      };
      try {
        const restored = await guild.channels.create(options);
        channelIds.set(item.originalId, restored.id);
        result.restored.push(`Created channel "${item.name}".`);
        result.warnings.push(...item.warnings.map((warning) => `Channel "${item.name}": ${warning}`));
      } catch (error) {
        result.failed.push(
          `Channel "${item.name}": ${error instanceof Error ? error.message.slice(0, 180) : "Discord request failed."}`,
        );
      }
    }
  }

  return result;
}
