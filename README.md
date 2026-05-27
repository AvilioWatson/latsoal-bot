# UTBK Content Desk

Manual-first workflow untuk membuat konten latihan soal UTBK.

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
python content_generator.py --mapel Matematika --topik Statistika --level sedang --mode auto
```

Output tersimpan di:

```text
outputs/<run-id>/
```

## GitHub Actions Self-Hosted

Workflow tersedia di `.github/workflows/manual-content.yml` dan hanya berjalan saat dipicu manual dari tab Actions.

Runner memakai:

```yaml
runs-on: self-hosted
```
