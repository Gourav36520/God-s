import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EmbedBuilder } from "discord.js";
import { buildLevelingAnnouncementPayload } from "./rankUpAnnouncement.js";

describe("leveling announcement message payload", () => {
  it("keeps class and level promotions above the card in one embed", () => {
    const payload = buildLevelingAnnouncementPayload({
      userId: "123456789",
      previousLevel: 1,
      currentLevel: 2,
      previousClass: "Poor Class",
      currentClass: "Middle Poor",
      accumulatedXp: 20_800n,
      progressBar: "🟨🟨🟨⬛⬛⬛⬛⬛⬛⬛ 35%",
      card: Buffer.from("card image"),
    });
    const embed = payload.embeds?.[0];
    assert.ok(embed instanceof EmbedBuilder);
    const serializedEmbed = embed.toJSON();

    assert.equal(payload.content, undefined);
    assert.equal(payload.embeds?.length, 1);
    assert.equal(
      serializedEmbed.title,
      "💰 MONEY UP!",
    );
    assert.equal(
      serializedEmbed.description,
      [
        "━━━━━━━━━━━━━━",
        "",
        "🎉 <@123456789> has ranked up!",
        "📈 Level: 1 ➜ 2",
        "Poor Class ➜ Middle Poor",
        "",
        "💸 Money: 20.8K",
        "📊 Money Progress: 🟨🟨🟨⬛⬛⬛⬛⬛⬛⬛ 35%",
        "",
        "Keep earning and climb to the next rank! 🚀",
        "",
        "━━━━━━━━━━━━━━",
      ].join("\n"),
    );
    assert.equal(serializedEmbed.image?.url, "attachment://money-123456789.png");
    assert.equal(payload.files?.length, 1);
  });

  it("uses a level title when only the numeric level changes", () => {
    const payload = buildLevelingAnnouncementPayload({
      userId: "123456789",
      previousLevel: 16,
      currentLevel: 17,
      previousClass: "Infinity",
      currentClass: "Infinity",
      accumulatedXp: 250n,
      progressBar: "🟨⬛⬛⬛⬛⬛⬛⬛⬛⬛ 10%",
      card: Buffer.from("card image"),
    });
    const embed = payload.embeds?.[0];
    assert.ok(embed instanceof EmbedBuilder);
    assert.equal(embed.toJSON().title, "📈 LEVEL UP!");
    assert.match(embed.toJSON().description ?? "", /Level: 16 ➜ 17/);
  });
});
