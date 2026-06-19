# UTBK Content Desk

Web lokal untuk membuat, meninjau, menyimpan, dan mengekspor konten latihan soal UTBK/SNBT. Aplikasi ini dibuat untuk workflow gratis dan manual-first: generator bisa memakai Gemini atau Kimi jika tersedia, tetapi tetap punya fallback lokal agar alur kerja tidak berhenti saat API limit.

## Portfolio Notes

Project ini saya buat sebagai tool lokal untuk membantu produksi konten latihan soal UTBK/SNBT sebelum diunggah ke Instagram. Fokusnya bukan hanya membuat soal, tetapi juga memastikan soal bisa dicek, disimpan, dipilih, dan diekspor dengan rapi.

Yang dikerjakan:

- Membuat web lokal untuk generate, preview, simpan, review, approve/reject, dan export soal.
- Menghubungkan server Node.js dengan generator Python tanpa framework backend tambahan.
- Menambahkan fallback lokal saat provider AI error, quota habis, atau response tidak valid.
- Membuat renderer gambar 1000x1000 untuk post soal dan JPG pembahasan siap upload.
- Membuat validator untuk mengecek struktur soal, pilihan jawaban, caption, hashtag, dan potensi duplikasi.
- Menyediakan Bank Review agar soal yang bagus bisa dipisahkan dari draft yang masih perlu dicek.
- Menambahkan test dan quality check otomatis agar perubahan lebih aman sebelum dipakai produksi konten.

## Tech Stack

- Node.js built-in HTTP server untuk backend lokal.
- Python untuk generator konten, validasi, dedup, dan fallback lokal.
- Vanilla JavaScript, HTML, dan CSS untuk frontend.
- JSON sebagai konfigurasi topik, pattern soal, metadata, dan manifest export.
- GitHub Actions untuk continuous integration.

## CV Summary

Contoh ringkasan untuk CV:

```text
Built a local content desk for preparing UTBK/SNBT practice questions for Instagram, using Node.js, Python, and vanilla JavaScript.

Implemented question generation, review workflow, validation, deduplication, caption support, image rendering, ZIP download/export tooling, automated tests, and GitHub Actions CI.
```

## Fitur Utama

- Generate soal UTBK/SNBT dari browser.
- Pilih subtes, topik, level, mode konten, provider AI, dan akun/brand caption.
- Preview soal, pilihan jawaban, caption, metadata, dan error/fallback.
- Generate gambar post soal 1000x1000 dan JPG pembahasan otomatis.
- Tambahkan thumbnail pembuka 1080x1080 yang berisi judul subtes dan subtopik.
- Preview dan download semua file run sebagai ZIP berisi satu folder.
- Simpan soal yang dianggap bagus ke Bank Review.
- Bank Review terpisah dari halaman generator.
- Bank Review bisa dibuka per subtes.
- Bank Review mempertahankan topik asli soal, sekaligus tetap bisa mencari topik kanonis seperti `Aljabar dan Fungsi`.
- Generate ulang atau hapus gambar dari item saved.
- Approve atau reject soal saved.
- Tandai soal saved yang sudah diupload.
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
- melihat preview gambar, soal, dan caption;
- melihat error/fallback jika ada;
- download folder hasil generate sebagai ZIP;
- menyimpan hasil yang bagus ke Bank Review.

### Bank Review

```text
http://127.0.0.1:8765/saved
```

Halaman untuk meninjau semua soal yang sudah disimpan. Di halaman ini kamu bisa:

- mencari soal berdasarkan subtes, topik, level, run id, atau source;
- filter berdasarkan status `Saved`, `Approved`, atau `Rejected`;
- preview gambar, soal, pilihan jawaban, caption, dan metadata;
- generate ulang gambar atau hapus gambar dari item saved;
- copy caption;
- buka metadata JSON;
- download folder saved sebagai ZIP;
- approve, reject, atau hapus soal saved;
- tandai soal yang sudah diupload;
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

Alternatif di Windows, klik dua kali `LatsoalBot.exe` dari root project. Launcher ini menghentikan server Node.js lama yang masih memakai port `8765`, menjalankan `node server.js` dari folder project saat ini, menyetel `LATSOAL_RENDER_ENGINE=pil` jika belum ada konfigurasi render, lalu membuka browser ke alamat lokal di atas.

Server memakai Node.js built-in HTTP server, tanpa Express dan tanpa dependency npm tambahan. Logic generator tetap berada di Python.

Jika PowerShell memblokir `npm.ps1`, jalankan lewat:

```powershell
npm.cmd start
```

## Menjalankan Dengan Docker

Docker menjaga dependency Node.js, Python, LaTeX, dan PDF converter tetap di dalam container, sehingga environment laptop tidak perlu dipasangi toolchain LaTeX.

Build dan jalankan:

```powershell
docker compose up --build
```

Lalu buka:

```text
http://127.0.0.1:8765
```

Compose memakai named volume `latsoal-data` untuk menyimpan:

```text
/data/outputs
/data/saved
/data/approved
/data/bank
```

Jadi output generate tetap tersimpan walaupun container dibuat ulang. File `.env` tetap dipakai untuk API key dan konfigurasi provider AI.

Perintah berguna:

```powershell
docker compose down
docker compose logs -f
docker compose exec latsoal-bot npm test
```

Di dalam container, renderer default adalah:

```text
LATSOAL_RENDER_ENGINE=latex
LATSOAL_LATEX_COMMAND=pdflatex
LATSOAL_PDF_CONVERTER=pdftoppm
```

Di Windows lewat `LatsoalBot.exe`, launcher memakai renderer PIL agar aplikasi tetap jalan tanpa instalasi LaTeX lokal. Jika ingin memaksa LaTeX di mesin lokal, set environment variable sendiri sebelum menjalankan server:

```powershell
$env:LATSOAL_RENDER_ENGINE="latex"
node server.js
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

## Konfigurasi Provider AI

Buat file `.env` di root project atau set environment variable di terminal:

```powershell
$env:GEMINI_API_KEY="isi_api_key"
$env:KIMI_API_KEY="isi_api_key_kimi"
```

Opsional:

```powershell
$env:AI_PROVIDER="gemini"
$env:GEMINI_MODEL="gemini-3.5-flash"
$env:KIMI_MODEL="moonshotai/kimi-k2.6"
```

Di web, pilih `Gemini` atau `Kimi` pada kontrol Provider AI sebelum menekan Generate. Mode `Draft lokal` tetap tidak memakai API.

Jangan commit API key. File `.env`, `outputs/`, `saved/`, dan `approved/` harus tetap lokal. Jika API key pernah terkirim di chat atau masuk log publik, rotate key tersebut dari dashboard penyedia API.

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

1. Browser mengirim pilihan subtes, topik, level, mode, provider AI, dan akun ke `server.js`.
2. `server.js` menjalankan `content_generator.py`.
3. Python membuat soal, caption, metadata, gambar soal, dan gambar pembahasan.
4. Hasil disimpan ke folder `outputs/<kode-subtes>/<topik>/<run-id>/`.
5. Browser menampilkan preview dari output tersebut.
6. Jika pengguna menekan tombol simpan, output dicopy ke `saved/<kode-subtes>/<topik>/<run-id>/`.

`run-id` dibuat dari timestamp. Jika timestamp yang sama sudah dipakai di `outputs/` atau `saved/`, generator otomatis maju ke detik berikutnya agar hasil lama tidak tertimpa.

Topik tertentu dapat disimpan ke folder kanonis agar struktur file rapi. Contohnya `Persamaan Linear`, `Fungsi Kuadrat`, dan beberapa topik aljabar lain masuk folder `aljabar-dan-fungsi`. Di Bank Review, nama topik asli dari metadata tetap ditampilkan dan tetap bisa dicari.

## LLM dan Fallback Lokal

Sistem ini masih bisa memakai LLM untuk membuat soal, tetapi tidak sepenuhnya bergantung pada LLM.

Jika Gemini atau Kimi berhasil:

- soal dibuat oleh provider AI terpilih;
- metadata mencatat provider, model, dan estimasi token jika tersedia;
- validator lokal tetap mengecek hasilnya.

Jika provider AI gagal, quota habis, network error, atau JSON tidak valid:

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
saved/<kode-subtes>/<topik>/<run-id>/metadata.json
```

## Output File

Setiap run membuat folder:

```text
outputs/<kode-subtes>/<topik>/<run-id>/
```

Isi umumnya:

```text
caption.txt
metadata.json
1.jpg
2.jpg
3.jpg
thumbnail.png atau thumbnail.jpg
post-1.png atau post-1.jpg
pembahasan-1.jpg
soal.json
```

Keterangan:

- `caption.txt`: caption final.
- `metadata.json`: catatan source, fallback, error, validator, dedup, usage token, dan daftar file gambar.
- `1.jpg`, `2.jpg`, `3.jpg`, dst: gambar final yang dipakai preview dan download, sudah berurutan dari thumbnail sampai pembahasan.
- `thumbnail.png` / `post-*.png` / `pembahasan-*.jpg`: output intermediate dari renderer PIL.
- `thumbnail.tex`, `post-*.tex`, `pembahasan-*.tex`, PDF, dan JPG intermediate hanya muncul jika renderer LaTeX dipakai.
- `soal.json`: data soal mentah.

Metadata gambar menyimpan file JPG bernomor di `files.image`, `files.images`, `files.thumbnail`, dan `files.explanation` / `files.explanations`.

Contoh struktur untuk Pengetahuan Kuantitatif topik fungsi kuadrat atau persamaan linear:

```text
saved/PK/aljabar-dan-fungsi/20260612-092806/
```

Renderer gambar mendukung tiga mode:

```text
LATSOAL_RENDER_ENGINE=auto   # default Python: coba LaTeX, fallback ke PIL
LATSOAL_RENDER_ENGINE=pil    # default launcher EXE: tidak perlu LaTeX
LATSOAL_RENDER_ENGINE=latex  # paksa LaTeX/TikZ -> PDF -> JPG
```

Mode PIL cukup membutuhkan Pillow dan menghasilkan thumbnail, soal, pilihan ganda, serta pembahasan siap upload. Layout soal, opsi, jawaban, dan pembahasan memakai kotak putih; jika masih muat, pilihan ganda digabung di halaman soal agar ruang kosong tidak terbuang. Konten di halaman lanjutan dimulai dari area atas, bukan dipusatkan ke bawah.

Mode LaTeX membutuhkan:

- LaTeX compiler, default `pdflatex`.
- PDF converter, salah satu dari ImageMagick `magick` atau Poppler `pdftoppm`.

Konfigurasi terkait:

```text
LATSOAL_RENDER_ENGINE=auto
LATSOAL_LATEX_COMMAND=pdflatex
LATSOAL_PDF_CONVERTER=
LATSOAL_RENDER_TIMEOUT_SECONDS=60
```

Jika mesin belum punya LaTeX/converter, pakai `LATSOAL_RENDER_ENGINE=pil` atau jalankan lewat `LatsoalBot.exe`.

Tombol `Download folder` mengunduh ZIP yang hanya berisi JPG bernomor:

```text
GET /download/outputs/<run-id>
GET /download/saved/<run-id>
```

Isi ZIP berada di folder `<run-id>/`, misalnya `<run-id>/1.jpg`, `<run-id>/2.jpg`, dan seterusnya.

Saat tombol simpan dipakai, output terpilih dicopy ke:

```text
saved/<kode-subtes>/<topik>/<run-id>/
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

Tombol `Sudah diupload` menandai item dengan `uploaded_at`, sedangkan `Tidak jadi diupload` mengosongkan tanda tersebut tanpa mengubah status review. Catatan upload tetap terpisah dari alur approve/reject/export.

Di Bank Review, tombol `Generate` pada panel gambar menjalankan ulang renderer dari `metadata.json`. Tombol `Hapus gambar` menghapus `1.jpg`, `2.jpg`, dst serta file render intermediate dari item saved tanpa menghapus data soal, caption, atau metadata utama.

Bank Review dibangun ulang dari file `saved/**/metadata.json` saat daftar dimuat. Ini membuat item lama tetap muncul walaupun index pernah tertinggal. Status review terbaru di `bank/index.json` tetap dipertahankan saat rebuild.

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
config/taxonomy.json
```

File ini menyimpan `subtest_codes`, `topic_aliases`, `topics`, dan `pattern_files`.

Frontend mengambil daftar topik dan alias lewat route `/config`, backend Node membaca config yang sama untuk validasi dan storage path, dan generator Python membaca file config yang sama untuk pilihan `--mapel` dan pattern referensi.

## Generate Manual Tanpa Web

Generator bisa dijalankan langsung dari terminal:

```powershell
python content_generator.py --mapel "Penalaran Umum" --topik "Penalaran deduktif" --level sedang --mode auto
```

Output tetap masuk ke:

```text
outputs/<kode-subtes>/<topik>/<run-id>/
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

### Kuota AI habis

Web akan menampilkan error quota dan generator akan memakai fallback jika memungkinkan. Tunggu reset quota atau ganti provider, model, atau key yang masih punya kuota.

### Preview tidak muncul

Cek folder `outputs/<kode-subtes>/<topik>/<run-id>/` atau `saved/<kode-subtes>/<topik>/<run-id>/`. Pastikan `soal.json`, `caption.txt`, dan `metadata.json` tersedia.

Jika metadata ada tetapi gambar hilang di Bank Review, buka item tersebut lalu tekan tombol `Generate` pada panel gambar untuk membuat ulang JPG bernomor.

Jika item saved tidak terlihat di daftar, buka ulang Bank Review atau restart server. Daftar saved dibangun ulang dari `saved/**/metadata.json`, sehingga item lama akan muncul kembali selama folder metadata masih ada.

### Download folder gagal

Pastikan run id masih ada di dalam `outputs/` atau `saved/`. Endpoint download menerima run id format timestamp seperti `20260605-230100` dan akan mencari foldernya di struktur nested subtes/topik.

### API key bocor

Segera revoke key di Google AI Studio, lalu buat key baru. Jangan simpan key di README, commit, issue, atau chat publik.
