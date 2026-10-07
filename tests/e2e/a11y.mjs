// Small in-page accessibility audit (spec §57) — no axe-core available offline, so the checks that
// matter most are done directly: alt text, accessible names, labels, headings, landmarks, duplicate
// ids, lang, and WCAG AA colour contrast of visible text.
export async function audit(page, opts = {}) {
  return page.evaluate((opts) => {
    const issues = [];
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      // visually-hidden (clip) helpers are for screen readers only
      if (s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath === "inset(50%)") return false;
      return true;
    };
    const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""} "${(el.textContent || "").trim().slice(0, 40)}"`;
    const inertOrHidden = (el) => !!el.closest("[aria-hidden=true], [inert], dialog:not([open])");
    const name = (el) => {
      const lb = el.getAttribute("aria-labelledby");
      if (lb) return lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      const al = el.getAttribute("aria-label");
      if (al && al.trim()) return al.trim();
      if (el.labels && el.labels.length) return [...el.labels].map((l) => l.textContent).join(" ").trim();
      const text = [...el.childNodes].map((n) => (n.nodeType === 3 ? n.textContent : n.nodeType === 1 && !n.closest("[aria-hidden=true]") ? (n.tagName === "IMG" ? n.getAttribute("alt") || "" : n.textContent) : "")).join("").trim();
      if (text) return text;
      return (el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
    };

    if (!document.documentElement.lang) issues.push("html: no lang");

    for (const img of document.querySelectorAll("img")) {
      if (inertOrHidden(img)) continue;
      if (!img.hasAttribute("alt")) issues.push(`img without alt: ${img.getAttribute("src")?.slice(0, 60)}`);
    }
    for (const el of document.querySelectorAll("button, a[href], [role=button], [role=link], [role=tab], [role=switch]")) {
      if (inertOrHidden(el) || !visible(el)) continue;
      if (!name(el)) issues.push(`no accessible name: ${describe(el)}`);
    }
    for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
      if (inertOrHidden(el) || !visible(el)) continue;
      if (!name(el)) issues.push(`form control without label: ${describe(el)} ${el.outerHTML.slice(0, 80)}`);
    }
    const ids = new Map();
    for (const el of document.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) || 0) + 1);
    for (const [id, n] of ids) if (n > 1) issues.push(`duplicate id: ${id}`);

    const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((h) => !inertOrHidden(h) && !h.closest("dialog"));
    const h1 = headings.filter((h) => h.tagName === "H1");
    if (h1.length !== 1) issues.push(`expected one h1, found ${h1.length}`);
    let prev = 0;
    for (const h of headings) {
      const level = Number(h.tagName[1]);
      if (prev && level > prev + 1) issues.push(`heading level skipped: h${prev} → ${describe(h)}`);
      prev = level;
    }
    if (!document.querySelector("main, [role=main]")) issues.push("no main landmark");
    if (!opts.admin) {
      if (!document.querySelector("header, [role=banner]")) issues.push("no header landmark");
      if (!document.querySelector("footer, [role=contentinfo]")) issues.push("no footer landmark");
    }
    const navs = document.querySelectorAll("nav");
    if (navs.length > 1) for (const n of navs) if (!n.getAttribute("aria-label") && !n.getAttribute("aria-labelledby")) issues.push(`unlabelled nav (one of ${navs.length})`);

    // Colour contrast (WCAG AA): text over a solid background.
    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const background = (el) => {
      const layers = [];
      for (let n = el; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.backgroundImage !== "none" && !/gradient/.test(s.backgroundImage)) return null; // text on a photo: not measurable
        if (/gradient/.test(s.backgroundImage)) return null;
        const c = parse(s.backgroundColor);
        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      }
      let out = { r: 255, g: 255, b: 255, a: 1 };
      for (const l of layers.reverse()) out = blend(l, out);
      return out;
    };
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let checked = 0;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent.trim()) continue;
      const el = t.parentElement;
      if (!el || seen.has(el) || inertOrHidden(el) || !visible(el)) continue;
      if (el.closest("svg, option, script, style, noscript")) continue;
      // Inside an <img>-like overlay (hero text over photos) the background is an image.
      if (el.closest("[data-contrast-skip]")) continue;
      seen.add(el);
      const s = getComputedStyle(el);
      if (el.closest("button:disabled, input:disabled, [aria-disabled=true]")) continue; // WCAG exempts inactive controls
      const fg = parse(s.color);
      const bg = background(el);
      if (!fg || !bg) continue;
      const color = fg.a < 1 ? blend(fg, bg) : fg;
      const L1 = lum(color), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const need = large ? 3 : 4.5;
      checked++;
      if (ratio + 0.01 < need) issues.push(`contrast ${ratio.toFixed(2)} < ${need}: ${describe(el)} (${s.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}))`);
    }
    if (checked < 5) issues.push(`contrast: only ${checked} text elements measured`);
    return [...new Set(issues)];
  }, opts);
}

/** Tab through the page: every focused element shows a visible focus indicator. */
export async function focusRing(page, steps = 12) {
  const missing = [];
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== "none");
      return { ring, what: `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}` };
    });
    if (r && !r.ring) missing.push(r.what);
  }
  return missing;
}
