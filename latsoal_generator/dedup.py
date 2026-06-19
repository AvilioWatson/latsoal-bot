import json
import re

import latsoal_generator.config as generator_config


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


def _question_text(question):
    return " ".join([
        question.get("mapel", ""),
        question.get("topik", ""),
        question.get("soal", ""),
        " ".join(str(value) for value in question.get("pilihan", {}).values()),
    ])


def check_duplicate(question):
    current_text = _question_text(question)
    best = {
        "is_duplicate": False,
        "similarity": 0.0,
        "matched_run_id": None,
        "matched_status": None,
        "threshold": generator_config.DEDUP_THRESHOLD,
        "reason": "",
    }

    bank_index_path = generator_config.BANK_INDEX_PATH
    if not bank_index_path.exists():
        return best
    try:
        index = json.loads(bank_index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return best

    for item in index if isinstance(index, list) else []:
        run_id = item.get("run_id")
        if not run_id:
            continue
        item_path = item.get("path") or f"saved/{run_id}"
        relative_path = str(item_path).replace("\\", "/")
        if relative_path.startswith("saved/"):
            relative_path = relative_path[len("saved/"):]
        metadata_path = generator_config.SAVED_DIR / relative_path / "metadata.json"
        if not metadata_path.exists():
            continue
        try:
            saved = json.loads(metadata_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        saved_question = saved.get("question", {})
        similarity = jaccard_similarity(current_text, _question_text(saved_question))
        if similarity > best["similarity"]:
            best.update({
                "similarity": round(similarity, 4),
                "matched_run_id": run_id,
                "matched_status": item.get("status", "saved"),
            })

    if best["similarity"] >= generator_config.DEDUP_THRESHOLD:
        best["is_duplicate"] = True
        best["reason"] = "Teks soal terlalu mirip dengan soal yang sudah disimpan."
    return best
