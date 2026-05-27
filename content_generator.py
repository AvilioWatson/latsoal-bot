import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import textwrap
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "outputs"
BANK_DIR = ROOT / "bank_soal" / "patterns"


def load_env_file():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file()
DEFAULT_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
MAX_GEMINI_RETRIES = int(os.getenv("GEMINI_RETRIES", "3"))
GEMINI_MAX_OUTPUT_TOKENS = int(os.getenv("GEMINI_MAX_OUTPUT_TOKENS", "4096"))
GEMINI_VALIDATE = os.getenv("GEMINI_VALIDATE", "").lower() in {"1", "true", "yes"}
GEMINI_CAPTION = os.getenv("GEMINI_CAPTION", "").lower() in {"1", "true", "yes"}
GEMINI_USAGE = []


MAPEL_TOPICS = {
    "Penalaran Umum": [
        "Penalaran deduktif",
        "Penalaran induktif",
        "Analogi",
        "Sebab akibat",
        "Penalaran analitis",
    ],
    "Pengetahuan dan Pemahaman Umum": [
        "Makna kata",
        "Hubungan antarkalimat",
        "Ide pokok",
        "Simpulan teks",
        "Kesesuaian pernyataan",
    ],
    "Pemahaman Bacaan dan Menulis": [
        "Kalimat efektif",
        "Ejaan",
        "Kohesi dan koherensi",
        "Paragraf padu",
        "Perbaikan kalimat",
    ],
    "Pengetahuan Kuantitatif": [
        "Aritmetika",
        "Aljabar dasar",
        "Perbandingan",
        "Peluang",
        "Statistika",
    ],
    "Literasi Bahasa Indonesia": [
        "Pemahaman teks informatif",
        "Pemahaman teks argumentatif",
        "Simpulan bacaan",
        "Tujuan penulis",
        "Evaluasi pernyataan",
    ],
    "Literasi Bahasa Inggris": [
        "Main idea",
        "Inference",
        "Vocabulary in context",
        "Author purpose",
        "Detail information",
    ],
    "Penalaran Matematika": [
        "Data dan ketidakpastian",
        "Bilangan",
        "Aljabar",
        "Geometri",
        "Pemodelan matematika",
    ],
}


PATTERN_FILES = {
    "Penalaran Umum": "penalaran_umum.json",
    "Pengetahuan dan Pemahaman Umum": "pengetahuan_pemahaman_umum.json",
    "Pemahaman Bacaan dan Menulis": "pemahaman_bacaan_menulis.json",
    "Pengetahuan Kuantitatif": "pengetahuan_kuantitatif.json",
    "Literasi Bahasa Indonesia": "literasi_bahasa_indonesia.json",
    "Literasi Bahasa Inggris": "literasi_bahasa_inggris.json",
    "Penalaran Matematika": "penalaran_matematika.json",
}


QUESTION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "mapel": {"type": "STRING"},
        "kelompok_tes": {"type": "STRING"},
        "topik": {"type": "STRING"},
        "level": {"type": "STRING"},
        "soal": {"type": "STRING"},
        "pilihan": {
            "type": "OBJECT",
            "properties": {
                "A": {"type": "STRING"},
                "B": {"type": "STRING"},
                "C": {"type": "STRING"},
                "D": {"type": "STRING"},
                "E": {"type": "STRING"},
            },
            "required": ["A", "B", "C", "D", "E"],
        },
        "jawaban": {"type": "STRING"},
        "pembahasan": {"type": "STRING"},
        "konsep_kunci": {"type": "STRING"},
        "tips_pengerjaan": {"type": "STRING"},
        "butuh_visual": {"type": "BOOLEAN"},
        "deskripsi_visual": {"type": "STRING"},
    },
    "required": [
        "mapel",
        "kelompok_tes",
        "topik",
        "level",
        "soal",
        "pilihan",
        "jawaban",
        "pembahasan",
        "konsep_kunci",
        "tips_pengerjaan",
        "butuh_visual",
        "deskripsi_visual",
    ],
}


VALIDATION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "lolos_validasi": {"type": "BOOLEAN"},
        "skor": {"type": "INTEGER"},
        "catatan": {
            "type": "OBJECT",
            "properties": {
                "struktur": {"type": "STRING"},
                "kebenaran": {"type": "STRING"},
                "bahasa": {"type": "STRING"},
            },
        },
        "saran_perbaikan": {"type": "STRING"},
    },
    "required": ["lolos_validasi", "skor", "catatan", "saran_perbaikan"],
}


CAPTION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "caption": {"type": "STRING"},
        "hashtag": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
        },
    },
    "required": ["caption", "hashtag"],
}


def _now_id():
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def _extract_json(text):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("Response tidak berisi JSON.")
    return json.loads(match.group(0))


def clean_error_message(exc):
    text = str(exc)
    if "429" in text or "RESOURCE_EXHAUSTED" in text:
        return "Kuota Gemini habis untuk model/free tier saat ini."
    if "WinError 10013" in text or "urlopen error" in text:
        return "Akses jaringan ke Gemini belum tersedia dari proses ini."
    if "Gagal parse JSON Gemini" in text:
        return "Gemini mengembalikan JSON yang tidak valid."
    return text[:240]


def _gemini_json(prompt, label, retries=MAX_GEMINI_RETRIES, schema=None):
    last_error = None
    strict_prompt = (
        f"{prompt}\n\n"
        "PENTING: Balas hanya dengan satu objek JSON valid. "
        "Jangan gunakan markdown, komentar, trailing comma, atau teks tambahan. "
        "Semua string harus memakai kutip ganda dan newline di dalam string harus di-escape."
    )
    for attempt in range(1, retries + 1):
        try:
            return _extract_json(_gemini_generate(strict_prompt, schema=schema))
        except Exception as exc:
            clean_error = clean_error_message(exc)
            if clean_error != str(exc):
                raise RuntimeError(clean_error) from exc
            last_error = exc
            strict_prompt = (
                f"{prompt}\n\n"
                f"Percobaan sebelumnya untuk {label} gagal diparse sebagai JSON valid: {exc}. "
                "Kirim ulang hanya satu objek JSON valid RFC 8259. "
                "Jangan ada teks pembuka, markdown, trailing comma, atau newline mentah di dalam string."
            )
    raise ValueError(f"Gagal parse JSON Gemini untuk {label} setelah {retries} percobaan: {clean_error_message(last_error)}")


def _gemini_generate(prompt, schema=None):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY belum tersedia.")

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{DEFAULT_MODEL}:generateContent?key={api_key}"
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.7,
            "topP": 0.95,
            "topK": 40,
            "maxOutputTokens": GEMINI_MAX_OUTPUT_TOKENS,
            "responseMimeType": "application/json",
        },
    }
    if schema:
        payload["generationConfig"]["responseSchema"] = schema
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini API gagal: {exc.code} {message}") from exc

    usage = raw.get("usageMetadata")
    if usage:
        GEMINI_USAGE.append({
            "model": DEFAULT_MODEL,
            "prompt_tokens": usage.get("promptTokenCount"),
            "output_tokens": usage.get("candidatesTokenCount"),
            "total_tokens": usage.get("totalTokenCount"),
        })

    try:
        candidate = raw["candidates"][0]
        finish_reason = candidate.get("finishReason")
        text = candidate["content"]["parts"][0]["text"]
        if finish_reason == "MAX_TOKENS":
            raise RuntimeError(
                f"Output Gemini terpotong karena maxOutputTokens={GEMINI_MAX_OUTPUT_TOKENS}."
            )
        return text
    except (KeyError, IndexError) as exc:
        raise RuntimeError("Format response Gemini tidak dikenali.") from exc


def load_patterns(mapel, topic, limit=2):
    pattern_file = PATTERN_FILES.get(mapel)
    if not pattern_file:
        return []
    path = BANK_DIR / pattern_file
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    patterns = data.get("patterns", [])
    topic_lower = topic.lower()
    matched = [
        pattern for pattern in patterns
        if topic_lower in " ".join([
            str(pattern.get("topik", "")),
            str(pattern.get("tipe", "")),
            " ".join(pattern.get("konsep_kunci", [])),
        ]).lower()
    ]
    selected = matched or patterns
    return selected[:limit]


def build_question_prompt(mapel, topic, level):
    base_rules = """
Kamu adalah generator soal latihan UTBK/SNBT untuk platform Instagram edukatif.
Buat soal orisinal sesuai format SNBT modern, bukan format mapel Saintek/Soshum lama.
Gunakan bahasa Indonesia baku. Setiap soal punya tepat 5 pilihan A sampai E,
hanya 1 jawaban benar, dan pembahasan jelas untuk pelajar SMA.
Jika memakai pola referensi, gunakan hanya struktur konsepnya. Jangan menyalin kalimat,
angka, konteks, atau pilihan dari contoh/pola referensi.
Output harus JSON valid tanpa markdown.
""".strip()

    patterns = load_patterns(mapel, topic)
    schema = {
        "mapel": mapel,
        "kelompok_tes": "TPS" if mapel in [
            "Penalaran Umum",
            "Pengetahuan dan Pemahaman Umum",
            "Pemahaman Bacaan dan Menulis",
            "Pengetahuan Kuantitatif",
        ] else "Literasi",
        "topik": topic,
        "level": level,
        "soal": "",
        "pilihan": {"A": "", "B": "", "C": "", "D": "", "E": ""},
        "jawaban": "",
        "pembahasan": "",
        "konsep_kunci": "",
        "tips_pengerjaan": "",
        "butuh_visual": False,
        "deskripsi_visual": "",
    }
    return (
        f"{base_rules}\n\n"
        f"Buatkan 1 soal latihan UTBK/SNBT subtes {mapel}.\n"
        f"Topik: {topic}\n"
        f"Tingkat kesulitan: {level}\n\n"
        "Pola referensi yang boleh dipakai sebagai cetakan konsep, bukan untuk disalin:\n"
        f"{json.dumps(patterns, ensure_ascii=False, indent=2)}\n\n"
        "Kembalikan JSON dengan struktur berikut:\n"
        f"{json.dumps(schema, ensure_ascii=False, indent=2)}"
    )


def build_validation_prompt(question):
    return (
        "Kamu adalah validator soal UTBK yang ketat dan teliti. "
        "Periksa kebenaran konten, kejelasan soal, kesesuaian level, "
        "kesesuaian UTBK, dan bahasa. Output harus JSON valid.\n\n"
        f"{json.dumps(question, ensure_ascii=False)}\n\n"
        "Kembalikan JSON: "
        '{"lolos_validasi": true, "skor": 0, "catatan": {}, "saran_perbaikan": ""}'
    )


def build_caption_prompt(question):
    return (
        "Kamu adalah copywriter konten edukasi Instagram untuk akun latihan soal UTBK. "
        "Buat caption 100 sampai 150 kata, ada hook, CTA jawab di komentar, "
        "motivasi singkat, dan hashtag relevan. "
        "Wajib pakai konteks UTBK 2026. Jangan memakai tahun 2024 atau 2025. "
        "Hashtag wajib diawali tanda # dan wajib memuat #UTBK2026, #LatsoalUTBK, "
        "#BelajarUTBK, dan #SoalUTBK. Output JSON valid.\n\n"
        f"{json.dumps(question, ensure_ascii=False)}\n\n"
        'Kembalikan JSON: {"caption": "", "hashtag": []}'
    )


def draft_question(mapel, topic, level):
    kelompok_tes = "TPS" if mapel in [
        "Penalaran Umum",
        "Pengetahuan dan Pemahaman Umum",
        "Pemahaman Bacaan dan Menulis",
        "Pengetahuan Kuantitatif",
    ] else "Literasi"

    templates = {
        "Penalaran Umum": {
            "soal": (
                "Semua peserta yang disiplin mengerjakan latihan secara rutin. "
                "Sebagian peserta yang mengerjakan latihan secara rutin mengalami peningkatan skor. "
                "Simpulan yang pasti benar adalah..."
            ),
            "pilihan": {
                "A": "Semua peserta yang disiplin mengalami peningkatan skor.",
                "B": "Sebagian peserta yang disiplin mungkin mengalami peningkatan skor.",
                "C": "Tidak ada peserta disiplin yang mengalami peningkatan skor.",
                "D": "Semua peserta yang meningkat skornya pasti disiplin.",
                "E": "Peserta yang tidak rutin berlatih pasti tidak disiplin.",
            },
            "jawaban": "B",
            "pembahasan": (
                "Premis pertama menyatakan semua peserta disiplin termasuk kelompok yang rutin latihan. "
                "Premis kedua menyatakan sebagian kelompok rutin mengalami peningkatan skor. "
                "Karena tidak dijamin bahwa bagian yang meningkat adalah semua peserta disiplin, simpulan paling aman adalah kemungkinan sebagian peserta disiplin mengalami peningkatan skor."
            ),
            "konsep_kunci": "Simpulan valid dari premis",
        },
        "Pengetahuan dan Pemahaman Umum": {
            "soal": (
                "Perhatikan kalimat berikut.\n"
                "(1) Banyak siswa mulai memakai aplikasi belajar daring. "
                "(2) Aplikasi tersebut memudahkan siswa mengakses latihan kapan saja. "
                "Hubungan antarkalimat yang paling tepat adalah..."
            ),
            "pilihan": {
                "A": "Kalimat (2) menyatakan akibat dari kalimat (1).",
                "B": "Kalimat (2) memberikan penjelasan terhadap kalimat (1).",
                "C": "Kalimat (2) bertentangan dengan kalimat (1).",
                "D": "Kalimat (2) menyatakan perbandingan dengan kalimat (1).",
                "E": "Kalimat (2) merupakan simpulan yang tidak berkaitan dengan kalimat (1).",
            },
            "jawaban": "B",
            "pembahasan": (
                "Kalimat (1) menyampaikan fakta umum bahwa banyak siswa memakai aplikasi belajar daring. "
                "Kalimat (2) menjelaskan alasan atau manfaat dari aplikasi tersebut, yaitu memudahkan akses latihan. "
                "Jadi, kalimat (2) berfungsi sebagai penjelasan terhadap kalimat (1)."
            ),
            "konsep_kunci": "Fungsi kalimat dan koherensi",
        },
        "Pemahaman Bacaan dan Menulis": {
            "soal": (
                "Kalimat berikut belum efektif: Para siswa-siswa diminta untuk mengumpulkan tugasnya masing-masing sebelum jam pelajaran dimulai. "
                "Perbaikan yang paling efektif adalah..."
            ),
            "pilihan": {
                "A": "Para siswa-siswa diminta mengumpulkan tugas sebelum jam pelajaran dimulai.",
                "B": "Siswa-siswa diminta untuk mengumpulkan tugasnya masing-masing sebelum jam pelajaran dimulai.",
                "C": "Para siswa diminta mengumpulkan tugas sebelum jam pelajaran dimulai.",
                "D": "Para siswa diminta untuk mengumpulkan tugasnya masing-masing sebelum jam pelajaran akan dimulai.",
                "E": "Semua para siswa diminta mengumpulkan tugas sebelum jam pelajaran dimulai.",
            },
            "jawaban": "C",
            "pembahasan": (
                "Bentuk 'para siswa-siswa' tidak efektif karena penanda jamak digunakan ganda. "
                "Kata 'untuk' dan 'masing-masing' juga tidak wajib dalam konteks ini. "
                "Kalimat paling hemat, jelas, dan tetap bermakna sama adalah pilihan C."
            ),
            "konsep_kunci": "Kalimat efektif",
        },
        "Pengetahuan Kuantitatif": {
            "soal": (
                "Rata-rata nilai 5 siswa adalah 78. Empat nilai yang diketahui adalah 72, 80, 76, dan 84. "
                "Nilai siswa kelima adalah..."
            ),
            "pilihan": {"A": "76", "B": "78", "C": "80", "D": "82", "E": "84"},
            "jawaban": "B",
            "pembahasan": (
                "Jumlah seluruh nilai adalah 5 x 78 = 390. "
                "Jumlah empat nilai yang diketahui adalah 72 + 80 + 76 + 84 = 312. "
                "Maka nilai siswa kelima adalah 390 - 312 = 78."
            ),
            "konsep_kunci": "Rata-rata",
        },
        "Literasi Bahasa Indonesia": {
            "soal": (
                "Bacalah teks berikut. Program membaca singkat di sekolah dapat membantu siswa membangun kebiasaan memahami teks. "
                "Kegiatan ini tidak harus berlangsung lama, tetapi perlu dilakukan konsisten agar siswa terbiasa menemukan informasi utama. "
                "Pernyataan yang sesuai dengan teks adalah..."
            ),
            "pilihan": {
                "A": "Program membaca hanya efektif jika dilakukan dalam waktu lama.",
                "B": "Konsistensi kegiatan membaca membantu siswa memahami informasi utama.",
                "C": "Siswa tidak perlu membaca teks untuk menemukan informasi utama.",
                "D": "Program membaca singkat selalu menggantikan pelajaran lain.",
                "E": "Kebiasaan membaca tidak berhubungan dengan pemahaman teks.",
            },
            "jawaban": "B",
            "pembahasan": (
                "Teks menyatakan bahwa kegiatan membaca tidak harus lama, tetapi perlu dilakukan konsisten agar siswa terbiasa menemukan informasi utama. "
                "Pernyataan yang paling sesuai adalah pilihan B."
            ),
            "konsep_kunci": "Informasi eksplisit",
        },
        "Literasi Bahasa Inggris": {
            "soal": (
                "Read the text. Many students use short study sessions to stay consistent. "
                "Although each session may seem simple, regular practice helps them remember concepts better. "
                "What is the main idea of the text?"
            ),
            "pilihan": {
                "A": "Long study sessions are always better than short ones.",
                "B": "Regular short practice can support better learning.",
                "C": "Students should avoid simple study sessions.",
                "D": "Remembering concepts does not require practice.",
                "E": "Consistency is unrelated to learning.",
            },
            "jawaban": "B",
            "pembahasan": (
                "Teks menekankan bahwa sesi belajar singkat yang dilakukan secara rutin membantu siswa mengingat konsep dengan lebih baik. "
                "Gagasan utama paling tepat adalah pilihan B."
            ),
            "konsep_kunci": "Main idea",
        },
        "Penalaran Matematika": {
            "soal": (
                "Sebuah toko mencatat penjualan buku selama tiga hari: Senin 24 buku, Selasa 30 buku, dan Rabu 36 buku. "
                "Jika pola kenaikan penjualan tetap sama, banyak buku yang terjual pada Kamis adalah..."
            ),
            "pilihan": {"A": "38", "B": "40", "C": "42", "D": "44", "E": "46"},
            "jawaban": "C",
            "pembahasan": (
                "Penjualan naik 6 buku setiap hari: 24 ke 30 naik 6, 30 ke 36 naik 6. "
                "Jika pola tetap sama, penjualan Kamis adalah 36 + 6 = 42."
            ),
            "konsep_kunci": "Pola bilangan dalam konteks data",
        },
    }

    template = templates.get(mapel, templates["Penalaran Umum"])
    return {
        "mapel": mapel,
        "kelompok_tes": kelompok_tes,
        "topik": topic,
        "level": level,
        "soal": template["soal"],
        "pilihan": template["pilihan"],
        "jawaban": template["jawaban"],
        "pembahasan": template["pembahasan"],
        "konsep_kunci": template["konsep_kunci"],
        "tips_pengerjaan": "Identifikasi informasi penting, eliminasi opsi yang tidak konsisten, lalu cek jawaban.",
        "butuh_visual": False,
        "deskripsi_visual": "",
    }


def local_validation(question):
    choices = question.get("pilihan", {})
    answer = question.get("jawaban", "")
    required = ["mapel", "topik", "level", "soal", "pilihan", "jawaban", "pembahasan"]
    missing = [key for key in required if not question.get(key)]
    valid_choices = sorted(choices.keys()) == ["A", "B", "C", "D", "E"]
    answer_ok = answer in choices
    score = 100
    if missing:
        score -= 25
    if not valid_choices:
        score -= 25
    if not answer_ok:
        score -= 25
    if len(question.get("pembahasan", "")) < 80:
        score -= 10
    return {
        "lolos_validasi": score >= 80,
        "skor": max(score, 0),
        "catatan": {
            "struktur": "Lengkap" if not missing else f"Field kosong: {', '.join(missing)}",
            "pilihan": "A sampai E tersedia" if valid_choices else "Pilihan harus tepat A sampai E",
            "jawaban": "Jawaban ada di pilihan" if answer_ok else "Jawaban tidak cocok dengan pilihan",
        },
        "saran_perbaikan": "" if score >= 80 else "Perbaiki struktur soal sebelum diposting.",
    }


def draft_caption(question):
    concept = question.get("konsep_kunci") or question.get("topik")
    caption = (
        f"Latihan {question['mapel']} hari ini: {question['topik']}.\n\n"
        f"Topik ini sering menguji ketelitian membaca pola dan hubungan informasi. "
        f"Kerjakan dulu sebelum melihat pembahasan, lalu cek apakah pilihanmu sudah sejalan dengan konsep {concept}.\n\n"
        f"Menurutmu jawabannya apa? Tulis A, B, C, D, atau E di komentar. "
        "Konsisten latihan kecil seperti ini akan membuatmu lebih siap menghadapi UTBK 2026."
    )
    return {
        "caption": caption,
        "hashtag": [
            "#UTBK2026",
            "#LatsoalUTBK",
            "#BelajarUTBK",
            "#SoalUTBK",
            "#PejuangUTBK",
            "#BelajarSMA",
            "#MasukPTN",
            "#SNPMB",
            "#TryoutUTBK",
            "#TipsUTBK",
        ],
    }


def wrap_lines(text, width):
    lines = []
    for paragraph in str(text).splitlines() or [""]:
        if not paragraph.strip():
            lines.append("")
            continue
        lines.extend(textwrap.wrap(paragraph, width=width, break_long_words=False))
    return lines


def svg_text_block(lines, x, y, size=28, weight=500, color="oklch(0.22 0.02 255)", line_height=1.35):
    output = []
    cursor = y
    for line in lines:
        safe = html.escape(line)
        output.append(
            f'<text x="{x}" y="{cursor}" font-size="{size}" font-weight="{weight}" '
            f'fill="{color}">{safe}</text>'
        )
        cursor += int(size * line_height)
    return "\n".join(output), cursor


def render_svg(question, output_path, variant):
    title = "Latihan UTBK" if variant == "soal" else "Pembahasan"
    accent = "#2767d8"
    ink = "#252a33"
    muted = "#69707d"
    bg = "#f8f9fb"
    panel = "#eceff4"

    blocks = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">',
        f'<rect width="1080" height="1080" fill="{bg}"/>',
        f'<rect x="62" y="64" width="956" height="952" rx="8" fill="{panel}" stroke="#d1d7e2"/>',
        f'<text x="88" y="126" font-size="34" font-weight="700" fill="{ink}">{title}</text>',
        f'<text x="88" y="170" font-size="22" font-weight="600" fill="{accent}">{html.escape(question["mapel"])} / {html.escape(question["topik"])} / {html.escape(question["level"])}</text>',
    ]

    if variant == "soal":
        text, y = svg_text_block(wrap_lines(question["soal"], 42), 88, 244, 31, 650, ink)
        blocks.append(text)
        y += 34
        for key, value in question["pilihan"].items():
            blocks.append(f'<circle cx="106" cy="{y - 9}" r="17" fill="{accent}"/>')
            blocks.append(f'<text x="100" y="{y}" font-size="19" font-weight="800" fill="{bg}">{key}</text>')
            lines = wrap_lines(value, 48)
            text, y = svg_text_block(lines, 142, y, 25, 500, ink)
            blocks.append(text)
            y += 20
    else:
        answer = f"Jawaban: {question.get('jawaban', '')}"
        blocks.append(f'<text x="88" y="246" font-size="30" font-weight="750" fill="{accent}">{html.escape(answer)}</text>')
        text, y = svg_text_block(wrap_lines(question["pembahasan"], 48), 88, 312, 27, 500, ink)
        blocks.append(text)
        y += 28
        tip = question.get("tips_pengerjaan") or question.get("konsep_kunci") or ""
        if tip:
            blocks.append(f'<text x="88" y="{y}" font-size="24" font-weight="700" fill="{muted}">Tips</text>')
            text, _ = svg_text_block(wrap_lines(tip, 52), 88, y + 42, 23, 500, muted)
            blocks.append(text)

    blocks.extend(
        [
            f'<text x="88" y="958" font-size="20" font-weight="600" fill="{muted}">Manual review sebelum upload</text>',
            f'<text x="844" y="958" font-size="20" font-weight="700" fill="{muted}">@namaakun</text>',
            "</svg>",
        ]
    )
    output_path.write_text("\n".join(blocks), encoding="utf-8")


def generate_content(mapel, topic, level, mode="auto", account="@namaakun"):
    GEMINI_USAGE.clear()
    run_id = _now_id()
    run_dir = OUTPUT_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    use_gemini = mode != "draft" and bool(os.getenv("GEMINI_API_KEY"))
    source = "draft"
    fallbacks = []
    errors = {}

    if use_gemini:
        source = "gemini"
        try:
            question = _gemini_json(
                build_question_prompt(mapel, topic, level),
                "soal",
                schema=QUESTION_SCHEMA,
            )
        except Exception as exc:
            source = "fallback"
            question = draft_question(mapel, topic, level)
            fallbacks.append("question")
            errors["question"] = clean_error_message(exc)

        if GEMINI_VALIDATE and "question" not in fallbacks:
            try:
                validation = _gemini_json(
                    build_validation_prompt(question),
                    "validasi",
                    retries=2,
                    schema=VALIDATION_SCHEMA,
                )
            except Exception as exc:
                validation = local_validation(question)
                validation["saran_perbaikan"] = (
                    validation.get("saran_perbaikan", "")
                    + f" Fallback lokal dipakai karena validasi Gemini gagal diparse: {exc}"
                ).strip()
                fallbacks.append("validation")
                errors["validation"] = clean_error_message(exc)
        else:
            validation = local_validation(question)
            fallbacks.append("validation")

        if GEMINI_CAPTION and "question" not in fallbacks:
            try:
                caption = _gemini_json(
                    build_caption_prompt(question),
                    "caption",
                    retries=2,
                    schema=CAPTION_SCHEMA,
                )
            except Exception as exc:
                caption = draft_caption(question)
                fallbacks.append("caption")
                errors["caption"] = clean_error_message(exc)
        else:
            caption = draft_caption(question)
            fallbacks.append("caption")
    else:
        question = draft_question(mapel, topic, level)
        validation = local_validation(question)
        caption = draft_caption(question)

    question["akun"] = account
    render_svg(question, run_dir / "post-soal.svg", "soal")
    render_svg(question, run_dir / "post-pembahasan.svg", "pembahasan")
    review_status = "needs_review" if "question" in fallbacks else "ready"
    if errors:
        review_status = "needs_review"

    metadata = {
        "run_id": run_id,
        "source": source,
        "fallbacks": fallbacks,
        "errors": errors,
        "review_status": review_status,
        "ai_usage": {
            "calls": GEMINI_USAGE.copy(),
            "total_prompt_tokens": sum(item.get("prompt_tokens") or 0 for item in GEMINI_USAGE),
            "total_output_tokens": sum(item.get("output_tokens") or 0 for item in GEMINI_USAGE),
            "total_tokens": sum(item.get("total_tokens") or 0 for item in GEMINI_USAGE),
        },
        "model": DEFAULT_MODEL if source == "gemini" else None,
        "created_at": dt.datetime.now().isoformat(timespec="seconds"),
        "question": question,
        "validation": validation,
        "caption": caption,
        "files": {
            "question": str(run_dir / "soal.json"),
            "caption": str(run_dir / "caption.txt"),
            "post_soal": str(run_dir / "post-soal.svg"),
            "post_pembahasan": str(run_dir / "post-pembahasan.svg"),
        },
    }

    (run_dir / "soal.json").write_text(
        json.dumps(question, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    caption_text = caption.get("caption", "")
    hashtags = " ".join(caption.get("hashtag", []))
    (run_dir / "caption.txt").write_text(f"{caption_text}\n\n{hashtags}\n", encoding="utf-8")
    (run_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return metadata


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapel", default="Penalaran Umum", choices=sorted(MAPEL_TOPICS.keys()))
    parser.add_argument("--topik", default="")
    parser.add_argument("--level", default="sedang", choices=["mudah", "sedang", "sulit"])
    parser.add_argument("--mode", default="auto", choices=["auto", "gemini", "draft"])
    parser.add_argument("--account", default="@namaakun")
    args = parser.parse_args()

    topic = args.topik or MAPEL_TOPICS[args.mapel][0]
    mode = "auto" if args.mode == "gemini" else args.mode
    metadata = generate_content(args.mapel, topic, args.level, mode, args.account)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
