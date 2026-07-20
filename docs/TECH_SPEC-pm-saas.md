# Tech Spec — Mini Project Management SaaS (Multi-Tenant)

> Dokumen ini adalah keputusan arsitektur & kontrak teknis yang sudah final.
> Tujuannya: memandu implementasi (mis. oleh Claude Code) tanpa mendikte
> setiap baris kode. Yang dinilai di take-home ini adalah *keputusan* di
> dokumen ini + kualitas eksekusinya — bukan siapa yang mengetik.
>
> **Instruksi untuk Claude Code**: implementasikan section demi section,
> secara bertahap, dengan commit terpisah mengikuti "Rencana Commit" di
> bagian akhir. Jangan menyimpang dari keputusan di sini tanpa flag ke user
> terlebih dahulu — terutama bagian Tenant Isolation dan RBAC.

---

## 1. Konteks & Tujuan

Backend mini Project Management (versi kecil Asana/Trello) untuk SaaS
multi-tenant. Entitas: Company (tenant) → banyak User, banyak Project,
setiap Project → banyak Task. **Data satu company tidak boleh pernah
terlihat oleh company lain, walaupun user menebak ID resource.**

Yang dinilai (urutan bobot menurun): tenant isolation terbukti lewat test
(★★★★★) → kualitas skema/modeling (★★★★) → kejelasan README (★★★★) →
struktur kode (★★★) → RBAC & API design (★★★) → testing & job (★★★).

---

## 2. Stack

| Layer | Pilihan | Alasan |
|---|---|---|
| Framework | NestJS + TypeScript | Guard/middleware/interceptor memberi tempat natural untuk penegakan tenant scoping berlapis; struktur modul memaksa controller tipis. |
| ORM/DB | Prisma + PostgreSQL | Prisma Client Extension bisa menegakkan scoping di layer data secara otomatis (lihat §4). |
| Queue | BullMQ + Redis | Job benar-benar keluar dari request cycle, bukan `setTimeout`. |
| Auth | JWT (access token saja, tanpa refresh — di-skip, lihat §9) | Stateless; `companyId` & `role` dibawa di payload token. |

---

## 3. Skema Database

### 3.1 ERD (ringkas)

```
Company 1───* User
Company 1───* Project
Company 1───* Task
Company 1───* AuditLog
Project 1───* Task
User    1───* Task        (assignee, opsional)
User    1───* AuditLog    (actor, opsional)
```

`Company` adalah tenant root — tidak punya `companyId` sendiri. Semua
tabel lain WAJIB punya `companyId`.

### 3.2 Prisma schema (final — implementasikan persis ini)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  MEMBER
}

enum TaskStatus {
  TODO
  DOING
  DONE
}

model Company {
  id        String   @id @default(uuid())
  name      String
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  users     User[]
  projects  Project[]
  tasks     Task[]
  auditLogs AuditLog[]

  @@map("companies")
}

model User {
  id           String   @id @default(uuid())
  companyId    String   @map("company_id")
  email        String
  passwordHash String   @map("password_hash")
  name         String
  role         Role     @default(MEMBER)
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  company       Company    @relation(fields: [companyId], references: [id], onDelete: Cascade)
  assignedTasks Task[]     @relation("TaskAssignee")
  auditLogs     AuditLog[]

  // Email unik PER company, bukan global — lihat §8.1 (keputusan diragukan)
  @@unique([companyId, email])
  @@index([companyId])
  @@map("users")
}

model Project {
  id          String   @id @default(uuid())
  companyId   String   @map("company_id")
  name        String
  description String?
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  tasks   Task[]

  @@index([companyId])
  @@map("projects")
}

model Task {
  id         String     @id @default(uuid())
  // companyId didenormalisasi sengaja dari project.companyId agar Prisma
  // extension bisa auto-scope Task TANPA join ke Project. Lihat §4.2.
  companyId  String     @map("company_id")
  projectId  String     @map("project_id")
  assigneeId String?    @map("assignee_id")
  title      String
  status     TaskStatus @default(TODO)
  // Optimistic lock untuk race condition pada update konkuren — lihat §7.
  version    Int        @default(0)
  createdAt  DateTime   @default(now()) @map("created_at")
  updatedAt  DateTime   @updatedAt @map("updated_at")

  company  Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  project  Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  assignee User?   @relation("TaskAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)

  @@index([companyId, projectId])
  @@index([companyId, assigneeId])
  @@map("tasks")
}

model AuditLog {
  id        String   @id @default(uuid())
  companyId String   @map("company_id")
  actorId   String?  @map("actor_id")
  action    String   // "project.create", "task.update", dst.
  entity    String   // "Project" | "Task"
  entityId  String   @map("entity_id")
  changes   Json?
  createdAt DateTime @default(now()) @map("created_at")

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  actor   User?   @relation(fields: [actorId], references: [id], onDelete: SetNull)

  @@index([companyId, entity, entityId])
  @@map("audit_logs")
}
```

### 3.3 Keputusan modeling yang wajib dijelaskan di README

- **`Task.companyId` redundant tapi disengaja** — bisa di-derive dari
  `project.companyId`, tapi disimpan langsung agar (a) Prisma extension bisa
  auto-scope tanpa join, (b) index komposit `(companyId, projectId)` murah,
  (c) satu pola scoping seragam di semua model.
- **Unique constraint email**: `@@unique([companyId, email])`, bukan
  global-unique. Konsekuensi pada login dijelaskan di §8.1.

---

## 4. Multi-Tenancy: Row-Level Scoping (Defense-in-Depth)

### 4.1 Kenapa row-level

| Strategi | Trade-off |
|---|---|
| **Row-level (dipilih)** | Satu skema, satu migration path, query sederhana. Risiko: satu query lupa filter → bocor. Dimitigasi berlapis (§4.2). Cocok untuk banyak tenant kecil. |
| Schema-per-tenant | Isolasi lebih kuat, tapi migrasi & koneksi jadi rumit per skema. |
| DB-per-tenant | Isolasi terkuat, paling mahal/kompleks provisioning. |

Untuk scope mini-PM ini, memilih schema/db-per-tenant adalah over-engineering.

### 4.2 Tiga lapis penegakan (wajib diimplementasikan semua)

**Layer 0 — Sumber kebenaran: `AsyncLocalStorage`.**
`companyId`, `userId`, `role` di-resolve dari JWT di sebuah middleware, lalu
seluruh request dijalankan di dalam context tersebut. `companyId` **tidak
pernah** dibaca dari URL param / body / query string — ini aturan keras.

**Layer 1 — Prisma Client Extension.**
Sebuah `$extends()` yang mencegat *semua* operasi (`findMany`, `findFirst`,
`create`, `update`, `updateMany`, `delete`, `deleteMany`, dst.) pada model
tenant-owned (`User`, `Project`, `Task`, `AuditLog` — **bukan** `Company`)
dan otomatis menyuntik `where: { companyId }` (untuk read/updateMany/
deleteMany) atau `data: { companyId }` (untuk create). Efeknya: developer
**tidak bisa lupa** scoping karena penegakan ada di layer data, bukan
disiplin manual. Extension harus **throw** bila dijalankan tanpa tenant
context terikat (fail loud, bukan diam-diam lintas tenant).

**Layer 2 — Assert eksplisit di service.**
Sebuah helper (mis. `assertOwned(record)`) dipanggil di service setelah
fetch, memeriksa `record.companyId === currentCompanyId`. Ini membuat
pengecekan isolasi **terbaca** di tempat logika bisnis — reviewer tak perlu
percaya buta pada "magic" extension. Untuk update/delete pakai
`updateMany`/`deleteMany` + cek `count` (atomik di DB): `count === 0` berarti
resource tidak ada / bukan milik tenant → lempar 404.

**Dua klien Prisma secara sengaja:**
- `prisma.scoped` (extended) → dipakai **semua** service bisnis.
- `prisma` (base, un-extended) → **hanya** untuk operasi yang sah lintas
  tenant: login (cari user by email tanpa tahu company dulu) dan seed.
  Harus sedikit, eksplisit, dan gampang di-review.

### 4.3 Respons cross-tenant: 404, bukan 403

Ketika user Company A mengakses resource Company B (dengan menebak ID),
response yang benar adalah **404** (seolah tidak ada), bukan 403 (ada tapi
dilarang). Alasan: 403 membocorkan bahwa ID itu nyata milik tenant lain →
memungkinkan enumerasi ID. 404 tidak membocorkan apa pun.

Catatan: 403 tetap dipakai untuk kasus RBAC **dalam satu company** (mis.
Member mencoba hapus project → 403, karena di sini yang relevan adalah
"boleh/tidak", bukan kebocoran keberadaan resource).

---

## 5. Auth

- `POST /api/v1/auth/register` — body: `{ companyName, name, email, password }`.
  Membuat `Company` baru + satu `User` dengan role `ADMIN` dalam satu
  transaksi DB. Return JWT langsung (auto-login setelah register).
- `POST /api/v1/auth/login` — body: `{ email, password }`. Cari user via
  klien **base** (bukan scoped) karena belum ada tenant context. Return JWT.
- JWT payload: `{ sub: userId, companyId, role }`. Expiry via env
  `JWT_EXPIRES` (default `1d`).
- Endpoint lain (selain register/login) **wajib** melalui guard auth; tanpa
  token → 401.

---

## 6. RBAC

Dua role: **ADMIN**, **MEMBER**.

| Aksi | Admin | Member |
|---|---|---|
| Buat/ubah/hapus Project | ✅ | ❌ (403) |
| Lihat Project & list | ✅ | ✅ |
| Buat/hapus Task, assign ke siapa pun | ✅ | ❌ (403) |
| Lihat Task | ✅ | ✅ |
| Ubah Task **miliknya sendiri** (assignee = dirinya) | ✅ | ✅ |
| Ubah Task milik orang lain | ✅ | ❌ (403) |
| Kelola user (`POST/GET /users`) | ✅ | ❌ (403) |

Penegakan dua tingkat:
- **Kasar (route-level)** — guard role berbasis decorator (mis. `@Roles(Role.ADMIN)`) untuk aksi yang murni butuh Admin.
- **Halus (data-level)** — di service `Task.update`: bila `role !== ADMIN`
  dan `task.assigneeId !== currentUserId` → 403. Ini **tidak bisa** jadi
  guard route-level karena bergantung pada data resource (siapa assignee-nya),
  bukan cuma role si pemanggil.

`POST /api/v1/users` (Admin-only) diperlukan agar RBAC "kelola user" bisa
diuji dan agar Member sungguhan bisa dibuat untuk keperluan testing.

---

## 7. API Endpoints

Prefix: `/api/v1`. Format response seragam via interceptor/filter global:

```jsonc
// sukses
{ "success": true, "data": { ... } }
// error
{ "success": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

| Method | Path | Role | Catatan |
|---|---|---|---|
| POST | `/auth/register` | public | buat Company + Admin |
| POST | `/auth/login` | public | |
| POST | `/users` | ADMIN | buat user (default MEMBER/ADMIN) |
| GET | `/users` | ADMIN | list user company sendiri |
| POST | `/projects` | ADMIN | |
| GET | `/projects` | any | list ter-scope otomatis |
| GET | `/projects/:id` | any | 404 bila bukan milik tenant |
| PATCH | `/projects/:id` | ADMIN | |
| DELETE | `/projects/:id` | ADMIN | |
| POST | `/projects/:projectId/tasks` | ADMIN | body bisa sertakan `assigneeId` → trigger job |
| GET | `/projects/:projectId/tasks` | any | |
| GET | `/projects/:projectId/tasks/:id` | any | |
| PATCH | `/projects/:projectId/tasks/:id` | any* | body wajib sertakan `version`; RBAC halus di service |
| DELETE | `/projects/:projectId/tasks/:id` | ADMIN | |

`*` — endpoint tidak dibatasi guard role; pembatasan (hanya task sendiri
untuk Member) ada di service (§6).

**Update Task wajib optimistic locking**: body `{ ..., version: number }`.
Service meng-update hanya jika `version` di DB masih sama (`updateMany where
{ id, version }`, lalu `version: { increment: 1 }`). Jika `count === 0` →
**409 Conflict** ("task sudah diubah proses lain").

---

## 8. Keputusan yang perlu di-flag/didiskusikan di README

### 8.1 Email unik per-company vs global
Dipilih: unik per-company (`@@unique([companyId, email])`) — benar secara
model (satu orang bisa jadi user di dua company). Konsekuensi: login by
email saja jadi ambigu bila email sama ada di >1 company. Untuk scope ini,
`login` cukup pakai `findFirst({ where: { email } })` dan ambil yang
pertama ditemukan — **tulis eksplisit di README bahwa ini kompromi**,
dengan alternatif: login menyertakan identifier company, atau email
global-unique (lebih sederhana, tapi menutup skenario satu email di >1
company).

### 8.2 Extension "magic" vs scoping eksplisit
Kenapa pakai keduanya (§4.2 Layer 1 + Layer 2) alih-alih salah satu saja —
tulis trade-off-nya (implisit-tapi-aman vs eksplisit-tapi-rawan-lupa) di
README sebagai salah satu "keputusan yang diragukan".

### 8.3 404 vs 403 lintas tenant
Jelaskan seperti §4.3.

---

## 9. Yang sengaja di-skip (sebutkan di README, jangan diam-diam dilewati)

- Refresh token / logout — hanya access token.
- Pagination/filtering pada endpoint list.
- Rate limiting, password policy lebih ketat.
- Soft delete (saat ini hard delete + cascade).
- Audit trail: delta sederhana, bukan before/after penuh.

---

## 10. Background Job

- Queue: BullMQ, nama queue `notifications`.
- Trigger: task dibuat dengan `assigneeId`, atau task di-update dengan
  `assigneeId` baru (assignment berubah).
- Producer (dalam request): **hanya** `queue.add(...)` lalu return — tidak
  boleh menunggu pengiriman email.
- Worker/processor: konsumsi job, **mock** kirim email (log ke console
  cukup, format bebas asal jelas: penerima, task, aksi). Worker berjalan di
  luar request context → **tidak** ada `AsyncLocalStorage` tenant context di
  sana; worker filter `companyId` secara manual dari payload job (bukan
  dari context) dan pakai klien Prisma **base**.
- Retry: minimal beberapa attempt dengan backoff (mis. 3× exponential).

---

## 11. Testing (wajib minimal 3, sesuai bobot ★★★★★ untuk isolasi)

### Test 1 — Tenant isolation (WAJIB, paling penting)
Skenario: register Company A & Company B. Admin B membuat sebuah Project.
Admin A mencoba **GET/PATCH/DELETE** project itu dengan menebak ID.
Assert: **404** di ketiganya (bukan 403, bukan 200). Tambahan: list project
A tidak memuat project B.

### Test 2 — RBAC
Skenario: Admin buat Member sungguhan via `POST /users`, member login.
Assert: Member **403** saat hapus project. Member **403** saat ubah task
bukan miliknya. Member **200** saat ubah task miliknya sendiri.

### Test 3 — Validasi input
Body kosong/invalid pada register & create project → 400. Field asing yang
tidak dikenal (payload berisi `companyId` yang disuntik manual) → **ditolak**
(whitelist validation), membuktikan tenant tidak bisa dioper dari body.

Test tambahan (opsional tapi disarankan): race condition — dua update
konkuren pada task yang sama dengan `version` sama → satu 200, satu 409.

---

## 12. Struktur folder yang disarankan

```
src/
  common/
    tenant/          # AsyncLocalStorage context, middleware, prisma extension, base service (assertOwned)
    audit/           # audit trail service
    guards/          # JwtAuthGuard, RolesGuard
    decorators/      # @Roles, @CurrentUser, @Public
    interceptors/    # response envelope
    filters/         # exception → error envelope
  prisma/            # schema.prisma, prisma.service.ts, seed.ts, migrations/
  auth/  users/  projects/  tasks/  jobs/
test/                # *.e2e-spec.ts
```

Prinsip: controller hanya parsing + delegasi; semua logic bisnis di
service. Ini bagian yang dinilai "struktur kode" (★★★).

---

## 13. Nilai Plus (kerjakan semua bila waktu cukup)

- Index sesuai §3.2 (sudah didesain, tinggal implementasi).
- Hindari N+1: list project pakai `_count`, list task pakai `include assignee`.
- Audit trail: sesuai §3.2 model `AuditLog` + service pencatat di
  create/update/delete Project & Task.
- Race condition: optimistic lock §7, dijelaskan di README.
- Migration reversible: gunakan Prisma Migrate standar (folder
  `migrations/` dengan `migration.sql` per perubahan).
- Dockerfile multistage (build → runtime slim) + `docker-compose.yml`
  (Postgres + Redis, healthcheck).
- CI: GitHub Actions — `npm ci` → `prisma generate` → `migrate deploy` →
  `lint` → `test`, dengan service Postgres & Redis di CI.

---

## 14. README wajib memuat

1. Cara run (env, migration, seed, run, test) — lihat §alur.
2. Strategi multi-tenancy + trade-off (§4, tabel §4.1).
3. Apa yang di-skip (§9) dan rencana kalau ada waktu lebih.
4. Satu (atau dua, §8.1 & §8.2) keputusan teknis yang diragukan + alasan.

---

## 15. Rencana Commit Bertahap

Commit kecil, bertahap, mencerminkan alur berpikir — bukan satu dump besar:

1. `chore: init nestjs + prisma + docker-compose (postgres, redis)`
2. `feat: prisma schema — company, user, project, task, audit`
3. `feat: auth — register & login with jwt`
4. `feat: tenant context (AsyncLocalStorage) + prisma auto-scope extension`
5. `feat: projects crud with tenant scoping (layer 2 assert)`
6. `feat: tasks crud nested under projects`
7. `feat: rbac guard — admin vs member + fine-grained task ownership`
8. `feat: bullmq notification job on task assignment`
9. `feat: audit trail + optimistic locking on task update`
10. `test: tenant isolation, rbac, validation (e2e)`
11. `ci: github actions lint+test; dockerfile`
12. `docs: readme — multi-tenancy strategy & trade-offs`

---

## 16. Catatan untuk Claude Code

- Ikuti persis skema di §3.2 — jangan mengubah nama kolom/index tanpa
  alasan, karena test §11 mengasumsikan bentuk data ini.
- Jangan implementasikan tenant scoping HANYA di satu layer — §4.2
  mengharuskan ketiganya (context, extension, assert eksplisit).
- Jangan pakai `403` untuk kasus cross-tenant (harus `404`, §4.3); pakai
  `403` hanya untuk RBAC dalam-company (§6).
- Bila ada ambiguitas yang tidak tercakup dokumen ini, catat sebagai asumsi
  eksplisit di README, jangan diam-diam memutuskan sendiri untuk hal yang
  memengaruhi tenant isolation atau RBAC.
