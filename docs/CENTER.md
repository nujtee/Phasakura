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
| บันทึกการใช้งาน | ทุกบทบาท | 300 รายการล่าสุด: ใคร ทำอะไร เว็บไหน เพราะอะไร (append-only, ลบ / แก้ไม่ได้) |
| บัญชีของฉัน | ทุกบทบาท | เปลี่ยนรหัสผ่าน (session อื่นออกทั้งหมด) |

บทบาท: **เจ้าของแพลตฟอร์ม** (ทุกอย่าง รวมพักเว็บในเฟส C6) · **ผู้ดูแลระบบ** (เข้าหลังบ้านแบบ SUPER_ADMIN) ·
**ซัพพอร์ต** (เข้าหลังบ้านแบบดูอย่างเดียว) — ต้องมีเจ้าของแพลตฟอร์มที่ใช้งานได้อย่างน้อย 1 คนเสมอ (trigger ในฐานข้อมูล)

ความปลอดภัย: ผิดรหัส 5 ครั้ง = ล็อก 15 นาที, session 8 ชม. / ไม่ใช้งาน 1 ชม. ออกเอง, cookie `__Host-csid` (HttpOnly, Secure,
SameSite=Strict), ทุก POST ต้องมาจาก origin ของ Center, CSP `default-src 'none'`, ไม่มี Workers.dev / preview URL
ยังไม่มี: 2FA และการแจ้งเตือน LINE (เฟส C5 / C9)

## เปลี่ยน key (สงสัยว่ารั่ว)

Center setup → `keys` อีกครั้ง → Center ใช้ key ใหม่ทันที (เว็บจะตอบ 401 จนกว่าจะได้ public key ใหม่) → ใส่ public key ใหม่ใน
`CENTER_PUBLIC_KEYS` (ลบอันเก่าออก) → `npm run sites:generate` → Release ทุกเว็บ

## ลืมรหัส / ล็อกตัวเองออก

PLATFORM_OWNER อีกคนสร้างลิงก์ตั้งรหัสผ่านใหม่ให้ (ผู้ใช้ Center → สร้างลิงก์ตั้งรหัสผ่านใหม่) — จึงควรมีเจ้าของแพลตฟอร์ม ≥ 2 คน
