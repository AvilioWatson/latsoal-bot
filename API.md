# API Contract

Base URL lokal:

```text
http://127.0.0.1:8765
```

Semua response JSON memakai `Content-Type: application/json; charset=utf-8`.
Response file/HTML dan JSON menyertakan header `X-Content-Type-Options: nosniff` dan `Referrer-Policy: same-origin`.

## Pages

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Homepage Near Education. |
| `GET` | `/generator` | Halaman Generator. |
| `GET` | `/saved` | Halaman Bank Review jika browser meminta HTML. |
| `GET` | `/saved.html` | Alias halaman Bank Review. |
| `GET` | `/saved/<subtes-slug>` | Halaman Bank Review terfilter subtes. |
| `GET` | `/import` | Halaman import batch JSON. |
| `GET` | `/stats` | Halaman Stats jika browser meminta HTML. |

## Config

### `GET /config`

Alias: `GET /api/config`

Response:

```json
{
  "topics": {
    "Penalaran Umum": ["Penalaran deduktif"]
  }
}
```

### `POST /api/config/topics`

Alias: `POST /config/topics`

Menambahkan subtopik baru ke subtes yang sudah ada di `config/taxonomy.json`.

Request:

```json
{
  "mapel": "Penalaran Umum",
  "topik": "Analogi Verbal"
}
```

Response:

```json
{
  "ok": true,
  "created": true,
  "mapel": "Penalaran Umum",
  "topik": "Analogi Verbal",
  "taxonomy_path": "C:\\Users\\Wildan\\Kuliah\\Project\\latsoal-bot\\config\\taxonomy.json"
}
```

### `DELETE /api/config/topics`

Alias: `DELETE /config/topics`

Menghapus subtopik dari subtes di konfigurasi taxonomy. Data soal yang sudah tersimpan tidak dihapus; item yang memakai subtopik tersebut akan ditandai perlu ganti subtopik di Bank Review.

Request:

```json
{
  "mapel": "Penalaran Umum",
  "topik": "Analogi Verbal"
}
```

Response:

```json
{
  "ok": true,
  "deleted": true,
  "mapel": "Penalaran Umum",
  "topik": "Analogi Verbal"
}
```

## Generate

### `POST /generate`

Alias: `POST /api/generate`

Request:

```json
{
  "mapel": "Penalaran Umum",
  "topik": "Penalaran deduktif",
  "level": "mudah",
  "mode": "draft",
  "provider": "gemini",
  "account": "@utbk_neareducation"
}
```

Validation:

- `mapel` harus ada di `config/taxonomy.json` pada field `topics`.
- `topik` harus tersedia untuk `mapel`.
- `level` harus `mudah`, `sedang`, atau `sulit`.
- `mode` harus `auto`, `gemini`, atau `draft`.
- `provider` harus `gemini` atau `kimi`.
- `account` maksimal 80 karakter.

Success response menyertakan `run_id`, `question`, `caption`, `validation`, `metadata`, dan `web_files`.

## Import Soal

### `GET /api/import/config`

Mengembalikan prompt ekstraksi PDF, template JSON, taksonomi, batas batch, dan threshold similarity.

### `POST /api/import/validate`

Request:

```json
{"questions": []}
```

Memvalidasi maksimal 1.000 soal dan menjalankan similarity check terhadap bank serta item sebelumnya dalam batch. Response mengelompokkan item sebagai `valid`, `similar`, `exact_duplicate`, atau `invalid`.

### `POST /api/import`

Request:

```json
{
  "questions": [],
  "selected_indices": [0, 2],
  "confirmed_similar_indices": [2],
  "account": "@utbk_neareducation"
}
```

Server mengulang validasi dan similarity check sebelum menyimpan. Duplikat exact ditolak; item similarity tinggi harus dicantumkan dalam `confirmed_similar_indices`. Gambar tidak dirender dalam request import dan dapat dibuat melalui endpoint gambar saved.

## Bank Review

### `POST /saved`

Alias: `POST /api/save`

Request:

```json
{"run_id": "20260529-123456"}
```

Menyalin `outputs/<run-id>/` ke `saved/<run-id>/` dan menambah entry ke `bank/index.json`.

### `GET /saved`

Alias: `GET /api/saved`

Jika request menerima JSON, response:

```json
{
  "items": []
}
```

### `GET /saved/<run-id>`

Alias: `GET /api/saved/<run-id>`

Mengembalikan metadata saved beserta `web_files`.

### `POST /saved/<run-id>/status`

Alias: `POST /api/saved/status`

Request:

```json
{"status": "approved"}
```

Status valid: `saved`, `approved`, `rejected`.
Response menyertakan `status_updated_at`; `approved_at` atau `rejected_at` diisi sesuai status.

### `POST /saved/<run-id>/uploaded`

Alias: `POST /api/saved/uploaded`

Menandai item saved sebagai sudah diupload. Response menyertakan `uploaded_at`.

### `POST /saved/<run-id>/unuploaded`

Alias: `POST /api/saved/unuploaded`

Membatalkan tanda upload dengan mengosongkan `uploaded_at`, tanpa mengubah status review.

### `DELETE /saved/<run-id>`

Alias: `POST /saved/<run-id>/delete`, `POST /api/saved/delete`

Menghapus entry index dan folder `saved/<run-id>/`.

### `POST /saved/<run-id>/images`

Merender atau merender ulang gambar soal dan pembahasan untuk item saved.

### `POST /saved/<run-id>/merge-passage`

Menggabungkan soal aktif dengan `other_run_id` menjadi satu paket bacaan. Hanya tersedia untuk PPU, PBM, dan PM, dengan dua soal bacaan tunggal pada subtes yang sama. Bacaan dari `run-id` aktif dipakai sebagai bacaan bersama, nomor soal dinormalisasi menjadi 1 dan 2, status review kembali ke `needs_review`, dan gambar lama dihapus agar dibuat ulang.

Request:

```json
{"other_run_id":"20260701-120000"}
```

Endpoint ini menolak paket bacaan yang sudah berisi lebih dari satu soal.

## Export

### `POST /export`

Alias: `POST /api/export/approved`

Menyalin semua item `approved` ke `approved/<export-id>/` dan membuat `manifest.json`.
Path file di manifest relatif terhadap folder export.

### `POST /api/export/tryout`

Membuat export khusus untuk project website tryout. Endpoint ini hanya mengambil item dengan status `approved`, menyalin aset ke `approved/<export-id>/`, lalu membuat file versioned:

```text
approved/<export-id>/tryout-export.v1.json
```

Response:

```json
{
  "export_id": "2026-06-26T10-00-00-000Z",
  "total": 1,
  "warning_count": 0,
  "file": "/approved/2026-06-26T10-00-00-000Z/tryout-export.v1.json",
  "manifest": {
    "schema_version": "tryout-export.v1",
    "source_app": "latsoal-bot",
    "questions": []
  }
}
```

Schema file utama:

```json
{
  "schema_version": "tryout-export.v1",
  "export_id": "2026-06-26T10-00-00-000Z",
  "created_at": "2026-06-26T10:00:00.000Z",
  "source_app": "latsoal-bot",
  "total": 1,
  "warning_count": 0,
  "skipped": [],
  "questions": [
    {
      "external_id": "20260626-100000",
      "subtest_name": "Penalaran Umum",
      "subtest_code": "PU",
      "topic": "Penalaran Deduktif",
      "canonical_topic": "Penalaran Deduktif",
      "difficulty_raw": "mudah",
      "difficulty": "easy",
      "question_text": "Teks soal...",
      "options": [
        {"label": "A", "text": "Pilihan A", "sort_order": 1}
      ],
      "correct_answer": "A",
      "explanation": "Pembahasan...",
      "caption": {},
      "assets": {"images": [], "explanations": []},
      "source": "import",
      "review_status": "ready",
      "validation": {},
      "dedup": {},
      "warnings": []
    }
  ]
}
```

Warning tidak menggagalkan export. Contoh warning: `review_not_ready`, `missing_question_text`, `missing_explanation`, `invalid_correct_answer`, dan `missing_option`.

## Download

### `GET /download/outputs/<run-id>`

Mengunduh hasil generate sebagai ZIP. Isi ZIP hanya file JPG bernomor di folder `<run-id>/`, misalnya `1.jpg`, `2.jpg`, dan seterusnya.

### `GET /download/saved/<run-id>`

Mengunduh hasil saved sebagai ZIP. Isi ZIP hanya file JPG bernomor di folder `<run-id>/`, misalnya `1.jpg`, `2.jpg`, dan seterusnya.

## Stats

### `GET /stats`

Jika request menerima JSON, response berisi agregat:

- `total`
- `by_status`
- `by_subtes`
- `by_source`
- `by_level`
- `last_7_days`
- `duplicate_rate`
- `export_batches`
- `pending_export`
- `warnings`

## Health

### `GET /health`

Response:

```json
{"ok": true, "app": "utbk-content-desk"}
```

## Errors

Error JSON memakai bentuk:

```json
{"error": "Pesan error"}
```

Status penting:

- `400`: input JSON atau field request tidak valid.
- `403`: path static asset keluar dari mount.
- `404`: route/file/run tidak ditemukan.
- `413`: body request terlalu besar.
- `500`: kegagalan internal atau generator gagal tanpa status khusus.
