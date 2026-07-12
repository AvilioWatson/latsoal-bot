BACAAN_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "id": {"type": "STRING"},
        "judul": {"type": "STRING"},
        "teks": {"type": "STRING"},
        "bahasa": {"type": "STRING"},
        "label": {"type": "STRING"},
    },
    "required": ["id", "judul", "teks", "bahasa"],
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
        "bacaan": BACAAN_SCHEMA,
        "bacaan_list": {
            "type": "ARRAY",
            "items": BACAAN_SCHEMA,
        },
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


EXPLANATION_REVIEW_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "lolos": {"type": "BOOLEAN"},
        "skor": {"type": "INTEGER"},
        "akurasi": {"type": "STRING"},
        "bahasa_formal": {"type": "STRING"},
        "catatan": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
        },
        "saran_revisi": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
        },
        "pembahasan_revisi": {"type": "STRING"},
        "question_revisi": QUESTION_SCHEMA,
        "question_group_revisi": {
            "type": "ARRAY",
            "items": QUESTION_SCHEMA,
        },
    },
    "required": [
        "lolos",
        "skor",
        "akurasi",
        "bahasa_formal",
        "catatan",
        "saran_revisi",
        "pembahasan_revisi",
        "question_revisi",
    ],
}
