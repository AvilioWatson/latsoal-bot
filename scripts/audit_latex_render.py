import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SAVED = ROOT / "saved"


def main():
    records = []
    for metadata_path in sorted(SAVED.rglob("metadata.json")):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception as error:
            records.append({
                "metadata": str(metadata_path),
                "status": "invalid_metadata",
                "error": str(error),
            })
            continue

        question = metadata.get("question") or {}
        engine = metadata.get("render_engine") or "missing"
        records.append({
            "run_id": metadata.get("run_id"),
            "mapel": question.get("mapel"),
            "topik": question.get("topik"),
            "render_engine": engine,
            "metadata": str(metadata_path),
            "needs_latex_render": engine != "latex",
        })

    pending = [record for record in records if record.get("needs_latex_render")]
    summary = {
        "total": len(records),
        "render_engines": dict(Counter(record.get("render_engine", "invalid") for record in records)),
        "needs_latex_render": len(pending),
        "items": pending,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
