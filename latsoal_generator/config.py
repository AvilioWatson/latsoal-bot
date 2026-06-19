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

TAXONOMY = json.loads((ROOT / "config" / "taxonomy.json").read_text(encoding="utf-8"))
MAPEL_TOPICS = TAXONOMY.get("topics", {})
PATTERN_FILES = TAXONOMY.get("pattern_files", {})
