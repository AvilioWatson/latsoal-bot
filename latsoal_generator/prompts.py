import json

from .config import BANK_DIR, PATTERN_FILES


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
Jangan menambahkan hint/petunjuk dalam tanda kurung pada teks soal.
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
        "Buat caption sangat singkat, hanya dua baris: baris pertama subtopik/subtes, "
        "baris kedua judul submateri/topik. Jangan tambah hook, CTA, motivasi, atau jawaban. "
        "Wajib pakai konteks UTBK 2026. Jangan memakai tahun 2024 atau 2025. "
        "Hashtag wajib diawali tanda # dan wajib memuat #UTBK, #LatsoalUTBK, "
        "#BelajarUTBK, dan #SoalUTBK. Output JSON valid.\n\n"
        f"{json.dumps(question, ensure_ascii=False)}\n\n"
        'Kembalikan JSON: {"caption": "", "hashtag": []}'
    )
