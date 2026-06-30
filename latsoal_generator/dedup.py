import json
import re
import datetime as dt

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
    passage = question.get("bacaan")
    passage_key = ""
    if isinstance(passage, dict):
        passage_key = " ".join([
            str(passage.get("id", "")),
            str(passage.get("nomor_soal", "")),
        ])
    return " ".join([
        question.get("mapel", ""),
        question.get("topik", ""),
        passage_key,
        question.get("soal", ""),
        " ".join(str(value) for value in question.get("pilihan", {}).values()),
    ])


def _passage_id(question):
    passage = question.get("bacaan")
    if isinstance(passage, dict):
        return str(passage.get("id") or "").strip()
    return ""


def check_duplicate(question, exclude_run_id=None, additional_questions=None):
    current_text = _question_text(question)
    best = {
        "is_duplicate": False,
        "similarity": 0.0,
        "matched_run_id": None,
        "matched_status": None,
        "matched_batch_index": None,
        "threshold": generator_config.DEDUP_THRESHOLD,
        "reason": "",
        "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "algorithm": "jaccard-v1",
    }

    def compare(candidate_question, run_id=None, status=None, batch_index=None):
        nonlocal best
        if _passage_id(question) and _passage_id(question) == _passage_id(candidate_question or {}):
            return
        similarity = jaccard_similarity(current_text, _question_text(candidate_question or {}))
        if similarity > best["similarity"]:
            best.update({
                "similarity": round(similarity, 4),
                "matched_run_id": run_id,
                "matched_status": status,
                "matched_batch_index": batch_index,
            })

    for candidate in additional_questions or []:
        compare(
            candidate.get("question") or {},
            run_id=candidate.get("run_id"),
            status=candidate.get("status") or "batch",
            batch_index=candidate.get("batch_index"),
        )

    bank_index_path = generator_config.BANK_INDEX_PATH
    index = []
    if bank_index_path.exists():
        try:
            index = json.loads(bank_index_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            index = []

    for item in index if isinstance(index, list) else []:
        run_id = item.get("run_id")
        if not run_id or run_id == exclude_run_id:
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
        compare(saved_question, run_id=run_id, status=item.get("status", "saved"))

    if best["similarity"] >= generator_config.DEDUP_THRESHOLD:
        best["is_duplicate"] = True
        best["reason"] = "Teks soal terlalu mirip dengan soal yang sudah disimpan."
    return best
