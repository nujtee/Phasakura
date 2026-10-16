# Sites — one codebase, every booking site

ทุกเว็บจองที่พัก (Phasakura, Chomkhao, Cherngdoi และเว็บที่จะเพิ่ม) ใช้โค้ดชุดเดียวใน repo นี้ (Center Management เฟส C0)
แต่ละเว็บมีเจ้าของ โดเมน Worker D1 R2 และ secret ของตัวเอง — ข้อมูลไม่ปนกัน

| ไฟล์ | คืออะไร | แก้เมื่อไร |
|---|---|---|
| `sites/sites.json` | ทะเบียนเว็บ: slug, ชื่อ, โดเมน, D1, ช่วงเลข rate limit, รอบ release (`wave`) | เพิ่มเว็บ / เปลี่ยนค่าของเว็บนั้น |
| `wrangler.jsonc` | config ของ **Phasakura** และเป็น **ต้นแบบ** ของทุกเว็บ (cron, assets, observability, compatibility date…) | เปลี่ยนค่าที่ใช้ร่วมกันทุกเว็บ |
| `sites/<slug>/wrangler.jsonc` | config ของเว็บอื่น — **สร้างอัตโนมัติ** จากสองไฟล์ข้างบน | ห้ามแก้เอง: `npm run sites:generate` |

`npm run check` (และ CI) ล้มถ้า config ที่สร้างไว้ไม่ตรงกับทะเบียน / ต้นแบบ — กันไม่ให้เว็บใดค่าตั้งเพี้ยนไปเอง

## คำสั่ง

```bash
npm run sites:generate                  # หลังแก้ wrangler.jsonc หรือ sites/sites.json
npm run site -- chomkhao preflight      # ตรวจ config ของเว็บนั้น
npm run site -- chomkhao migrations     # migration ที่ apply แล้ว / ค้าง (remote)
npm run site -- chomkhao backup         # Time Travel bookmark + export D1
npm run site -- chomkhao migrate        # backup แล้ว apply migration ที่ค้าง
npm run site -- chomkhao deploy         # preflight + build + wrangler deploy
npm run site -- chomkhao smoke          # smoke test https://chomkhao.com
npm run site -- all migrations          # ทุกเว็บ เรียงตาม wave (1 ก่อน) หยุดที่เว็บแรกที่ล้ม
```

คำสั่งเดิมของ Phasakura (`npm run deploy`, `npm run db:migrate:remote`, `npm run preflight`…) ยังใช้ได้เหมือนเดิม

## Deploy ตอนนี้ (ระหว่างเฟส C0 → C1)

| เว็บ | Deploy จาก | หมายเหตุ |
|---|---|---|
| Phasakura | Workers Builds ← repo นี้ (`main`, `npx wrangler deploy`) | เหมือนเดิม |
| Chomkhao | Workers Builds ← `nujtee/Chomkhao` | ยังไม่ย้าย — **ห้ามแก้โค้ดใน repo นั้นแล้ว** |
| Cherngdoi | Workers Builds ← `nujtee/Cherngdoi` | ยังไม่ย้าย — **ห้ามแก้โค้ดใน repo นั้นแล้ว** |

เฟส C1 ย้ายการ deploy ทุกเว็บมาที่ GitHub Actions จาก repo นี้ (backup → migrate → deploy → smoke เป็นรอบตาม `wave`)
แล้วตัด Workers Builds ของ Chomkhao / Cherngdoi ออก จนกว่าจะถึงตอนนั้น ถ้าต้องการให้สองเว็บนั้นได้โค้ดใหม่
ให้ deploy เองจาก repo นี้: `npm run site -- chomkhao migrate && npm run site -- chomkhao deploy`

## เพิ่มเว็บใหม่ (จนกว่า `site:create` ในเฟส C7 จะทำให้อัตโนมัติ)

1. เจ้าของย้าย zone โดเมนเข้าบัญชี Cloudflare ของแพลตฟอร์ม (zone ต้อง Active และยังไม่มี CNAME ของ apex / www)
2. สร้างทรัพยากร:
   ```bash
   npx wrangler d1 create <slug>-db --location=apac
   npx wrangler r2 bucket create <slug>-media-public
   npx wrangler r2 bucket create <slug>-media-private
   ```
3. เพิ่มเว็บใน `sites/sites.json` (D1 id จากข้อ 2, `rateLimitBase` เป็นพันที่ยังไม่มีใครใช้ รวม `reservedRateLimitBases`, `wave: 1`)
4. `npm run sites:generate && npm run site -- <slug> preflight` → 0 error
5. `npm run site -- <slug> migrate`
6. SUPER_ADMIN ของเจ้าของ:
   ```bash
   npm run admin:bootstrap -- --email owner@<domain> --name "Owner" --database <slug>-db --out bootstrap.sql
   npx wrangler d1 execute <slug>-db --remote --file bootstrap.sql --config sites/<slug>/wrangler.jsonc
   rm bootstrap.sql
   ```
7. ตั้ง secret ของเว็บนั้น (`npx wrangler secret put <NAME> --config sites/<slug>/wrangler.jsonc`) ตาม docs/PRODUCTION.md ข้อ 4
8. `npm run site -- <slug> deploy && npm run site -- <slug> smoke`
9. Commit `sites/sites.json` และ `sites/<slug>/wrangler.jsonc`

## สิ่งที่ห้ามมีในโค้ด

ชื่อหรือโดเมนของเว็บใดเว็บหนึ่งในโค้ดที่ผู้ใช้เห็น — ใช้ `src/shared/site-name.ts` (ชื่อจากโดเมนของเว็บเอง เช่น
ชื่อไฟล์รายงาน `chomkhao-revenue-….xlsx`, User-Agent, ตัวอย่างอีเมล `booking@<โดเมน>`) และข้อมูลใน D1 (ชื่อเว็บ, โลโก้, ข้อความ)
ส่วนตัวระบุภายใน เช่น header `X-Requested-With: phasakura` และชื่อ key ใน localStorage คงไว้ (แยกตามโดเมนอยู่แล้ว)
