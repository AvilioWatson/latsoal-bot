import argparse
import datetime as dt
import json
import os
import random
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "outputs"
BANK_DIR = ROOT / "bank_soal" / "patterns"
SAVED_DIR = ROOT / "saved"
DEDUP_THRESHOLD = float(os.getenv("DEDUP_THRESHOLD", "0.82"))


def json_stdout(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def classify_error(exc):
    message = clean_error_message(exc) if "clean_error_message" in globals() else str(exc)
    lowered = message.lower()
    if "quota" in lowered or "429" in lowered:
        return "quota_exceeded"
    if any(token in lowered for token in ["urlopen", "timed out", "timeout", "network", "connection", "dns"]):
        return "network_error"
    if "json" in lowered or "parse" in lowered:
        return "invalid_json"
    if "validasi" in lowered or "validation" in lowered:
        return "validation_failed"
    return "unknown"


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        json_stdout({
            "ok": False,
            "error": "validation_failed",
            "detail": message,
            "fallback_used": False,
            "fallback_reason": None,
        })
        raise SystemExit(2)


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


STOPWORDS = {
    "yang", "dan", "di", "ke", "dari", "dengan", "untuk", "pada", "adalah",
    "atau", "dalam", "ini", "itu", "sebagai", "maka", "jika", "akan",
    "antara", "berikut", "teks", "kalimat", "soal", "pilihan", "jawaban",
}


def normalize_terms(text):
    words = re.findall(r"[a-zA-Z0-9]+", str(text).lower())
    return {word for word in words if len(word) > 2 and word not in STOPWORDS}


def jaccard_similarity(left, right):
    left_terms = normalize_terms(left)
    right_terms = normalize_terms(right)
    if not left_terms or not right_terms:
        return 0.0
    return len(left_terms & right_terms) / len(left_terms | right_terms)


def check_duplicate(question):
    current_text = " ".join([
        question.get("mapel", ""),
        question.get("topik", ""),
        question.get("soal", ""),
        " ".join(str(value) for value in question.get("pilihan", {}).values()),
    ])
    best = {
        "is_duplicate": False,
        "similarity": 0.0,
        "matched_run_id": None,
        "matched_status": None,
        "threshold": DEDUP_THRESHOLD,
        "reason": "",
    }

    index_path = SAVED_DIR / "index.json"
    if not index_path.exists():
        return best
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return best

    for item in index if isinstance(index, list) else []:
        run_id = item.get("run_id")
        if not run_id:
            continue
        metadata_path = SAVED_DIR / run_id / "metadata.json"
        if not metadata_path.exists():
            continue
        try:
            saved = json.loads(metadata_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        saved_question = saved.get("question", {})
        saved_text = " ".join([
            saved_question.get("mapel", ""),
            saved_question.get("topik", ""),
            saved_question.get("soal", ""),
            " ".join(str(value) for value in saved_question.get("pilihan", {}).values()),
        ])
        similarity = jaccard_similarity(current_text, saved_text)
        if similarity > best["similarity"]:
            best.update({
                "similarity": round(similarity, 4),
                "matched_run_id": run_id,
                "matched_status": item.get("status", "saved"),
            })

    if best["similarity"] >= DEDUP_THRESHOLD:
        best["is_duplicate"] = True
        best["reason"] = "Teks soal terlalu mirip dengan soal yang sudah disimpan."
    return best


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


def make_choices(correct_value, deltas, formatter=str):
    values = []
    for delta in deltas:
        value = correct_value + delta
        if value > 0 and value not in values:
            values.append(value)
    if correct_value not in values:
        values.append(correct_value)
    values = values[:5]
    while len(values) < 5:
        candidate = correct_value + len(values) + 1
        if candidate not in values:
            values.append(candidate)
    values = sorted(values)
    labels = ["A", "B", "C", "D", "E"]
    choices = {label: formatter(value) for label, value in zip(labels, values)}
    answer = labels[values.index(correct_value)]
    return choices, answer


def deterministic_quant_question(mapel, topic, level, seed):
    rng = random.Random(seed)
    kelompok_tes = "TPS" if mapel == "Pengetahuan Kuantitatif" else "Literasi"

    if topic in {"Statistika", "Data dan ketidakpastian"}:
        n = rng.choice([5, 6, 7])
        known_count = n - 1
        known_values = [rng.randrange(62, 91, 2) for _ in range(known_count)]
        missing = rng.randrange(64, 93, 2)
        total = sum(known_values) + missing
        while total % n != 0:
            missing += 1
            total = sum(known_values) + missing
        mean = total // n
        choices, answer = make_choices(missing, [-6, -3, 0, 3, 6])
        return {
            "mapel": mapel,
            "kelompok_tes": kelompok_tes,
            "topik": topic,
            "level": level,
            "tipe": "mean_missing_value",
            "params": {"n": n, "mean": mean, "known_values": known_values, "missing_value": missing},
            "soal": (
                f"Rata-rata nilai {n} siswa adalah {mean}. "
                f"{known_count} nilai yang diketahui adalah {', '.join(map(str, known_values[:-1]))}, dan {known_values[-1]}. "
                "Nilai siswa yang belum diketahui adalah..."
            ),
            "pilihan": choices,
            "jawaban": answer,
            "pembahasan": (
                f"Jumlah seluruh nilai adalah {n} x {mean} = {total}. "
                f"Jumlah nilai yang diketahui adalah {' + '.join(map(str, known_values))} = {sum(known_values)}. "
                f"Nilai yang belum diketahui adalah {total} - {sum(known_values)} = {missing}."
            ),
            "konsep_kunci": "Rata-rata dan jumlah data",
            "tips_pengerjaan": "Ubah rata-rata menjadi jumlah total terlebih dahulu, lalu kurangi dengan jumlah data yang diketahui.",
            "butuh_visual": False,
            "deskripsi_visual": "",
        }

    if topic in {"Perbandingan", "Bilangan"}:
        a = rng.randint(2, 5)
        b = rng.randint(3, 7)
        multiplier = rng.randint(8, 18)
        total = (a + b) * multiplier
        target = b * multiplier
        choices, answer = make_choices(target, [-2 * multiplier, -multiplier, 0, multiplier, 2 * multiplier])
        return {
            "mapel": mapel,
            "kelompok_tes": kelompok_tes,
            "topik": topic,
            "level": level,
            "tipe": "ratio_total",
            "params": {"ratio": [a, b], "total": total, "target_value": target},
            "soal": (
                f"Perbandingan jumlah buku latihan milik Rani dan Dimas adalah {a}:{b}. "
                f"Jika jumlah buku mereka seluruhnya {total}, banyak buku milik Dimas adalah..."
            ),
            "pilihan": choices,
            "jawaban": answer,
            "pembahasan": (
                f"Total bagian adalah {a} + {b} = {a + b}. "
                f"Setiap bagian bernilai {total} / {a + b} = {multiplier}. "
                f"Bagian Dimas adalah {b}, sehingga banyak bukunya {b} x {multiplier} = {target}."
            ),
            "konsep_kunci": "Rasio dan total bagian",
            "tips_pengerjaan": "Jumlahkan bagian rasio, cari nilai satu bagian, lalu kalikan dengan bagian yang ditanya.",
            "butuh_visual": False,
            "deskripsi_visual": "",
        }

    start = rng.randrange(12, 31, 2)
    step = rng.choice([3, 4, 5, 6, 8])
    values = [start + step * i for i in range(3)]
    next_value = values[-1] + step
    choices, answer = make_choices(next_value, [-2 * step, -step, 0, step, 2 * step])
    return {
        "mapel": mapel,
        "kelompok_tes": kelompok_tes,
        "topik": topic,
        "level": level,
        "tipe": "arithmetic_sequence_context",
        "params": {"values": values, "step": step, "next_value": next_value},
        "soal": (
            f"Sebuah komunitas mencatat jumlah peserta latihan selama tiga hari: "
            f"hari pertama {values[0]}, hari kedua {values[1]}, dan hari ketiga {values[2]}. "
            "Jika pola kenaikannya tetap, jumlah peserta pada hari keempat adalah..."
        ),
        "pilihan": choices,
        "jawaban": answer,
        "pembahasan": (
            f"Kenaikan dari hari pertama ke kedua adalah {values[1]} - {values[0]} = {step}. "
            f"Kenaikan dari hari kedua ke ketiga juga {values[2]} - {values[1]} = {step}. "
            f"Jadi, hari keempat adalah {values[2]} + {step} = {next_value}."
        ),
        "konsep_kunci": "Pola bilangan aritmetika",
        "tips_pengerjaan": "Cari selisih antar data berurutan, lalu gunakan pola yang sama untuk data berikutnya.",
        "butuh_visual": False,
        "deskripsi_visual": "",
    }


def validate_caption(caption, answer):
    caption_text = caption.get("caption", "")
    hashtags = caption.get("hashtag", [])
    required_hashtags = {"#UTBK2026", "#LatsoalUTBK", "#BelajarUTBK", "#SoalUTBK"}
    hashtag_set = set(hashtags)
    issues = []
    score_penalty = 0

    if any(year in caption_text or year in " ".join(hashtags) for year in ["UTBK2024", "UTBK2025", "SNBT2024", "SNBT2025"]):
        issues.append("Caption/hashtag memakai tahun lama.")
        score_penalty += 20
    if not required_hashtags.issubset(hashtag_set):
        issues.append("Hashtag wajib belum lengkap.")
        score_penalty += 15
    if answer and re.search(rf"\b(?:jawaban|kunci)\s*(?:adalah|:)?\s*{re.escape(answer)}\b", caption_text, re.I):
        issues.append("Caption kemungkinan membocorkan jawaban.")
        score_penalty += 30
    if len(caption_text.split()) > 180:
        issues.append("Caption terlalu panjang.")
        score_penalty += 10
    if len(caption_text.split()) < 35:
        issues.append("Caption terlalu pendek.")
        score_penalty += 10
    return {
        "lolos": score_penalty == 0,
        "issues": issues,
        "score_penalty": score_penalty,
    }


def local_validation(question, caption=None):
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
    if len(set(str(value).strip().lower() for value in choices.values())) != len(choices):
        score -= 15
    if "pilihan sementara" in json.dumps(choices, ensure_ascii=False).lower():
        score -= 30
    if len(question.get("soal", "").split()) < 12:
        score -= 10
    if len(question.get("soal", "")) > 850:
        score -= 10
    caption_result = validate_caption(caption or {"caption": "", "hashtag": []}, answer)
    score -= caption_result["score_penalty"]
    issues = []
    if missing:
        issues.append(f"Field kosong: {', '.join(missing)}")
    if not valid_choices:
        issues.append("Pilihan harus tepat A sampai E.")
    if not answer_ok:
        issues.append("Jawaban tidak cocok dengan pilihan.")
    if len(question.get("pembahasan", "")) < 80:
        issues.append("Pembahasan terlalu pendek.")
    if len(set(str(value).strip().lower() for value in choices.values())) != len(choices):
        issues.append("Ada opsi duplikat.")
    if "pilihan sementara" in json.dumps(choices, ensure_ascii=False).lower():
        issues.append("Masih ada placeholder.")
    issues.extend(caption_result["issues"])
    return {
        "lolos_validasi": score >= 80,
        "skor": max(score, 0),
        "issues": issues,
        "catatan": {
            "struktur": "Lengkap" if not missing else f"Field kosong: {', '.join(missing)}",
            "pilihan": "A sampai E tersedia" if valid_choices else "Pilihan harus tepat A sampai E",
            "jawaban": "Jawaban ada di pilihan" if answer_ok else "Jawaban tidak cocok dengan pilihan",
            "duplikasi_opsi": "Tidak ada opsi duplikat" if len(set(str(value).strip().lower() for value in choices.values())) == len(choices) else "Ada opsi duplikat",
            "placeholder": "Tidak ada placeholder" if "pilihan sementara" not in json.dumps(choices, ensure_ascii=False).lower() else "Masih ada placeholder",
            "caption": "Caption bersih" if caption_result["lolos"] else "; ".join(caption_result["issues"]),
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
            if mapel in {"Pengetahuan Kuantitatif", "Penalaran Matematika"}:
                question = deterministic_quant_question(mapel, topic, level, run_id)
            else:
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
        if mapel in {"Pengetahuan Kuantitatif", "Penalaran Matematika"}:
            question = deterministic_quant_question(mapel, topic, level, run_id)
        else:
            question = draft_question(mapel, topic, level)
        caption = draft_caption(question)
        validation = local_validation(question, caption)

    if not GEMINI_VALIDATE or source in {"draft", "fallback"}:
        validation = local_validation(question, caption)
    question["akun"] = account
    dedup = check_duplicate(question)
    review_status = "needs_review" if "question" in fallbacks else "ready"
    if errors:
        review_status = "needs_review"
    if dedup["is_duplicate"]:
        review_status = "needs_review"
        validation["lolos_validasi"] = False
        validation["skor"] = min(validation.get("skor", 0), 74)
        validation.setdefault("catatan", {})["duplikasi"] = (
            f"Mirip {dedup['similarity']} dengan run {dedup['matched_run_id']}"
        )
        validation["saran_perbaikan"] = (
            validation.get("saran_perbaikan", "")
            + " Soal terdeteksi mirip dengan saved item; ubah konteks, angka, atau struktur."
        ).strip()

    metadata = {
        "ok": True,
        "run_id": run_id,
        "source": source,
        "fallback_used": bool(fallbacks),
        "fallback_reason": "; ".join(fallbacks) if fallbacks else None,
        "fallbacks": fallbacks,
        "errors": errors,
        "review_status": review_status,
        "dedup": dedup,
        "validator": {
            "passed": bool(validation.get("lolos_validasi")),
            "issues": validation.get("issues", []),
        },
        "usage": {
            "input_tokens": sum(item.get("prompt_tokens") or 0 for item in GEMINI_USAGE),
            "output_tokens": sum(item.get("output_tokens") or 0 for item in GEMINI_USAGE),
        },
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
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    parser = JsonArgumentParser()
    parser.add_argument("--mapel", default="Penalaran Umum", choices=sorted(MAPEL_TOPICS.keys()))
    parser.add_argument("--topik", default="")
    parser.add_argument("--level", default="sedang", choices=["mudah", "sedang", "sulit"])
    parser.add_argument("--mode", default="auto", choices=["auto", "gemini", "draft"])
    parser.add_argument("--account", default="@namaakun")
    try:
        args = parser.parse_args()
        topic = args.topik or MAPEL_TOPICS[args.mapel][0]
        mode = "auto" if args.mode == "gemini" else args.mode
        metadata = generate_content(args.mapel, topic, args.level, mode, args.account)
        json_stdout(metadata)
    except SystemExit:
        raise
    except Exception as exc:
        error = classify_error(exc)
        detail = clean_error_message(exc)
        json_stdout({
            "ok": False,
            "error": error,
            "detail": detail,
            "fallback_used": False,
            "fallback_reason": None,
        })
        print(f"[ERROR] {error}: {detail}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
