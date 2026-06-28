# Plan Pengembangan Website UTBK Tryout

## Ringkasan

`utbk-tryout-web` adalah project baru yang terpisah dari `latsoal-bot`. Project ini menjadi platform publik untuk user mengerjakan tryout UTBK/SNBT, melihat hasil, pembahasan, riwayat, dan ranking.

MVP dibuat gratis dulu tanpa payment gateway. Data utama disimpan di PostgreSQL. Soal diimport dari file `tryout-export.v1.json` yang dibuat oleh `latsoal-bot`.

## Arsitektur

Backend:

- Go.
- Gin untuk HTTP router.
- PostgreSQL.
- `pgx` untuk driver database.
- `sqlc` untuk query type-safe.
- SQL migration untuk perubahan schema.
- Session cookie `HttpOnly`, `Secure`, `SameSite=Lax`.

Frontend:

- Next.js App Router.
- TypeScript.
- Tailwind CSS.
- shadcn/ui.
- TanStack Query untuk data fetching.
- React Hook Form + Zod untuk form.

Storage MVP:

- Database menyimpan data soal, paket, attempt, dan jawaban.
- Asset gambar memakai URL dari export `latsoal-bot` atau local uploads.
- Cloudflare R2/MinIO masuk fase lanjutan.

Tidak masuk MVP:

- Redis.
- Queue/background worker.
- Payment gateway.
- Materialized ranking table.
- Email notification.

## Struktur Project

Backend:

```text
utbk-tryout-api/
  cmd/server/main.go
  internal/
    handler/
    service/
    repository/
    middleware/
    model/
  pkg/
    database/
    session/
    validator/
  db/
    migrations/
    queries/
  sqlc.yaml
  docker-compose.yml
  .env.example
```

Frontend:

```text
utbk-tryout-web/
  app/
    (auth)/
    (user)/
    admin/
  components/
    ui/
    shared/
    exam/
  lib/
    api/
    hooks/
    stores/
  types/
```

## Database MVP

### `users`

- `id`
- `name`
- `email`
- `password_hash`
- `role`: `user`, `admin`, `superadmin`
- `is_active`
- `created_at`
- `updated_at`

### `sessions`

- `id`
- `user_id`
- `token_hash`
- `expires_at`
- `created_at`
- `last_used_at`

### `questions`

- `id`
- `external_id` unique dari `latsoal-bot.run_id`
- `subtest_name`
- `subtest_code`
- `topic`
- `canonical_topic`
- `difficulty`
- `difficulty_raw`
- `question_text`
- `correct_answer`
- `explanation`
- `source`
- `review_status`
- `status`: `active`, `inactive`
- `import_batch_id`
- `created_at`
- `updated_at`

### `question_options`

- `id`
- `question_id`
- `label`: `A`, `B`, `C`, `D`, `E`
- `text`
- `sort_order`

### `question_assets`

- `id`
- `question_id`
- `asset_type`: `image`, `thumbnail`, `explanation`
- `url`
- `sort_order`

### `import_batches`

- `id`
- `schema_version`
- `source_app`
- `export_id`
- `filename`
- `total_questions`
- `imported_count`
- `updated_count`
- `failed_count`
- `warning_count`
- `status`
- `created_by`
- `created_at`

### `tryouts`

- `id`
- `title`
- `slug`
- `description`
- `duration_minutes`
- `status`: `draft`, `published`, `archived`
- `is_free`
- `created_by`
- `created_at`
- `updated_at`

### `tryout_sections`

- `id`
- `tryout_id`
- `title`
- `subtest_code`
- `sort_order`
- `duration_minutes` nullable

### `tryout_questions`

- `id`
- `tryout_id`
- `section_id`
- `question_id`
- `number`
- `weight`

### `attempts`

- `id`
- `user_id`
- `tryout_id`
- `attempt_no`
- `status`: `in_progress`, `submitted`, `expired`
- `started_at`
- `expires_at`
- `submitted_at`
- `score`
- `correct_count`
- `wrong_count`
- `empty_count`

### `attempt_answers`

- `id`
- `attempt_id`
- `question_id`
- `selected_option`
- `is_flagged`
- `is_correct`
- `answered_at`
- `updated_at`

## Aturan Data

- `questions.external_id` wajib unique agar import idempotent.
- Import ulang file yang sama harus update data soal, bukan membuat duplikat.
- `attempts` memakai `attempt_no`, bukan `UNIQUE(user_id, tryout_id)`, agar multiple attempt bisa ditambahkan tanpa migration besar.
- Timer selalu dihitung dari server memakai `started_at` dan `expires_at`.
- Client boleh menampilkan countdown, tetapi server tetap menolak jawaban jika attempt sudah expired.
- Score dihitung saat submit dari database.
- Ranking MVP dihitung langsung dari tabel `attempts` memakai SQL window function.

## Halaman User

### `/`

Landing sederhana:

- Brand dan value proposition singkat.
- Daftar tryout terbaru.
- CTA login/register.

### `/login` dan `/register`

- Form auth.
- Error state untuk email/password salah.
- Redirect ke dashboard setelah login.

### `/dashboard`

- Ringkasan attempt terakhir.
- Tryout yang tersedia.
- Shortcut ke riwayat.
- Statistik sederhana: total tryout selesai, skor terbaik, rata-rata skor.

### `/tryouts`

- List paket tryout.
- Filter status/free.
- Card berisi title, durasi, jumlah soal, section, dan status.

### `/tryouts/[slug]`

- Detail paket.
- Daftar section/subtes.
- Durasi.
- Jumlah soal.
- Tombol mulai.
- Jika sudah pernah attempt, tampilkan tombol lihat hasil atau mulai attempt baru sesuai policy.

### `/attempts/[id]/work`

Halaman pengerjaan:

- Header sticky berisi judul tryout, timer, tombol submit.
- Panel nomor soal desktop.
- Bottom navigation mobile.
- Area soal utama.
- Passage jika ada.
- Opsi A-E.
- Tombol ragu-ragu.
- Autosave saat memilih jawaban.
- Submit modal dengan jumlah terjawab, kosong, dan ragu-ragu.
- Auto-submit saat timer habis.
- Local fallback di `localStorage` saat offline.

### `/attempts/[id]/result`

- Skor akhir.
- Jumlah benar/salah/kosong.
- Rank dan percentile.
- Breakdown per subtes.
- CTA lihat pembahasan.

### `/attempts/[id]/review`

- Daftar soal.
- Jawaban user.
- Jawaban benar.
- Highlight benar/salah.
- Pembahasan.

### `/history`

- Riwayat attempt user.
- Filter berdasarkan tryout/status.

### `/profile`

- Data akun.
- Ubah nama/password.

## Halaman Admin

### `/admin`

- Statistik ringkas: total user, total soal, total tryout, total attempt.
- Warning import terakhir.

### `/admin/imports`

- Upload `tryout-export.v1.json`.
- Preview validasi.
- Tampilkan imported/updated/failed/warnings.
- Confirm import.

### `/admin/questions`

- Tabel bank soal.
- Search.
- Filter subtest, topic, difficulty, status.
- Link ke detail soal.

### `/admin/questions/[id]`

- Preview soal.
- Edit teks soal, opsi, jawaban, pembahasan.
- Aktif/nonaktifkan soal.

### `/admin/tryouts`

- Daftar paket tryout.
- Filter draft/published/archived.

### `/admin/tryouts/new`

- Form buat paket tryout.
- Title, slug, description, duration, status draft.

### `/admin/tryouts/[id]`

- Edit info paket.
- Kelola section.
- Pilih soal dari bank.
- Reorder soal.
- Publish/archive.

### `/admin/users`

- List user.
- Filter role/status.
- Ubah role dan aktif/nonaktif.

## API MVP

Auth:

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`

User tryout:

- `GET /tryouts`
- `GET /tryouts/:slug`
- `POST /attempts`
- `GET /attempts/:id`
- `GET /attempts/:id/questions`
- `PATCH /attempts/:id/answers/:question_id`
- `POST /attempts/:id/submit`
- `GET /attempts/:id/result`
- `GET /attempts/:id/review`
- `GET /tryouts/:id/ranking`
- `GET /users/me/history`

Admin:

- `POST /admin/imports/preview`
- `POST /admin/imports/commit`
- `GET /admin/imports`
- `GET /admin/questions`
- `GET /admin/questions/:id`
- `PUT /admin/questions/:id`
- `PATCH /admin/questions/:id/status`
- `GET /admin/tryouts`
- `POST /admin/tryouts`
- `GET /admin/tryouts/:id`
- `PUT /admin/tryouts/:id`
- `POST /admin/tryouts/:id/sections`
- `POST /admin/tryouts/:id/questions`
- `PUT /admin/tryouts/:id/questions/reorder`
- `PATCH /admin/tryouts/:id/status`

## Roadmap

### Phase 1: Foundation

- Setup repository backend dan frontend.
- Setup PostgreSQL lokal dengan Docker.
- Setup migration.
- Setup Go API.
- Setup Next.js.
- Implement auth session cookie.
- Implement layout dasar user dan admin.

### Phase 2: Importer dan Bank Soal

- Implement parser `tryout-export.v1.json`.
- Implement preview import.
- Implement commit import idempotent.
- Implement admin bank soal.
- Implement edit dan status soal.

### Phase 3: Paket Tryout

- Implement CRUD tryout.
- Implement section.
- Implement pilih soal.
- Implement reorder soal.
- Implement publish/archive.

### Phase 4: Pengerjaan Tryout

- Implement start attempt.
- Implement halaman pengerjaan.
- Implement autosave.
- Implement timer server-side.
- Implement submit.
- Implement expired attempt.

### Phase 5: Hasil, Pembahasan, Ranking

- Implement scoring.
- Implement halaman result.
- Implement halaman review.
- Implement ranking query.
- Implement history user.

### Phase 6: Polish dan Deployment

- Responsive QA desktop/mobile.
- Loading, empty, error, confirmation states.
- Security hardening.
- Deploy backend.
- Deploy frontend.
- Setup database production.

### Phase 7: Fitur Lanjutan

- Payment/premium.
- Object storage.
- Redis cache.
- Analytics per soal.
- Email notification.
- Multiple attempt policy.
- Export hasil PDF.

## Test Plan

- Backend unit test: auth, importer, scoring, timer expiry.
- Backend integration test: import soal -> buat tryout -> start attempt -> answer -> submit -> result.
- Frontend test: login, daftar tryout, pengerjaan, autosave, submit modal, result.
- E2E test: user menyelesaikan tryout penuh.
- Security test: user tidak bisa akses attempt milik user lain.
- Admin auth test: admin endpoint menolak role user.
- Import regression: file export dari `latsoal-bot` valid dan idempotent.

## Asumsi

- MVP gratis dulu.
- Tidak ada payment gateway pada MVP.
- Project tryout terpisah dari `latsoal-bot`.
- PostgreSQL menjadi sumber data utama.
- Ranking dihitung dari `attempts` dulu.
- Redis, queue, object storage, dan monetisasi masuk setelah MVP stabil.
