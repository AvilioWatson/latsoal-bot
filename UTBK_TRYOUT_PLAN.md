# Kondisi Website UTBK Content Generator Sekarang

Project saat ini adalah tool lokal untuk membuat, meninjau, menyimpan, dan mengekspor konten latihan soal UTBK/SNBT.

Fokus utama project ini:

- Generate soal UTBK/SNBT.
- Preview soal, pilihan jawaban, pembahasan, caption, dan gambar post.
- Review soal sebelum dipakai.
- Simpan soal bagus ke Bank Review.
- Approve/reject soal.
- Export soal approved.
- Menyimpan data soal dalam bentuk file JSON dan folder.

Struktur penyimpanan saat ini masih berbasis file dan folder, misalnya:

```text
saved/
  <run_id>/
    metadata.json
    soal.json
    caption.txt
    post-1.png
    pembahasan-1.jpg

bank/
  index.json
```

Model ini masih cocok untuk workflow produksi konten karena sederhana, mudah dibuka manual, dan cocok untuk proses review internal.

Namun, model folder seperti ini kurang cocok jika dipakai langsung sebagai database utama untuk website tryout publik. Alasannya:

- Sulit melakukan query kompleks, misalnya berdasarkan subtes, topik, level, status, dan sumber soal.
- Kurang ideal untuk banyak user yang mengakses bersamaan.
- Tidak cocok untuk menyimpan riwayat pengerjaan, jawaban user, nilai, ranking, dan analitik.
- Sulit menjaga konsistensi data jika ada banyak proses membaca dan menulis data.
- Pagination, search, random soal, dan filter akan semakin berat saat jumlah soal bertambah.

Kesimpulannya, project sekarang sebaiknya tetap dipakai sebagai content production tool, bukan langsung dijadikan website tryout.

# Plan Untuk Membuat Website UTBK Tryout

Website UTBK Tryout sebaiknya dibuat sebagai project terpisah dari UTBK content generator.

Pembagian peran project:

```text
latsoal-bot/
  Content generator dan bank review soal.
  Dipakai untuk generate, review, approve, dan export soal.

utbk-tryout-web/
  Website tryout UTBK.
  Dipakai oleh user untuk mengerjakan tryout, melihat nilai, pembahasan, dan riwayat.
```

## Stack yang Disarankan

Backend:

- Golang.
- PostgreSQL.
- REST API.
- JWT atau session-based authentication.
- sqlc, GORM, atau query SQL manual.

Frontend:

- React/Next.js jika ingin frontend modern dan scalable.
- Atau Go templates jika ingin versi awal yang lebih sederhana.

Database:

- PostgreSQL untuk data utama.
- File storage atau object storage untuk aset gambar, PDF, dan file pendukung.

## Alur Data

Alur ideal dari project lama ke project baru:

```text
UTBK Content Generator
  generate soal
  review soal
  approve soal
  export JSON

Website UTBK Tryout
  import JSON approved
  simpan soal ke PostgreSQL
  tampilkan soal ke user
  rekam jawaban user
  hitung skor
  tampilkan pembahasan dan hasil
```

## Fitur Utama Website Tryout

Fitur minimal:

- Login/register user.
- Daftar paket tryout.
- Halaman pengerjaan tryout.
- Timer pengerjaan.
- Navigasi nomor soal.
- Simpan jawaban user.
- Submit tryout.
- Hitung skor otomatis.
- Tampilkan hasil tryout.
- Tampilkan pembahasan.
- Riwayat tryout user.

Fitur lanjutan:

- Ranking peserta.
- Analisis per subtes.
- Analisis benar/salah/kosong.
- Admin panel untuk mengelola paket tryout.
- Import soal dari export project content generator.
- Filter soal berdasarkan subtes, topik, dan level.
- Pembayaran atau akses premium jika website ingin dimonetisasi.

## Struktur Database Awal

Tabel utama yang dibutuhkan:

```text
users
- id
- name
- email
- password_hash
- created_at

questions
- id
- subtest
- topic
- difficulty
- question_text
- explanation
- correct_answer
- source
- status
- created_at

question_options
- id
- question_id
- label
- text

tryouts
- id
- title
- description
- duration_minutes
- status
- created_at

tryout_questions
- id
- tryout_id
- question_id
- number
- weight

attempts
- id
- user_id
- tryout_id
- started_at
- submitted_at
- score
- status

attempt_answers
- id
- attempt_id
- question_id
- selected_option
- is_correct
- answered_at
```

Jika ada soal dengan teks stimulus panjang, bisa ditambahkan:

```text
passages
- id
- title
- body

questions
- passage_id
```

## Tahapan Pengerjaan

Tahap 1: Fondasi project baru.

- Buat repository/project baru.
- Setup Golang backend.
- Setup PostgreSQL.
- Setup migration database.
- Buat struktur API dasar.

Tahap 2: Bank soal.

- Buat schema soal di PostgreSQL.
- Buat importer dari JSON export project lama.
- Buat API untuk mengambil daftar soal.
- Buat API untuk detail soal.

Tahap 3: Paket tryout.

- Buat tabel tryouts dan tryout_questions.
- Buat admin sederhana untuk membuat paket tryout.
- Buat endpoint daftar paket tryout.
- Buat endpoint detail paket tryout.

Tahap 4: Pengerjaan tryout.

- Buat fitur mulai attempt.
- Buat fitur simpan jawaban.
- Buat timer.
- Buat submit attempt.
- Hitung skor otomatis.

Tahap 5: Hasil dan pembahasan.

- Tampilkan nilai akhir.
- Tampilkan jawaban benar/salah.
- Tampilkan pembahasan.
- Tampilkan riwayat tryout user.

Tahap 6: Pengembangan lanjutan.

- Ranking.
- Statistik per subtes.
- Dashboard admin.
- Monetisasi.
- Optimasi performa.
- Deployment.

## Kesimpulan

Project UTBK content generator yang sekarang tetap berguna sebagai alat produksi soal.

Website UTBK Tryout sebaiknya dibuat sebagai project terpisah dengan database SQL, terutama PostgreSQL, agar lebih cocok untuk kebutuhan user, tryout, scoring, history, dan ranking.

Golang cocok dipakai untuk backend project baru karena performanya bagus, deployment relatif sederhana, dan cocok untuk API yang menangani banyak request.
