# Plan Pengembangan Latsoal Bot

## Ringkasan

`latsoal-bot` tetap menjadi website internal untuk produksi konten soal UTBK/SNBT. Project ini tidak dimigrasi ke SQL untuk MVP website tryout karena storage file/folder masih cocok untuk workflow editorial: generate, import, review, edit, approve/reject, render gambar, dan export.

Fokus pengembangan adalah membuat output `latsoal-bot` lebih stabil untuk dikonsumsi project baru `utbk-tryout-web`, tanpa membuat website tryout membaca struktur internal `saved/`, `bank/index.json`, atau folder export lama secara langsung.

## Keputusan Arsitektur

- Storage utama tetap file-based:
  - `saved/` untuk arsip soal hasil review.
  - `bank/index.json` untuk indeks status saved/approved/rejected.
  - `approved/` untuk batch export.
- `latsoal-bot` tidak menyimpan user tryout, attempt, skor, ranking, atau data publik.
- Website tryout baru akan mengonsumsi file export kontrak `tryout-export.v1.json`, bukan membaca `metadata.json` mentah satu per satu.
- Export lama `/api/export/approved` tetap dipertahankan untuk arsip lengkap beserta aset.
- Export baru `/api/export/tryout` menjadi kontrak stabil untuk project tryout.

## Fitur yang Dipertahankan

- Generate soal UTBK/SNBT dari halaman generator.
- Import batch soal dari JSON.
- Validasi struktur soal.
- Dedup lokal terhadap soal yang sudah tersimpan.
- Simpan soal ke Bank Review.
- Edit metadata/soal/caption.
- Review pembahasan.
- Approve/reject soal.
- Render ulang gambar.
- Tandai uploaded.
- Export approved lama ke folder `approved/<export_id>/`.

## Export Contract untuk Website Tryout

Endpoint baru:

```text
POST /api/export/tryout
```

Output file:

```text
approved/<export_id>/tryout-export.v1.json
```

Static URL:

```text
/approved/<export_id>/tryout-export.v1.json
```

Response API:

```json
{
  "export_id": "2026-06-26T10-00-00-000Z",
  "total": 120,
  "warning_count": 3,
  "file": "/approved/2026-06-26T10-00-00-000Z/tryout-export.v1.json",
  "manifest": {}
}
```

Schema file:

```json
{
  "schema_version": "tryout-export.v1",
  "export_id": "2026-06-26T10-00-00-000Z",
  "created_at": "2026-06-26T10:00:00.000Z",
  "source_app": "latsoal-bot",
  "total": 1,
  "warning_count": 0,
  "skipped": [],
  "questions": []
}
```

Setiap item `questions[]`:

```json
{
  "external_id": "20260626-100000",
  "subtest_name": "Penalaran Umum",
  "subtest_code": "PU",
  "topic": "Penalaran Induktif",
  "canonical_topic": "Penalaran Induktif",
  "difficulty_raw": "mudah",
  "difficulty": "easy",
  "question_text": "Teks soal...",
  "options": [
    {"label": "A", "text": "Pilihan A", "sort_order": 1},
    {"label": "B", "text": "Pilihan B", "sort_order": 2},
    {"label": "C", "text": "Pilihan C", "sort_order": 3},
    {"label": "D", "text": "Pilihan D", "sort_order": 4},
    {"label": "E", "text": "Pilihan E", "sort_order": 5}
  ],
  "correct_answer": "A",
  "explanation": "Pembahasan...",
  "caption": {},
  "assets": {
    "images": [],
    "explanations": []
  },
  "source": "import",
  "review_status": "ready",
  "validation": {},
  "dedup": {},
  "warnings": []
}
```

Aturan export:

- Hanya soal dengan status `approved` yang masuk export.
- Soal approved dengan `review_status != ready` tetap diexport, tetapi diberi warning `review_not_ready`.
- Field `external_id` selalu memakai `run_id`.
- `difficulty` dinormalisasi:
  - `mudah` -> `easy`
  - `sedang` -> `medium`
  - `sulit` -> `hard`
- Jika ada field penting kosong, export tetap berjalan dan mencatat warning.
- Folder batch export tetap menyalin folder per `run_id` agar asset URL stabil.

## UI Dashboard

Tambahkan panel export di dashboard admin:

- Tombol `Export for Tryout`.
- Status proses export.
- Total soal yang diexport.
- Jumlah warning.
- Link ke file JSON hasil export.

UI ini tidak menggantikan export lama. Export lama tetap tersedia untuk arsip penuh.

## Tahapan Pengembangan

### Phase 1: Stabilkan Export Contract

- Implement endpoint `/api/export/tryout`.
- Implement mapper dari `metadata.json` ke schema `tryout-export.v1`.
- Tambahkan warning untuk data yang belum siap.
- Tambahkan panel export di dashboard.
- Tambahkan test mapper dan API.

### Phase 2: Quality Gate Editorial

- Tambahkan indikator di Bank Review untuk soal yang siap masuk tryout.
- Tandai soal dengan warning sebelum export.
- Tambahkan filter `review_status = ready`.
- Tambahkan ringkasan jumlah approved tetapi belum ready.

### Phase 3: Import/Export Compatibility

- Dokumentasikan schema export di README/API docs.
- Tambahkan sample `tryout-export.v1.json`.
- Tambahkan test regression agar schema tidak berubah tanpa sengaja.
- Tambahkan `schema_version` baru jika format berubah di masa depan.

### Phase 4: Workflow Produksi Lebih Rapi

- Tambahkan halaman audit soal approved.
- Tambahkan batch notes saat export.
- Tambahkan validasi caption dan pembahasan sebelum approve.
- Tambahkan pencarian berdasarkan `external_id`, subtes, topik, level, dan warning.

## Test Plan

- Unit test mapper `metadataToTryoutQuestion`.
- API test: save -> approve -> export tryout -> file JSON valid.
- Compatibility test: soal tanpa gambar tetap valid.
- Warning test: approved tetapi `review_status != ready` menghasilkan warning.
- Regression test: `/api/export/approved` tetap berjalan.
- Manual test dashboard: klik `Export for Tryout`, buka link JSON, pastikan file bisa diakses.

## Batasan

- Tidak ada login user publik di `latsoal-bot`.
- Tidak ada scoring atau ranking di `latsoal-bot`.
- Tidak ada migrasi PostgreSQL untuk `latsoal-bot` pada MVP.
- Tidak ada payment atau monetisasi di project ini.
