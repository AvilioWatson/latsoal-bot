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


MOJIBAKE_REPLACEMENTS = {
    "Â²": "²",
    "Â³": "³",
    "Â±": "±",
    "Ã—": "×",
    "â‰ ": "≠",
    "â‰ ": "≠",
    "â‰¤": "≤",
    "â‰¥": "≥",
    "âˆš": "√",
    "âˆ ": "∠",
    "â†’": "→",
    "âœ“": "✓",
    "âœ—": "✗",
    "â€“": "-",
    "â€”": "-",
    "Ï€": "π",
    "â‚": "1",
    "â‚‚": "2",
    "₀": "0",
    "₁": "1",
    "₂": "2",
    "₃": "3",
    "₄": "4",
    "₅": "5",
    "₆": "6",
    "₇": "7",
    "₈": "8",
    "₉": "9",
    "Â": "",
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


def slugify(value):
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")


def is_valid_question(question):
    answer = str(question.get("jawaban") or "").strip().upper()
    choices = question.get("pilihan") or {}
    return (
        answer in {"A", "B", "C", "D", "E"}
        and all(str(choices.get(key, "")).strip() for key in ["A", "B", "C", "D", "E"])
        and str(question.get("soal", "")).strip()
        and str(question.get("pembahasan", "")).strip()
    )


def normalize_question_text(question):
    return " ".join(str(question.get("soal", "")).lower().split())


def existing_question_texts():
    texts = set()
    if not content_generator.SAVED_DIR.exists():
        return texts
    for metadata_path in content_generator.SAVED_DIR.rglob("metadata.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        question = metadata.get("question") or {}
        text = normalize_question_text(question)
        if text:
            texts.add(text)
    return texts


def caption_for(question):
    caption = content_generator.normalize_caption(question, content_generator.draft_caption(question))
    caption_text = caption.get("caption", "")
    hashtags = " ".join(caption.get("hashtag", []))
    return caption, f"{caption_text}\n\n{hashtags}\n"


def next_run_id(base_time, index):
    return (base_time + dt.timedelta(seconds=index)).strftime("%Y%m%d-%H%M%S")


def write_imported_question(question, run_id, account):
    storage_path = content_generator.build_storage_path(question, run_id)
    run_dir = content_generator.SAVED_DIR / storage_path
    run_dir.mkdir(parents=True, exist_ok=True)

    question = dict(question)
    question["jawaban"] = str(question.get("jawaban") or "").strip().upper()
    question["akun"] = account
    caption, caption_text = caption_for(question)
    validation = content_generator.local_validation(question, caption)

    (run_dir / "soal.json").write_text(json.dumps(question, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_dir / "caption.txt").write_text(caption_text, encoding="utf-8")

    metadata = {
        "ok": True,
        "run_id": run_id,
        "source": "import",
        "fallback_used": False,
        "fallback_reason": None,
        "fallbacks": [],
        "errors": {},
        "review_status": "needs_review",
        "dedup": content_generator.check_duplicate(question),
        "validator": {
            "passed": bool(validation.get("lolos_validasi")),
            "issues": validation.get("issues", []),
        },
        "usage": {"input_tokens": 0, "output_tokens": 0},
        "ai_usage": {"calls": [], "total_prompt_tokens": 0, "total_output_tokens": 0, "total_tokens": 0},
        "provider": None,
        "model": None,
        "storage_path": storage_path.as_posix(),
        "created_at": dt.datetime.now().isoformat(timespec="seconds"),
        "question": question,
        "validation": validation,
        "caption": caption,
        "files": {
            "question": str(run_dir / "soal.json"),
            "caption": str(run_dir / "caption.txt"),
            "image": None,
            "images": [],
            "thumbnail": None,
            "explanation": None,
            "explanations": [],
        },
    }
    metadata_path = run_dir / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    render_result = content_generator.render_images_for_metadata(metadata_path)
    return run_dir, storage_path.as_posix(), render_result["files"]


def load_index():
    path = content_generator.BANK_INDEX_PATH
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_index(index):
    content_generator.BANK_INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    content_generator.BANK_INDEX_PATH.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_json")
    parser.add_argument("--account", default="@utbk_neareducation")
    args = parser.parse_args()

    source = Path(args.input_json)
    questions = fix_text(json.loads(source.read_text(encoding="utf-8")))
    if not isinstance(questions, list):
        raise ValueError("Input harus berupa array JSON soal.")

    valid_questions = [question for question in questions if is_valid_question(question)]
    skipped_invalid = len(questions) - len(valid_questions)
    existing_texts = existing_question_texts()
    deduped_questions = []
    skipped_duplicates = 0
    for question in valid_questions:
        text = normalize_question_text(question)
        if text in existing_texts:
            skipped_duplicates += 1
            continue
        existing_texts.add(text)
        deduped_questions.append(question)
    base_time = dt.datetime.now()
    index = [item for item in load_index() if item.get("run_id")]
    imported = []

    for offset, question in enumerate(deduped_questions):
        run_id = next_run_id(base_time, offset)
        run_dir, storage_path, _ = write_imported_question(question, run_id, args.account)
        now = dt.datetime.now().isoformat(timespec="milliseconds") + "Z"
        index.insert(0, {
            "run_id": run_id,
            "subtes": slugify(question.get("mapel", "")),
            "topik": slugify(question.get("topik", "")),
            "level": question.get("level", ""),
            "status": "saved",
            "source": "import",
            "is_duplicate": False,
            "saved_at": now,
            "status_updated_at": None,
            "approved_at": None,
            "rejected_at": None,
            "exported_at": None,
            "export_batch_id": None,
            "uploaded_at": None,
            "path": f"saved/{storage_path}",
        })
        imported.append({"run_id": run_id, "path": str(run_dir), "topik": question.get("topik")})

    save_index(index)
    print(json.dumps({
        "ok": True,
        "imported": imported,
        "skipped": skipped_invalid + skipped_duplicates,
        "skipped_invalid": skipped_invalid,
        "skipped_duplicates": skipped_duplicates,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
