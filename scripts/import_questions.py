import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import content_generator


CHOICE_KEYS = ["A", "B", "C", "D", "E"]
VALID_LEVELS = {"mudah", "sedang", "sulit"}
MAX_BATCH = 1000


MOJIBAKE_REPLACEMENTS = {
    "Ã‚Â²": "Â²", "Ã‚Â³": "Â³", "Ã‚Â±": "Â±", "Ãƒâ€”": "Ã—",
    "Ã¢â€° ": "â‰ ", "Ã¢â€°Â ": "â‰ ", "Ã¢â€°Â¤": "â‰¤", "Ã¢â€°Â¥": "â‰¥",
    "Ã¢Ë†Å¡": "âˆš", "Ã¢Ë†Â ": "âˆ ", "Ã¢â€ â€™": "â†’", "Ã¢Å“â€œ": "âœ“",
    "Ã¢Å“â€”": "âœ—", "Ã¢â‚¬â€œ": "-", "Ã¢â‚¬â€": "-", "Ãâ‚¬": "Ï€",
    "Ã¢â€šÂ": "1", "Ã¢â€šâ€š": "2", "â‚€": "0", "â‚": "1", "â‚‚": "2",
    "â‚ƒ": "3", "â‚„": "4", "â‚…": "5", "â‚†": "6", "â‚‡": "7",
    "â‚ˆ": "8", "â‚‰": "9", "Ã‚": "",
}


def fix_text(value):
    if isinstance(value, str):
        for source, target in MOJIBAKE_REPLACEMENTS.items():
            value = value.replace(source, target)
        return value
    if isinstance(value, list):
        return [fix_text(item) for item in value]
    if isinstance(value, dict):
        return {key: fix_text(item) for key, item in value.items()}
    return value


def normalize_question_text(question):
    return " ".join(str(question.get("soal", "")).lower().split())


def existing_question_records():
    records = []
    if not content_generator.SAVED_DIR.exists():
        return records
    for metadata_path in content_generator.SAVED_DIR.rglob("metadata.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        question = metadata.get("question") or {}
        text = normalize_question_text(question)
        if text:
            records.append({
                "text": text,
                "run_id": metadata.get("run_id") or metadata_path.parent.name,
                "question": question,
            })
    return records


def validate_and_normalize_question(raw_question):
    if not isinstance(raw_question, dict):
        return {}, ["Soal harus berupa JSON object."]
    question = fix_text(dict(raw_question))
    errors = []
    for field in ["mapel", "topik", "level", "soal", "jawaban", "pembahasan"]:
        if not isinstance(question.get(field), str) or not question[field].strip():
            errors.append(f"Field '{field}' wajib berupa teks non-empty.")

    mapel = str(question.get("mapel") or "").strip()
    topik = str(question.get("topik") or "").strip()
    level = str(question.get("level") or "").strip().lower()
    answer = str(question.get("jawaban") or "").strip().upper()
    question["mapel"] = mapel
    question["level"] = level
    question["jawaban"] = answer

    if mapel and mapel not in content_generator.MAPEL_TOPICS:
        errors.append("Subtes/mapel tidak tersedia dalam taksonomi.")
    if mapel in content_generator.MAPEL_TOPICS and topik:
        canonical = content_generator.canonical_topic(mapel, topik)
        if canonical not in content_generator.MAPEL_TOPICS[mapel]:
            errors.append("Topik tidak tersedia untuk subtes tersebut.")
        else:
            question["topik"] = canonical
    if level and level not in VALID_LEVELS:
        errors.append("Level harus mudah, sedang, atau sulit.")

    choices = question.get("pilihan")
    if not isinstance(choices, dict):
        errors.append("Pilihan wajib berupa object A sampai E.")
    else:
        actual_keys = sorted(str(key).upper() for key in choices)
        if actual_keys != CHOICE_KEYS:
            errors.append("Pilihan harus tepat A, B, C, D, dan E.")
        normalized_choices = {}
        for key in CHOICE_KEYS:
            value = choices.get(key)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"Pilihan {key} wajib berupa teks non-empty.")
            else:
                normalized_choices[key] = value.strip()
        if len({value.casefold() for value in normalized_choices.values()}) != len(normalized_choices):
            errors.append("Pilihan jawaban tidak boleh duplikat.")
        question["pilihan"] = normalized_choices
    if answer and answer not in CHOICE_KEYS:
        errors.append("Jawaban harus salah satu dari A sampai E.")

    source = question.get("sumber_pdf")
    if source is not None and not isinstance(source, dict):
        errors.append("sumber_pdf harus berupa object atau dihilangkan.")
    elif isinstance(source, dict):
        for key in ["nama_file", "halaman"]:
            if key in source and not isinstance(source[key], str):
                errors.append(f"sumber_pdf.{key} harus berupa teks.")
        question["sumber_pdf"] = {
            "nama_file": str(source.get("nama_file") or "").strip(),
            "halaman": str(source.get("halaman") or "").strip(),
        }
    return question, list(dict.fromkeys(errors))


def evaluate_batch(raw_questions):
    if not isinstance(raw_questions, list):
        raise ValueError("Input harus berupa array JSON soal.")
    if len(raw_questions) > MAX_BATCH:
        raise ValueError(f"Maksimal {MAX_BATCH} soal per batch.")

    existing = existing_question_records()
    existing_by_text = {record["text"]: record for record in existing}
    earlier = []
    earlier_by_text = {}
    items = []
    for index, raw_question in enumerate(raw_questions):
        question, errors = validate_and_normalize_question(raw_question)
        normalized_text = normalize_question_text(question)
        exact_match = existing_by_text.get(normalized_text) or earlier_by_text.get(normalized_text)
        dedup = content_generator.check_duplicate(question, additional_questions=earlier) if not errors else None
        is_exact = bool(normalized_text and exact_match)
        is_similar = bool(dedup and dedup.get("is_duplicate") and not is_exact)
        status = "invalid" if errors else "exact_duplicate" if is_exact else "similar" if is_similar else "valid"
        if is_exact:
            dedup = dedup or content_generator.check_duplicate(question, additional_questions=earlier)
            dedup.update({
                "is_duplicate": True,
                "similarity": 1.0,
                "matched_run_id": exact_match.get("run_id"),
                "matched_batch_index": exact_match.get("batch_index"),
                "matched_status": exact_match.get("status") or "saved",
                "reason": "Stem soal sama dengan soal yang sudah ada.",
            })
        items.append({
            "index": index,
            "status": status,
            "selectable": not errors and not is_exact,
            "selected_by_default": not errors and not is_exact and not is_similar,
            "errors": errors,
            "question": question,
            "dedup": dedup,
        })
        if not errors and not is_exact:
            candidate = {"question": question, "batch_index": index, "status": "batch"}
            earlier.append(candidate)
            earlier_by_text[normalized_text] = candidate

    counts = {key: sum(1 for item in items if item["status"] == key) for key in ["valid", "similar", "exact_duplicate", "invalid"]}
    return {"ok": True, "total": len(items), "summary": counts, "items": items}


def caption_for(question):
    caption = content_generator.normalize_caption(question, content_generator.draft_caption(question))
    return caption, f"{caption.get('caption', '')}\n\n{' '.join(caption.get('hashtag', []))}\n"


def write_imported_question(question, run_id, account, dedup, render_images=False):
    storage_path = content_generator.build_storage_path(question, run_id)
    run_dir = content_generator.SAVED_DIR / storage_path
    run_dir.mkdir(parents=True, exist_ok=True)
    question = dict(question)
    question["akun"] = account
    caption, caption_text = caption_for(question)
    validation = content_generator.local_validation(question, caption)
    if dedup and dedup.get("is_duplicate"):
        validation["lolos_validasi"] = False
        validation["skor"] = min(validation.get("skor", 0), 74)
        validation.setdefault("catatan", {})["duplikasi"] = (
            f"Mirip {dedup.get('similarity')} dengan "
            f"{dedup.get('matched_run_id') or 'item batch ' + str((dedup.get('matched_batch_index') or 0) + 1)}"
        )
    (run_dir / "soal.json").write_text(json.dumps(question, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir / "caption.txt").write_text(caption_text, encoding="utf-8")
    metadata = {
        "ok": True, "run_id": run_id, "source": "import", "fallback_used": False,
        "fallback_reason": None, "fallbacks": [], "errors": {}, "review_status": "needs_review",
        "dedup": dedup, "validator": {"passed": bool(validation.get("lolos_validasi")), "issues": validation.get("issues", [])},
        "usage": {"input_tokens": 0, "output_tokens": 0},
        "ai_usage": {"calls": [], "total_prompt_tokens": 0, "total_output_tokens": 0, "total_tokens": 0},
        "provider": None, "model": None, "storage_path": storage_path.as_posix(),
        "created_at": dt.datetime.now().isoformat(timespec="seconds"), "question": question,
        "validation": validation, "caption": caption,
        "files": {"question": str(run_dir / "soal.json"), "caption": str(run_dir / "caption.txt"), "image": None,
                  "images": [], "thumbnail": None, "explanation": None, "explanations": []},
    }
    metadata_path = run_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    if render_images:
        content_generator.render_images_for_metadata(metadata_path)
    return run_dir, storage_path.as_posix()


def load_index():
    try:
        data = json.loads(content_generator.BANK_INDEX_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_index(index):
    path = content_generator.BANK_INDEX_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".import.tmp")
    temporary.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def allocate_run_ids(count, occupied):
    current = dt.datetime.now()
    allocated = []
    while len(allocated) < count:
        run_id = current.strftime("%Y%m%d-%H%M%S")
        if run_id not in occupied:
            allocated.append(run_id)
            occupied.add(run_id)
        current += dt.timedelta(seconds=1)
    return allocated


def import_batch(payload, account, render_images=False):
    questions = payload.get("questions") if isinstance(payload, dict) else payload
    evaluation = evaluate_batch(questions)
    selected = payload.get("selected_indices") if isinstance(payload, dict) else None
    confirmed = set(payload.get("confirmed_similar_indices") or []) if isinstance(payload, dict) else set()
    if selected is None:
        selected = [item["index"] for item in evaluation["items"] if item["selected_by_default"]]
    selected = list(dict.fromkeys(int(index) for index in selected))
    by_index = {item["index"]: item for item in evaluation["items"]}
    accepted = []
    rejected = []
    for index in selected:
        item = by_index.get(index)
        if not item or not item["selectable"]:
            rejected.append({"index": index, "reason": "Soal invalid atau duplikat exact."})
        elif item["status"] == "similar" and index not in confirmed:
            rejected.append({"index": index, "reason": "Similarity tinggi belum dikonfirmasi."})
        else:
            accepted.append(item)

    index_entries = [item for item in load_index() if item.get("run_id")]
    occupied = {item["run_id"] for item in index_entries}
    run_ids = allocate_run_ids(len(accepted), occupied)
    imported = []
    for item, run_id in zip(accepted, run_ids):
        run_dir, storage_path = write_imported_question(item["question"], run_id, account, item["dedup"], render_images)
        now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")
        index_entries.insert(0, {
            "run_id": run_id, "subtes": content_generator.slugify(item["question"].get("mapel")),
            "topik": content_generator.slugify(item["question"].get("topik")), "level": item["question"].get("level"),
            "status": "saved", "source": "import", "is_duplicate": bool(item["dedup"] and item["dedup"].get("is_duplicate")),
            "saved_at": now, "status_updated_at": None, "approved_at": None, "rejected_at": None,
            "exported_at": None, "export_batch_id": None, "uploaded_at": None, "path": f"saved/{storage_path}",
        })
        imported.append({"index": item["index"], "run_id": run_id, "path": str(run_dir), "topik": item["question"].get("topik")})
    save_index(index_entries)
    return {"ok": True, "imported": imported, "rejected": rejected, "summary": evaluation["summary"]}


def read_payload(source):
    raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    return fix_text(json.loads(raw))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_json", nargs="?", default="-")
    parser.add_argument("--account", default="@utbk_neareducation")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--skip-render", action="store_true")
    args = parser.parse_args()
    try:
        payload = read_payload(args.input_json)
        questions = payload.get("questions") if isinstance(payload, dict) else payload
        result = evaluate_batch(questions) if args.validate_only else import_batch(payload, args.account, not args.skip_render)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
