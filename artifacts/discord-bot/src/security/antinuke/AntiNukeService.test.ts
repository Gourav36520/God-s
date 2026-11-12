import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import type { Guild } from "discord.js";
import type { SecurityManager } from "../SecurityManager.js";
import { SeverityPolicy } from "../heat/SeverityPolicy.js";
import {
  AntiNukeService,
  criticalEventForIncident,
} from "./AntiNukeService.js";
import { RollingThresholdCounter } from "./policy.js";
import type { AntiNukeIncident } from "./types.js";
import type { AntiNukeResponse } from "./types.js";

const criticalDetectorCases = [
  { detector: "webhook-create", type: "webhookRaid", title: "Webhook Raid" },
  { detector: "webhook-delete", type: "webhookRaid", title: "Webhook Raid" },
  { detector: "webhook-update", type: "webhookRaid", title: "Webhook Raid" },
  { detector: "member-ban", type: "massBan", title: "Mass Ban" },
  { detector: "member-kick", type: "massKick", title: "Mass Kick" },
  {
    detector: "channel-delete",
    type: "massChannelDelete",
    title: "Mass Channel Delete",
  },
] as const;

function makeService(failingGuildId?: string) {
  const configs = new Map<string, Record<string, unknown>>();
  const incidents: Array<{ guildId: string; action: string }> = [];
  const database = {
    saveAntiNukeConfigRow: async (
      guildId: string,
      config: Record<string, unknown>,
    ) => {
      if (guildId === failingGuildId) {
        throw Object.assign(new Error("simulated database failure"), {
          code: "TEST_DB_FAILURE",
        });
      }
      configs.set(guildId, structuredClone(config));
    },
    createAntiNukeIncidentRow: async (incident: {
      guildId: string;
      action: string;
    }) => {
      incidents.push(incident);
      return true;
    },
    updateAntiNukeIncidentOutcome: async () => true,
    listAntiNukeIncidentRows: async (guildId: string) =>
      incidents.filter((incident) => incident.guildId === guildId),
  };
  const service = new AntiNukeService({} as SecurityManager);
  Object.assign(service, { client: {}, database });
  return { service, configs, incidents };
}

test("creates and persists isolated defaults for multiple new guilds", async () => {
  const { service, configs } = makeService();

  const first = await service.ensureConfig("guild-a");
  const second = await service.ensureConfig("guild-b");

  assert.notStrictEqual(first, second);
  assert.deepEqual([...configs.keys()].sort(), ["guild-a", "guild-b"]);
  assert.deepEqual(
    {
      channelDelete: [
        first.detectors["channel-delete"].limit,
        first.detectors["channel-delete"].windowSeconds,
      ],
      channelCreate: [
        first.detectors["channel-create"].limit,
        first.detectors["channel-create"].windowSeconds,
      ],
      memberKick: [
        first.detectors["member-kick"].limit,
        first.detectors["member-kick"].windowSeconds,
      ],
      memberBan: [
        first.detectors["member-ban"].limit,
        first.detectors["member-ban"].windowSeconds,
      ],
    },
    {
      channelDelete: [2, 5],
      channelCreate: [3, 3],
      memberKick: [2, 5],
      memberBan: [2, 5],
    },
  );

  await service.updateConfig("guild-a", (current) => ({
    ...current,
    enabled: false,
    logs: { ...current.logs, channelId: "guild-a-log" },
  }));

  assert.equal(service.getConfig("guild-a").enabled, false);
  assert.equal(service.getConfig("guild-a").logs.channelId, "guild-a-log");
  assert.equal(service.getConfig("guild-b").enabled, true);
  assert.equal(service.getConfig("guild-b").logs.channelId, null);
});

test("incident response cannot invoke automatic lockdown from legacy settings", async () => {
  const { service } = makeService();
  let lockdownCalled = false;
  Object.assign(service, {
    applyLockdown: async () => {
      lockdownCalled = true;
      return { changed: 1, skipped: 0, message: "lockdown ran" };
    },
  });
  const applyResponse = (
    service as unknown as {
      applyResponse(
        guild: Guild,
        executorId: string,
        response: AntiNukeResponse,
        reason: string,
      ): Promise<string>;
    }
  ).applyResponse.bind(service);

  const result = await applyResponse(
    { ownerId: "guild-owner" } as Guild,
    "executor-id",
    "lockdown",
    "legacy setting",
  );

  assert.equal(lockdownCalled, false);
  assert.equal(result, "Automatic lockdown is disabled for Anti-Nuke incidents.");
});

test("stores and lists incidents within their own guild", async () => {
  const { service, incidents } = makeService();

  await service.recordSystemIncident({
    guildId: "guild-a",
    action: "guild-a-action",
    outcome: "saved",
  });
  await service.recordSystemIncident({
    guildId: "guild-b",
    action: "guild-b-action",
    outcome: "saved",
  });

  assert.equal(incidents.length, 2);
  assert.deepEqual(
    (await service.listIncidents("guild-a")).map((incident) => incident.action),
    ["guild-a-action"],
  );
  assert.deepEqual(
    (await service.listIncidents("guild-b")).map((incident) => incident.action),
    ["guild-b-action"],
  );
});

test("a guild-specific default write failure does not block another guild", async () => {
  const { service, configs } = makeService("guild-b");

  await service.ensureConfig("guild-a");
  await assert.rejects(service.ensureConfig("guild-b"));

  assert.deepEqual([...configs.keys()], ["guild-a"]);
  assert.equal(service.getConfig("guild-a").enabled, true);
  assert.equal(service.getConfig("guild-b").enabled, true);
});

test("keeps burst counters isolated by guild", () => {
  const counter = new RollingThresholdCounter();

  assert.equal(counter.add("guild-a", "executor", "channel-delete", 1_000, 3_000), 1);
  assert.equal(counter.add("guild-a", "executor", "channel-delete", 1_500, 3_000), 2);
  assert.equal(counter.add("guild-b", "executor", "channel-delete", 1_500, 3_000), 1);
  assert.equal(counter.count("guild-a", "executor", "channel-delete", 1_500, 3_000), 2);
  assert.equal(counter.count("guild-b", "executor", "channel-delete", 1_500, 3_000), 1);
});

test("adds NEXUS owner-review reports to slow verified activity without punishment", async () => {
  const { service } = makeService();
  const reports: Array<{
    incident: AntiNukeIncident;
    thresholdReached: boolean;
    ownerReview: boolean;
  }> = [];
  Object.assign(service, {
    sendIncident: async (
      _guild: Guild,
      incident: AntiNukeIncident,
      thresholdReached: boolean,
      ownerReview: boolean,
    ) => {
      reports.push({ incident, thresholdReached, ownerReview });
      return true;
    },
  });
  const guild = {
    id: "guild-nexus",
    ownerId: "owner-id",
    client: { users: { fetch: async () => ({ bot: false }) } },
  } as unknown as Guild;
  const processActivity = (
    service as unknown as {
      processActivity(activity: {
        guild: Guild;
        detector: "channel-delete";
        targetId: string;
        executorId: string;
        eventKey: string;
        action: string;
        details: Record<string, unknown>;
        occurredAt: Date;
      }): Promise<void>;
    }
  ).processActivity.bind(service);
  const start = Date.now() - 5 * 60_000;

  for (let index = 0; index < 4; index += 1) {
    await processActivity({
      guild,
      detector: "channel-delete",
      targetId: `channel-${index}`,
      executorId: "executor-id",
      eventKey: `audit-${index}`,
      action: "channel-delete",
      details: {},
      occurredAt: new Date(start + index * 30_000),
    });
  }

  assert.equal(reports.length, 4);
  assert.ok(reports.every((report) => !report.thresholdReached));
  assert.equal(reports[3].ownerReview, true);
  assert.equal(reports[3].incident.response, "log");
  assert.deepEqual(reports[3].incident.details.nexus, {
    status: "available",
    analysisMode: "deterministic",
    riskLevel: "high",
    riskScore: 75,
    confidence: 0.72,
    summary:
      "Verified activity forms a repeated or cross-detector pattern. Review it manually; NEXUS cannot take action.",
    reasons: [
      "4 verified channel-delete events occurred within 15 minutes without reaching the 2-event threshold in 5 seconds.",
      "The repeated activity continued across multiple configured threshold windows.",
      "Recent activity is one event below the configured burst threshold.",
    ],
    falsePositiveIndicators: [
      "The configured burst threshold has not been reached; review the pattern before taking action.",
      "Activity is limited to one detector and may reflect routine server maintenance.",
      "Routine administrator maintenance can produce repeated verified changes.",
    ],
    recommendation: "owner-review",
    historyWindowMinutes: 15,
    relatedEventCount: 4,
    distinctRelatedDetectors: 1,
    sameDetectorEventCount: 4,
  });
});

test("keeps threshold punishment active when NEXUS analysis fails", async () => {
  const { service } = makeService();
  let responses = 0;
  Object.assign(service, {
    nexusAnalyzer: {
      analyze: async () => {
        throw new Error("simulated NEXUS failure");
      },
    },
    applyResponse: async () => {
      responses += 1;
      return "Deterministic response completed.";
    },
    sendIncident: async () => true,
  });
  const guild = {
    id: "guild-failure",
    ownerId: "owner-id",
    client: { users: { fetch: async () => ({ bot: false }) } },
  } as unknown as Guild;
  const processActivity = (
    service as unknown as {
      processActivity(activity: {
        guild: Guild;
        detector: "channel-delete";
        targetId: string;
        executorId: string;
        eventKey: string;
        action: string;
        details: Record<string, unknown>;
        occurredAt: Date;
      }): Promise<void>;
    }
  ).processActivity.bind(service);
  const occurredAt = Date.now();

  for (let index = 0; index < 2; index += 1) {
    await processActivity({
      guild,
      detector: "channel-delete",
      targetId: `channel-${index}`,
      executorId: "executor-id",
      eventKey: `audit-failure-${index}`,
      action: "channel-delete",
      details: {},
      occurredAt: new Date(occurredAt + index * 1_000),
    });
  }

  assert.equal(responses, 1);
});

test("threshold incidents map to their critical severity policy entries", () => {
  const policy = new SeverityPolicy();

  for (const { detector, type, title } of criticalDetectorCases) {
    const event = criticalEventForIncident({ detector }, true);
    assert.deepEqual(event, { type, title }, detector);
    assert.ok(event);
    assert.equal(policy.resolve(event.type), "critical", detector);
    assert.equal(criticalEventForIncident({ detector }, false), null, detector);
  }
});

test("critical Anti-Nuke incidents attach the shared PNG and retain incident data", async () => {
  const { service } = makeService();
  const sent: unknown[] = [];
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({
      has: () => true,
    }),
    send: async (payload: unknown) => {
      sent.push(payload);
    },
  };
  const client = {
    channels: { fetch: async () => channel },
    users: { cache: new Map() },
  };
  Object.assign(service, { client });
  await service.updateConfig("guild-logs", (current) => ({
    ...current,
    logs: {
      ...current.logs,
      channelId: "anti-nuke-logs",
      alertsEnabled: true,
      mentionOwner: true,
    },
  }));

  const guild = {
    id: "guild-logs",
    ownerId: "guild-owner",
    members: { me: {}, cache: new Map() },
  } as unknown as Guild;
  const sendIncident = (
    service as unknown as {
      sendIncident(
        guild: Guild,
        incident: AntiNukeIncident,
        thresholdReached: boolean,
      ): Promise<boolean>;
    }
  ).sendIncident.bind(service);

  for (const [index, { detector }] of criticalDetectorCases.entries()) {
    const incident: AntiNukeIncident = {
      id: `incident-${index}`,
      guildId: guild.id,
      eventKey: `event-${index}`,
      detector,
      executorId: "executor-id",
      targetId: `target-${index}`,
      action: detector,
      thresholdCount: 3,
      response: "log",
      outcome: "Threshold reached; no response was scheduled.",
      details: {
        executorKind: "human",
        thresholdReached: true,
        limit: 3,
        windowSeconds: 5,
      },
      occurredAt: new Date("2026-11-11T09:00:00.000Z"),
    };

    assert.equal(await sendIncident(guild, incident, true), true);
  }

  assert.equal(sent.length, criticalDetectorCases.length);
  for (const [index, { detector }] of criticalDetectorCases.entries()) {
    const payload = sent[index] as {
      content?: string;
      embeds: Array<{
        toJSON: () => {
          title?: string;
          description?: string;
          fields?: Array<{ name: string; value: string }>;
          image?: { url?: string };
        };
      }>;
      files?: Array<{ name?: string; attachment: unknown }>;
      allowedMentions?: { users?: string[]; parse?: string[] };
    };
    const embed = payload.embeds[0].toJSON();

    assert.equal(embed.title, `Anti-Nuke · ${detector}`);
    assert.match(embed.description ?? "", /Action:.*Outcome:/s);
    assert.equal(embed.image?.url, "attachment://moderation-action-card.png");
    assert.equal(payload.files?.[0].name, "moderation-action-card.png");
    assert.ok(Buffer.isBuffer(payload.files?.[0].attachment));
    assert.equal(payload.content, "<@guild-owner>");
    assert.deepEqual(payload.allowedMentions, {
      users: ["guild-owner"],
      parse: [],
    });
    assert.ok(
      embed.fields?.some((field) => field.name === "Incident ID"),
      `missing incident details for ${detector}`,
    );
  }
});

test("owner-review NEXUS reports can alert the owner below deterministic thresholds", async () => {
  const { service } = makeService();
  const sent: Array<{
    content?: string;
    embeds: Array<{ toJSON: () => { fields?: Array<{ name: string; value: string }> } }>;
    allowedMentions?: { users?: string[]; parse?: string[] };
  }> = [];
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload: (typeof sent)[number]) => {
      sent.push(payload);
    },
  };
  Object.assign(service, {
    client: { channels: { fetch: async () => channel }, users: { cache: new Map() } },
  });
  await service.updateConfig("guild-review", (current) => ({
    ...current,
    logs: {
      ...current.logs,
      channelId: "anti-nuke-logs",
      alertsEnabled: true,
      mentionOwner: true,
    },
  }));
  const guild = {
    id: "guild-review",
    ownerId: "owner-id",
    members: { me: {}, cache: new Map() },
  } as unknown as Guild;
  const incident: AntiNukeIncident = {
    id: "nexus-review",
    guildId: guild.id,
    eventKey: "nexus-review-event",
    detector: "channel-delete",
    executorId: "executor-id",
    targetId: "channel-id",
    action: "channel-delete",
    thresholdCount: 1,
    response: "log",
    outcome: "Threshold not reached (1/2).",
    details: {
      executorKind: "human",
      thresholdReached: false,
      limit: 2,
      windowSeconds: 5,
      nexus: {
        status: "available",
        analysisMode: "deterministic",
        riskLevel: "high",
        riskScore: 75,
        confidence: 0.72,
        summary: "Review the repeated activity manually.",
        reasons: ["Repeated verified activity."],
        falsePositiveIndicators: ["The burst threshold was not reached."],
        recommendation: "owner-review",
      },
    },
    occurredAt: new Date(),
  };
  const sendIncident = (
    service as unknown as {
      sendIncident(
        guild: Guild,
        incident: AntiNukeIncident,
        thresholdReached: boolean,
        ownerReview: boolean,
      ): Promise<boolean>;
    }
  ).sendIncident.bind(service);

  assert.equal(await sendIncident(guild, incident, false, true), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, "<@owner-id>");
  assert.deepEqual(sent[0].allowedMentions, {
    users: ["owner-id"],
    parse: [],
  });
  assert.ok(
    sent[0].embeds[0]
      .toJSON()
      .fields?.some((field) => field.name === "GOD'S NEXUS"),
  );
});
