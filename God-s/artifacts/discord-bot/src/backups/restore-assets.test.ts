import assert from "node:assert/strict";
import test from "node:test";
import { normalizeArchivedMessageAssets } from "./restore-service.js";

test("archived message assets are mapped to the restore attachment shape", () => {
  const data = Buffer.from("durable attachment bytes");
  const assets = normalizeArchivedMessageAssets([
    {
      messageId: "original-message-id",
      partIndex: 0,
      fileName: "document.txt",
      data,
    },
  ]);

  assert.equal(assets.length, 1);
  assert.equal(assets[0].resourceType, "message_attachment");
  assert.equal(assets[0].sourceId, "original-message-id");
  assert.equal(assets[0].partIndex, 0);
  assert.equal(assets[0].fileName, "document.txt");
  assert.deepEqual(assets[0].data, data);
});
