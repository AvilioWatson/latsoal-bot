import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import content_generator


def main():
    states = Counter()
    above_threshold = []
    invalid = []
    for metadata_path in sorted(content_generator.SAVED_DIR.rglob("metadata.json")):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception as error:
            states["invalid_metadata"] += 1
            invalid.append({"metadata": str(metadata_path), "error": str(error)})
            continue
        dedup = metadata.get("dedup")
        if not isinstance(dedup, dict) or "similarity" not in dedup:
            states["not_tested"] += 1
            continue
        states["tested"] += 1
        if dedup.get("is_duplicate"):
            above_threshold.append({
                "run_id": metadata.get("run_id") or metadata_path.parent.name,
                "similarity": dedup.get("similarity"),
                "matched_run_id": dedup.get("matched_run_id"),
                "matched_batch_index": dedup.get("matched_batch_index"),
                "metadata": str(metadata_path),
            })
    print(json.dumps({
        "ok": not invalid,
        "total": sum(states.values()),
        "states": dict(states),
        "above_threshold": above_threshold,
        "invalid": invalid,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
