import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_HASHTAGS = ["#UTBK", "#UTBK2027", "#LatsoalUTBK", "#BelajarUTBK", "#SoalUTBK"]


def normalize_hashtags(value):
    raw = value if isinstance(value, list) else []
    merged = []
    for tag in [*REQUIRED_HASHTAGS, *raw]:
        tag = str(tag or "").strip()
        if not tag:
            continue
        if not tag.startswith("#"):
            tag = f"#{tag}"
        if tag not in merged:
            merged.append(tag)
    return merged


def caption_text(caption):
    text = str(caption.get("caption") or "")
    hashtags = " ".join(caption.get("hashtag") or [])
    return f"{text}\n\n{hashtags}\n"


def backfill_metadata(metadata_path, dry_run=False):
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    caption = metadata.get("caption")
    if not isinstance(caption, dict):
        return False

    next_hashtags = normalize_hashtags(caption.get("hashtag"))
    if caption.get("hashtag") == next_hashtags:
        return False

    caption["hashtag"] = next_hashtags
    if dry_run:
        return True

    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    caption_path = metadata_path.parent / "caption.txt"
    caption_path.write_text(caption_text(caption), encoding="utf-8")
    return True


def main():
    parser = argparse.ArgumentParser(description="Backfill required UTBK hashtags into stored captions.")
    parser.add_argument("roots", nargs="*", default=["saved", "outputs", "approved"])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    checked = 0
    updated = []
    for root_name in args.roots:
        root = (ROOT / root_name).resolve()
        if not root.exists():
            continue
        for metadata_path in root.rglob("metadata.json"):
            checked += 1
            if backfill_metadata(metadata_path, dry_run=args.dry_run):
                updated.append(str(metadata_path.relative_to(ROOT)))

    print(json.dumps({
        "ok": True,
        "checked": checked,
        "updated_count": len(updated),
        "updated": updated,
        "dry_run": args.dry_run,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
