import json
import random

import latsoal_generator.config as generator_config
from .storage import canonical_topic, slugify

MIN_TOPIC_EXAMPLES = 3


class InsufficientTopicExamplesError(RuntimeError):
    def __init__(self, mapel, topic, found, required=MIN_TOPIC_EXAMPLES):
        self.mapel = mapel
        self.topic = topic
        self.found = found
        self.required = required
        super().__init__(
            f"Contoh soal topik '{topic}' untuk subtes '{mapel}' baru {found}. "
            f"Butuh minimal {required} contoh dari database sebelum generate."
        )


def load_patterns(mapel, topic, limit=2):
    pattern_file = generator_config.PATTERN_FILES.get(mapel)
    if not pattern_file:
        return []
    path = generator_config.BANK_DIR / pattern_file
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


def _compact_example(question):
    pilihan = question.get("pilihan", {})
    return {
        "mapel": question.get("mapel", ""),
        "topik": question.get("topik", ""),
        "level": question.get("level", ""),
        "soal": question.get("soal", ""),
        "pilihan": pilihan if isinstance(pilihan, dict) else {},
        "jawaban": question.get("jawaban", ""),
        "pembahasan": question.get("pembahasan", ""),
        "konsep_kunci": question.get("konsep_kunci", ""),
        "butuh_visual": bool(question.get("butuh_visual", False)),
    }


def load_topic_examples(mapel, topic, limit=3):
    if not generator_config.SAVED_DIR.exists():
        return []

    wanted_mapel = slugify(mapel)
    wanted_topic = slugify(canonical_topic(mapel, topic))
    examples = []
    for metadata_path in generator_config.SAVED_DIR.rglob("metadata.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        question = metadata.get("question", {})
        if not isinstance(question, dict):
            continue
        question_mapel = question.get("mapel", "")
        question_topic = question.get("topik", "")
        if slugify(question_mapel) != wanted_mapel:
            continue
        if slugify(canonical_topic(question_mapel, question_topic)) != wanted_topic:
            continue
        if not question.get("soal") or not isinstance(question.get("pilihan"), dict):
            continue
        examples.append(_compact_example(question))

    if len(examples) <= limit:
        random.shuffle(examples)
        return examples
    return random.sample(examples, limit)


def require_topic_examples(mapel, topic, minimum=MIN_TOPIC_EXAMPLES):
    examples = load_topic_examples(mapel, topic, limit=minimum)
    if len(examples) < minimum:
        raise InsufficientTopicExamplesError(mapel, topic, len(examples), minimum)
    return examples


def build_question_prompt(mapel, topic, level, topic_examples=None):
    base_rules = """
Kamu adalah generator soal latihan UTBK/SNBT untuk platform Instagram edukatif.
Buat soal orisinal sesuai format SNBT modern, bukan format mapel Saintek/Soshum lama.
Gunakan bahasa Indonesia baku. Setiap soal punya tepat 5 pilihan A sampai E,
hanya 1 jawaban benar, dan pembahasan jelas untuk pelajar SMA.
Pembahasan wajib memakai bahasa Indonesia formal, baku, objektif, dan tidak memakai gaya percakapan.
Jika memakai pola referensi, gunakan hanya struktur konsepnya. Jangan menyalin kalimat,
angka, konteks, atau pilihan dari contoh/pola referensi.
Jangan menambahkan hint/petunjuk dalam tanda kurung pada teks soal.
Output harus JSON valid tanpa markdown.
""".strip()

    patterns = load_patterns(mapel, topic)
    if topic_examples is None:
        topic_examples = load_topic_examples(mapel, topic, limit=MIN_TOPIC_EXAMPLES)
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
        "Contoh soal database untuk topik yang sama, diambil acak dari Bank Review/saved. "
        "Gunakan minimal 3 contoh jika tersedia untuk menangkap variasi terbaru database, "
        "tetapi jangan menyalin kalimat, angka, konteks, pilihan, atau pembahasannya:\n"
        f"{json.dumps(topic_examples, ensure_ascii=False, indent=2)}\n\n"
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


def build_explanation_review_prompt(question):
    return (
        "Kamu adalah reviewer akademik UTBK/SNBT yang ketat. "
        "Periksa pembahasan soal berikut sebelum soal di-approve. "
        "Nilai apakah jawaban benar, langkah pembahasan valid, tidak ada lompatan logika, "
        "dan bahasa pembahasan formal, baku, objektif, serta tidak memakai gaya percakapan. "
        "Jika pembahasan kurang formal atau kurang tepat, berikan versi revisi yang formal. "
        "Output harus JSON valid tanpa markdown.\n\n"
        f"{json.dumps(question, ensure_ascii=False, indent=2)}\n\n"
        "Kembalikan JSON: "
        '{"lolos": false, "skor": 0, "akurasi": "", "bahasa_formal": "", '
        '"catatan": [], "saran_revisi": [], "pembahasan_revisi": ""}'
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
