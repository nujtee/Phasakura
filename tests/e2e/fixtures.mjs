// Test images for the browser suites, drawn in Chromium (no image library needed): photographic-ish
// gradients with noise, so the browser-side compression of Phase 12 sees realistic multi-MB PNGs.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const IMAGES = [
  // name, width, height, colour A, colour B, label, noise
  ["slide.png", 1600, 800, "#3b6b3a", "#3b6b3a", "Hero slide", false],
  ["g1.png", 900, 600, "#b0476b", "#b0476b", "Gallery 1", false],
  ["g2.png", 600, 900, "#35556f", "#35556f", "Gallery 2", false],
  ["logo.png", 480, 160, "#1f4d3a", "#1f4d3a", "LOGO", false],
  ["hero-a.png", 3000, 1500, "#2f5d50", "#c9a66b", "Morning mist", true],
  ["hero-b.png", 2400, 1200, "#35556f", "#e0b7c6", "Sakura season", true],
  ["hero-m.png", 900, 1400, "#35556f", "#e0b7c6", "Mobile", true],
  ["g-wide.png", 2000, 1200, "#b0476b", "#f2c38b", "Valley", true],
  ["g-tall.png", 1000, 1500, "#1f4d3a", "#9cc5a1", "Pine", true],
  ["g-sq.png", 1400, 1400, "#4b3f72", "#f6b26b", "Lantern", true],
  ["food.png", 1600, 1200, "#8a3b12", "#f3d29b", "Grilled fish", true],
  ["story.png", 2000, 1333, "#5b4636", "#d7c4a3", "1967", true],
];

export async function makeFixtures(dir, launch) {
  mkdirSync(dir, { recursive: true });
  const todo = IMAGES.filter(([name]) => !existsSync(join(dir, name)));
  if (!todo.length) return;
  const browser = await launch();
  const page = await browser.newPage();
  for (const [name, w, h, a, b, text, noise] of todo) {
    const base64 = await page.evaluate(async ({ w, h, a, b, text, noise }) => {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, a); grad.addColorStop(1, b);
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      if (noise) {
        const img = g.getImageData(0, 0, w, h);
        let seed = 12345;
        for (let i = 0; i < img.data.length; i += 4) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const n = ((seed >> 16) % 60) - 30;
          img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
        }
        g.putImageData(img, 0, 0);
      }
      g.fillStyle = "#fff"; g.font = `${Math.round(h / 6)}px sans-serif`; g.textAlign = "center";
      g.fillText(text, w / 2, h * 0.55);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, { w, h, a, b, text, noise });
    writeFileSync(join(dir, name), Buffer.from(base64, "base64"));
  }
  await browser.close();
}
