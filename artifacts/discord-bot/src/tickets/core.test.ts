import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import type { Interaction } from "discord.js";
import { data as ticketCommand } from "../commands/ticket.js";
import {
  buildDefaultConfig,
} from "../security/defaults.js";
import {
  buildTicketPermissionOverwrites,
  buildTicketTopic,
  findOpenTicketForOpener,
  getTicketPanelMissingItems,
  parseTicketTopic,
  TICKET_CLOSE_BUTTON_ID,
  TICKET_CREATE_BUTTON_ID,
} from "./core.js";
import {
  isTicketComponent,
} from "../events/ticketInteractionCreate.js";
import {
  buildTicketCloseButtonRow,
  buildTicketConfigPanel,
  buildTicketPanelButtonRow,
} from "./views.js";
import type { TicketConfig } from "../security/types.js";

const defaultTicketConfig = buildDefaultConfig("123456789012345678").ticket;

function componentCustomId(component: object): string | undefined {
  return "custom_id" in component && typeof component.custom_id === "string"
    ? component.custom_id
    : undefined;
}

test("ticket config defaults remain safe and panel readiness names each missing item", () => {
  assert.deepEqual(defaultTicketConfig, {
    enabled: false,
    staffRoleId: null,
    categoryId: null,
    transcriptChannelId: null,
    panelChannelId: null,
    panelEmbedId: null,
  });
  assert.deepEqual(getTicketPanelMissingItems(defaultTicketConfig, false), [
    "Ticket System is disabled",
    "Staff Role",
    "Ticket Category",
    "Panel Channel",
    "Panel Embed",
  ]);

  const readyConfig: TicketConfig = {
    enabled: true,
    staffRoleId: "222222222222222222",
    categoryId: "333333333333333333",
    transcriptChannelId: null,
    panelChannelId: "444444444444444444",
    panelEmbedId: "saved-embed",
  };
  assert.deepEqual(getTicketPanelMissingItems(readyConfig, true), []);
  assert.deepEqual(getTicketPanelMissingItems(readyConfig, false), ["Panel Embed"]);
});

test("ticket button builders use the IDs handled by the interaction router", () => {
  const createButton =
    buildTicketPanelButtonRow().toJSON().components[0];
  const closeButton =
    buildTicketCloseButtonRow().toJSON().components[0];
  const createButtonId = componentCustomId(createButton);
  const closeButtonId = componentCustomId(closeButton);
  assert.equal(createButtonId, TICKET_CREATE_BUTTON_ID);
  assert.equal(closeButtonId, TICKET_CLOSE_BUTTON_ID);

  const createInteraction = {
    isButton: () => true,
    customId: createButtonId,
  } as unknown as Interaction;
  const closeInteraction = {
    isButton: () => true,
    customId: closeButtonId,
  } as unknown as Interaction;
  const unrelatedInteraction = {
    isButton: () => true,
    customId: "unrelated:button",
  } as unknown as Interaction;
  assert.equal(isTicketComponent(createInteraction), true);
  assert.equal(isTicketComponent(closeInteraction), true);
  assert.equal(isTicketComponent(unrelatedInteraction), false);
});

test("ticket command is routed as a root command with direct config, embed, and panel subcommands", () => {
  const schema = ticketCommand.toJSON();
  assert.equal(schema.name, "ticket");
  const options = schema.options ?? [];
  assert.deepEqual(
    options.map((option) => option.name),
    ["config", "embed", "panel"],
  );
  assert.ok(options.every((option) => option.type === 1));
});

test("ticket configuration component IDs bind the current guild and administrator", () => {
  const panel = buildTicketConfigPanel({
    guildId: "111111111111111111",
    userId: "222222222222222222",
    config: defaultTicketConfig,
  });
  const customIds = panel.components.flatMap((row) =>
    row.toJSON().components.map(componentCustomId),
  );
  assert.ok(
    customIds.includes("ticket:config:staff:111111111111111111:222222222222222222"),
  );
  assert.ok(
    customIds.includes("ticket:config:save:111111111111111111:222222222222222222"),
  );
});

test("ticket topics persist opener/status and duplicate detection ignores closed or unrelated channels", () => {
  const openTopic = buildTicketTopic(
    "111111111111111111",
    "222222222222222222",
  );
  assert.deepEqual(parseTicketTopic(openTopic), {
    guildId: "111111111111111111",
    openerId: "222222222222222222",
    status: "open",
  });
  assert.equal(
    findOpenTicketForOpener(
      [
        { topic: buildTicketTopic("111111111111111111", "222222222222222222", "closed") },
        { topic: buildTicketTopic("999999999999999999", "222222222222222222") },
        { topic: openTopic },
      ],
      "111111111111111111",
      "222222222222222222",
    )?.topic,
    openTopic,
  );
  assert.equal(parseTicketTopic("not-a-ticket"), null);
});

test("ticket permissions grant access only to opener, staff, and bot while denying everyone", () => {
  const overwrites = buildTicketPermissionOverwrites({
    everyoneRoleId: "111111111111111111",
    openerId: "222222222222222222",
    staffRoleId: "333333333333333333",
    botUserId: "444444444444444444",
  });
  const byId = (id: string) => overwrites.find((overwrite) => overwrite.id === id);
  const has = (
    id: string,
    permission: bigint,
    mode: "allow" | "deny" = "allow",
  ) =>
    new PermissionsBitField(byId(id)?.[mode] ?? []).has(permission);
  assert.ok(has("111111111111111111", PermissionFlagsBits.ViewChannel, "deny"));
  for (const id of ["222222222222222222", "333333333333333333"]) {
    assert.ok(has(id, PermissionFlagsBits.ViewChannel));
    assert.ok(has(id, PermissionFlagsBits.SendMessages));
  }
  assert.ok(has("444444444444444444", PermissionFlagsBits.ManageChannels));
  assert.equal(overwrites.length, 4);
});