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

## Release (deploy) — GitHub Actions เท่านั้น (เฟส C1)

Push / merge เข้า `main` = แค่ CI (ทดสอบ) **ไม่ขึ้นเว็บใด** — ปล่อยจริงด้วย GitHub → **Actions → Release → Run workflow**

| ช่อง | ค่า |
|---|---|
| Branch, tag or commit | `main` (หรือ commit ที่ต้องการ) |
| Sites | `all` หรือ slug คั่นด้วยเว้นวรรค เช่น `chomkhao cherngdoi` |

ลำดับต่อเว็บ: preflight → จด **D1 Time Travel bookmark** (จุดย้อนกลับ อยู่ในหน้า summary ของ run) → migrate → deploy → smoke test (ลอง 3 ครั้ง)
เว็บเรียงเป็นรอบตาม `wave` ใน `sites/sites.json` — รอบ 1 (เว็บที่คนใช้น้อย) ก่อน, รอบถัดไปเริ่มเมื่อรอบก่อนผ่านครบทุกเว็บ;
เว็บใดล้ม run หยุด เว็บที่ปล่อยไปแล้วอยู่บน version ใหม่ (migration เป็นแบบเพิ่ม โค้ดเก่า / ใหม่ใช้ฐานเดียวกันได้)

**ย้อนกลับ**: โค้ด `npx wrangler rollback --config <config ของเว็บนั้น>`; ข้อมูล `npx wrangler d1 time-travel restore <slug>-db --bookmark=<จาก summary>`

**ตั้งค่าครั้งเดียว**

1. Cloudflare → My Profile → API Tokens → Create Token → template **Edit Cloudflare Workers** → เพิ่ม Permission
   **Account › D1 › Edit** → Account Resources: บัญชีของแพลตฟอร์ม, Zone Resources: All zones → Create → คัด token
2. GitHub → repo → Settings → Secrets and variables → Actions → New repository secret:
   `CLOUDFLARE_API_TOKEN` (token ข้อ 1) และ `CLOUDFLARE_ACCOUNT_ID` (เลขบัญชีใน URL ของ Cloudflare dashboard)
3. (แนะนำ) GitHub → Settings → Environments → `production-wave-2` → Wait timer 30 นาที หรือ Required reviewers —
   ได้เวลาดูรอบ 1 ก่อนรอบ 2 เริ่ม (environment ถูกสร้างเองตอน run ครั้งแรก)
4. Run Release กับ `chomkhao cherngdoi` (ยังไม่มีการจอง) ให้ผ่านก่อน แล้วค่อย `all`
5. **ปิด Workers Builds ทุกเว็บ** (Cloudflare → Workers & Pages → <worker> → Settings → Builds → Disconnect) —
   ไม่งั้น push `main` จะ deploy Phasakura เองโดยไม่ migrate; Chomkhao / Cherngdoi ตัดการเชื่อมกับ repo เดิม
   แล้ว archive `nujtee/Chomkhao`, `nujtee/Cherngdoi` (GitHub → Settings → Archive)

ระหว่างยังไม่ได้ตั้งค่าข้างบน ใช้คำสั่งจากเครื่องตัวเองได้: `npm run site -- <slug> migrate && npm run site -- <slug> deploy`

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

## สิทธิ์ CENTER (เฟส C2)

Center Management สั่งเว็บได้ผ่าน `/api/center/*` เท่านั้น ด้วยคำขอที่ **เซ็นด้วย Ed25519** (`src/shared/center-protocol.ts`)
ไม่ใช่ผู้ใช้ในตาราง `users` ของเว็บ — admin ของเว็บลบหรือแก้สิทธิ์นี้ไม่ได้

- เว็บถือแค่ **public key** ใน var `CENTER_PUBLIC_KEYS` (`{"<keyId>":"<base64url 32 ไบต์>"}` — ไม่ใช่ความลับ, อยู่ใน `wrangler.jsonc`
  แล้ว `npm run sites:generate`); private key อยู่ที่ Center เท่านั้น (C4). **ว่าง = ไม่มี Center API (404)** ซึ่งเป็นค่าตอนนี้
- ลายเซ็นครอบ: method, host ของเว็บปลายทาง (คำขอที่เซ็นให้ chomkhao.com ใช้กับ phasakura.com ไม่ได้), path+query, เวลา, nonce,
  ผู้ส่งใน Center (`X-Center-Actor`: id, email, role `PLATFORM_OWNER`/`OPERATOR`/`SUPPORT_READONLY`, reason) และ sha256 ของ body
- เวลาต้องห่างนาฬิกาเว็บไม่เกิน 60 วินาที; nonce ใช้ได้ครั้งเดียว (ตาราง `center_nonces`, migration 0030, cron ล้างทุก 5 นาที)
- ทุกครั้งที่ปฏิเสธ → Security events `CENTER_REQUEST_REFUSED` (เหตุผล เช่น `BAD_SIGNATURE`, `CLOCK_SKEW`, `REPLAYED_NONCE`) ตอบ 401
- อ่าน: `GET /api/center/hello` (เว็บไหน, API version, schema, พักอยู่ไหม), `GET /api/center/status` (= หน้า System status),
  `GET /api/center/users` (บัญชีของเว็บเอง ไม่มี hash รหัสผ่าน), `GET /api/center/suspension`

### คำสั่งแก้ข้อมูลและ SSO (เฟส C3, migration 0031)

ทุกคำสั่งที่แก้ข้อมูล **ต้องมีเหตุผล** (`reason` ใน `X-Center-Actor`) และถูกบันทึกใน **Audit logs ของเว็บ** ในชื่อ "Center · อีเมล"
พร้อม role, key และเหตุผล (batch เดียวกับการเปลี่ยนแปลง)

| คำสั่ง | Role ใน Center | ผล |
|---|---|---|
| `POST /api/center/sso` | ทุก role | ตั๋วใช้ครั้งเดียว อายุ 60 วินาที → browser ของคนใน Center โพสต์ฟอร์ม `ticket=…` ไปที่ `POST /api/center/sso/consume` → session หลังบ้าน **2 ชั่วโมง** แล้วไป `/admin` |
| `POST /api/center/sessions/revoke` `{actorId?}` | PLATFORM_OWNER, OPERATOR | ตัด session ของ Center user คนนั้น (หรือทั้งหมด) และตั๋วที่ยังไม่ใช้ |
| `PUT /api/center/suspension` `{suspended, note?}` | PLATFORM_OWNER | **พักเว็บได้เฉพาะกรณีค้างค่าบริการ** (`UNPAID_FEES` — ฐานข้อมูลรับค่าอื่นไม่ได้): แขกจองใหม่ไม่ได้ (423 `SITE_SUSPENDED`), หน้าเว็บ / การจองเดิม / สลิป / หลังบ้าน / export ใช้ได้ตามปกติ, หน้า System status ของเจ้าของขึ้นสีแดงพร้อมเหตุผล |

**Center user ในเว็บ** = แถวใน `users` ที่ id ขึ้นต้นด้วย `center_` (สร้างโดย Center API เท่านั้น):
PLATFORM_OWNER / OPERATOR = SUPER_ADMIN, SUPPORT_READONLY = สิทธิ์ `*.view` ทั้งหมดเท่านั้น (ปรับตาม role ทุกครั้งที่เข้า)
admin ของเว็บ **มองไม่เห็นและแก้ไม่ได้** (ไม่อยู่ในรายชื่อ, 404, ไม่นับเป็น SUPER_ADMIN ของเว็บ — trigger กันลบ SUPER_ADMIN คนสุดท้ายของเว็บ
ไม่นับ Center), เข้าด้วยรหัสผ่านไม่ได้, ไม่ได้รับอีเมล / LINE แจ้งเตือน
- เปลี่ยน key: ใส่ key ใหม่คู่ key เก่า (keyId ต่างกัน) → Release → ให้ Center ใช้ key ใหม่ → เอา key เก่าออก → Release

## สิ่งที่ห้ามมีในโค้ด

ชื่อหรือโดเมนของเว็บใดเว็บหนึ่งในโค้ดที่ผู้ใช้เห็น — ใช้ `src/shared/site-name.ts` (ชื่อจากโดเมนของเว็บเอง เช่น
ชื่อไฟล์รายงาน `chomkhao-revenue-….xlsx`, User-Agent, ตัวอย่างอีเมล `booking@<โดเมน>`) และข้อมูลใน D1 (ชื่อเว็บ, โลโก้, ข้อความ)
ส่วนตัวระบุภายใน เช่น header `X-Requested-With: phasakura` และชื่อ key ใน localStorage คงไว้ (แยกตามโดเมนอยู่แล้ว)
