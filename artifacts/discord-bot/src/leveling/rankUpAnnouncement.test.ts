import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EmbedBuilder } from "discord.js";
import { buildMoneyRankUpPayload } from "./rankUpAnnouncement.js";

describe("Money rank-up message payload", () => {
  it("keeps the complete announcement above the card in one embed", () => {
    const payload = buildMoneyRankUpPayload({
      userId: "123456789",
      previousClass: "Poor Class",
      currentClass: "Middle Poor",
      recentXp: 20_800n,
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
});
