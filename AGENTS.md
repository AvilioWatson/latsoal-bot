# Agent Guide

Panduan ini dibuat agar agent berikutnya bisa cepat memahami struktur file dan alur kerja repo tanpa membaca seluruh README terlebih dahulu.

## Aturan Kerja

- Jangan revert perubahan user atau perubahan agent sebelumnya kecuali diminta eksplisit.
- Repo sering berisi data runtime lokal yang berubah (`saved/`, `outputs/`, `bank/`, `approved/`). Periksa `git status --short` sebelum dan sesudah edit.
- Untuk edit manual, gunakan `apply_patch`.
- Untuk pencarian, pakai `rg` atau `rg --files`.
- Untuk perubahan UI/renderer, render minimal satu contoh nyata lalu cek visual dengan `view_image`.

## Entry Point Aplikasi

- `server.js`: HTTP server utama, routing static files, dan dispatch route.
- `routes/generate.js`: endpoint generate soal dan simpan output.
- `routes/bank.js`: Bank Review, saved list, preview metadata, status, image regenerate/delete, AI explanation review, apply review.
- `routes/import.js`: import banyak soal dari JSON.
- `routes/export.js`: export approved dan tryout export.
- `routes/download.js`: download ZIP folder output/saved.
- `lib/http.js`: helper request/response JSON.
- `lib/paths.js`: root path, storage path, route path, subtest code, topic canonicalization.
- `lib/filestore.js`: rebuild/read/update `bank/index.json` dari `saved/**/metadata.json`.

## Frontend Map

- `frontend/index.html` + `frontend/app.js`: halaman Generator.
- `frontend/saved.html` + `frontend/saved.js`: halaman Bank Review.
- `frontend/import.html` + `frontend/import.js`: halaman import JSON/PDF extraction prompt.
- `frontend/edit.html` + `frontend/edit.js`: edit metadata/soal.
- `frontend/dashboard.html` + `frontend/dashboard.js`: dashboard/export tools.
- `frontend/shared.js`: helper preview gambar, source text, image list.
- `frontend/styles.css`: style utama semua halaman.
- `frontend/home.*`: homepage launcher.

Bank Review khusus:

- Filter subtes dan card memakai label singkat lewat `SUBTEST_SHORT_LABELS` di `frontend/saved.js`.
- Preview panel memakai state `body[data-saved-preview-open="true"]` di `frontend/styles.css`.
- Saat preview terbuka, navbar disembunyikan agar panel preview setengah layar lebih penuh.
- Draft AI review ditampilkan lewat `showAiReviewDraft()` di `frontend/saved.js`; jika ada `question_group_revisi`, UI menampilkan array grup.

## Generator Dan Renderer

- `content_generator.py`: generator utama, validasi lokal, dedup, renderer PIL/LaTeX, AI review, CLI.
- `latsoal_generator/prompts.py`: prompt generator, validator, caption, explanation review.
- `latsoal_generator/schemas.py`: schema respons AI.
- `latsoal_generator/config.py`: load taxonomy/pattern/data root untuk Python.
- `latsoal_generator/storage.py`: helper path/taxonomy Python.

Area penting di `content_generator.py`:

- `_wrap_passage_paragraphs()`: format paragraf bacaan. Paragraf baru turun baris rapat. Indent visual hanya diberikan pada paragraf yang membungkus lebih dari satu baris.
- `_paginate_passage_intro()`: kapasitas halaman bacaan.
- `render_passage_intro_images()`: menggambar halaman bacaan.
- `_resolve_render_questions()`: mencari satu grup bacaan dari metadata eksplisit atau `saved/**/metadata.json`.
- `render_passage_bundle_content_images()`: render paket bacaan multi-soal.
- `review_explanation_for_metadata()`: cek pembahasan AI. Untuk bacaan multi-soal, mengirim input grup dan menerima `question_group_revisi`.

## Data Runtime

Folder runtime default berada di root repo:

- `outputs/`: hasil generate sebelum disimpan.
- `saved/`: Bank Review. Struktur: `saved/<kode-subtes>/<topik>/<run-id>/`.
- `bank/index.json`: index review untuk status, path, upload marker, dan metadata ringkas.
- `approved/`: hasil export approved.
- `.tmp/`: file kerja sementara.

Data bisa diisolasi dengan:

```powershell
$env:LATSOAL_DATA_ROOT="C:\tmp\latsoal-data"
node server.js
```

Jangan berasumsi `saved/` dan `bank/index.json` bersih. Bank Review dapat rebuild index dari `saved/**/metadata.json`.

## Alur Generate

1. Browser Generator mengirim payload ke Node.
2. Node menjalankan `content_generator.py`.
3. Python membuat `soal.json`, `caption.txt`, `metadata.json`, dan gambar.
4. Output disimpan ke `outputs/<kode-subtes>/<topik>/<run-id>/`.
5. Jika user klik simpan, route Bank menyalin output ke `saved/<kode-subtes>/<topik>/<run-id>/`.
6. `bank/index.json` di-update lewat `lib/filestore.js`.

## Alur Bank Review

1. `GET /saved` memanggil `listSavedRuns()` di `routes/bank.js`.
2. `listSavedRuns()` memanggil `rebuildIndex()` dari `lib/filestore.js`.
3. Tiap item membaca `saved/**/metadata.json`.
4. Frontend `frontend/saved.js` menampilkan card, filter subtes/subtopik/status, dan preview.
5. Preview detail mengambil `GET /saved/<run-id>` atau `/api/saved/<run-id>`.
6. Generate gambar ulang memanggil `POST /saved/<run-id>/images`.
7. Cek pembahasan AI memanggil `POST /saved/<run-id>/explanation-review`, lalu polling status.
8. Terapkan revisi memanggil `POST /saved/<run-id>/explanation-review/apply`.

Untuk revisi grup bacaan, apply akan:

- membaca metadata run aktif;
- mencari run lain yang punya `mapel`, `bacaan.id`, dan teks bacaan sama;
- mencocokkan revisi berdasarkan `bacaan.nomor_soal`;
- menulis ulang `metadata.json` dan `soal.json` pada tiap run grup.

## Alur Import

- UI: `frontend/import.*`.
- Route: `routes/import.js`.
- Script pendukung: `scripts/import_questions.py`.
- Import bacaan multi-soal bisa disimpan sebagai `question_group` jika input memiliki bacaan yang sama dan `total_soal` valid.

## Export Tryout

- Route export: `routes/export.js`.
- Contract builder: `lib/tryout-export.js`.
- Test utama: `tests/tryout-export.test.mjs`.
- Sample: `tryout-export.v1.sample.json`.

## Taxonomy Dan Pattern

- `config/taxonomy.json`: sumber subtes, kode subtes, alias topik, topik, dan mapping pattern.
- `bank_soal/patterns/*.json`: pola referensi per subtes.
- `lib/taxonomy.js`: endpoint/update taxonomy Node.
- `latsoal_generator/config.py`: akses taxonomy Python.

## Verifikasi Per Area

Syntax cepat:

```powershell
node --check frontend/saved.js
node --check routes/bank.js
python -m py_compile content_generator.py
```

Renderer bacaan:

```powershell
python -m unittest tests.test_content_generator.ContentGeneratorTest.test_wrap_passage_paragraphs_keeps_tight_new_paragraphs_without_uppercase_marker tests.test_content_generator.ContentGeneratorTest.test_wrap_passage_paragraphs_marks_only_wrapped_paragraphs_for_indent tests.test_content_generator.ContentGeneratorTest.test_render_images_for_metadata_groups_passage_bundle
python content_generator.py --render-images saved/PPU/kalimat-efektif/20260701-122656/metadata.json
```

AI review grup:

```powershell
python -m unittest tests.test_content_generator.ContentGeneratorTest.test_review_explanation_reviews_passage_group tests.test_content_generator.ContentGeneratorTest.test_review_explanation_falls_back_when_ai_json_is_invalid
```

Full check:

```powershell
npm.cmd run check
```

`npm.cmd run check` lebih berat karena menjalankan lint syntax, unit test Node/Python, JSON validation, smoke test, dan audit file tracked.

## Contoh Data Untuk Visual QA

Contoh bacaan multi-soal yang sering dipakai untuk cek renderer:

```text
saved/PPU/kalimat-efektif/20260701-122656/metadata.json
```

Run ini bagian dari `PPU-003`, judul bacaan `Manfaat Live Stream Shopping bagi Gen Z`, total 5 soal. Setelah render, buka:

```text
saved/PPU/kalimat-efektif/20260701-122656/2.jpg
```

Yang perlu dicek:

- judul bacaan berada di tengah;
- paragraf baru turun baris rapat;
- paragraf yang membungkus beberapa baris punya indent visual di baris pertama;
- paragraf satu baris tidak di-indent;
- tidak ada capslock buatan;
- ruang bawah halaman tidak terlalu kosong.

## File Yang Biasanya Jangan Disentuh

- `.env` dan API key lokal.
- `saved/`, `outputs/`, `approved/`, dan `bank/index.json`, kecuali tugas memang tentang data runtime/recovery.
- Folder `Tempat Donwload Soal/`, kecuali user meminta mengubah output download lokal.
- File yang sudah berubah sebelum task dimulai, kecuali langsung berkaitan dengan tugas.
