import json
import re


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
    if len(caption_text.strip()) < 3:
        issues.append("Caption kosong.")
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
    caption = f"{question['mapel']}\n{question['topik']}"
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


def normalize_caption(question, caption):
    normalized = dict(caption or {})
    short = draft_caption(question)
    normalized["caption"] = short["caption"]
    hashtags = normalized.get("hashtag")
    if not isinstance(hashtags, list) or not hashtags:
        hashtags = short["hashtag"]
    required = short["hashtag"][:4]
    merged = []
    for tag in [*required, *hashtags]:
        tag = str(tag).strip()
        if not tag:
            continue
        if not tag.startswith("#"):
            tag = f"#{tag}"
        if tag not in merged:
            merged.append(tag)
    normalized["hashtag"] = merged
    return normalized


PAREN_HINT_WORD_RE = re.compile(
    r"\b(?:hint|petunjuk|gunakan|pakai|perhatikan|lihat|cek|misal|misalnya|contoh|"
    r"gambar|diagram|bantu|sketsa|asumsikan|ingat|anggap)\b",
    re.I,
)
PAREN_MATH_RE = re.compile(r"[=<>+\-*/^≤≥≠√∠π²³]|\b-?\d+(?:[.,]\d+)?\s*,\s*-?\d+(?:[.,]\d+)?\b")


def _is_removable_question_parenthetical(body, context):
    body = str(body or "").strip()
    if not body:
        return True
    if PAREN_HINT_WORD_RE.search(body):
        return True
    if PAREN_MATH_RE.search(body):
        return False
    if re.fullmatch(r"[A-Ea-e]", body):
        return False

    context_lower = str(context or "").lower()
    math_context = any(
        keyword in context_lower
        for keyword in (
            "persamaan linear",
            "pertidaksamaan linear",
            "aljabar",
            "fungsi linear",
            "sistem persamaan",
        )
    )
    if math_context and re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ]", body):
        return True
    return False


def _remove_question_hint_parentheses(text, context=""):
    def replace(match):
        body = match.group(1)
        if _is_removable_question_parenthetical(body, context):
            return ""
        return match.group(0)

    cleaned = re.sub(r"\s*\(([^()]*)\)", replace, str(text or ""))
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    cleaned = re.sub(r"\s+([,.!?;:])", r"\1", cleaned)
    return cleaned.strip()


def normalize_question(question):
    normalized = dict(question or {})
    context = " ".join(
        str(normalized.get(key, ""))
        for key in ("mapel", "topik", "level", "soal")
    )
    normalized["soal"] = _remove_question_hint_parentheses(normalized.get("soal", ""), context)
    return normalized
