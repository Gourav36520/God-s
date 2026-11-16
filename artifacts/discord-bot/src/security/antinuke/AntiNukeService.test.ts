import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityManager } from "../SecurityManager.js";
import { AntiNukeService } from "./AntiNukeService.js";
import { RollingThresholdCounter } from "./policy.js";

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
      channelDelete: [3, 3],
      channelCreate: [3, 3],
      memberKick: [3, 5],
      memberBan: [3, 5],
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
