import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import content_generator


def needs_similarity(metadata):
    dedup = metadata.get("dedup")
    return not isinstance(dedup, dict) or "similarity" not in dedup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--all", action="store_true", help="Hitung ulang metadata yang sudah memiliki similarity.")
    args = parser.parse_args()
    checked = []
    skipped = 0
    failed = []
    for metadata_path in sorted(content_generator.SAVED_DIR.rglob("metadata.json")):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if not args.all and not needs_similarity(metadata):
                skipped += 1
                continue
            run_id = str(metadata.get("run_id") or metadata_path.parent.name)
            dedup = content_generator.check_duplicate(metadata.get("question") or {}, exclude_run_id=run_id)
            if not args.dry_run:
                metadata["dedup"] = dedup
                temporary = metadata_path.with_suffix(".similarity.tmp")
                temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
                temporary.replace(metadata_path)
            checked.append({"run_id": run_id, "metadata": str(metadata_path), "dedup": dedup})
        except Exception as error:
            failed.append({"metadata": str(metadata_path), "error": str(error)})
    print(json.dumps({
        "ok": not failed,
        "dry_run": args.dry_run,
        "checked": len(checked),
        "skipped": skipped,
        "duplicates": sum(1 for item in checked if item["dedup"].get("is_duplicate")),
        "items": checked,
        "failed": failed,
    }, ensure_ascii=False, indent=2))
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
