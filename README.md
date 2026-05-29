# UTBK Content Desk

Web lokal untuk membuat, meninjau, menyimpan, dan mengekspor konten latihan soal UTBK/SNBT. Aplikasi ini dibuat untuk workflow gratis dan manual-first: generator bisa memakai Gemini jika tersedia, tetapi tetap punya fallback lokal agar alur kerja tidak berhenti saat API limit.

## Fitur Utama

- Generate soal UTBK/SNBT dari browser.
- Pilih subtes, topik, level, mode konten, dan akun/brand caption.
- Preview soal, pilihan jawaban, caption, metadata, dan error/fallback.
- Simpan soal yang dianggap bagus ke Bank Review.
- Bank Review terpisah dari halaman generator.
- Bank Review bisa dibuka per subtes.
- Approve atau reject soal saved.
- Export semua item approved ke folder `approved/`.
- Dedup lokal terhadap soal yang sudah tersimpan.
- Validator lokal untuk mengecek struktur soal, opsi jawaban, caption, hashtag, dan potensi masalah dasar.

## Halaman Web

### Generator

```text
http://127.0.0.1:8765/
```

Halaman utama untuk membuat konten baru. Di halaman ini kamu bisa:

- memilih subtes UTBK/SNBT;
- memilih topik;
- memilih level;
- generate soal;
- melihat preview soal dan caption;
- melihat error/fallback jika ada;
- menyimpan hasil yang bagus ke Bank Review.

### Bank Review

```text
http://127.0.0.1:8765/saved
```

Halaman untuk meninjau semua soal yang sudah disimpan. Di halaman ini kamu bisa:

- mencari soal berdasarkan subtes, topik, level, run id, atau source;
- filter berdasarkan status `Saved`, `Approved`, atau `Rejected`;
- preview soal, pilihan jawaban, caption, dan metadata;
- copy caption;
- buka metadata JSON;
- approve, reject, atau hapus soal saved;
- export semua soal approved.

### Bank Review per Subtes

Setiap subtes punya URL sendiri agar review lebih rapi:

```text
http://127.0.0.1:8765/saved/penalaran-umum
http://127.0.0.1:8765/saved/pengetahuan-dan-pemahaman-umum
http://127.0.0.1:8765/saved/pemahaman-bacaan-dan-menulis
http://127.0.0.1:8765/saved/pengetahuan-kuantitatif
http://127.0.0.1:8765/saved/literasi-bahasa-indonesia
http://127.0.0.1:8765/saved/literasi-bahasa-inggris
http://127.0.0.1:8765/saved/penalaran-matematika
```

## Cara Menjalankan

Pastikan Node.js dan Python sudah tersedia.

Jalankan server lokal:

```powershell
node server.js
```

Lalu buka:

```text
http://127.0.0.1:8765
```

Server memakai Node.js built-in HTTP server, tanpa Express dan tanpa dependency npm tambahan. Logic generator tetap berada di Python.

Jika PowerShell memblokir `npm.ps1`, jalankan lewat:

```powershell
npm.cmd start
```

## Check dan Smoke Test

Jalankan validasi lokal:

```powershell
npm.cmd run check
```

Command ini menjalankan:

- `node --check` untuk `server.js`, semua file `routes/*.js`, `lib/*.js`, dan `frontend/*.js`;
- audit file yang dilacak git agar `.env`, output runtime, saved item, approved export, dan `bank/index.json` tidak ikut commit;
- secret scan ringan untuk file tracked dan untracked non-ignored;
- pemeriksaan line ending LF untuk source, docs, dan config tracked maupun untracked non-ignored;
- unit test Node untuk validator output, utilitas path, config topik, dan workflow API Bank Review/export;
- validasi JSON untuk `config/*.json` dan `bank_soal/patterns/*.json`;
- `python -m py_compile content_generator.py`;
- unit test Python untuk validasi lokal, dedup, dan output draft generator;
- pemeriksaan bahwa topik dan mapping pattern di generator Python sama dengan `config/*.json`;
- smoke test generator Python dalam mode `draft`, lalu membersihkan output smoke test tersebut.

Alias berikut juga tersedia:

```powershell
npm.cmd test
```

Quality gate yang sama juga dijalankan di GitHub Actions lewat:

```text
.github/workflows/quality.yml
```

Checklist kualitas ringkas tersedia di:

```text
QUALITY.md
```

Kontrak endpoint lokal tersedia di:

```text
API.md
```

## Konfigurasi Gemini

Buat file `.env` di root project atau set environment variable di terminal:

```powershell
$env:GEMINI_API_KEY="isi_api_key"
```

Opsional:

```powershell
$env:GEMINI_MODEL="gemini-3.5-flash"
```

Jangan commit API key. File `.env`, `outputs/`, `saved/`, dan `approved/` harus tetap lokal.

## Isolasi Data Lokal

Secara default, data runtime disimpan di root project:

```text
outputs/
saved/
approved/
bank/
```

Untuk test atau eksperimen tanpa menyentuh data utama, arahkan data runtime ke folder lain:

```powershell
$env:LATSOAL_DATA_ROOT="C:\tmp\latsoal-data"
npm.cmd start
```

Kode aplikasi tetap dibaca dari repo, tetapi output, saved item, approved export, dan index bank memakai folder tersebut.

## Cara Kerja Generator

Alur dasar saat tombol generate ditekan:

1. Browser mengirim pilihan subtes, topik, level, mode, dan akun ke `server.js`.
2. `server.js` menjalankan `content_generator.py`.
3. Python membuat soal, caption, dan metadata.
4. Hasil disimpan ke folder `outputs/<run-id>/`.
5. Browser menampilkan preview dari output tersebut.
6. Jika pengguna menekan tombol simpan, output dicopy ke `saved/<run-id>/`.

## LLM dan Fallback Lokal

Sistem ini masih bisa memakai LLM untuk membuat soal, tetapi tidak sepenuhnya bergantung pada LLM.

Jika Gemini berhasil:

- soal dibuat oleh Gemini;
- metadata mencatat model dan estimasi token dari `usageMetadata`;
- validator lokal tetap mengecek hasilnya.

Jika Gemini gagal, quota habis, network error, atau JSON tidak valid:

- generator masuk mode fallback lokal;
- error ditampilkan di web;
- metadata mencatat bagian mana yang fallback;
- konten diberi status review agar dicek manual.

Untuk `Pengetahuan Kuantitatif` dan `Penalaran Matematika`, fallback lokal dapat membuat soal deterministik berbasis rumus, misalnya:

- rata-rata dengan data hilang;
- rasio dan total bagian;
- pola bilangan aritmetika.

## Validator Lokal

Validator lokal mengecek hal-hal dasar tanpa LLM:

- struktur data soal lengkap;
- pilihan jawaban A sampai E tersedia;
- kunci jawaban ada di pilihan;
- opsi tidak duplikat;
- teks soal tidak terlalu kosong;
- caption tidak membocorkan jawaban;
- hashtag wajib ada;
- skor validasi berada di rentang 0 sampai 100;
- tahun lama yang tidak relevan terdeteksi;
- dedup terhadap soal yang sudah disimpan.

Validator tidak menggantikan review manusia. Fungsinya untuk menangkap kesalahan teknis sebelum soal dipakai.

## Dedup Soal

Saat generate, sistem membandingkan teks soal baru dengan bank saved lokal. Jika kemiripan melewati threshold, metadata akan mencatat:

```json
{
  "dedup": {
    "is_duplicate": true,
    "similarity": 0.86,
    "matched_run_id": "..."
  }
}
```

Threshold default:

```text
DEDUP_THRESHOLD=0.82
```

Nilai ini bisa diubah lewat environment variable.

Dedup membaca index review utama di:

```text
bank/index.json
```

Metadata soal pembanding tetap dibaca dari:

```text
saved/<run-id>/metadata.json
```

## Output File

Setiap run membuat folder:

```text
outputs/<run-id>/
```

Isi umumnya:

```text
caption.txt
metadata.json
soal.json
```

Keterangan:

- `caption.txt`: caption final.
- `metadata.json`: catatan source, fallback, error, validator, dedup, dan usage token.
- `soal.json`: data soal mentah.

Generator ini hanya fokus membuat data soal. Konversi `soal.json` menjadi PNG/SVG dilakukan oleh sistem terpisah.

Saat tombol simpan dipakai, output terpilih dicopy ke:

```text
saved/<run-id>/
```

Saat export approved dipakai, item approved dicopy ke:

```text
approved/<export-id>/
```

Folder export berisi file konten dan `manifest.json`.

## Workflow Review

Workflow review memakai status di Bank Review:

- `Saved`: item baru disimpan dari halaman Generator dan perlu dicek.
- `Approved`: item sudah lolos review manual dan akan ikut saat export.
- `Rejected`: item disimpan sebagai arsip review, tetapi tidak ikut export.

Tombol `Export approved` hanya menyalin item berstatus `Approved` ke folder `approved/<export-id>/`.

## Struktur Subtes

Subtes default mengikuti struktur UTBK/SNBT modern:

```text
TPS
  - Penalaran Umum
  - Pengetahuan dan Pemahaman Umum
  - Pemahaman Bacaan dan Menulis
  - Pengetahuan Kuantitatif

Literasi
  - Literasi Bahasa Indonesia
  - Literasi Bahasa Inggris
  - Penalaran Matematika
```

Pola referensi disimpan di:

```text
bank_soal/patterns/
```

Pola ini dipakai sebagai cetakan konsep, bukan untuk menyalin soal.

Daftar subtes dan topik aplikasi disimpan di satu sumber:

```text
config/topics.json
```

Mapping subtes ke file pattern disimpan di:

```text
config/patterns.json
```

Frontend mengambil daftar topik lewat route `/config`, dan generator Python membaca file config yang sama untuk pilihan `--mapel` dan pattern referensi.

## Generate Manual Tanpa Web

Generator bisa dijalankan langsung dari terminal:

```powershell
python content_generator.py --mapel "Penalaran Umum" --topik "Penalaran deduktif" --level sedang --mode auto
```

Output tetap masuk ke:

```text
outputs/<run-id>/
```

## GitHub Actions Self-Hosted

Workflow manual tersedia di:

```text
.github/workflows/manual-content.yml
```

Workflow ini memakai:

```yaml
runs-on: self-hosted
```

Artinya proses berjalan di runner milik sendiri, bukan runner cloud berbayar. Aktivasi tetap manual dari tab Actions.

Workflow manual menjalankan `npm.cmd run check` sebelum generate agar artifact hanya dibuat dari repo yang lolos quality gate.

## Troubleshooting

### Route tidak ditemukan di `/saved/<subtes>`

Restart server Node:

```powershell
node server.js
```

Jika masih error, pastikan file `server.js` terbaru sedang dijalankan.

### Gemini quota habis

Web akan menampilkan error quota dan generator akan memakai fallback jika memungkinkan. Tunggu reset quota atau ganti model/key yang masih punya kuota.

### Preview tidak muncul

Cek folder `outputs/<run-id>/` atau `saved/<run-id>/`. Pastikan `soal.json`, `caption.txt`, dan `metadata.json` tersedia.

### API key bocor

Segera revoke key di Google AI Studio, lalu buat key baru. Jangan simpan key di README, commit, issue, atau chat publik.
