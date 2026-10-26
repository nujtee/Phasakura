import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dataUrlToBlob, isInApp, isIos } from "../../src/client/media/SaveImage.tsx";

describe("save QR image: which way for which phone", () => {
  it("knows the in-app browsers (downloads go nowhere there) and iPhone / iPad", () => {
    const iphoneLine = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.10.0";
    const androidFb = "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0;]";
    const androidChrome = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
    const iphoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    assert.equal(isInApp(iphoneLine), true);
    assert.equal(isInApp(androidFb), true);
    assert.equal(isInApp(androidChrome), false);
    assert.equal(isInApp(iphoneSafari), false);
    assert.equal(isIos(iphoneSafari), true);
    assert.equal(isIos(androidChrome), false);
  });

  it("turns the drawn QR (data URL) into an image file", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,iVBORw0KGgo=")!;
    assert.equal(blob.type, "image/png");
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(dataUrlToBlob(null), null);
    assert.equal(dataUrlToBlob("https://example.test/qr.png"), null);
  });
});
