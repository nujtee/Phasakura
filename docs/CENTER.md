# Center Management — `center.phasakura.com`

คอนโซลกลางของแพลตฟอร์ม (เฟส C4): Worker `center` + D1 `center-db` ของตัวเอง, โค้ดอยู่ใน repo นี้ (`src/center/`),
config `center/wrangler.jsonc` **generate จาก `sites/sites.json`** (`npm run sites:generate`) — ห้ามแก้เอง

- Center ไม่เก็บข้อมูลแขก: อ่าน / สั่งแต่ละเว็บผ่าน `/api/center/*` ที่เซ็นด้วย Ed25519 เท่านั้น (`docs/SITES.md` หัวข้อสิทธิ์ CENTER)
- เรียกเว็บผ่าน **service binding** (`SITE_<SLUG>`) — ไม่ออกอินเทอร์เน็ต, ไม่ติด Bot Fight Mode; เพิ่มเว็บใน registry แล้ว generate + Release Center
- หน้าเว็บ render ฝั่ง server ทั้งหมด ไม่มี JavaScript ยกเว้นหน้าส่งต่อ SSO (สคริปต์บรรทัดเดียว อนุญาตด้วย hash ใน CSP)

## ติดตั้งครั้งแรก (ทำครั้งเดียว ตามลำดับ)

1. **Release** (Actions → Release, `sites` = `center` หรือ `all`) — migrate `center-db`, deploy, สร้าง Custom Domain `center.phasakura.com`,
   smoke test `GET /healthz`
2. **Actions → Center setup → task = `keys`** — สร้าง key คู่ใหม่: private key ไปเป็น secret `CENTER_SIGNING_KEY` ของ Worker `center`
   ทันที (ไม่แสดงที่ไหนเลย), summary แสดง **public key** (JSON) → ใส่ใน `wrangler.jsonc` → `vars.CENTER_PUBLIC_KEYS` →
   `npm run sites:generate` → Release ทุกเว็บ (Claude ทำขั้นนี้ให้ได้)
3. **Actions → Center setup → task = `first-owner`** (email, name) — PLATFORM_OWNER คนแรก (ทำได้เฉพาะตอน Center ยังไม่มีผู้ใช้);
   summary แสดงลิงก์ตั้งรหัสผ่านใช้ครั้งเดียว อายุ 48 ชั่วโมง
4. เปิดลิงก์ → ตั้งรหัสผ่าน (≥ 12 ตัว) → เข้า Center → **ผู้ใช้ Center** → เพิ่ม PLATFORM_OWNER คนที่สอง

## ใช้งาน

| หน้า | ใคร | ทำอะไร |
|---|---|---|
| เว็บทั้งหมด | ทุกบทบาท | สถานะแต่ละเว็บ (ออนไลน์ / ฐานข้อมูล / พักอยู่) + **เข้าหลังบ้าน** (ต้องใส่เหตุผล → ตั๋ว SSO 60 วินาที → session หลังบ้าน 2 ชม.) |
| ผู้ใช้ Center | PLATFORM_OWNER | เพิ่มคน (ลิงก์ตั้งรหัสผ่าน 48 ชม. แสดงครั้งเดียว), เปลี่ยนบทบาท, ปิด / เปิดบัญชี, ลิงก์ตั้งรหัสผ่านใหม่ (24 ชม.) — เปลี่ยนบทบาทหรือปิดบัญชี = ออกจากหลังบ้านทุกเว็บทันที |
| ตั้งค่า | PLATFORM_OWNER | กลุ่ม LINE สำหรับแจ้งเตือน, เปิด / ปิดแต่ละประเภท, ส่งข้อความทดสอบ |
| บันทึกการใช้งาน | ทุกบทบาท | 300 รายการล่าสุด: ใคร ทำอะไร เว็บไหน เพราะอะไร (append-only, ลบ / แก้ไม่ได้) |
| บัญชีของฉัน | ทุกบทบาท | เปลี่ยนรหัสผ่าน (session อื่นออกทั้งหมด) |

บทบาท: **เจ้าของแพลตฟอร์ม** (ทุกอย่าง รวมพักเว็บในเฟส C6) · **ผู้ดูแลระบบ** (เข้าหลังบ้านแบบ SUPER_ADMIN) ·
**ซัพพอร์ต** (เข้าหลังบ้านแบบดูอย่างเดียว) — ต้องมีเจ้าของแพลตฟอร์มที่ใช้งานได้อย่างน้อย 1 คนเสมอ (trigger ในฐานข้อมูล)

ความปลอดภัย: ผิดรหัส 5 ครั้ง = ล็อก 15 นาที, session 8 ชม. / ไม่ใช้งาน 1 ชม. ออกเอง, cookie `__Host-csid` (HttpOnly, Secure,
SameSite=Strict), ทุก POST ต้องมาจาก origin ของ Center, CSP `default-src 'none'`, ไม่มี Workers.dev / preview URL
ยังไม่มี: 2FA (เฟส C9)

## สุขภาพเว็บและการแจ้งเตือน LINE (เฟส C5)

Center ตรวจทุกเว็บ **ทุก 5 นาที** (cron ของ Worker `center`) ผ่าน `/api/center/status` ของแต่ละเว็บ แล้วเก็บผล 14 วัน
(หน้าเว็บทั้งหมด = ผลล่าสุด, กดชื่อเว็บ = ประวัติ 8 ชั่วโมง + ประวัติการแจ้งเตือน, ปุ่ม "ตรวจตอนนี้")

| ประเภท | เมื่อไร |
|---|---|
| เว็บล่ม / ติดต่อไม่ได้ | เรียกไม่ถึง, ตอบไม่ใช่ 200, หรือฐานข้อมูลใช้ไม่ได้ |
| ฐานข้อมูลไม่ตรงกับโค้ด | `/api/health` ของเว็บ schema = outdated |
| cron หยุด | cron ของเว็บไม่ทำงานเกิน 5 นาที |
| error ของเซิร์ฟเวอร์สูง | ≥ 5 ครั้งใน 24 ชม. |
| การตั้งค่าผิดพลาด | ข้อในหน้า System status ของเว็บที่เป็นสีแดง (เช่น ไม่มีบัญชีรับเงินหลัก) |
| กลับมาปกติ | ปัญหาที่แจ้งไปแล้วหายไป (พร้อมระยะเวลา) |

กติกา: ต้องเห็นปัญหา **2 รอบติดกัน** (~10 นาที) จึงแจ้ง · แจ้งครั้งเดียวต่อปัญหา · ทุกเหตุการณ์ในรอบเดียวรวมเป็น LINE ข้อความเดียว ·
ทุกเหตุการณ์ถูกบันทึก (ส่งแล้ว / ไม่ส่งเพราะปิดประเภทนั้น / ยังไม่เลือกกลุ่ม / ไม่มี token / LINE ไม่รับ)

### ตั้งค่า LINE ของ Center (ครั้งเดียว)

1. LINE Developers → Provider เดิมหรือใหม่ → **Create a Messaging API channel** (= LINE Official Account ใหม่ ชื่อเช่น "Phasakura Center")
2. LINE Official Account Manager → ตั้งค่า → **อนุญาตให้บอทเข้าร่วมแชทกลุ่ม** (Allow bot to join group chats) และปิดข้อความตอบกลับอัตโนมัติ
3. Messaging API → **Channel access token (long-lived)** → Issue · Basic settings → **Channel secret**
4. Cloudflare → Workers & Pages → **center** → Settings → Variables and Secrets → เพิ่ม **Secret** 2 ตัว:
   `CENTER_LINE_TOKEN` (access token) และ `CENTER_LINE_SECRET` (channel secret)
5. Messaging API → **Webhook URL** = `https://center.phasakura.com/line/webhook` → Verify → เปิด **Use webhook**
6. เชิญบอทเข้ากลุ่ม LINE ที่จะรับแจ้งเตือน → Center → **ตั้งค่า** → เลือกกลุ่ม → บันทึก → **ส่งข้อความทดสอบ**

## หน้าเว็บแต่ละเว็บ (เฟส C6)

กดชื่อเว็บในหน้า "เว็บทั้งหมด" ข้อมูลในหน้านี้อ่านจากเว็บโดยตรงผ่าน service binding และลงลายเซ็นทุกครั้ง

- **หลังบ้าน:** ใส่เหตุผลแล้วกด "เข้าหลังบ้าน" (SSO 2 ชั่วโมง)
- **การให้บริการ:** เจ้าของแพลตฟอร์มเท่านั้นที่พัก / เปิดเว็บได้ และทำได้เฉพาะกรณีค้างค่าบริการ ต้องติ๊กยืนยันและใส่เหตุผลทุกครั้ง
  - ระหว่างพัก แขกจองใหม่ไม่ได้ (เว็บตอบ 423) ส่วนหน้าเว็บ การจองเดิม สลิป และหลังบ้านใช้ได้ตามปกติ
- **ผู้ดูแลของเว็บ:** รายชื่อ admin ของเว็บ (ไม่รวมบัญชี "Center · …") ดูได้อย่างเดียว ส่วนการเพิ่มหรือแก้ผู้ใช้ทำในหลังบ้านของเว็บ
- **ตัด session ของ Center:** สำหรับเจ้าของแพลตฟอร์มและผู้ดูแลระบบ ทำให้ทุกคนที่เข้าหลังบ้านเว็บนี้จาก Center ออกจากระบบ และยกเลิกตั๋ว SSO ที่ค้างอยู่ admin ของเว็บเองไม่ถูกกระทบ
- **ผลตรวจ 8 ชั่วโมงล่าสุด และประวัติการแจ้งเตือน LINE**

- **เจ้าของเว็บ** (เฟส C7) เจ้าของแพลตฟอร์มเห็นการ์ดนี้เมื่อเว็บยังไม่มีผู้ดูแล หรือผู้ดูแลคนเดียวยังไม่เคยเข้าใช้
  - ใส่อีเมล ชื่อ และเหตุผล → ได้บัญชี SUPER_ADMIN และลิงก์ตั้งรหัสผ่าน (72 ชั่วโมง)
  - ลิงก์แสดงครั้งเดียว Center ไม่เก็บไว้ ให้ส่งให้เจ้าของทางช่องทางส่วนตัว
  - ถ้าลิงก์หายหรือหมดอายุ ให้กด "สร้างลิงก์ใหม่" ลิงก์เดิมจะใช้ไม่ได้
  - หลังเจ้าของเข้าใช้แล้ว การเพิ่มผู้ใช้ให้ทำในหลังบ้านของเว็บ
  - วิธีเพิ่มเว็บใหม่ทั้งหมดอยู่ใน `docs/SITES.md`

ทุกคำสั่งบันทึกทั้งใน "บันทึกการใช้งาน" ของ Center และใน Audit logs ของเว็บนั้น ถ้าเว็บติดต่อไม่ได้ หน้านี้ยังเปิดได้และบอกสาเหตุ ส่วนคำสั่งที่ไม่สำเร็จจะถูกบันทึกว่าล้มเหลว

## Release และสำรองข้อมูลจาก Center (เฟส C8)

### Release

เมนู **Release** แสดง run ล่าสุดของ GitHub Actions → Release สถานะเป็น กำลังทำ / รออนุมัติ / สำเร็จ / ไม่สำเร็จ พร้อมลิงก์ไปหน้า run

- **เจ้าของแพลตฟอร์ม** เลือกเว็บ (หรือ "ทุกเว็บ + Center") ใส่เหตุผล แล้วกด **เริ่ม Release**
- Center สั่ง GitHub ให้รัน workflow Release บน `main` โดยชื่อ run จะเป็น `Release <เว็บ> — <อีเมล>: <เหตุผล>`
- ขั้นตอนจริงยังอยู่ใน GitHub Actions เหมือนเดิม: preflight → จุดย้อนกลับ D1 → migrate → deploy → smoke test

**ตั้งค่าครั้งเดียว (ทำเอง ห้ามวาง token ในแชต):**
1. GitHub → รูปโปรไฟล์ → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
   - **Token name:** `center-release`
   - **Expiration:** 90 วัน หรือตามสะดวก (หมดแล้วต้องสร้างใหม่)
   - **Repository access:** Only select repositories → `nujtee/Phasakura`
   - **Permissions → Repository permissions → Actions:** **Read and write** (ที่เหลือปล่อยเป็น No access; Metadata: Read-only ถูกเลือกให้อัตโนมัติ)
   - กด **Generate token** แล้วคัดลอกไว้ชั่วคราว
2. Cloudflare → **Workers & Pages** → **center** → **Settings** → **Variables and Secrets** → **Add**
   - Type: **Secret**
   - Name: `CENTER_GITHUB_TOKEN`
   - Value: token จากข้อ 1 → **Deploy**
3. เปิด Center → **Release** ควรเห็นรายการ run ล่าสุด
   - repo กำหนดใน `sites/sites.json` → `center.githubRepo` (var `CENTER_GITHUB_REPO`)
   - token หมดอายุ: Center จะขึ้น "GitHub ไม่รับ token" ให้ทำข้อ 1–2 ใหม่

### สำรองข้อมูล

- แต่ละเว็บสำรองฐานข้อมูลของตัวเองเป็นไฟล์ `.sql.gz` ลง R2 ส่วนตัวของเว็บนั้น (`<slug>-media-private/backups/`)
  - ข้อมูลไม่ออกจากบัญชี Cloudflare และไม่ผ่าน GitHub
- **อัตโนมัติ** ทุกวัน 03:17 น. (เวลาไทย) เก็บ 30 ไฟล์ล่าสุด
- **หน้าเว็บใน Center → สำรองข้อมูล**
  - เจ้าของแพลตฟอร์มและผู้ดูแลระบบกด "สำรองตอนนี้" ได้ (ต้องใส่เหตุผล)
  - การ์ดเตือนสีเหลืองถ้าไม่มีไฟล์ในช่วง 48 ชั่วโมง
- **ดาวน์โหลด:** เจ้าของแพลตฟอร์มเท่านั้น ต้องใส่เหตุผล บันทึกทั้งใน Center และใน Audit logs ของเว็บ
  - ไฟล์มีข้อมูลแขก ใช้เมื่อจำเป็น เช่น เจ้าของเว็บขอข้อมูลตอนเลิกใช้บริการ
- ในไฟล์ไม่มี session, ลิงก์รีเซ็ตรหัส, ตั๋ว SSO และ nonce (มีแค่โครงตาราง) จึงไม่มีใครเข้าระบบค้างอยู่ได้จากการกู้คืน

**กู้คืนจากไฟล์ (ลงฐานข้อมูลใหม่ที่ว่างเท่านั้น):**
```bash
gunzip -k 2026-10-19T20-17-00Z-abc123.sql.gz
npx wrangler d1 create <slug>-restore --location=apac
npx wrangler d1 execute <slug>-restore --remote --file 2026-10-19T20-17-00Z-abc123.sql
```
ตรวจข้อมูลในฐานใหม่ก่อน แล้วค่อยเปลี่ยน D1 id ของเว็บใน `sites/sites.json` → `npm run sites:generate` → Release

ถ้าแค่ย้อนเวลาภายใน 30 วัน ใช้ **D1 Time Travel** (`wrangler d1 time-travel restore`) เร็วกว่า: bookmark ก่อนแต่ละ Release อยู่ในหน้า Summary ของ run

## เปลี่ยน key (สงสัยว่ารั่ว)

Center setup → `keys` อีกครั้ง → Center ใช้ key ใหม่ทันที (เว็บจะตอบ 401 จนกว่าจะได้ public key ใหม่) → ใส่ public key ใหม่ใน
`CENTER_PUBLIC_KEYS` (ลบอันเก่าออก) → `npm run sites:generate` → Release ทุกเว็บ

## ลืมรหัส / ล็อกตัวเองออก

PLATFORM_OWNER อีกคนสร้างลิงก์ตั้งรหัสผ่านใหม่ให้ (ผู้ใช้ Center → สร้างลิงก์ตั้งรหัสผ่านใหม่) — จึงควรมีเจ้าของแพลตฟอร์ม ≥ 2 คน
