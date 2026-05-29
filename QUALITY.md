# Quality Gate

Jalankan sebelum merge atau sebelum sesi produksi:

```powershell
npm.cmd run check
```

Gate ini memeriksa:

- sintaks semua file JavaScript server, route, lib, dan frontend;
- JSON config dan pattern soal;
- audit git tracking agar file runtime lokal (`outputs/`, `saved/`, `approved/`, `bank/index.json`, `.env`) tidak ikut commit;
- secret scan ringan untuk file tracked dan untracked non-ignored;
- kontrak endpoint di `API.md` mencakup route utama aplikasi;
- line ending source/docs/config tracked dan untracked non-ignored dijaga LF lewat `.gitattributes` dan quality check;
- workflow manual generate menjalankan quality gate sebelum membuat artifact;
- unit/integration test Node;
- compile dan unit test Python;
- sinkronisasi config Python dengan `config/*.json`;
- smoke test generator mode `draft` dengan cleanup output.

Gate akan gagal jika file test Node atau Python tidak ditemukan, supaya rename/move test tidak membuat suite kosong tampak hijau.

## Runtime Safety

- Gunakan `LATSOAL_DATA_ROOT` untuk test/eksperimen agar data utama `outputs/`, `saved/`, `approved/`, dan `bank/` tidak tersentuh.
- Jangan commit `.env`, output runtime, atau file hasil export.
- Review item fallback dan duplikat secara manual sebelum approve.

## Release Checklist

- `npm.cmd run check` hijau.
- README sesuai perilaku aplikasi saat ini.
- `config/topics.json` dan `config/patterns.json` sinkron dengan file pattern.
- Generate mode `draft` berhasil.
- Halaman `/`, `/saved`, `/stats`, dan `/health` bisa diakses saat server berjalan.
