import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import content_generator


def load_index():
    path = content_generator.BANK_INDEX_PATH
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else []


def save_index(index):
    content_generator.BANK_INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    content_generator.BANK_INDEX_PATH.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def metadata_dirs():
    if not content_generator.SAVED_DIR.exists():
        return []
    return [path.parent for path in content_generator.SAVED_DIR.rglob("metadata.json")]


def migrate_one(run_dir):
    metadata_path = run_dir / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    run_id = metadata.get("run_id") or run_dir.name
    if not re_valid_run_id(run_id):
        return None
    target_relative = content_generator.build_storage_path(metadata.get("question") or {}, run_id)
    target_dir = content_generator.SAVED_DIR / target_relative
    current_relative = run_dir.relative_to(content_generator.SAVED_DIR)
    metadata["storage_path"] = target_relative.as_posix()
    retarget_files(metadata, target_dir)

    if current_relative == target_relative:
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"run_id": run_id, "path": f"saved/{target_relative.as_posix()}", "moved": False}

    target_dir.parent.mkdir(parents=True, exist_ok=True)
    if target_dir.exists():
        shutil.rmtree(target_dir)
    shutil.move(str(run_dir), str(target_dir))
    (target_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    cleanup_empty_parents(current_relative.parent)
    return {"run_id": run_id, "path": f"saved/{target_relative.as_posix()}", "moved": True}


def retarget_files(metadata, target_dir):
    files = metadata.setdefault("files", {})
    files["question"] = str(target_dir / "soal.json")
    files["caption"] = str(target_dir / "caption.txt")

    def artifact_name(value):
        return Path(str(value or "")).name

    for key in ["image", "thumbnail", "explanation"]:
        if files.get(key):
            files[key] = str(target_dir / artifact_name(files[key]))
    for key in ["images", "explanations"]:
        if isinstance(files.get(key), list):
            files[key] = [str(target_dir / artifact_name(file)) for file in files[key]]


def re_valid_run_id(run_id):
    import re
    return bool(re.fullmatch(r"\d{8}-\d{6}", str(run_id or "")))


def cleanup_empty_parents(relative_dir):
    current = content_generator.SAVED_DIR / relative_dir
    while current != content_generator.SAVED_DIR and current.exists():
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def main():
    migrated = []
    for run_dir in metadata_dirs():
        item = migrate_one(run_dir)
        if item:
            migrated.append(item)

    migrated_by_run_id = {item["run_id"]: item for item in migrated}
    index = []
    seen = set()
    for entry in load_index():
        run_id = entry.get("run_id")
        if run_id in migrated_by_run_id and run_id not in seen:
            index.append({**entry, "path": migrated_by_run_id[run_id]["path"]})
            seen.add(run_id)
    for item in migrated:
        if item["run_id"] not in seen:
            index.append({
                "run_id": item["run_id"],
                "path": item["path"],
                "status": "saved",
                "source": "import",
            })
    save_index(index)
    print(json.dumps({"ok": True, "migrated": migrated}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
