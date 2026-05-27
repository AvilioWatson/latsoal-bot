# UTBK Content Desk

Manual-first workflow untuk membuat konten latihan soal UTBK/SNBT berdasarkan subtes modern.

## Jalankan Frontend Lokal

```powershell
node server.js
```

Buka:

```text
http://127.0.0.1:8765
```

Jika `GEMINI_API_KEY` belum diset, generator memakai mode draft lokal untuk mengecek alur dan tampilan.

Server lokal memakai Node.js tanpa dependency tambahan. Logic generator tetap di Python.
Jika ingin lewat npm di PowerShell yang memblokir `npm.ps1`, pakai `npm.cmd start`.

## Pakai Gemini

Set environment variable di mesin runner atau terminal lokal:

```powershell
$env:GEMINI_API_KEY="isi_api_key"
```

Jangan commit API key ke repo. Jika key pernah terkirim di chat, issue, atau log, revoke key tersebut dan buat key baru.

Opsional:

```powershell
$env:GEMINI_MODEL="gemini-3.5-flash"
```

## Generate Manual Tanpa UI

```powershell
python content_generator.py --mapel "Penalaran Umum" --topik "Penalaran deduktif" --level sedang --mode auto
```

Output tersimpan di:

```text
outputs/<run-id>/
```

Jika tombol `Simpan` dipakai di dashboard, output pilihan akan dicopy ke:

```text
saved/<run-id>/
```

`saved/` dan `outputs/` diabaikan oleh git karena berisi hasil kerja lokal.
Daftar saved bisa dikelola dari sidebar dashboard dengan status `Saved`, `Approved`, atau `Rejected`.

## GitHub Actions Self-Hosted

Workflow tersedia di `.github/workflows/manual-content.yml` dan hanya berjalan saat dipicu manual dari tab Actions.

Runner memakai:

```yaml
runs-on: self-hosted
```

## Struktur Subtes

Default generator mengikuti struktur UTBK/SNBT modern:

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

Pola referensi tersimpan di:

```text
bank_soal/patterns/
```

Pola ini dipakai sebagai cetakan konsep, bukan untuk menyalin soal.
