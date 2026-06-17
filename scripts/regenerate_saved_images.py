import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import content_generator


def iter_metadata(scope_codes):
    saved = content_generator.SAVED_DIR
    for code in scope_codes:
      base = saved / code
      if base.exists():
          yield from sorted(base.rglob("metadata.json"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--codes", default="PK,PM")
    args = parser.parse_args()
    codes = [code.strip() for code in args.codes.split(",") if code.strip()]
    rendered = []
    for metadata_path in iter_metadata(codes):
        result = content_generator.render_images_for_metadata(metadata_path)
        rendered.append({
            "run_id": result.get("run_id"),
            "metadata": str(metadata_path),
            "images": len(result.get("files", {}).get("images", [])),
        })
    print(json.dumps({"ok": True, "rendered": rendered}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
