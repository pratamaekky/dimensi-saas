# Mini Project Management SaaS (Multi-Tenant)

Backend mini Project Management (versi kecil Asana/Trello) untuk SaaS multi-tenant, dibangun
sesuai [`docs/TECH_SPEC-pm-saas.md`](docs/TECH_SPEC-pm-saas.md). Entitas: `Company` (tenant) →
banyak `User`, banyak `Project`, setiap `Project` → banyak `Task`.

Stack: NestJS + TypeScript, Prisma + PostgreSQL, BullMQ + Redis, JWT (access + refresh token).

**Kenapa stack ini:** NestJS dipilih karena guard/middleware/interceptor-nya memberi tempat
natural untuk penegakan tenant scoping berlapis (lihat §2), dan struktur modul-nya memaksa
controller tetap tipis — cocok dengan bobot penilaian "struktur kode" di brief. Prisma dipilih
karena Client Extension-nya bisa menegakkan scoping di layer data secara otomatis (§2, Layer 1),
sesuatu yang lebih sulit dilakukan rapi dengan query builder biasa. PostgreSQL karena relasional,
mendukung constraint (`@@unique([companyId, email])`) dan index komposit yang jadi bagian dari
strategi isolasi. BullMQ dipilih atas alternatif seperti `setTimeout`/in-process queue karena job
benar-benar keluar dari request cycle (persist di Redis, punya retry/backoff bawaan) — bukan
sekadar disimulasikan.

---

## 1. Cara Run

### Prasyarat

- Node.js 20+
- PostgreSQL (lokal, atau via `docker-compose up -d`)
- Redis (lokal, atau via `docker-compose up -d`)

### Langkah

```bash
# 1. Install dependencies
npm install

# 2. Siapkan env
cp .env.example .env
# Sesuaikan DATABASE_URL dengan role/kredensial Postgres lokal Anda.
# Kalau pakai docker-compose (lihat docker-compose.yml), .env.example sudah cocok
# (postgres:postgres@localhost:5432).

# 3. Migrasi database
npx prisma migrate deploy   # atau `npx prisma migrate dev` saat development

# 4. (Opsional) Seed 2 company + 2 admin untuk eksplorasi manual
npx ts-node prisma/seed.ts
# admin@acme.test / admin@globex.test, password: password123

# 5. Jalankan server (default port dari .env, fallback 3000)
npm run start:dev

# 6. Jalankan test e2e (tenant isolation, RBAC, validasi input, race condition,
#    pagination, refresh token/logout, password policy)
npm run test:e2e
```

Ada juga Postman collection siap-pakai di [`postman/`](postman/) — import
`PM-SaaS.postman_collection.json` + `PM-SaaS.postman_environment.json`, pilih environment "PM
SaaS - Local", lalu jalankan folder-nya berurutan (01→08). Setiap request meng-capture
token/id yang dibutuhkan request berikutnya secara otomatis lewat Tests script; ada folder demo
khusus untuk RBAC (403) dan tenant isolation (404).

Semua endpoint di-prefix `/api/v1`. Response envelope seragam:

```jsonc
{ "success": true, "data": { ... } }
{ "success": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

Alur dasar: `POST /auth/register` (buat Company + Admin, dapat `{ accessToken, refreshToken }`
langsung) → pakai `accessToken` sebagai `Authorization: Bearer <token>` untuk semua endpoint lain.
Kalau `accessToken` sudah expired (`JWT_EXPIRES`, default 15 menit), tukar `refreshToken` lewat
`POST /auth/refresh` untuk dapat pasangan baru — lihat §3.2.

---

## 2. Skema Database & Strategi Multi-Tenancy

Skema: [`prisma/schema.prisma`](prisma/schema.prisma) (model `Company`, `User`, `Project`,
`Task`, `AuditLog`); file migration reversible standar Prisma Migrate ada di
[`prisma/migrations/`](prisma/migrations/). ERD ringkas:

```
Company 1───* User
Company 1───* Project
Company 1───* Task
Company 1───* AuditLog
Project 1───* Task
User    1───* Task        (assignee, opsional)
User    1───* AuditLog    (actor, opsional)
```

`Company` adalah tenant root (tidak punya `companyId` sendiri); semua tabel lain wajib punya
`companyId`. `Task.companyId` sengaja didenormalisasi dari `project.companyId` agar bisa
di-auto-scope tanpa join ke `Project` (lihat Layer 1 di bawah) dan agar index komposit
`(companyId, projectId)` murah.

### Kenapa row-level scoping

| Strategi | Trade-off |
|---|---|
| **Row-level (dipilih)** | Satu skema, satu migration path, query sederhana. Risiko: satu query lupa filter → bocor. Dimitigasi berlapis (lihat di bawah). Cocok untuk banyak tenant kecil. |
| Schema-per-tenant | Isolasi lebih kuat, tapi migrasi & koneksi jadi rumit per skema. |
| DB-per-tenant | Isolasi terkuat, paling mahal/kompleks provisioning. |

Untuk scope mini-PM ini, schema/db-per-tenant adalah over-engineering — row-level dipilih dan
dimitigasi dengan tiga lapis penegakan independen, bukan satu titik kegagalan.

### Tiga lapis penegakan (defense-in-depth)

1. **`AsyncLocalStorage` tenant context** ([`src/common/tenant/tenant-context.ts`](src/common/tenant/tenant-context.ts)) —
   `companyId`/`userId`/`role` di-resolve dari JWT di [`TenantMiddleware`](src/common/tenant/tenant.middleware.ts),
   lalu seluruh request berjalan di dalam context tersebut. `companyId` **tidak pernah** dibaca
   dari URL/body/query — hanya dari sini.
2. **Prisma Client Extension** ([`src/common/tenant/prisma-tenant.extension.ts`](src/common/tenant/prisma-tenant.extension.ts)) —
   mencegat semua operasi Prisma pada model tenant-owned (`User`, `Project`, `Task`, `AuditLog`)
   dan otomatis menyuntik `where: { companyId }` / `data: { companyId }`. **Throw** jika dijalankan
   tanpa context terikat (fail loud). Dua klien Prisma disediakan sengaja: `prisma.scoped`
   (dipakai semua service bisnis) dan `prisma.base` (unscoped — hanya untuk login, seed, dan
   worker BullMQ, lihat §10 spec).
3. **Assert eksplisit di service** ([`src/common/tenant/assert-owned.ts`](src/common/tenant/assert-owned.ts)) —
   `assertOwned(record, companyId)` dipanggil di service setelah fetch; untuk update/delete
   dipakai `updateMany`/`deleteMany` + cek `count` (atomik di DB) — `count === 0` berarti
   resource tidak ada / bukan milik tenant.

### 404 vs 403 lintas tenant

Ketika user Company A mengakses resource Company B (menebak ID), response yang benar adalah
**404**, bukan 403. 403 membocorkan bahwa ID itu nyata milik tenant lain (memungkinkan enumerasi
ID); 404 tidak membocorkan apa pun. 403 tetap dipakai untuk RBAC **dalam satu company** (mis.
Member mencoba hapus project).

---

## 3. Yang Sengaja Di-skip

- Filtering (by `status`/`assigneeId`) pada endpoint list — **pagination sudah diimplementasi**,
  lihat §3.1.
- Rate limiting.
- Soft delete (saat ini hard delete + cascade dari FK `onDelete: Cascade`).
- Audit trail: delta sederhana (field yang diubah), bukan before/after penuh.
- Pruning refresh token yang sudah expired/revoked — tabelnya akan terus bertumbuh tanpa job
  pembersih (lihat §3.2).

**Rencana kalau ada waktu lebih:** filtering (`status`/`assigneeId`) pada endpoint list, lalu
rate limiting, baru cron pembersih refresh token kedaluwarsa.

(Item "refresh token/logout" dan "password policy lebih ketat" yang tadinya ada di daftar ini
sudah diimplementasi — lihat §3.2.)

### 3.1 Pagination (sudah dikerjakan)

`GET /projects` dan `GET /projects/:projectId/tasks` menerima query param `page` (default 1) dan
`limit` (default 20, maks 100). `limit` di luar rentang → 400 (whitelist validation, sama seperti
DTO lain). Response envelope untuk kedua endpoint ini jadi:

```jsonc
{
  "success": true,
  "data": {
    "items": [ /* ... */ ],
    "meta": { "total": 42, "page": 1, "limit": 20, "totalPages": 3 }
  }
}
```

`total` dihitung via `count()` terpisah yang tetap kena scoping tenant yang sama (Prisma
extension), jadi jumlahnya juga otomatis per-company, bukan global.

### 3.2 Refresh token, logout, dan password policy (sudah dikerjakan)

**Refresh token.** `POST /auth/register` dan `POST /auth/login` sekarang mengembalikan
`{ accessToken, refreshToken }`, bukan cuma `accessToken`. `accessToken` (JWT) diperpendek jadi
`JWT_EXPIRES=15m` (dulu default `1d`) — access token pendek + refresh token panjang adalah alasan
utama pola ini berguna; kalau access token tetap berumur 1 hari, refresh token nyaris tak
menambah apa-apa.

- `refreshToken` **bukan JWT**, melainkan 40-byte random string. Hanya *hash*-nya (`sha256`) yang
  disimpan di tabel `refresh_tokens` — kalau DB bocor, tidak ada token siap-pakai yang ikut bocor
  (mirip alasan password di-hash, bukan disimpan plaintext).
- `POST /auth/refresh` (`{ refreshToken }`, publik) — cari `tokenHash` via `prisma.base` (belum
  ada tenant context di titik ini, sama seperti login), validasi belum revoked & belum expired,
  **rotate**: token lama langsung di-revoke, pasangan access+refresh baru diterbitkan. Rotasi ini
  mencegah refresh token lama dipakai ulang (replay) kalau ia sempat bocor lalu dipakai sekali oleh
  penyerang — pemilik asli akan otomatis nge-fail di percobaan refresh berikutnya, tanda ada yang
  janggal. Token tidak valid/kedaluwarsa/sudah di-revoke → 401.
- `POST /auth/logout` (butuh access token valid) — revoke **semua** refresh token aktif milik user
  (logout di semua device/sesi sekaligus; tidak ada per-device session tracking — simplifikasi
  yang disengaja, cukup untuk scope ini).
- **Keterbatasan yang melekat pada JWT stateless**: `accessToken` yang sudah beredar di tangan
  client **tetap valid** sampai kedaluwarsa alami, walau sudah logout — tidak ada blacklist.
  Makanya `JWT_EXPIRES` diperpendek jadi 15 menit: window "masih valid walau sudah logout" dibatasi
  ke maksimal 15 menit, bukan 1 hari.
- Tidak ada job pembersih baris `refresh_tokens` yang sudah expired/revoked — tabelnya bertumbuh
  terus (lihat §3, "sengaja di-skip").

**Password policy.** `password` pada `POST /auth/register` dan `POST /users` sekarang wajib:
minimal 8 karakter, mengandung huruf besar, huruf kecil, dan karakter spesial (`class-validator`
`@Matches`, regex di [`src/common/validators/password.ts`](src/common/validators/password.ts)).
Password yang tidak memenuhi → 400. `login` tetap hanya mengecek presence (tidak retroaktif
memvalidasi ulang password lama), dan `prisma/seed.ts` membuat hash langsung lewat Prisma (bypass
DTO), jadi kredensial seed di §1 tidak terpengaruh aturan baru ini.

---

## 4. Keputusan Teknis yang Diragukan

### 4.1 Email unik per-company, bukan global

`@@unique([companyId, email])` — benar secara model (satu orang bisa jadi user di dua company).
Konsekuensinya: `login` hanya berdasarkan email jadi ambigu jika email yang sama ada di lebih dari
satu company. Implementasi saat ini (`AuthService.login`, [`src/auth/auth.service.ts`](src/auth/auth.service.ts))
memakai `findFirst({ where: { email } })` dan mengambil match pertama — **ini kompromi yang
disengaja**, bukan bug. Alternatif yang dipertimbangkan: login menyertakan identifier company
(lebih benar, tapi menambah field di form login), atau email global-unique (lebih sederhana, tapi
menutup skenario satu email dipakai di >1 company).

### 4.2 Prisma extension "magic" + assert eksplisit — kenapa dua-duanya

Extension (Layer 1) membuat developer **tidak bisa lupa** scoping karena penegakan ada di layer
data. Tapi ini "magic" — reviewer harus percaya bahwa extension benar-benar mencegat semua
operasi. `assertOwned` (Layer 2) membuat isolasi **terbaca** di call site: siapa pun yang membaca
`projects.service.ts` bisa melihat langsung bahwa companyId dicek, tanpa perlu menelusuri
extension. Trade-off-nya: implisit-tapi-aman (extension) vs eksplisit-tapi-rawan-lupa (assert
manual jika hanya mengandalkan disiplin). Keduanya dipakai bersamaan justru karena masing-masing
menutupi kelemahan yang lain — bukan redundansi sia-sia.

### 4.3 Assumsi tambahan (tidak eksplisit di tech spec, di-flag sesuai §16)

- **Penempatan modul `/users`**: rencana commit di spec (§15) tidak punya langkah khusus untuk
  `/users`. Diletakkan pada commit RBAC (`feat: rbac guard...`) karena spec §6 menyatakan endpoint
  ini "diperlukan agar RBAC ... bisa diuji".
- **Optimistic locking digabung ke commit CRUD Task**, bukan menyusul di commit terpisah seperti
  urutan literal §15 — karena kontrak `PATCH task` sudah mewajibkan `version` sejak awal (§7);
  memisahkannya berarti endpoint sempat melanggar kontraknya sendiri. Tidak mengubah keputusan
  tenant isolation/RBAC, hanya pengelompokan commit.
- **Docker tidak diverifikasi dengan menjalankan build** — mesin development yang dipakai untuk
  membangun proyek ini tidak memiliki Docker terpasang (hanya Postgres/Redis lokal via Homebrew).
  `Dockerfile` dan `docker-compose.yml` ditulis mengikuti pola standar multistage Node/Prisma dan
  ditinjau ulang secara manual, tapi belum pernah benar-benar di-build/dijalankan.

---

## 5. Struktur Folder

```
src/
  common/
    tenant/          # AsyncLocalStorage context, middleware, prisma extension, assertOwned
    guards/           # JwtAuthGuard, RolesGuard
    decorators/       # @Roles, @Public
    interceptors/      # response envelope
    filters/           # exception -> error envelope
    pagination/        # PaginationQueryDto, paginate() helper
    validators/        # STRONG_PASSWORD_REGEX
  audit/              # audit trail service
  jobs/               # BullMQ queue + notification worker
  prisma/             # prisma.service.ts (base + scoped client)
  auth/  users/  projects/  tasks/
prisma/
  schema.prisma  seed.ts  migrations/
test/                  # *.e2e-spec.ts
```

Controller hanya parsing + delegasi; semua logic bisnis ada di service.

---

## 6. Testing

`npm run test:e2e` menjalankan (terhadap Postgres/Redis lokal yang sama, bukan mock — karena yang
diuji justru jaminan isolasi datanya sendiri):

1. **Tenant isolation** — Company A menebak ID project Company B → 404 di GET/PATCH/DELETE;
   list project A tidak memuat project B.
2. **RBAC** — Member 403 hapus project, 403 ubah task bukan miliknya, 200 ubah task miliknya.
3. **Validasi input** — body kosong → 400; field asing (`companyId` yang disuntik manual) →
   ditolak whitelist validation → 400.
4. **Race condition (bonus)** — dua update konkuren pada task yang sama dengan `version` sama →
   satu 200, satu 409.
5. **Pagination** — `page`/`limit` menghasilkan `items`/`meta` yang benar, default page 1/limit
   20 dipakai kalau query param diomit, `limit` di luar rentang → 400.
6. **Refresh token, logout, password policy** — register/login mengembalikan pasangan
   access+refresh; refresh me-rotate token (token lama tidak bisa dipakai ulang → 401); logout
   me-revoke refresh token lalu percobaan refresh berikutnya 401; logout tanpa access token → 401;
   password lemah (tanpa huruf besar/karakter spesial) ditolak di register maupun `POST /users`.
