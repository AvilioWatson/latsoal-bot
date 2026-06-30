import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = Path(os.getenv("LATSOAL_DATA_ROOT", ROOT)).resolve()
OUTPUT_DIR = DATA_ROOT / "outputs"
BANK_DIR = ROOT / "bank_soal" / "patterns"
SAVED_DIR = DATA_ROOT / "saved"
BANK_INDEX_PATH = DATA_ROOT / "bank" / "index.json"
DEDUP_THRESHOLD = float(os.getenv("DEDUP_THRESHOLD", "0.82"))
LOGO_PATH = ROOT / "assets" / "near_education_wordmark_v2.svg"
RENDER_ENGINE = os.getenv("LATSOAL_RENDER_ENGINE", "auto").strip().lower()
LATEX_COMMAND = os.getenv("LATSOAL_LATEX_COMMAND", "pdflatex").strip() or "pdflatex"
PDF_CONVERTER = os.getenv("LATSOAL_PDF_CONVERTER", "").strip()
RENDER_TIMEOUT_SECONDS = int(os.getenv("LATSOAL_RENDER_TIMEOUT_SECONDS", "60"))

DEFAULT_TAXONOMY_PATH = DATA_ROOT / "config" / "taxonomy.json" if DATA_ROOT != ROOT else ROOT / "config" / "taxonomy.json"
TAXONOMY_PATH = Path(os.getenv("LATSOAL_TAXONOMY_PATH", DEFAULT_TAXONOMY_PATH)).resolve()
if not TAXONOMY_PATH.exists():
    TAXONOMY_PATH.parent.mkdir(parents=True, exist_ok=True)
    TAXONOMY_PATH.write_text((ROOT / "config" / "taxonomy.json").read_text(encoding="utf-8"), encoding="utf-8")
TAXONOMY = json.loads(TAXONOMY_PATH.read_text(encoding="utf-8"))
SEED_TAXONOMY = json.loads((ROOT / "config" / "taxonomy.json").read_text(encoding="utf-8"))
taxonomy_changed = False
for subtest, topics in SEED_TAXONOMY.get("topics", {}).items():
    if subtest in TAXONOMY.get("topics", {}):
        continue
    TAXONOMY.setdefault("topics", {})[subtest] = topics
    if subtest in SEED_TAXONOMY.get("subtest_codes", {}):
        TAXONOMY.setdefault("subtest_codes", {})[subtest] = SEED_TAXONOMY["subtest_codes"][subtest]
    if subtest in SEED_TAXONOMY.get("topic_aliases", {}):
        TAXONOMY.setdefault("topic_aliases", {})[subtest] = SEED_TAXONOMY["topic_aliases"][subtest]
    if subtest in SEED_TAXONOMY.get("pattern_files", {}):
        TAXONOMY.setdefault("pattern_files", {})[subtest] = SEED_TAXONOMY["pattern_files"][subtest]
    taxonomy_changed = True
if taxonomy_changed:
    TAXONOMY_PATH.write_text(json.dumps(TAXONOMY, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
MAPEL_TOPICS = TAXONOMY.get("topics", {})
PATTERN_FILES = TAXONOMY.get("pattern_files", {})
