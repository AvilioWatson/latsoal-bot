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


def _normalize_comparable_text(text):
    normalized = re.sub(r"[^a-z0-9]+", " ", str(text or "").casefold())
    return " ".join(normalized.split())


def _character_ngrams(text, size=3):
    normalized = _normalize_comparable_text(text)
    if not normalized:
        return set()
    if len(normalized) <= size:
        return {normalized}
    return {normalized[index:index + size] for index in range(len(normalized) - size + 1)}


def _dice_similarity(left, right):
    left_grams = _character_ngrams(left)
    right_grams = _character_ngrams(right)
    if not left_grams or not right_grams:
        return 0.0
    return (2 * len(left_grams & right_grams)) / (len(left_grams) + len(right_grams))


def text_similarity(left, right):
    normalized_left = _normalize_comparable_text(left)
    normalized_right = _normalize_comparable_text(right)
    if not normalized_left or not normalized_right:
        return 0.0
    if normalized_left == normalized_right:
        return 1.0
    return (jaccard_similarity(left, right) * 0.65) + (_dice_similarity(left, right) * 0.35)


def _choices_text(question):
    choices = question.get("pilihan") if isinstance(question.get("pilihan"), dict) else {}
    return " ".join(f"{key} {choices[key]}" for key in sorted(choices))


def _passage_text(question):
    passage = question.get("bacaan")
    if not isinstance(passage, dict):
        return ""
    return " ".join([
        str(passage.get("judul", "")),
        str(passage.get("teks", "")),
    ]).strip()


def question_similarity(left, right):
    stem = text_similarity(left.get("soal"), right.get("soal"))
    left_choices = _choices_text(left)
    right_choices = _choices_text(right)
    choices = text_similarity(left_choices, right_choices) if left_choices and right_choices else 0.0
    weighted = (stem * 0.78) + (choices * 0.22) if left_choices and right_choices else stem
    similarity = max(weighted, stem) if stem >= 0.96 else weighted
    passage = text_similarity(_passage_text(left), _passage_text(right))
    return {
        "similarity": similarity,
        "stem": stem,
        "choices": choices,
        "passage": passage,
        "same_passage": passage >= 0.98,
    }


def _same_passage_group(left, right):
    left_passage = _passage_text(left)
    right_passage = _passage_text(right)
    return bool(left_passage and right_passage and text_similarity(left_passage, right_passage) >= 0.98)


def check_duplicate(question, exclude_run_id=None, additional_questions=None):
    best = {
        "is_duplicate": False,
        "similarity": 0.0,
        "matched_run_id": None,
        "matched_status": None,
        "matched_batch_index": None,
        "question_similarity": 0.0,
        "passage_similarity": 0.0,
        "same_passage": False,
        "similarity_breakdown": {"stem": 0.0, "choices": 0.0},
        "threshold": generator_config.DEDUP_THRESHOLD,
        "reason": "",
        "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "algorithm": "weighted-question-v2",
    }

    def compare(candidate_question, run_id=None, status=None, batch_index=None, skip_same_passage_group=False):
        nonlocal best
        if skip_same_passage_group and _same_passage_group(question, candidate_question or {}):
            return
        scores = question_similarity(question, candidate_question or {})
        if scores["similarity"] > best["similarity"]:
            best.update({
                "similarity": round(scores["similarity"], 4),
                "question_similarity": round(scores["similarity"], 4),
                "passage_similarity": round(scores["passage"], 4),
                "same_passage": scores["same_passage"],
                "similarity_breakdown": {
                    "stem": round(scores["stem"], 4),
                    "choices": round(scores["choices"], 4),
                },
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
            skip_same_passage_group=True,
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
        best["reason"] = "Pertanyaan dan pilihan jawaban terlalu mirip dengan soal yang sudah disimpan."
    return best
