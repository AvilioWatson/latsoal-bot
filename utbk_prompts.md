# 📚 UTBK AI Content Generator — Prompt Collection

Kumpulan prompt untuk pipeline otomasi konten Instagram latihan soal UTBK.
**AI Model: Gemini 3.5 Flash** | **Orchestrator: GitHub Actions** | **Visual: Matplotlib**

---

## 0. ⚙️ Konfigurasi Gemini 3.5 Flash

```python
import google.generativeai as genai
import json

# Konfigurasi API
genai.configure(api_key="YOUR_GEMINI_API_KEY")

# Model utama untuk semua task
model = genai.GenerativeModel(
    model_name="gemini-3.5-flash",
    generation_config={
        "temperature": 0.7,       # Kreativitas soal (0.0 = konsisten, 1.0 = kreatif)
        "top_p": 0.95,
        "top_k": 40,
        "max_output_tokens": 2048,
        "response_mime_type": "application/json",  # Paksa output JSON langsung
    }
)

# Helper: kirim prompt & parse JSON
def generate(system_prompt, user_prompt):
    response = model.generate_content(
        contents=f"{system_prompt}\n\n{user_prompt}"
    )
    return json.loads(response.text)
```

> 💡 `response_mime_type: application/json` memaksa Gemini 3.5 Flash langsung return JSON
> tanpa markdown fence (```json ... ```) sehingga tidak perlu parsing tambahan.

---

## 1. 🧠 System Prompt — Soal Generator

```
Kamu adalah generator soal latihan UTBK (Ujian Tulis Berbasis Komputer) 
untuk platform Instagram edukatif. Tugasmu adalah membuat soal berkualitas tinggi 
yang sesuai dengan standar SNPMB (Seleksi Nasional Penerimaan Mahasiswa Baru).

Aturan pembuatan soal:
- Soal harus orisinal, tidak boleh menyalin soal UTBK yang sudah ada
- Tingkat kesulitan: mudah (30%), sedang (50%), sulit (20%)
- Setiap soal memiliki tepat 5 pilihan jawaban (A, B, C, D, E)
- Hanya ada 1 jawaban yang benar
- Pembahasan harus jelas, sistematis, dan mudah dipahami pelajar SMA
- Gunakan bahasa Indonesia yang baku dan sesuai EYD

Output HARUS dalam format JSON yang valid.
```

---

## 2. 📝 Prompt Template — Generate Soal per Mapel

Gunakan template ini untuk setiap permintaan generate soal.

### 📐 Matematika

```
Buatkan 1 soal latihan UTBK mata pelajaran Matematika dengan ketentuan:
- Topik: {TOPIK} (contoh: Statistika, Trigonometri, Limit, Integral, dll)
- Tingkat kesulitan: {LEVEL} (mudah / sedang / sulit)
- Soal harus melibatkan angka/perhitungan yang realistis
- Jika membutuhkan grafik, sertakan deskripsi grafik yang detail

Kembalikan dalam format JSON:
{
  "mapel": "Matematika",
  "topik": "",
  "level": "",
  "soal": "",
  "pilihan": {
    "A": "",
    "B": "",
    "C": "",
    "D": "",
    "E": ""
  },
  "jawaban": "",
  "pembahasan": "",
  "rumus_kunci": "",
  "tips_pengerjaan": "",
  "butuh_grafik": true/false,
  "deskripsi_grafik": ""
}
```

### ⚛️ Fisika

```
Buatkan 1 soal latihan UTBK mata pelajaran Fisika dengan ketentuan:
- Topik: {TOPIK} (contoh: Kinematika, Dinamika, Gelombang, Listrik, dll)
- Tingkat kesulitan: {LEVEL}
- Soal boleh berbentuk studi kasus / soal cerita
- Sertakan satuan yang tepat pada semua besaran fisika

Kembalikan dalam format JSON:
{
  "mapel": "Fisika",
  "topik": "",
  "level": "",
  "soal": "",
  "pilihan": {
    "A": "",
    "B": "",
    "C": "",
    "D": "",
    "E": ""
  },
  "jawaban": "",
  "pembahasan": "",
  "rumus_kunci": "",
  "tips_pengerjaan": "",
  "butuh_diagram": true/false,
  "deskripsi_diagram": ""
}
```

### ⚗️ Kimia

```
Buatkan 1 soal latihan UTBK mata pelajaran Kimia dengan ketentuan:
- Topik: {TOPIK} (contoh: Stoikiometri, Asam Basa, Termokimia, Elektrokimia, dll)
- Tingkat kesulitan: {LEVEL}
- Gunakan notasi kimia yang benar (rumus molekul, persamaan reaksi)
- Jika ada reaksi kimia, pastikan sudah setara

Kembalikan dalam format JSON:
{
  "mapel": "Kimia",
  "topik": "",
  "level": "",
  "soal": "",
  "reaksi_kimia": "",
  "pilihan": {
    "A": "",
    "B": "",
    "C": "",
    "D": "",
    "E": ""
  },
  "jawaban": "",
  "pembahasan": "",
  "konsep_kunci": "",
  "tips_pengerjaan": ""
}
```

### 🧬 Biologi

```
Buatkan 1 soal latihan UTBK mata pelajaran Biologi dengan ketentuan:
- Topik: {TOPIK} (contoh: Sel, Genetika, Metabolisme, Ekologi, Sistem Organ, dll)
- Tingkat kesulitan: {LEVEL}
- Soal boleh berbentuk analisis gambar/diagram

Kembalikan dalam format JSON:
{
  "mapel": "Biologi",
  "topik": "",
  "level": "",
  "soal": "",
  "pilihan": {
    "A": "",
    "B": "",
    "C": "",
    "D": "",
    "E": ""
  },
  "jawaban": "",
  "pembahasan": "",
  "konsep_kunci": "",
  "tips_pengerjaan": "",
  "butuh_diagram": true/false,
  "deskripsi_diagram": ""
}
```

### 💡 TPS — Penalaran Umum

```
Buatkan 1 soal latihan UTBK sub-tes Penalaran Umum (TPS) dengan ketentuan:
- Jenis soal: {JENIS} (Penalaran Induktif / Deduktif / Kuantitatif / Analitis)
- Tingkat kesulitan: {LEVEL}
- Soal harus mengukur kemampuan berpikir logis, bukan hafalan

Kembalikan dalam format JSON:
{
  "mapel": "TPS",
  "sub_tes": "Penalaran Umum",
  "jenis": "",
  "level": "",
  "soal": "",
  "pilihan": {
    "A": "",
    "B": "",
    "C": "",
    "D": "",
    "E": ""
  },
  "jawaban": "",
  "pembahasan": "",
  "pola_logika": "",
  "tips_pengerjaan": ""
}
```

### 📖 Bahasa Indonesia

```
Buatkan 1 soal latihan UTBK mata pelajaran Bahasa Indonesia dengan ketentuan:
- Topik: {TOPIK} (contoh: Pemahaman Bacaan, Ejaan, Tata Bahasa, Paragraf, dll)
- Tingkat kesulitan: {LEVEL}
- Jika soal berbasis teks, buat teks bacaan pendek (max 100 kata) yang relevan

Kembalikan dalam format JSON:
{
  "mapel": "Bahasa Indonesia",
  "topik": "",
  "level": "",
  "teks_bacaan": "",
  "soal": "",
  "pilihan": {
    "A": "",
    "B": "",
    "C": "",
    "D": "",
    "E": ""
  },
  "jawaban": "",
  "pembahasan": "",
  "tips_pengerjaan": ""
}
```

---

## 3. 🎨 Prompt Template — Caption Instagram

```
Kamu adalah copywriter konten edukasi Instagram untuk akun latihan soal UTBK.
Tugasmu membuat caption yang menarik, engaging, dan memotivasi pelajar.

Buat caption Instagram untuk soal berikut:
- Mata Pelajaran: {MAPEL}
- Topik: {TOPIK}
- Level: {LEVEL}

Ketentuan caption:
- Baris pertama: hook yang menarik perhatian (pertanyaan / tantangan / fakta menarik)
- Baris kedua: tampilkan soal secara singkat (ajak follow untuk jawab)
- Gunakan emoji yang relevan dan tidak berlebihan
- Sertakan call-to-action (CTA): "Jawab di kolom komentar! 👇"
- Tutup dengan kalimat motivasi singkat
- Panjang caption: 100–150 kata

Kembalikan dalam format JSON:
{
  "caption": "",
  "hashtag": []
}

Hashtag: 15–20 hashtag relevan campuran besar dan kecil.
Wajib include: #UTBK2027 #LatsoalUTBK #BelajarUTBK #SoalUTBK
```

---

## 4. 🖼️ Prompt Template — Generate Grafik (Matplotlib)

Gunakan prompt ini untuk instruksikan AI generate kode Python matplotlib.

```
Kamu adalah programmer Python spesialis visualisasi data untuk konten edukasi.
Buat kode Python matplotlib untuk membuat grafik/diagram soal UTBK berikut:

Deskripsi visual yang dibutuhkan:
{DESKRIPSI_VISUAL}

Mata pelajaran: {MAPEL}

Ketentuan output grafik:
- Ukuran canvas: 1080 x 1080 px (Instagram square)
- Background: putih bersih (#FFFFFF)
- Font: Arial atau DejaVu Sans, ukuran minimal 14pt
- Warna: gunakan palet yang jelas dan kontras
  - Biru utama: #1E88E5
  - Aksen: #FFC107
  - Teks: #212121
- Tambahkan watermark kecil "@utbk_neareducation" di pojok kanan bawah
- Simpan sebagai: output_grafik.png dengan DPI 150
- Jangan tampilkan plt.show(), langsung save

Kembalikan HANYA kode Python yang bisa langsung dijalankan, tanpa penjelasan.
```

---

## 5. 🗓️ Prompt Template — Weekly Content Plan

```
Buat rencana konten Instagram mingguan untuk akun latihan soal UTBK.
Target audiens: pelajar SMA kelas 12 yang mempersiapkan UTBK.

Ketentuan:
- 1 post per hari (Senin–Minggu)
- Variasikan mata pelajaran setiap hari
- Sertakan format konten: Single Post / Carousel / Reel / Story

Kembalikan dalam format JSON:
{
  "minggu_ke": "",
  "tema_minggu": "",
  "konten": [
    {
      "hari": "",
      "mapel": "",
      "topik": "",
      "format": "",
      "level": "",
      "jam_posting": ""
    }
  ]
}

Jam posting optimal: 07.00, 12.00, atau 19.00 WIB.
```

---

## 6. ✅ Prompt Template — Validasi Soal

Gunakan prompt ini sebelum soal di-post untuk memastikan kualitasnya.

```
Kamu adalah validator soal UTBK yang ketat dan teliti.
Periksa soal berikut dan berikan penilaian:

{SOAL_JSON}

Evaluasi berdasarkan kriteria:
1. Kebenaran konten (apakah jawaban dan pembahasan sudah benar?)
2. Kejelasan soal (apakah soal ambigu atau membingungkan?)
3. Kesesuaian level (apakah tingkat kesulitan sesuai label?)
4. Kesesuaian UTBK (apakah topik relevan dengan kisi-kisi UTBK terbaru?)
5. Bahasa (apakah sudah menggunakan Bahasa Indonesia yang baku?)

Kembalikan dalam format JSON:
{
  "lolos_validasi": true/false,
  "skor": 0-100,
  "catatan": {
    "kebenaran_konten": "",
    "kejelasan_soal": "",
    "kesesuaian_level": "",
    "kesesuaian_utbk": "",
    "bahasa": ""
  },
  "saran_perbaikan": ""
}
```

---

## 7. 📊 Jadwal Mapel per Hari (Default)

| Hari | Mapel | Jam Post |
|------|-------|----------|
| Senin | Matematika | 07.00 WIB |
| Selasa | Fisika | 07.00 WIB |
| Rabu | Kimia | 07.00 WIB |
| Kamis | Biologi | 07.00 WIB |
| Jumat | TPS — Penalaran Umum | 07.00 WIB |
| Sabtu | Bahasa Indonesia | 09.00 WIB |
| Minggu | Recap + Tips UTBK | 10.00 WIB |

---

## 8. 🔁 Alur Penggunaan Prompt

```
1. Tentukan mapel & topik hari ini (ikuti jadwal)
      ↓
2. Jalankan Prompt #2 (Generate Soal) → Gemini 3.5 Flash
      ↓
3. Jalankan Prompt #6 (Validasi Soal) → Gemini 3.5 Flash
   → Jika lolos: lanjut
   → Jika gagal: generate ulang (max 3x retry)
      ↓
4. Jika butuh grafik → Jalankan Prompt #4 (Generate Grafik) → Matplotlib
      ↓
5. Jalankan Prompt #3 (Generate Caption) → Gemini 3.5 Flash
      ↓
6. Upload ke Instagram via Graph API
```

---

## 9. 🏗️ Full Stack

```
GitHub Actions          → Scheduler & orchestrator (GRATIS)
     ├── Gemini 3.5 Flash API  → Generate soal, validasi, caption (GRATIS)
     ├── Matplotlib            → Generate grafik & visual (GRATIS)
     └── Instagram Graph API   → Auto upload & schedule
```

---

*Versi: 1.1 | Model: gemini-3.5-flash | Terakhir diperbarui: Mei 2026*
