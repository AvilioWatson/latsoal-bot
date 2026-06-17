import argparse
import datetime as dt
import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path(os.getenv("LATSOAL_DATA_ROOT", ROOT)).resolve()
OUTPUT_DIR = DATA_ROOT / "outputs"
BANK_DIR = ROOT / "bank_soal" / "patterns"
SAVED_DIR = DATA_ROOT / "saved"
BANK_INDEX_PATH = DATA_ROOT / "bank" / "index.json"
DEDUP_THRESHOLD = float(os.getenv("DEDUP_THRESHOLD", "0.82"))
LOGO_PATH = ROOT / "assets" / "near_education_wordmark_v2.svg"
RENDER_ENGINE = os.getenv("LATSOAL_RENDER_ENGINE", "latex").strip().lower()
LATEX_COMMAND = os.getenv("LATSOAL_LATEX_COMMAND", "pdflatex").strip() or "pdflatex"
PDF_CONVERTER = os.getenv("LATSOAL_PDF_CONVERTER", "").strip()
RENDER_TIMEOUT_SECONDS = int(os.getenv("LATSOAL_RENDER_TIMEOUT_SECONDS", "60"))

SUBTEST_CODES = {
    "pengetahuan-kuantitatif": "PK",
    "penalaran-matematika": "PM",
    "penalaran-umum": "PU",
    "pengetahuan-dan-pemahaman-umum": "PPU",
    "pemahaman-bacaan-dan-menulis": "PBM",
    "literasi-bahasa-indonesia": "LBI",
    "literasi-bahasa-inggris": "LBE",
}


def json_stdout(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def slugify(value):
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")


def subtest_code(mapel):
    slug = slugify(mapel)
    return SUBTEST_CODES.get(slug, slug.upper() or "LAINNYA")


def build_storage_path(question, run_id):
    return Path(subtest_code(question.get("mapel"))) / slugify(question.get("topik") or "umum") / run_id


def classify_error(exc):
    message = clean_error_message(exc) if "clean_error_message" in globals() else str(exc)
    lowered = message.lower()
    if "quota" in lowered or "429" in lowered:
        return "quota_exceeded"
    if any(token in lowered for token in ["urlopen", "timed out", "timeout", "network", "connection", "dns"]):
        return "network_error"
    if "json" in lowered or "parse" in lowered:
        return "invalid_json"
    if "validasi" in lowered or "validation" in lowered:
        return "validation_failed"
    return "unknown"


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        json_stdout({
            "ok": False,
            "error": "validation_failed",
            "detail": message,
            "fallback_used": False,
            "fallback_reason": None,
        })
        raise SystemExit(2)


def load_env_file():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file()
DEFAULT_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
KIMI_MODEL = os.getenv("KIMI_MODEL", "moonshotai/kimi-k2.6")
KIMI_API_URL = os.getenv("KIMI_API_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
MAX_GEMINI_RETRIES = int(os.getenv("GEMINI_RETRIES", "3"))
GEMINI_MAX_OUTPUT_TOKENS = int(os.getenv("GEMINI_MAX_OUTPUT_TOKENS", "4096"))
KIMI_MAX_OUTPUT_TOKENS = int(os.getenv("KIMI_MAX_OUTPUT_TOKENS", "16384"))
GEMINI_VALIDATE = os.getenv("GEMINI_VALIDATE", "").lower() in {"1", "true", "yes"}
GEMINI_CAPTION = os.getenv("GEMINI_CAPTION", "").lower() in {"1", "true", "yes"}
GEMINI_USAGE = []


MAPEL_TOPICS = json.loads((ROOT / "config" / "topics.json").read_text(encoding="utf-8"))
PATTERN_FILES = json.loads((ROOT / "config" / "patterns.json").read_text(encoding="utf-8"))


QUESTION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "mapel": {"type": "STRING"},
        "kelompok_tes": {"type": "STRING"},
        "topik": {"type": "STRING"},
        "level": {"type": "STRING"},
        "soal": {"type": "STRING"},
        "pilihan": {
            "type": "OBJECT",
            "properties": {
                "A": {"type": "STRING"},
                "B": {"type": "STRING"},
                "C": {"type": "STRING"},
                "D": {"type": "STRING"},
                "E": {"type": "STRING"},
            },
            "required": ["A", "B", "C", "D", "E"],
        },
        "jawaban": {"type": "STRING"},
        "pembahasan": {"type": "STRING"},
        "konsep_kunci": {"type": "STRING"},
        "tips_pengerjaan": {"type": "STRING"},
        "butuh_visual": {"type": "BOOLEAN"},
        "deskripsi_visual": {"type": "STRING"},
    },
    "required": [
        "mapel",
        "kelompok_tes",
        "topik",
        "level",
        "soal",
        "pilihan",
        "jawaban",
        "pembahasan",
        "konsep_kunci",
        "tips_pengerjaan",
        "butuh_visual",
        "deskripsi_visual",
    ],
}


VALIDATION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "lolos_validasi": {"type": "BOOLEAN"},
        "skor": {"type": "INTEGER"},
        "catatan": {
            "type": "OBJECT",
            "properties": {
                "struktur": {"type": "STRING"},
                "kebenaran": {"type": "STRING"},
                "bahasa": {"type": "STRING"},
            },
        },
        "saran_perbaikan": {"type": "STRING"},
    },
    "required": ["lolos_validasi", "skor", "catatan", "saran_perbaikan"],
}


CAPTION_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "caption": {"type": "STRING"},
        "hashtag": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
        },
    },
    "required": ["caption", "hashtag"],
}


def _now_id():
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def _extract_json(text):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("Response tidak berisi JSON.")
    return json.loads(match.group(0))


def clean_error_message(exc):
    text = str(exc)
    if "429" in text or "RESOURCE_EXHAUSTED" in text:
        return "Kuota AI habis untuk model/free tier saat ini."
    if "WinError 10013" in text or "urlopen error" in text:
        return "Akses jaringan ke provider AI belum tersedia dari proses ini."
    if "Gagal parse JSON Gemini" in text:
        return "Gemini mengembalikan JSON yang tidak valid."
    if "Gagal parse JSON Kimi" in text:
        return "Kimi mengembalikan JSON yang tidak valid."
    return text[:240]


def _load_font(size, bold=False, family="sans"):
    try:
        from PIL import ImageFont
    except ImportError:
        return None

    if family == "lora":
        font_names = [
            "Lora-Bold.ttf" if bold else "Lora-Regular.ttf",
            "Lora-Bold.otf" if bold else "Lora-Regular.otf",
            "georgiab.ttf" if bold else "georgia.ttf",
            "timesbd.ttf" if bold else "times.ttf",
        ]
    elif family == "playfair":
        font_names = [
            "PlayfairDisplay-Bold.ttf" if bold else "PlayfairDisplay-Regular.ttf",
            "PlayfairDisplay-Bold.otf" if bold else "PlayfairDisplay-Regular.otf",
            "georgiab.ttf" if bold else "georgia.ttf",
            "timesbd.ttf" if bold else "times.ttf",
        ]
    elif family == "inter":
        font_names = [
            "Inter-Bold.ttf" if bold else "Inter-Regular.ttf",
            "Inter_18pt-Bold.ttf" if bold else "Inter_18pt-Regular.ttf",
            "arialbd.ttf" if bold else "arial.ttf",
            "segoeuib.ttf" if bold else "segoeui.ttf",
        ]
    elif family == "logo":
        font_names = [
            "Arial Black.ttf",
            "ariblk.ttf",
            "Inter-ExtraBold.ttf",
            "Inter_18pt-ExtraBold.ttf",
            "arialbd.ttf",
        ]
    elif family == "math":
        font_names = [
            "cambria.ttc",
            "seguisym.ttf",
            "segoeuisl.ttf",
            "cambria.ttf",
            "arial.ttf",
        ]
    elif family == "serif":
        font_names = [
            "georgiab.ttf" if bold else "georgia.ttf",
            "timesbd.ttf" if bold else "times.ttf",
            "cambriaz.ttf" if bold else "cambria.ttf",
        ]
    else:
        font_names = [
            "arialbd.ttf" if bold else "arial.ttf",
            "segoeuib.ttf" if bold else "segoeui.ttf",
            "calibrib.ttf" if bold else "calibri.ttf",
        ]
    search_dirs = [
        ROOT / "assets" / "fonts",
        Path(os.getenv("WINDIR", "C:/Windows")) / "Fonts",
        ROOT,
    ]
    for directory in search_dirs:
        for name in font_names:
            path = directory / name
            if path.exists():
                return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


MATH_TEXT_CHARS = set("∩∪⊂⊆⊄⊈∅≠≤≥∈∉⇒→←↔×÷±√∞≈∑∏∆∠°")
_MATH_FONT_CACHE = {}


def _font_size(font):
    return int(getattr(font, "size", 24) or 24)


def _math_font_for(font):
    size = _font_size(font)
    if size not in _MATH_FONT_CACHE:
        _MATH_FONT_CACHE[size] = _load_font(size, family="math")
    return _MATH_FONT_CACHE[size]


def _font_for_char(char, font):
    return _math_font_for(font) if char in MATH_TEXT_CHARS else font


def _plain_text_width(draw, text, font):
    bbox = draw.textbbox((0, 0), str(text), font=font)
    return bbox[2] - bbox[0]


def _text_width(draw, text, font):
    text = str(text)
    if not any(char in MATH_TEXT_CHARS for char in text):
        return _plain_text_width(draw, text, font)
    return sum(_plain_text_width(draw, char, _font_for_char(char, font)) for char in text)


def _draw_text_with_math(draw, x, y, text, font, fill):
    cursor_x = x
    for char in str(text):
        char_font = _font_for_char(char, font)
        draw.text((cursor_x, y), char, font=char_font, fill=fill)
        cursor_x += _plain_text_width(draw, char, char_font)


def _line_height(draw, font):
    bbox = draw.textbbox((0, 0), "Ag", font=font)
    return bbox[3] - bbox[1]


def _text_bbox(draw, text, font):
    return draw.textbbox((0, 0), str(text), font=font)


def _lines_visual_height(draw, lines, font, gap=8):
    heights = []
    for line in lines:
        bbox = _text_bbox(draw, line, font)
        heights.append(bbox[3] - bbox[1])
    return sum(heights) + gap * max(0, len(lines) - 1)


def _wrap_text(draw, text, font, max_width):
    lines = []
    for source_line in str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        words = source_line.split()
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if current and _text_width(draw, candidate, font) > max_width:
                lines.append(current)
                current = word
            else:
                current = candidate
        if current:
            lines.append(current)
    return lines or [""]


def _split_sentences(text):
    sentences = re.split(r"(?<=[.!?])\s+", str(text).strip())
    return [sentence.strip() for sentence in sentences if sentence.strip()]


def _format_question_text(text):
    formatted = str(text).replace("\r\n", "\n").replace("\r", "\n")
    formatted = re.sub(r"\s+([1-9]\d?\.)\s+", r"\n\1 ", formatted)
    formatted = re.sub(r"\s+(Simpulan\b)", r"\n\1", formatted)
    return re.sub(r"\n{3,}", "\n\n", formatted).strip()


def _wrap_question_paragraphs(draw, text, font, max_width):
    formatted = _format_question_text(text)
    paragraphs = []
    for paragraph in re.split(r"\n{2,}|\n", formatted):
        paragraph = paragraph.strip()
        if paragraph:
            paragraphs.append(_wrap_text(draw, paragraph, font, max_width))
    return paragraphs or [[""]]


def _flatten_paragraphs(paragraphs):
    lines = []
    for index, paragraph in enumerate(paragraphs):
        if index:
            lines.append("")
        lines.extend(paragraph)
    return _trim_blank_lines(lines)


def _paginate_paragraph_lines(paragraphs, first_capacity, next_capacity, paragraph_gap=0):
    pages = []
    current = []
    current_count = 0

    def capacity_for_next_page():
        return first_capacity if not pages else next_capacity

    for paragraph in paragraphs:
        paragraph_count = len(paragraph)
        gap = paragraph_gap if current else 0
        capacity = capacity_for_next_page()

        if current and current_count + gap + paragraph_count > capacity:
            pages.append(_trim_blank_lines(current))
            current = []
            current_count = 0
            gap = 0
            capacity = capacity_for_next_page()

        if paragraph_count > capacity:
            if current:
                pages.append(_trim_blank_lines(current))
                current = []
                current_count = 0
            for index in range(0, paragraph_count, capacity):
                chunk = paragraph[index:index + capacity]
                if index + capacity >= paragraph_count:
                    current = chunk
                    current_count = len(chunk)
                else:
                    pages.append(_trim_blank_lines(chunk))
            continue

        if gap > 1:
            current.extend([""] * gap)
            current_count += gap
        current.extend(paragraph)
        current_count += paragraph_count

    if current:
        pages.append(_trim_blank_lines(current))
    return [page for page in pages if page]


def _draw_justified_line(draw, x, y, line, font, fill, max_width, justify=True):
    words = str(line).split()
    if not justify or len(words) < 2:
        _draw_text_with_math(draw, x, y, line, font, fill)
        return
    words_width = sum(_text_width(draw, word, font) for word in words)
    gap_count = len(words) - 1
    gap_width = max(4, (max_width - words_width) / gap_count)
    cursor_x = x
    for index, word in enumerate(words):
        _draw_text_with_math(draw, cursor_x, y, word, font, fill)
        cursor_x += _text_width(draw, word, font)
        if index < gap_count:
            cursor_x += gap_width


def _chunks(items, size):
    return [items[index:index + size] for index in range(0, len(items), size)]


def _paginate_quiz(draw, question, fonts):
    q_paragraphs = _wrap_question_paragraphs(draw, question.get("soal", ""), fonts["question"], 790)
    q_lines = _flatten_paragraphs(q_paragraphs)
    choices = question.get("pilihan", {})
    choice_page_limit = 460 if len(q_lines) <= 5 else 742
    choice_pages = []
    current = []
    used = 0
    for key in ["A", "B", "C", "D", "E"]:
        lines = _wrap_text(draw, choices.get(key, ""), fonts["body"], 650)
        content_h = _lines_visual_height(draw, lines, fonts["body"], gap=8)
        block_h = max(78, content_h + 28)
        if current and used + block_h + 14 > choice_page_limit:
            choice_pages.append(current)
            current = []
            used = 0
        current.append((key, lines, block_h))
        used += block_h + 14
    if current:
        choice_pages.append(current)

    pages = []
    if len(q_lines) <= 5:
        pages.append({"question_lines": q_lines, "choices": choice_pages[0] if choice_pages else []})
        for choice_page in choice_pages[1:]:
            pages.append({"question_lines": [], "choices": choice_page})
    else:
        for q_chunk in _paginate_paragraph_lines(q_paragraphs, 10, 10, paragraph_gap=1):
            pages.append({"question_lines": q_chunk, "choices": []})
        for choice_page in choice_pages:
            pages.append({"question_lines": [], "choices": choice_page})
    return pages or [{"question_lines": [""], "choices": []}]


def _load_quiz_logo(target_width=164):
    if not LOGO_PATH.exists():
        return None
    try:
        import cairosvg
        from PIL import Image
    except Exception:
        return _build_quiz_logo_fallback(target_width)

    try:
        svg_text = LOGO_PATH.read_text(encoding="utf-8")
        svg_text = re.sub(r"<rect\b[^>]*/>\s*", "", svg_text, count=1)
        png_bytes = cairosvg.svg2png(bytestring=svg_text.encode("utf-8"), output_width=target_width)
        logo = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
        logo.load()
        return logo
    except Exception:
        return _build_quiz_logo_fallback(target_width)


def _draw_tracking_text(draw, x, y, text, font, fill, tracking=0):
    cursor_x = x
    for char in text:
        draw.text((cursor_x, y), char, font=font, fill=fill)
        cursor_x += _text_width(draw, char, font) + tracking


def _tracking_width(draw, text, font, tracking=0):
    if not text:
        return 0
    return sum(_text_width(draw, char, font) for char in text) + tracking * (len(text) - 1)


def _build_quiz_logo_fallback(target_width=164):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None

    height = int(target_width * 290 / 690)
    logo = Image.new("RGBA", (target_width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(logo)
    ink = "#2b2010"
    near_font = _load_font(32, bold=True)
    education_font = _load_font(10)

    near = "NEAR"
    near_tracking = 1
    near_w = _tracking_width(draw, near, near_font, near_tracking)
    _draw_tracking_text(draw, (target_width - near_w) / 2, 12, near, near_font, ink, near_tracking)

    education = "EDUCATION"
    edu_tracking = 3
    edu_w = _tracking_width(draw, education, education_font, edu_tracking)
    _draw_tracking_text(draw, (target_width - edu_w) / 2, 45, education, education_font, ink, edu_tracking)
    return logo


def _count_quiz_image_pages(question):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return 0

    width = height = 1000
    fonts = {
        "question": _load_font(30, family="lora"),
        "body": _load_font(30, family="lora"),
    }
    probe = Image.new("RGB", (width, height), "#f5f0e8")
    return len(_paginate_quiz(ImageDraw.Draw(probe), question, fonts))


def render_thumbnail_image(question, run_dir):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None

    width = height = 1080
    colors = {
        "bg": "#f5f0e8",
        "panel": "#ede8df",
        "ink": "#2a2118",
        "muted": "#9c8f7e",
        "line": "#d4cdc2",
        "accent": "#26405a",
    }
    fonts = {
        "category": _load_font(46, family="playfair"),
        "title": _load_font(28, family="lora"),
        "small": _load_font(18, family="lora"),
    }

    image = Image.new("RGB", (width, height), colors["bg"])
    draw = ImageDraw.Draw(image)
    logo = _load_quiz_logo()
    account = str(question.get("akun", "@utbk_neareducation") or "@utbk_neareducation")
    if not account.startswith("@"):
        account = f"@{account}"
    subtest = str(question.get("mapel", "Latihan UTBK"))
    subtopic = str(question.get("topik") or question.get("mapel", "Subtopik"))

    draw.rectangle((0, 0, width, height), fill=colors["bg"])
    left = 78
    right = width - 78
    center_y = height // 2
    if logo:
        image.paste(logo, (right - logo.width - 28, 96), logo)

    draw.line((left, 270, right, 270), fill=colors["line"], width=2)
    draw.line((left, 810, right, 810), fill=colors["line"], width=2)
    subtest_lines = _wrap_text(draw, subtest, fonts["category"], 760)[:2]
    subtopic_lines = _wrap_text(draw, subtopic, fonts["title"], 760)[:2]
    subtest_h = _lines_visual_height(draw, subtest_lines, fonts["category"], gap=10)
    subtopic_h = _lines_visual_height(draw, subtopic_lines, fonts["title"], gap=8)
    total_title_h = subtest_h + 24 + subtopic_h
    text_y = center_y - total_title_h // 2
    for line in subtest_lines:
        line_w = _text_width(draw, line, fonts["category"])
        draw.text(((width - line_w) / 2, text_y), line, font=fonts["category"], fill=colors["ink"])
        text_y += _line_height(draw, fonts["category"]) + 10
    text_y += 14
    for line in subtopic_lines:
        line_w = _text_width(draw, line, fonts["title"])
        draw.text(((width - line_w) / 2, text_y), line, font=fonts["title"], fill=colors["muted"])
        text_y += _line_height(draw, fonts["title"]) + 8

    draw.text((left + 70, height - 45), account, font=fonts["small"], fill="#9ca3af")
    output_path = run_dir / "thumbnail.png"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, format="PNG", optimize=True)
    return output_path


def render_quiz_images(question, run_dir, page_offset=0, total_pages=None):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return []

    width = height = 1000
    colors = {
        "bg": "#f5f0e8",       # krem hangat untuk background & pilihan
        "panel": "#ede8df",    # sedikit lebih gelap untuk kotak soal
        "panel2": "#e5dfd5",
        "ink": "#2a2118",      # coklat gelap, bukan hitam murni
        "muted": "#9c8f7e",    # muted coklat
        "quiet": "#c8bfb0",
        "line": "#d4cdc2",     # border sedikit kecoklatan
        "dark": "#1a1208",
        "white": "#f5f0e8",    # "putih" di sini tetap krem
    }
    fonts = {
        "category": _load_font(25, family="lora"),
        "title": _load_font(36, bold=True, family="playfair"),
        "question": _load_font(30, family="lora"),
        "body": _load_font(30, family="lora"),
        "body_bold": _load_font(30, bold=True, family="playfair"),
        "small": _load_font(24, family="lora"),
    }

    probe = Image.new("RGB", (width, height), colors["bg"])
    probe_draw = ImageDraw.Draw(probe)
    pages = _paginate_quiz(probe_draw, question, fonts)
    display_total = total_pages or len(pages)
    logo = _load_quiz_logo()
    output_paths = []

    for page_index, page in enumerate(pages, start=1):
        image = Image.new("RGB", (width, height), colors["bg"])
        draw = ImageDraw.Draw(image)
        account = question.get("akun", "@utbk_neareducation")

        draw.rectangle((0, 0, width, height), fill=colors["bg"])
        if logo:
            image.paste(logo, (928 - logo.width, 68), logo)
        category = str(question.get("mapel", "Kuis")).upper()
        title = str(question.get("topik") or question.get("mapel", "Pengetahuan Umum"))
        _draw_tracking_text(draw, 72, 78, category[:42], fonts["category"], colors["muted"], tracking=2)
        draw.text((72, 118), title[:44], font=fonts["title"], fill=colors["ink"])

        has_question = bool(page["question_lines"])
        has_choices = bool(page["choices"])
        q_line_h = _line_height(draw, fonts["question"]) + 16
        if has_question and not has_choices:
            q_box_h = min(696, max(320, len(page["question_lines"]) * q_line_h + 120))
            available_top = 188
            available_bottom = 930
            q_box_top = available_top + (available_bottom - available_top - q_box_h) // 2
            question_box = (72, q_box_top, 928, q_box_top + q_box_h)
        elif has_question:
            q_box_bottom = min(440, 228 + len(page["question_lines"]) * q_line_h + 54)
            question_box = (72, 188, 928, max(328, q_box_bottom))
        else:
            question_box = None

        q_lines = page["question_lines"]
        if question_box:
            draw.rounded_rectangle(question_box, radius=7, fill=colors["panel"], outline=colors["line"], width=2)
        q_total_h = len(q_lines) * q_line_h
        if question_box:
            q_y = question_box[1] + max(26, (question_box[3] - question_box[1] - q_total_h) // 2)
            text_x = question_box[0] + 54
            text_w = question_box[2] - question_box[0] - 108
            for line_index, line in enumerate(q_lines):
                _draw_justified_line(
                    draw,
                    text_x,
                    q_y,
                    line,
                    fonts["question"],
                    colors["ink"],
                    text_w,
                    justify=line_index < len(q_lines) - 1,
                )
                q_y += q_line_h

        GAP = 14
        block_heights = []
        for _, lines, _ in page["choices"]:
            content_h = _lines_visual_height(draw, lines, fonts["body"], gap=8)
            block_heights.append(max(78, content_h + 28))

        total_h = sum(block_heights) + GAP * (len(page["choices"]) - 1)
        area_top = (question_box[3] + 28) if question_box else 188
        area_bottom = 930
        area_h = area_bottom - area_top
        y = area_top + (area_h - total_h) // 2 if page["choices"] else area_top
        for (key, lines, _), block_h in zip(page["choices"], block_heights):
            fill = colors["bg"]
            outline = colors["line"]
            draw.rounded_rectangle((72, y, 928, y + block_h), radius=7, fill=fill, outline=outline, width=2)
            badge_fill = colors["bg"]
            badge_outline = colors["line"]
            badge_text = "#26405a"

            badge_top = y + (block_h - 54) // 2
            draw.rounded_rectangle((104, badge_top, 164, badge_top + 54), radius=4, fill=badge_fill, outline=badge_outline, width=2)
            key_bbox = _text_bbox(draw, key, fonts["body"])
            key_h = key_bbox[3] - key_bbox[1]
            key_y = badge_top + (54 - key_h) // 2 - key_bbox[1]
            draw.text((124, key_y), key, font=fonts["body"], fill=badge_text)

            total_text_h = _lines_visual_height(draw, lines, fonts["body"], gap=8)
            text_y = y + (block_h - total_text_h) // 2
            text_w = 700
            for line_index, line in enumerate(lines):
                line_bbox = _text_bbox(draw, line, fonts["body"])
                line_h = line_bbox[3] - line_bbox[1]
                _draw_justified_line(
                    draw,
                    190,
                    text_y - line_bbox[1],
                    line,
                    fonts["body"],
                    colors["ink"],
                    text_w,
                    justify=line_index < len(lines) - 1,
                )
                text_y += line_h + 8

            y += block_h + GAP

        draw.text((72, 942), account, font=fonts["small"], fill="#9ca3af")
        if display_total > 1:
            page_text = f"{page_offset + page_index}/{display_total}"
            page_w = _text_width(draw, page_text, fonts["small"])
            draw.text((928 - page_w, 942), page_text, font=fonts["small"], fill=colors["muted"])

        output_path = run_dir / f"post-{page_index}.png"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, format="PNG", optimize=True)
        output_paths.append(output_path)

    return output_paths


def _format_explanation_text(text, max_paragraph_chars=230):
    raw = str(text).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return ""
    symbol_replacements = {}
    for symbol, replacement in symbol_replacements.items():
        raw = raw.replace(symbol, replacement)
    raw = re.sub(r"[ \t]{2,}", " ", raw)
    raw = raw.replace(" - ", " __LATSOAL_MINUS__ ")

    raw = re.sub(r"(?m)^\s*[-–—•]\s*", "", raw)
    raw = re.sub(r"\s+[-–—•]\s+(?=[A-ZA-ZÀ-ÖØ-ÝA-Z0-9])", " ", raw)
    raw = re.sub(r"\s+[-–—•]\s*(?=$|[.!?])", "", raw)
    raw = raw.replace(" __LATSOAL_MINUS__ ", " - ")
    raw = re.sub(r"\s+(Oleh karena itu,)", r"\n\1", raw)
    raw = re.sub(r"\s+(Maka,)", r"\n\1", raw)
    raw = re.sub(r"\s+(Pilihan [A-E]\b)", r"\n\1", raw)

    paragraphs = []
    for block in re.split(r"\n{2,}|\n", raw):
        block = block.strip()
        if not block:
            continue
        current = ""
        for sentence in _split_sentences(block):
            candidate = f"{current} {sentence}".strip()
            if current and len(candidate) > max_paragraph_chars:
                paragraphs.append(current)
                current = sentence
            else:
                current = candidate
        if current:
            paragraphs.append(current)
    return "\n\n".join(paragraphs)


def _wrap_explanation_text(draw, text, font, max_width):
    lines = []
    for paragraph in _format_explanation_text(text).split("\n\n"):
        paragraph_lines = _wrap_text(draw, paragraph, font, max_width)
        if lines:
            lines.append("")
        lines.extend(paragraph_lines)
    return lines


def _wrap_explanation_paragraphs(draw, text, font, max_width):
    paragraphs = []
    for paragraph in _format_explanation_text(text).split("\n\n"):
        paragraph = paragraph.strip()
        if paragraph:
            paragraphs.append(_wrap_text(draw, paragraph, font, max_width))
    return paragraphs


def _explanation_visual_height(line_count, line_h):
    if line_count <= 0:
        return 0
    return line_count * line_h


def _trim_blank_lines(lines):
    trimmed = list(lines)
    while trimmed and not trimmed[0]:
        trimmed.pop(0)
    while trimmed and not trimmed[-1]:
        trimmed.pop()
    return trimmed


def _paginate_explanation_pages(draw, question, fonts):
    explanation = str(question.get("pembahasan") or "").strip()
    if not explanation:
        return []

    pages = []
    current = []
    current_count = 0
    paragraphs = _wrap_explanation_paragraphs(draw, explanation, fonts["body"], 748)

    def capacity_for_next_page():
        return 12 if not pages else 15

    for paragraph_lines in paragraphs:
        paragraph_count = len(paragraph_lines)
        gap = 1 if current else 0
        capacity = capacity_for_next_page()

        if current and current_count + gap + paragraph_count > capacity:
            pages.append(_trim_blank_lines(current))
            current = []
            current_count = 0
            gap = 0
            capacity = capacity_for_next_page()

        if paragraph_count > capacity:
            if current:
                pages.append(_trim_blank_lines(current))
                current = []
                current_count = 0
            for index in range(0, paragraph_count, capacity):
                chunk = paragraph_lines[index:index + capacity]
                if index + capacity >= paragraph_count:
                    current = chunk
                    current_count = len(chunk)
                else:
                    pages.append(_trim_blank_lines(chunk))
            continue

        if gap:
            current.append("")
            current_count += 1
        current.extend(paragraph_lines)
        current_count += paragraph_count

    if current:
        pages.append(_trim_blank_lines(current))
    return [page for page in pages if page]


def _count_explanation_image_pages(question):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return 0

    width = height = 1000
    fonts = {"body": _load_font(29, family="lora")}
    probe = Image.new("RGB", (width, height), "#f5f0e8")
    return len(_paginate_explanation_pages(ImageDraw.Draw(probe), question, fonts))


def render_explanation_images(question, run_dir, page_offset=0, total_pages=None):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return []

    width = height = 1000
    colors = {
        "bg": "#f5f0e8",
        "panel": "#ede8df",
        "answer_panel": "#e0d9cb",
        "ink": "#2a2118",
        "muted": "#9c8f7e",
        "line": "#d4cdc2",
    }
    fonts = {
        "category": _load_font(25, family="lora"),
        "title": _load_font(36, bold=True, family="playfair"),
        "body": _load_font(29, family="lora"),
        "body_bold": _load_font(29, bold=True, family="playfair"),
        "small": _load_font(24, family="lora"),
    }

    explanation = str(question.get("pembahasan") or "").strip()
    if not explanation:
        return []

    probe = Image.new("RGB", (width, height), colors["bg"])
    probe_draw = ImageDraw.Draw(probe)
    line_h = _line_height(probe_draw, fonts["body"]) + 12
    pages = _paginate_explanation_pages(probe_draw, question, fonts)
    display_total = total_pages or len(pages)

    logo = _load_quiz_logo()
    output_paths = []
    answer_key = str(question.get("jawaban") or "").strip().upper()
    choices = question.get("pilihan") or {}
    answer_text = choices.get(answer_key, "")

    for page_index, lines in enumerate(pages, start=1):
        image = Image.new("RGB", (width, height), colors["bg"])
        draw = ImageDraw.Draw(image)
        account = question.get("akun", "@utbk_neareducation")

        draw.rectangle((0, 0, width, height), fill=colors["bg"])
        if logo:
            image.paste(logo, (928 - logo.width, 68), logo)
        _draw_tracking_text(
            draw,
            72,
            78,
            str(question.get("mapel", "Kuis")).upper()[:42],
            fonts["category"],
            colors["muted"],
            tracking=2,
        )
        draw.text((72, 118), "Pembahasan", font=fonts["title"], fill=colors["ink"])

        panel_top = 210
        if page_index == 1:
            answer_box = (72, panel_top, 928, panel_top + 104)
            draw.rounded_rectangle(answer_box, radius=7, fill=colors["answer_panel"], outline=colors["line"], width=2)
            badge = (104, panel_top + 25, 164, panel_top + 79)
            draw.rounded_rectangle(badge, radius=4, fill=colors["bg"], outline=colors["line"], width=2)
            if answer_key:
                key_bbox = _text_bbox(draw, answer_key, fonts["body_bold"])
                key_y = badge[1] + (54 - (key_bbox[3] - key_bbox[1])) // 2 - key_bbox[1]
                draw.text((124, key_y), answer_key, font=fonts["body_bold"], fill="#26405a")

            answer_label = "Jawaban"
            if answer_key and answer_text:
                answer_label = f"{answer_key}. {answer_text}"
            elif answer_key:
                answer_label = f"{answer_key}"
            answer_lines = _wrap_text(draw, answer_label, fonts["body"], 690)
            answer_h = _lines_visual_height(draw, answer_lines[:2], fonts["body"], gap=8)
            answer_y = panel_top + (104 - answer_h) // 2
            for answer_line in answer_lines[:2]:
                line_bbox = _text_bbox(draw, answer_line, fonts["body"])
                _draw_text_with_math(draw, 190, answer_y - line_bbox[1], answer_line, fonts["body"], colors["ink"])
                answer_y += (line_bbox[3] - line_bbox[1]) + 8
            panel_top = 342

        content_h = _explanation_visual_height(len(lines), line_h)
        panel_bottom = min(876, panel_top + content_h + 92)
        draw.rounded_rectangle((72, panel_top, 928, panel_bottom), radius=7, fill=colors["panel"], outline=colors["line"], width=2)
        text_y = panel_top + 46
        for line_index, line in enumerate(lines):
            if line:
                _draw_justified_line(
                    draw,
                    126,
                    text_y,
                    line,
                    fonts["body"],
                    colors["ink"],
                    748,
                    justify=line_index < len(lines) - 1 and lines[line_index + 1] != "",
                )
            text_y += line_h

        draw.text((72, 942), account, font=fonts["small"], fill="#9ca3af")
        if display_total > 1:
            page_text = f"{page_offset + page_index}/{display_total}"
            page_w = _text_width(draw, page_text, fonts["small"])
            draw.text((928 - page_w, 942), page_text, font=fonts["small"], fill=colors["muted"])

        output_path = run_dir / f"pembahasan-{page_index}.jpg"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, format="JPEG", quality=95, subsampling=0, optimize=True)
        output_paths.append(output_path)

    return output_paths


def render_numbered_jpg_images(image_paths, run_dir):
    output_paths = []
    for index, source_path in enumerate([path for path in image_paths if path], start=1):
        source_path = Path(source_path)
        output_path = run_dir / f"{index}.jpg"
        if source_path.suffix.lower() in {".jpg", ".jpeg"}:
            shutil.copyfile(source_path, output_path)
        else:
            try:
                from PIL import Image
            except ImportError:
                raise RuntimeError("Pillow dibutuhkan untuk menomori gambar non-JPG.")
            with Image.open(source_path) as image:
                image.convert("RGB").save(output_path, format="JPEG", quality=95, subsampling=0, optimize=True)
        output_paths.append(output_path)
    return output_paths


def _wrap_plain_lines(text, width=62, max_lines=None):
    lines = []
    for paragraph in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        paragraph = re.sub(r"\s+", " ", paragraph).strip()
        if not paragraph:
            if lines:
                lines.append("")
            continue
        lines.extend(textwrap.wrap(paragraph, width=width, break_long_words=False, break_on_hyphens=False) or [""])
    lines = _trim_blank_lines(lines) or [""]
    return lines[:max_lines] if max_lines else lines


def _chunk_lines(lines, size):
    return [lines[index:index + size] for index in range(0, len(lines), size)] or [[""]]


LATEX_SYMBOLS = {
    "≤": r"$\leq$",
    "≥": r"$\geq$",
    "≠": r"$\neq$",
    "×": r"$\times$",
    "÷": r"$\div$",
    "±": r"$\pm$",
    "√": r"$\sqrt{\ }$",
    "∞": r"$\infty$",
    "≈": r"$\approx$",
    "∩": r"$\cap$",
    "∪": r"$\cup$",
    "∈": r"$\in$",
    "∉": r"$\notin$",
    "∠": r"$\angle$",
    "→": r"$\to$",
    "⇒": r"$\Rightarrow$",
    "°": r"$^\circ$",
    "π": r"$\pi$",
    "²": r"$^2$",
    "³": r"$^3$",
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
    "✓": r"\textit{benar}",
    "✗": r"\textit{salah}",
}

LATEX_MATH_SYMBOLS = {
    "≤": r"\leq",
    "≥": r"\geq",
    "≠": r"\neq",
    "×": r"\times",
    "÷": r"\div",
    "±": r"\pm",
    "∞": r"\infty",
    "≈": r"\approx",
    "∩": r"\cap",
    "∪": r"\cup",
    "∈": r"\in",
    "∉": r"\notin",
    "∠": r"\angle",
    "→": r"\to",
    "⇒": r"\Rightarrow",
    "°": r"^\circ",
    "π": r"\pi",
    "²": r"^2",
    "³": r"^3",
}


def _latex_escape(text):
    replacements = {
        "\\": r"\textbackslash{}",
        "&": r"\&",
        "%": r"\%",
        "$": r"\$",
        "#": r"\#",
        "_": r"\_",
        "{": r"\{",
        "}": r"\}",
        "[": r"{[}",
        "]": r"{]}",
        "~": r"\textasciitilde{}",
        "^": r"\textasciicircum{}",
    }
    parts = []
    for char in str(text or ""):
        if char in LATEX_SYMBOLS:
            parts.append(LATEX_SYMBOLS[char])
        else:
            parts.append(replacements.get(char, char))
    return "".join(parts)


def _latex_text_escape(text):
    replacements = {
        "\\": r"\textbackslash{}",
        "&": r"\&",
        "%": r"\%",
        "$": r"\$",
        "#": r"\#",
        "_": r"\_",
        "{": r"\{",
        "}": r"\}",
        "[": r"{[}",
        "]": r"{]}",
        "~": r"\textasciitilde{}",
        "^": r"\textasciicircum{}",
    }
    parts = []
    for char in str(text or ""):
        if char in LATEX_SYMBOLS:
            parts.append(LATEX_SYMBOLS[char])
        else:
            parts.append(replacements.get(char, char))
    return "".join(parts)


def _latex_math_escape(text):
    value = str(text or "")
    value = value.replace("\\", "")
    value = re.sub(r"√\s*\(?([A-Za-z0-9]+)\)?", r"\\sqrt{\1}", value)
    replacements = {
        "&": r"\&",
        "%": r"\%",
        "#": r"\#",
        "_": r"\_",
        "{": r"\{",
        "}": r"\}",
    }
    parts = []
    for char in value:
        if char in LATEX_MATH_SYMBOLS:
            parts.append(LATEX_MATH_SYMBOLS[char])
        elif char in replacements:
            parts.append(replacements[char])
        else:
            parts.append(char)
    return "".join(parts)


MATH_TOKEN_RE = re.compile(
    r"(?P<prefix>^|[\s({\[])"
    r"(?P<body>[A-Za-z]?\(?[A-Za-z]\)?(?:\([A-Za-z0-9]+\))?[A-Za-z0-9π√∠°²³₀-₉+\-*/=<>≤≥≠.,]+)"
)


def _looks_like_math_token(token):
    value = token.strip()
    if not value or len(value) < 2:
        return False
    if value.lower() in {"dan", "atau", "jika", "maka", "dari", "yang"}:
        return False
    if any(char in value for char in "=<>≤≥≠√∠π²³^*/"):
        return True
    if re.search(r"\b[xyabckmn]\d+\b|\d+[xyabckmn]\b|[xyabckmn][+\-]\d", value, re.I):
        return True
    if re.search(r"f\(x\)|[xy]\([^)]+\)", value, re.I):
        return True
    return False


def _latex_format_inline(text):
    source = str(text or "").replace(">=", "\u2265").replace("<=", "\u2264")
    result = []
    last = 0
    for match in MATH_TOKEN_RE.finditer(source):
        prefix = match.group("prefix")
        body = match.group("body")
        start = match.start("body")
        end = match.end("body")
        if not _looks_like_math_token(body):
            continue
        result.append(_latex_text_escape(source[last:start]))
        trailing = ""
        while body and body[-1] in ".,;:":
            trailing = body[-1] + trailing
            body = body[:-1]
            end -= 1
        result.append(rf"\mbox{{${_latex_math_escape(body)}$}}")
        result.append(_latex_text_escape(trailing))
        last = match.end("body")
    result.append(_latex_text_escape(source[last:]))
    return "".join(result)


def _compact_math_for_line_wrap(text):
    def compact_line(match):
        variable = match.group(1)
        relation = match.group(2).replace(">=", "\u2265").replace("<=", "\u2264")
        slope = (match.group(3) or "").replace(" ", "")
        sign = (match.group(4) or "").replace(" ", "")
        intercept = (match.group(5) or "").replace(" ", "")
        return f"{variable}{relation}{slope}x{sign}{intercept}"

    return re.sub(
        r"\b([yf])\s*([=<>]=?|≤|≥)\s*([+-]?\s*\d*(?:/\d+)?(?:\.\d+)?)\s*x\s*([+-])?\s*(\d+(?:\.\d+)?)?",
        compact_line,
        str(text or ""),
        flags=re.I,
    )


def _latex_lines(lines):
    return r"\\".join(_latex_format_inline(line) if line else r"\mbox{}" for line in lines)


def _node(x, y, width, lines, size=30, color="ink", align="left", weight=""):
    font = rf"\fontsize{{{size}pt}}{{{int(size * 1.28)}pt}}\selectfont"
    if weight == "bold":
        font = r"\bfseries " + font
    return (
        rf"\node[anchor=north west, text={color}, align={align}, text width={width}pt, "
        rf"font={{{font}}}] at ({x},{1080 - y}) {{{_latex_lines(lines)}}};"
    )


def _rect(x1, y1, x2, y2, fill="panel", draw="line", radius=7):
    return (
        rf"\draw[fill={fill}, draw={draw}, line width=2pt, rounded corners={radius}pt] "
        rf"({x1},{1080 - y1}) rectangle ({x2},{1080 - y2});"
    )


def _latex_document(body):
    return rf"""\documentclass{{article}}
\usepackage[papersize={{1080pt,1080pt}},margin=0pt]{{geometry}}
\usepackage[utf8]{{inputenc}}
\usepackage[T1]{{fontenc}}
\usepackage{{lmodern}}
\usepackage{{tikz}}
\usetikzlibrary{{arrows.meta}}
\pagestyle{{empty}}
\definecolor{{bg}}{{HTML}}{{F7F2EA}}
\definecolor{{panel}}{{HTML}}{{FFFDF8}}
\definecolor{{softpanel}}{{HTML}}{{FBFAF6}}
\definecolor{{answerpanel}}{{HTML}}{{E7F3EE}}
\definecolor{{ink}}{{HTML}}{{1F2933}}
\definecolor{{muted}}{{HTML}}{{697586}}
\definecolor{{line}}{{HTML}}{{D7D0C4}}
\definecolor{{grid}}{{HTML}}{{E9E4DA}}
\definecolor{{accent}}{{HTML}}{{176B87}}
\definecolor{{accenttwo}}{{HTML}}{{315A89}}
\definecolor{{solution}}{{HTML}}{{CFE8F3}}
\definecolor{{danger}}{{HTML}}{{B45309}}
\definecolor{{graphgreen}}{{HTML}}{{159947}}
\definecolor{{graphblue}}{{HTML}}{{2563EB}}
\definecolor{{graphyellow}}{{HTML}}{{D99A00}}
\definecolor{{graphred}}{{HTML}}{{DC2626}}
\definecolor{{shadegreen}}{{HTML}}{{DDF6E6}}
\definecolor{{shadeblue}}{{HTML}}{{DFE9FF}}
\definecolor{{shadeyellow}}{{HTML}}{{FFF1C2}}
\definecolor{{shadered}}{{HTML}}{{FFE0E0}}
\begin{{document}}
\begin{{tikzpicture}}[x=1pt,y=1pt]
\fill[bg] (0,0) rectangle (1080,1080);
{body}
\end{{tikzpicture}}
\end{{document}}
"""


def _latex_thumbnail_source(question):
    subtest = _wrap_plain_lines(question.get("mapel", "Latihan UTBK"), 28, 2)
    subtopic = _wrap_plain_lines(question.get("topik") or question.get("mapel", "Subtopik"), 44, 2)
    account = str(question.get("akun", "@utbk_neareducation") or "@utbk_neareducation")
    body = "\n".join([
        r"\draw[line, line width=2pt] (78,810) -- (1002,810);",
        r"\draw[line, line width=2pt] (78,270) -- (1002,270);",
        _node(78, 408, 924, subtest, size=48, align="center", weight="bold"),
        _node(132, 542, 816, subtopic, size=30, color="muted", align="center"),
        _node(148, 1008, 500, [account], size=20, color="muted"),
    ])
    return _latex_document(body)


def _needs_cartesian_visual(question):
    mapel = slugify(question.get("mapel"))
    if mapel not in {"pengetahuan-kuantitatif", "penalaran-matematika"}:
        return False
    text = " ".join([
        str(question.get("soal", "")),
        str(question.get("deskripsi_visual", "")),
        str(question.get("topik", "")),
    ]).lower()
    keywords = [
        "kartesius",
        "koordinat",
        "bidang x",
        "bidang x, y",
        "grafik",
        "garis",
        "parabola",
        "kurva",
        "pertidaksamaan",
        "sumbu x",
        "sumbu y",
    ]
    return bool(question.get("butuh_visual")) or any(keyword in text for keyword in keywords)


def _parse_linear_equations(question):
    text = " ".join([str(question.get("soal", "")), str(question.get("deskripsi_visual", ""))])
    equations = []
    for match in re.finditer(r"y\s*([=<>≤≥]+)\s*([+-]?\s*\d*(?:/\d+)?(?:\.\d+)?)\s*x(?![²^])\s*([+-]\s*\d+(?:\.\d+)?)?", text, re.I):
        relation = match.group(1)
        slope_text = (match.group(2) or "1").replace(" ", "")
        intercept_text = (match.group(3) or "0").replace(" ", "")
        if slope_text in {"", "+"}:
            slope = 1.0
        elif slope_text == "-":
            slope = -1.0
        elif "/" in slope_text:
            left, right = slope_text.split("/", 1)
            slope = float(left or 1) / float(right)
        else:
            slope = float(slope_text)
        intercept = float(intercept_text) if intercept_text else 0.0
        equations.append({"type": "line", "m": slope, "b": intercept, "relation": relation})
    if not equations and "gradien 1" in text.lower() and "(0,1)" in text:
        equations.append({"type": "line", "m": 1.0, "b": 1.0, "relation": "="})
    return equations[:3]


def _parse_parabola(question):
    text = " ".join([str(question.get("soal", "")), str(question.get("deskripsi_visual", ""))])
    match = re.search(
        r"y\s*=\s*x(?:²|\^2)\s*([+-]\s*\d+)\s*x\s*([+-]\s*\d+)",
        text,
        re.I,
    )
    if match:
        bx = float(match.group(1).replace(" ", ""))
        c = float(match.group(2).replace(" ", ""))
        return {"type": "parabola", "a": 1.0, "b": bx, "c": c}
    match = re.search(
        r"f\(x\)\s*=\s*([+-]?\d*)x(?:²|\^2)\s*([+-]\s*\d*)?x?\s*([+-]\s*\d+)?",
        text,
        re.I,
    )
    if match:
        a_text = (match.group(1) or "1").replace(" ", "")
        a = -1.0 if a_text == "-" else float(a_text or 1)
        b_text = (match.group(2) or "0").replace(" ", "")
        b = 0.0 if b_text in {"", "+", "-"} else float(b_text)
        c = float((match.group(3) or "0").replace(" ", ""))
        return {"type": "parabola", "a": a, "b": b, "c": c}
    return None


def _cartesian_visual_code(question, x=570, y=198, w=438, h=352):
    if not _needs_cartesian_visual(question):
        return ""

    lines = _parse_linear_equations(question)
    parabola = _parse_parabola(question)
    grid_size = max(220, min(w - 58, h - 32))
    grid_w = grid_size
    grid_h = grid_size
    plot_top = y + 10
    left = x + (w - grid_size) / 2
    bottom = 1080 - plot_top - grid_size
    center_x = grid_w / 2
    center_y = grid_h / 2
    x_unit = grid_w / 13
    y_unit = grid_h / 13
    body = [
        rf"\begin{{scope}}[shift={{({left},{bottom})}}]",
        rf"\clip (0,0) rectangle ({grid_w:.1f},{grid_h:.1f});",
        rf"\draw[grid, line width=0.75pt] (0,0) grid[xstep={x_unit:.1f}, ystep={y_unit:.1f}] ({grid_w:.1f},{grid_h:.1f});",
        rf"\draw[ink, line width=1.8pt, -{{Stealth[length=7pt]}}] (0,{center_y:.1f}) -- ({grid_w + 6:.1f},{center_y:.1f}) node[below left, text=ink] {{$x$}};",
        rf"\draw[ink, line width=1.8pt, -{{Stealth[length=7pt]}}] ({center_x:.1f},0) -- ({center_x:.1f},{grid_h + 6:.1f}) node[below left, text=ink] {{$y$}};",
        rf"\draw[muted, line width=1.2pt] ({center_x:.1f},{center_y - 4:.1f}) -- ({center_x:.1f},{center_y + 4:.1f}) node[below right, text=muted, font={{\fontsize{{13pt}}{{15pt}}\selectfont}}] {{0}};",
    ]

    def px(value):
        return min(grid_w, max(0, center_x + value * x_unit))

    def py(value):
        return min(grid_h, max(0, center_y + value * y_unit))

    def px_raw(value):
        return center_x + value * x_unit

    def py_raw(value):
        return center_y + value * y_unit

    for tick in range(-6, 7):
        if tick == 0:
            continue
        tick_x = px(tick)
        tick_y = py(tick)
        body.append(rf"\draw[muted, line width=0.9pt] ({tick_x:.1f},{center_y - 4:.1f}) -- ({tick_x:.1f},{center_y + 4:.1f});")
        body.append(
            rf"\node[anchor=north, text=muted, font={{\fontsize{{13pt}}{{15pt}}\selectfont}}] "
            rf"at ({tick_x:.1f},{center_y - 7:.1f}) {{{tick}}};"
        )
        body.append(rf"\draw[muted, line width=0.9pt] ({center_x - 4:.1f},{tick_y:.1f}) -- ({center_x + 4:.1f},{tick_y:.1f});")
        body.append(
            rf"\node[anchor=east, text=muted, font={{\fontsize{{13pt}}{{15pt}}\selectfont}}] "
            rf"at ({center_x - 8:.1f},{tick_y - 3:.1f}) {{{tick}}};"
        )

    palette = [
        ("graphgreen", "shadegreen"),
        ("graphblue", "shadeblue"),
        ("graphyellow", "shadeyellow"),
        ("graphred", "shadered"),
    ]
    for index, line in enumerate(lines):
        points = []
        raw_points = []
        for vx in [-6, 6]:
            vy = line["m"] * vx + line["b"]
            points.append((px(vx), py(vy)))
        for vx in [-20, 20]:
            vy = line["m"] * vx + line["b"]
            raw_points.append((px_raw(vx), py_raw(vy)))
        style = "dashed" if line["relation"] != "=" else "solid"
        color, shade_color = palette[index % len(palette)]
        if line["relation"] != "=":
            relation = str(line["relation"])
            shade_top = "<" not in relation and "\u2264" not in relation and "\u00e2\u2030\u00a4" not in relation
            far_x1 = -grid_w
            far_x2 = grid_w * 2
            far_top = grid_h * 2
            far_bottom = -grid_h
            if shade_top:
                polygon = (
                    f"({raw_points[0][0]:.1f},{raw_points[0][1]:.1f}) -- "
                    f"({raw_points[1][0]:.1f},{raw_points[1][1]:.1f}) -- "
                    f"({far_x2:.1f},{far_top:.1f}) -- ({far_x1:.1f},{far_top:.1f}) -- cycle"
                )
            else:
                polygon = (
                    f"({raw_points[0][0]:.1f},{raw_points[0][1]:.1f}) -- "
                    f"({raw_points[1][0]:.1f},{raw_points[1][1]:.1f}) -- "
                    f"({far_x2:.1f},{far_bottom:.1f}) -- ({far_x1:.1f},{far_bottom:.1f}) -- cycle"
                )
            body.append(rf"\fill[{shade_color}, opacity=0.52, blend mode=multiply] {polygon};")
        body.append(
            rf"\draw[{color}, {style}, line width=3pt] "
            rf"({raw_points[0][0]:.1f},{raw_points[0][1]:.1f}) -- ({raw_points[1][0]:.1f},{raw_points[1][1]:.1f});"
        )
        body.append(rf"\fill[{color}] ({px(0):.1f},{py(line['b']):.1f}) circle (3.5pt);")

    if parabola:
        a = parabola["a"]
        b = parabola["b"]
        c = parabola["c"]
        coords = []
        for step in range(-6, 7):
            vx = step
            vy = a * vx * vx + b * vx + c
            coords.append(f"({px(vx):.1f},{py(vy):.1f})")
        if len(coords) >= 3:
            vertex_x = -b / (2 * a) if a else 0
            vertex_y = a * vertex_x * vertex_x + b * vertex_x + c
            body.append(rf"\draw[graphred, line width=3pt, smooth] plot coordinates {{{' '.join(coords)}}};")
            body.append(rf"\fill[graphyellow] ({px(vertex_x):.1f},{py(vertex_y):.1f}) circle (4.5pt);")

    if not lines and not parabola:
        body.append(rf"\draw[graphgreen, line width=3pt] ({grid_w * 0.12:.1f},{grid_h * 0.25:.1f}) -- ({grid_w * 0.9:.1f},{grid_h * 0.78:.1f});")
        body.append(rf"\draw[graphblue, dashed, line width=3pt] ({grid_w * 0.12:.1f},{grid_h * 0.78:.1f}) -- ({grid_w * 0.9:.1f},{grid_h * 0.32:.1f});")

    body.append(r"\end{scope}")
    return "\n".join(body)


def _latex_quiz_sources(question):
    question_text = _compact_math_for_line_wrap(_format_question_text(question.get("soal", "")))
    q_lines = _wrap_plain_lines(question_text, 76)
    choices = question.get("pilihan") or {}
    choice_lines = {
        key: _wrap_plain_lines(choices.get(key, ""), 52, 3)
        for key in ["A", "B", "C", "D", "E"]
    }
    pages = []
    has_visual = _needs_cartesian_visual(question)
    if has_visual:
        marker = re.search(
            r"\b(?:perhatikan|berdasarkan|dari)\s+(?:grafik|gambar|diagram)[^.?!]*(?:[.?!]|$)",
            question_text,
            re.I,
        )
        overflow_lines = []
        if marker:
            before_lines = _wrap_plain_lines(question_text[:marker.start()].strip(), 76)
            after_lines = _wrap_plain_lines(question_text[marker.end():].strip(), 76)
            top_lines = before_lines[:3] or q_lines[:2]
            bottom_lines = after_lines[:5] or q_lines[2:7]
            overflow_lines = before_lines[3:] + after_lines[5:]
        else:
            split_at = max(1, min(3, len(q_lines) - 1)) if len(q_lines) > 1 else len(q_lines)
            top_lines = q_lines[:split_at]
            bottom_lines = q_lines[split_at:split_at + 5]
            overflow_lines = q_lines[split_at + 5:]
        pages.append({
            "question": [],
            "question_top": top_lines,
            "question_bottom": bottom_lines,
            "choices": [],
            "visual_inline": True,
        })
        for chunk in _chunk_lines(overflow_lines, 13):
            if chunk and chunk != [""]:
                pages.append({"question": chunk, "choices": [], "visual": False})
        pages.append({"question": [], "choices": list(choice_lines.items()), "visual": False})
    elif len(q_lines) <= 8:
        pages.append({"question": q_lines, "choices": list(choice_lines.items()), "visual": False})
    else:
        for chunk in _chunk_lines(q_lines, 13):
            pages.append({"question": chunk, "choices": [], "visual": False})
        pages.append({"question": [], "choices": list(choice_lines.items()), "visual": False})

    sources = []
    for page_number, page in enumerate(pages, start=1):
        body_parts = [
            _node(72, 78, 760, [str(question.get("mapel", "Kuis")).upper()[:42]], size=25, color="muted"),
            _node(72, 118, 760, [str(question.get("topik") or question.get("mapel", "Pengetahuan Umum"))[:54]], size=36, weight="bold"),
        ]
        if page.get("visual_inline"):
            top_lines = page.get("question_top") or []
            bottom_lines = page.get("question_bottom") or []
            body_parts.append(_rect(72, 190, 1008, 914))
            if top_lines:
                body_parts.append(_node(112, 228, 860, top_lines, size=25))
            visual_y = 328 if len(top_lines) <= 2 else 356
            body_parts.append(_cartesian_visual_code(question, x=150, y=visual_y, w=780, h=500))
            bottom_y = visual_y + 540
            if bottom_lines:
                body_parts.append(_node(112, bottom_y, 860, bottom_lines, size=25))
            choice_top = 930
        elif page["question"]:
            q_height = max(190, 58 + len(page["question"]) * 42)
            if page.get("visual"):
                q_height = max(260, q_height)
                body_parts.append(_rect(72, 190, 548, 190 + q_height))
                body_parts.append(_node(112, 230, 396, page["question"], size=27))
                visual = _cartesian_visual_code(question)
                if visual:
                    body_parts.append(visual)
            else:
                body_parts.append(_rect(72, 190, 1008, 190 + q_height))
                body_parts.append(_node(126, 230, 828, page["question"], size=29))
            choice_top = 220 + q_height
        else:
            choice_top = 210
        y = choice_top + 16
        for key, lines in page["choices"]:
            height = max(82, 34 + len(lines) * 36)
            body_parts.append(_rect(72, y, 1008, y + height, fill="bg"))
            body_parts.append(_rect(104, y + 20, 164, y + 74, fill="bg", radius=4))
            body_parts.append(_node(124, y + 31, 34, [key], size=30, color="accent", weight="bold"))
            body_parts.append(_node(190, y + 24, 748, lines, size=29))
            y += height + 14
        account = str(question.get("akun", "@utbk_neareducation") or "@utbk_neareducation")
        body_parts.append(_node(72, 1010, 450, [account], size=22, color="muted"))
        if len(pages) > 1:
            body_parts.append(_node(930, 1010, 80, [f"{page_number}/{len(pages)}"], size=22, color="muted", align="right"))
        sources.append(_latex_document("\n".join(body_parts)))
    return sources


def _latex_explanation_sources(question):
    explanation = str(question.get("pembahasan") or "").strip()
    if not explanation:
        return []
    has_visual = _needs_cartesian_visual(question)
    lines = _wrap_plain_lines(_format_explanation_text(explanation), 44 if has_visual else 74)
    chunks = _chunk_lines(lines, 12 if has_visual else 13)
    answer_key = str(question.get("jawaban") or "").strip().upper()
    answer_text = (question.get("pilihan") or {}).get(answer_key, "")
    sources = []
    for page_number, chunk in enumerate(chunks, start=1):
        body_parts = [
            _node(72, 78, 760, [str(question.get("mapel", "Kuis")).upper()[:42]], size=25, color="muted"),
            _node(72, 118, 760, ["Pembahasan"], size=36, weight="bold"),
        ]
        panel_top = 210
        if page_number == 1:
            body_parts.append(_rect(72, panel_top, 1008, panel_top + 104, fill="answerpanel"))
            body_parts.append(_rect(104, panel_top + 25, 164, panel_top + 79, fill="bg", radius=4))
            body_parts.append(_node(124, panel_top + 36, 34, [answer_key], size=29, color="accent", weight="bold"))
            answer = f"{answer_key}. {answer_text}" if answer_text else answer_key or "Jawaban"
            body_parts.append(_node(190, panel_top + 34, 748, _wrap_plain_lines(answer, 58, 2), size=28))
            panel_top = 342
        panel_bottom = min(914, panel_top + 84 + len(chunk) * 38)
        if has_visual and page_number == 1:
            body_parts.append(_rect(72, panel_top, 532, 914))
            body_parts.append(_node(116, panel_top + 40, 344, chunk, size=24))
            body_parts.append(_cartesian_visual_code(question, x=560, y=342, w=448, h=572))
        else:
            body_parts.append(_rect(72, panel_top, 1008, panel_bottom))
            body_parts.append(_node(126, panel_top + 42, 828 if not has_visual else 760, chunk, size=27))
        account = str(question.get("akun", "@utbk_neareducation") or "@utbk_neareducation")
        body_parts.append(_node(72, 1010, 450, [account], size=22, color="muted"))
        if len(chunks) > 1:
            body_parts.append(_node(930, 1010, 80, [f"{page_number}/{len(chunks)}"], size=22, color="muted", align="right"))
        sources.append(_latex_document("\n".join(body_parts)))
    return sources


def _require_executable(command, label):
    executable = shutil.which(command)
    if not executable:
        raise RuntimeError(
            f"{label} tidak ditemukan. Install LaTeX toolchain atau set LATSOAL_RENDER_ENGINE=pil. "
            f"Command yang dicari: {command}"
        )
    return executable


def _run_render_command(args, cwd):
    completed = subprocess.run(
        args,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        timeout=RENDER_TIMEOUT_SECONDS,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(detail[-1200:] or f"Command render gagal: {' '.join(args)}")


def _convert_pdf_to_jpg(pdf_path, jpg_path):
    converter = PDF_CONVERTER
    if converter:
        converter_path = _require_executable(converter, "PDF converter")
    else:
        converter_path = shutil.which("magick") or shutil.which("pdftoppm")
    if not converter_path:
        raise RuntimeError(
            "PDF converter tidak ditemukan. Install ImageMagick (`magick`) atau Poppler (`pdftoppm`)."
        )

    converter_name = Path(converter_path).name.lower()
    if converter_name.startswith("magick"):
        _run_render_command([
            converter_path,
            "-density",
            "180",
            str(pdf_path),
            "-background",
            "white",
            "-alpha",
            "remove",
            "-quality",
            "95",
            str(jpg_path),
        ], pdf_path.parent)
        return jpg_path

    output_stem = jpg_path.with_suffix("")
    _run_render_command([
        converter_path,
        "-jpeg",
        "-r",
        "180",
        "-singlefile",
        str(pdf_path),
        str(output_stem),
    ], pdf_path.parent)
    generated = output_stem.with_suffix(".jpg")
    if generated != jpg_path and generated.exists():
        generated.replace(jpg_path)
    return jpg_path


def _render_latex_source(source, run_dir, stem):
    latex_path = run_dir / f"{stem}.tex"
    pdf_path = run_dir / f"{stem}.pdf"
    jpg_path = run_dir / f"{stem}.jpg"
    latex_path.write_text(source, encoding="utf-8")
    latex = _require_executable(LATEX_COMMAND, "LaTeX compiler")
    _run_render_command([
        latex,
        "-interaction=nonstopmode",
        "-halt-on-error",
        f"-output-directory={run_dir}",
        str(latex_path),
    ], run_dir)
    if not pdf_path.exists():
        raise RuntimeError(f"LaTeX tidak menghasilkan PDF: {pdf_path.name}")
    return _convert_pdf_to_jpg(pdf_path, jpg_path)


def render_latex_content_images(question, run_dir):
    run_dir.mkdir(parents=True, exist_ok=True)
    rendered = [_render_latex_source(_latex_thumbnail_source(question), run_dir, "thumbnail")]
    for index, source in enumerate(_latex_quiz_sources(question), start=1):
        rendered.append(_render_latex_source(source, run_dir, f"post-{index}"))
    for index, source in enumerate(_latex_explanation_sources(question), start=1):
        rendered.append(_render_latex_source(source, run_dir, f"pembahasan-{index}"))
    return rendered


def render_pil_content_images(question, run_dir):
    numbered_pages = _count_quiz_image_pages(question) + _count_explanation_image_pages(question)
    thumbnail_path = render_thumbnail_image(question, run_dir)
    thumbnail_paths = [thumbnail_path] if thumbnail_path else []
    image_paths = render_quiz_images(
        question,
        run_dir,
        page_offset=0,
        total_pages=numbered_pages,
    )
    explanation_paths = render_explanation_images(
        question,
        run_dir,
        page_offset=len(image_paths),
        total_pages=numbered_pages,
    )
    return thumbnail_paths + image_paths + explanation_paths


def render_content_images(question, run_dir):
    engine = RENDER_ENGINE or "latex"
    if engine not in {"latex", "pil", "auto"}:
        raise ValueError("LATSOAL_RENDER_ENGINE harus salah satu dari: latex, pil, auto.")
    if engine in {"latex", "auto"}:
        try:
            return render_latex_content_images(question, run_dir), "latex"
        except Exception:
            if engine == "latex":
                raise
    return render_pil_content_images(question, run_dir), "pil"


STOPWORDS = {
    "yang", "dan", "di", "ke", "dari", "dengan", "untuk", "pada", "adalah",
    "atau", "dalam", "ini", "itu", "sebagai", "maka", "jika", "akan",
    "antara", "berikut", "teks", "kalimat", "soal", "pilihan", "jawaban",
}


def normalize_terms(text):
    words = re.findall(r"[a-zA-Z0-9]+", str(text).lower())
    return {word for word in words if len(word) > 2 and word not in STOPWORDS}


def jaccard_similarity(left, right):
    left_terms = normalize_terms(left)
    right_terms = normalize_terms(right)
    if not left_terms or not right_terms:
        return 0.0
    return len(left_terms & right_terms) / len(left_terms | right_terms)


def check_duplicate(question):
    current_text = " ".join([
        question.get("mapel", ""),
        question.get("topik", ""),
        question.get("soal", ""),
        " ".join(str(value) for value in question.get("pilihan", {}).values()),
    ])
    best = {
        "is_duplicate": False,
        "similarity": 0.0,
        "matched_run_id": None,
        "matched_status": None,
        "threshold": DEDUP_THRESHOLD,
        "reason": "",
    }

    if not BANK_INDEX_PATH.exists():
        return best
    try:
        index = json.loads(BANK_INDEX_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return best

    for item in index if isinstance(index, list) else []:
        run_id = item.get("run_id")
        if not run_id:
            continue
        item_path = item.get("path") or f"saved/{run_id}"
        relative_path = str(item_path).replace("\\", "/")
        if relative_path.startswith("saved/"):
            relative_path = relative_path[len("saved/"):]
        metadata_path = SAVED_DIR / relative_path / "metadata.json"
        if not metadata_path.exists():
            continue
        try:
            saved = json.loads(metadata_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        saved_question = saved.get("question", {})
        saved_text = " ".join([
            saved_question.get("mapel", ""),
            saved_question.get("topik", ""),
            saved_question.get("soal", ""),
            " ".join(str(value) for value in saved_question.get("pilihan", {}).values()),
        ])
        similarity = jaccard_similarity(current_text, saved_text)
        if similarity > best["similarity"]:
            best.update({
                "similarity": round(similarity, 4),
                "matched_run_id": run_id,
                "matched_status": item.get("status", "saved"),
            })

    if best["similarity"] >= DEDUP_THRESHOLD:
        best["is_duplicate"] = True
        best["reason"] = "Teks soal terlalu mirip dengan soal yang sudah disimpan."
    return best


def _ai_json(prompt, label, retries=MAX_GEMINI_RETRIES, schema=None, provider="gemini"):
    last_error = None
    provider_label = provider.capitalize()
    strict_prompt = (
        f"{prompt}\n\n"
        "PENTING: Balas hanya dengan satu objek JSON valid. "
        "Jangan gunakan markdown, komentar, trailing comma, atau teks tambahan. "
        "Semua string harus memakai kutip ganda dan newline di dalam string harus di-escape."
    )
    for attempt in range(1, retries + 1):
        try:
            return _extract_json(_ai_generate(strict_prompt, schema=schema, provider=provider))
        except Exception as exc:
            clean_error = clean_error_message(exc)
            if clean_error != str(exc):
                raise RuntimeError(clean_error) from exc
            last_error = exc
            strict_prompt = (
                f"{prompt}\n\n"
                f"Percobaan sebelumnya untuk {label} gagal diparse sebagai JSON valid: {exc}. "
                "Kirim ulang hanya satu objek JSON valid RFC 8259. "
                "Jangan ada teks pembuka, markdown, trailing comma, atau newline mentah di dalam string."
            )
    raise ValueError(f"Gagal parse JSON {provider_label} untuk {label} setelah {retries} percobaan: {clean_error_message(last_error)}")


def _gemini_json(prompt, label, retries=MAX_GEMINI_RETRIES, schema=None):
    return _ai_json(prompt, label, retries=retries, schema=schema, provider="gemini")


def _ai_generate(prompt, schema=None, provider="gemini"):
    if provider == "kimi":
        return _kimi_generate(prompt)
    return _gemini_generate(prompt, schema=schema)


def _gemini_generate(prompt, schema=None):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY belum tersedia.")

    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{DEFAULT_MODEL}:generateContent?key={api_key}"
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.7,
            "topP": 0.95,
            "topK": 40,
            "maxOutputTokens": GEMINI_MAX_OUTPUT_TOKENS,
            "responseMimeType": "application/json",
        },
    }
    if schema:
        payload["generationConfig"]["responseSchema"] = schema
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini API gagal: {exc.code} {message}") from exc

    usage = raw.get("usageMetadata")
    if usage:
        GEMINI_USAGE.append({
            "provider": "gemini",
            "model": DEFAULT_MODEL,
            "prompt_tokens": usage.get("promptTokenCount"),
            "output_tokens": usage.get("candidatesTokenCount"),
            "total_tokens": usage.get("totalTokenCount"),
        })

    try:
        candidate = raw["candidates"][0]
        finish_reason = candidate.get("finishReason")
        text = candidate["content"]["parts"][0]["text"]
        if finish_reason == "MAX_TOKENS":
            raise RuntimeError(
                f"Output Gemini terpotong karena maxOutputTokens={GEMINI_MAX_OUTPUT_TOKENS}."
            )
        return text
    except (KeyError, IndexError) as exc:
        raise RuntimeError("Format response Gemini tidak dikenali.") from exc


def _kimi_generate(prompt):
    api_key = os.getenv("KIMI_API_KEY") or os.getenv("NVIDIA_API_KEY")
    if not api_key:
        raise RuntimeError("KIMI_API_KEY atau NVIDIA_API_KEY belum tersedia.")

    payload = {
        "model": KIMI_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": KIMI_MAX_OUTPUT_TOKENS,
        "temperature": 1.0,
        "top_p": 1.0,
        "stream": False,
    }
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        KIMI_API_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Kimi API gagal: {exc.code} {message}") from exc

    usage = raw.get("usage") or {}
    if usage:
        GEMINI_USAGE.append({
            "provider": "kimi",
            "model": KIMI_MODEL,
            "prompt_tokens": usage.get("prompt_tokens"),
            "output_tokens": usage.get("completion_tokens"),
            "total_tokens": usage.get("total_tokens"),
        })

    try:
        choice = raw["choices"][0]
        finish_reason = choice.get("finish_reason")
        text = choice["message"]["content"]
        if finish_reason == "length":
            raise RuntimeError(
                f"Output Kimi terpotong karena max_tokens={KIMI_MAX_OUTPUT_TOKENS}."
            )
        return text
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("Format response Kimi tidak dikenali.") from exc


def load_patterns(mapel, topic, limit=2):
    pattern_file = PATTERN_FILES.get(mapel)
    if not pattern_file:
        return []
    path = BANK_DIR / pattern_file
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    patterns = data.get("patterns", [])
    topic_lower = topic.lower()
    matched = [
        pattern for pattern in patterns
        if topic_lower in " ".join([
            str(pattern.get("topik", "")),
            str(pattern.get("tipe", "")),
            " ".join(pattern.get("konsep_kunci", [])),
        ]).lower()
    ]
    selected = matched or patterns
    return selected[:limit]


def build_question_prompt(mapel, topic, level):
    base_rules = """
Kamu adalah generator soal latihan UTBK/SNBT untuk platform Instagram edukatif.
Buat soal orisinal sesuai format SNBT modern, bukan format mapel Saintek/Soshum lama.
Gunakan bahasa Indonesia baku. Setiap soal punya tepat 5 pilihan A sampai E,
hanya 1 jawaban benar, dan pembahasan jelas untuk pelajar SMA.
Jika memakai pola referensi, gunakan hanya struktur konsepnya. Jangan menyalin kalimat,
angka, konteks, atau pilihan dari contoh/pola referensi.
Jangan menambahkan hint/petunjuk dalam tanda kurung pada teks soal.
Output harus JSON valid tanpa markdown.
""".strip()

    patterns = load_patterns(mapel, topic)
    schema = {
        "mapel": mapel,
        "kelompok_tes": "TPS" if mapel in [
            "Penalaran Umum",
            "Pengetahuan dan Pemahaman Umum",
            "Pemahaman Bacaan dan Menulis",
            "Pengetahuan Kuantitatif",
        ] else "Literasi",
        "topik": topic,
        "level": level,
        "soal": "",
        "pilihan": {"A": "", "B": "", "C": "", "D": "", "E": ""},
        "jawaban": "",
        "pembahasan": "",
        "konsep_kunci": "",
        "tips_pengerjaan": "",
        "butuh_visual": False,
        "deskripsi_visual": "",
    }
    return (
        f"{base_rules}\n\n"
        f"Buatkan 1 soal latihan UTBK/SNBT subtes {mapel}.\n"
        f"Topik: {topic}\n"
        f"Tingkat kesulitan: {level}\n\n"
        "Pola referensi yang boleh dipakai sebagai cetakan konsep, bukan untuk disalin:\n"
        f"{json.dumps(patterns, ensure_ascii=False, indent=2)}\n\n"
        "Kembalikan JSON dengan struktur berikut:\n"
        f"{json.dumps(schema, ensure_ascii=False, indent=2)}"
    )


def build_validation_prompt(question):
    return (
        "Kamu adalah validator soal UTBK yang ketat dan teliti. "
        "Periksa kebenaran konten, kejelasan soal, kesesuaian level, "
        "kesesuaian UTBK, dan bahasa. Output harus JSON valid.\n\n"
        f"{json.dumps(question, ensure_ascii=False)}\n\n"
        "Kembalikan JSON: "
        '{"lolos_validasi": true, "skor": 0, "catatan": {}, "saran_perbaikan": ""}'
    )


def build_caption_prompt(question):
    return (
        "Kamu adalah copywriter konten edukasi Instagram untuk akun latihan soal UTBK. "
        "Buat caption sangat singkat, hanya dua baris: baris pertama subtopik/subtes, "
        "baris kedua judul submateri/topik. Jangan tambah hook, CTA, motivasi, atau jawaban. "
        "Wajib pakai konteks UTBK 2026. Jangan memakai tahun 2024 atau 2025. "
        "Hashtag wajib diawali tanda # dan wajib memuat #UTBK, #LatsoalUTBK, "
        "#BelajarUTBK, dan #SoalUTBK. Output JSON valid.\n\n"
        f"{json.dumps(question, ensure_ascii=False)}\n\n"
        'Kembalikan JSON: {"caption": "", "hashtag": []}'
    )


def draft_question(mapel, topic, level):
    kelompok_tes = "TPS" if mapel in [
        "Penalaran Umum",
        "Pengetahuan dan Pemahaman Umum",
        "Pemahaman Bacaan dan Menulis",
        "Pengetahuan Kuantitatif",
    ] else "Literasi"

    templates = {
        "Penalaran Umum": {
            "soal": (
                "Semua peserta yang disiplin mengerjakan latihan secara rutin. "
                "Sebagian peserta yang mengerjakan latihan secara rutin mengalami peningkatan skor. "
                "Simpulan yang pasti benar adalah..."
            ),
            "pilihan": {
                "A": "Semua peserta yang disiplin mengalami peningkatan skor.",
                "B": "Sebagian peserta yang disiplin mungkin mengalami peningkatan skor.",
                "C": "Tidak ada peserta disiplin yang mengalami peningkatan skor.",
                "D": "Semua peserta yang meningkat skornya pasti disiplin.",
                "E": "Peserta yang tidak rutin berlatih pasti tidak disiplin.",
            },
            "jawaban": "B",
            "pembahasan": (
                "Premis pertama menyatakan semua peserta disiplin termasuk kelompok yang rutin latihan. "
                "Premis kedua menyatakan sebagian kelompok rutin mengalami peningkatan skor. "
                "Karena tidak dijamin bahwa bagian yang meningkat adalah semua peserta disiplin, simpulan paling aman adalah kemungkinan sebagian peserta disiplin mengalami peningkatan skor."
            ),
            "konsep_kunci": "Simpulan valid dari premis",
        },
        "Pengetahuan dan Pemahaman Umum": {
            "soal": (
                "Perhatikan kalimat berikut.\n"
                "(1) Banyak siswa mulai memakai aplikasi belajar daring. "
                "(2) Aplikasi tersebut memudahkan siswa mengakses latihan kapan saja. "
                "Hubungan antarkalimat yang paling tepat adalah..."
            ),
            "pilihan": {
                "A": "Kalimat (2) menyatakan akibat dari kalimat (1).",
                "B": "Kalimat (2) memberikan penjelasan terhadap kalimat (1).",
                "C": "Kalimat (2) bertentangan dengan kalimat (1).",
                "D": "Kalimat (2) menyatakan perbandingan dengan kalimat (1).",
                "E": "Kalimat (2) merupakan simpulan yang tidak berkaitan dengan kalimat (1).",
            },
            "jawaban": "B",
            "pembahasan": (
                "Kalimat (1) menyampaikan fakta umum bahwa banyak siswa memakai aplikasi belajar daring. "
                "Kalimat (2) menjelaskan alasan atau manfaat dari aplikasi tersebut, yaitu memudahkan akses latihan. "
                "Jadi, kalimat (2) berfungsi sebagai penjelasan terhadap kalimat (1)."
            ),
            "konsep_kunci": "Fungsi kalimat dan koherensi",
        },
        "Pemahaman Bacaan dan Menulis": {
            "soal": (
                "Kalimat berikut belum efektif: Para siswa-siswa diminta untuk mengumpulkan tugasnya masing-masing sebelum jam pelajaran dimulai. "
                "Perbaikan yang paling efektif adalah..."
            ),
            "pilihan": {
                "A": "Para siswa-siswa diminta mengumpulkan tugas sebelum jam pelajaran dimulai.",
                "B": "Siswa-siswa diminta untuk mengumpulkan tugasnya masing-masing sebelum jam pelajaran dimulai.",
                "C": "Para siswa diminta mengumpulkan tugas sebelum jam pelajaran dimulai.",
                "D": "Para siswa diminta untuk mengumpulkan tugasnya masing-masing sebelum jam pelajaran akan dimulai.",
                "E": "Semua para siswa diminta mengumpulkan tugas sebelum jam pelajaran dimulai.",
            },
            "jawaban": "C",
            "pembahasan": (
                "Bentuk 'para siswa-siswa' tidak efektif karena penanda jamak digunakan ganda. "
                "Kata 'untuk' dan 'masing-masing' juga tidak wajib dalam konteks ini. "
                "Kalimat paling hemat, jelas, dan tetap bermakna sama adalah pilihan C."
            ),
            "konsep_kunci": "Kalimat efektif",
        },
        "Pengetahuan Kuantitatif": {
            "soal": (
                "Rata-rata nilai 5 siswa adalah 78. Empat nilai yang diketahui adalah 72, 80, 76, dan 84. "
                "Nilai siswa kelima adalah..."
            ),
            "pilihan": {"A": "76", "B": "78", "C": "80", "D": "82", "E": "84"},
            "jawaban": "B",
            "pembahasan": (
                "Jumlah seluruh nilai adalah 5 x 78 = 390. "
                "Jumlah empat nilai yang diketahui adalah 72 + 80 + 76 + 84 = 312. "
                "Maka nilai siswa kelima adalah 390 - 312 = 78."
            ),
            "konsep_kunci": "Rata-rata",
        },
        "Literasi Bahasa Indonesia": {
            "soal": (
                "Bacalah teks berikut. Program membaca singkat di sekolah dapat membantu siswa membangun kebiasaan memahami teks. "
                "Kegiatan ini tidak harus berlangsung lama, tetapi perlu dilakukan konsisten agar siswa terbiasa menemukan informasi utama. "
                "Pernyataan yang sesuai dengan teks adalah..."
            ),
            "pilihan": {
                "A": "Program membaca hanya efektif jika dilakukan dalam waktu lama.",
                "B": "Konsistensi kegiatan membaca membantu siswa memahami informasi utama.",
                "C": "Siswa tidak perlu membaca teks untuk menemukan informasi utama.",
                "D": "Program membaca singkat selalu menggantikan pelajaran lain.",
                "E": "Kebiasaan membaca tidak berhubungan dengan pemahaman teks.",
            },
            "jawaban": "B",
            "pembahasan": (
                "Teks menyatakan bahwa kegiatan membaca tidak harus lama, tetapi perlu dilakukan konsisten agar siswa terbiasa menemukan informasi utama. "
                "Pernyataan yang paling sesuai adalah pilihan B."
            ),
            "konsep_kunci": "Informasi eksplisit",
        },
        "Literasi Bahasa Inggris": {
            "soal": (
                "Read the text. Many students use short study sessions to stay consistent. "
                "Although each session may seem simple, regular practice helps them remember concepts better. "
                "What is the main idea of the text?"
            ),
            "pilihan": {
                "A": "Long study sessions are always better than short ones.",
                "B": "Regular short practice can support better learning.",
                "C": "Students should avoid simple study sessions.",
                "D": "Remembering concepts does not require practice.",
                "E": "Consistency is unrelated to learning.",
            },
            "jawaban": "B",
            "pembahasan": (
                "Teks menekankan bahwa sesi belajar singkat yang dilakukan secara rutin membantu siswa mengingat konsep dengan lebih baik. "
                "Gagasan utama paling tepat adalah pilihan B."
            ),
            "konsep_kunci": "Main idea",
        },
        "Penalaran Matematika": {
            "soal": (
                "Sebuah toko mencatat penjualan buku selama tiga hari: Senin 24 buku, Selasa 30 buku, dan Rabu 36 buku. "
                "Jika pola kenaikan penjualan tetap sama, banyak buku yang terjual pada Kamis adalah..."
            ),
            "pilihan": {"A": "38", "B": "40", "C": "42", "D": "44", "E": "46"},
            "jawaban": "C",
            "pembahasan": (
                "Penjualan naik 6 buku setiap hari: 24 ke 30 naik 6, 30 ke 36 naik 6. "
                "Jika pola tetap sama, penjualan Kamis adalah 36 + 6 = 42."
            ),
            "konsep_kunci": "Pola bilangan dalam konteks data",
        },
    }

    template = templates.get(mapel, templates["Penalaran Umum"])
    return {
        "mapel": mapel,
        "kelompok_tes": kelompok_tes,
        "topik": topic,
        "level": level,
        "soal": template["soal"],
        "pilihan": template["pilihan"],
        "jawaban": template["jawaban"],
        "pembahasan": template["pembahasan"],
        "konsep_kunci": template["konsep_kunci"],
        "tips_pengerjaan": "Identifikasi informasi penting, eliminasi opsi yang tidak konsisten, lalu cek jawaban.",
        "butuh_visual": False,
        "deskripsi_visual": "",
    }


def make_choices(correct_value, deltas, formatter=str):
    values = []
    for delta in deltas:
        value = correct_value + delta
        if value > 0 and value not in values:
            values.append(value)
    if correct_value not in values:
        values.append(correct_value)
    values = values[:5]
    while len(values) < 5:
        candidate = correct_value + len(values) + 1
        if candidate not in values:
            values.append(candidate)
    values = sorted(values)
    labels = ["A", "B", "C", "D", "E"]
    choices = {label: formatter(value) for label, value in zip(labels, values)}
    answer = labels[values.index(correct_value)]
    return choices, answer


def deterministic_quant_question(mapel, topic, level, seed):
    rng = random.Random(seed)
    kelompok_tes = "TPS" if mapel == "Pengetahuan Kuantitatif" else "Literasi"

    if topic in {"Statistika", "Data dan ketidakpastian"}:
        n = rng.choice([5, 6, 7])
        known_count = n - 1
        known_values = [rng.randrange(62, 91, 2) for _ in range(known_count)]
        missing = rng.randrange(64, 93, 2)
        total = sum(known_values) + missing
        while total % n != 0:
            missing += 1
            total = sum(known_values) + missing
        mean = total // n
        choices, answer = make_choices(missing, [-6, -3, 0, 3, 6])
        return {
            "mapel": mapel,
            "kelompok_tes": kelompok_tes,
            "topik": topic,
            "level": level,
            "tipe": "mean_missing_value",
            "params": {"n": n, "mean": mean, "known_values": known_values, "missing_value": missing},
            "soal": (
                f"Rata-rata nilai {n} siswa adalah {mean}. "
                f"{known_count} nilai yang diketahui adalah {', '.join(map(str, known_values[:-1]))}, dan {known_values[-1]}. "
                "Nilai siswa yang belum diketahui adalah..."
            ),
            "pilihan": choices,
            "jawaban": answer,
            "pembahasan": (
                f"Jumlah seluruh nilai adalah {n} x {mean} = {total}. "
                f"Jumlah nilai yang diketahui adalah {' + '.join(map(str, known_values))} = {sum(known_values)}. "
                f"Nilai yang belum diketahui adalah {total} - {sum(known_values)} = {missing}."
            ),
            "konsep_kunci": "Rata-rata dan jumlah data",
            "tips_pengerjaan": "Ubah rata-rata menjadi jumlah total terlebih dahulu, lalu kurangi dengan jumlah data yang diketahui.",
            "butuh_visual": False,
            "deskripsi_visual": "",
        }

    if topic in {"Perbandingan", "Bilangan"}:
        a = rng.randint(2, 5)
        b = rng.randint(3, 7)
        multiplier = rng.randint(8, 18)
        total = (a + b) * multiplier
        target = b * multiplier
        choices, answer = make_choices(target, [-2 * multiplier, -multiplier, 0, multiplier, 2 * multiplier])
        return {
            "mapel": mapel,
            "kelompok_tes": kelompok_tes,
            "topik": topic,
            "level": level,
            "tipe": "ratio_total",
            "params": {"ratio": [a, b], "total": total, "target_value": target},
            "soal": (
                f"Perbandingan jumlah buku latihan milik Rani dan Dimas adalah {a}:{b}. "
                f"Jika jumlah buku mereka seluruhnya {total}, banyak buku milik Dimas adalah..."
            ),
            "pilihan": choices,
            "jawaban": answer,
            "pembahasan": (
                f"Total bagian adalah {a} + {b} = {a + b}. "
                f"Setiap bagian bernilai {total} / {a + b} = {multiplier}. "
                f"Bagian Dimas adalah {b}, sehingga banyak bukunya {b} x {multiplier} = {target}."
            ),
            "konsep_kunci": "Rasio dan total bagian",
            "tips_pengerjaan": "Jumlahkan bagian rasio, cari nilai satu bagian, lalu kalikan dengan bagian yang ditanya.",
            "butuh_visual": False,
            "deskripsi_visual": "",
        }

    start = rng.randrange(12, 31, 2)
    step = rng.choice([3, 4, 5, 6, 8])
    values = [start + step * i for i in range(3)]
    next_value = values[-1] + step
    choices, answer = make_choices(next_value, [-2 * step, -step, 0, step, 2 * step])
    return {
        "mapel": mapel,
        "kelompok_tes": kelompok_tes,
        "topik": topic,
        "level": level,
        "tipe": "arithmetic_sequence_context",
        "params": {"values": values, "step": step, "next_value": next_value},
        "soal": (
            f"Sebuah komunitas mencatat jumlah peserta latihan selama tiga hari: "
            f"hari pertama {values[0]}, hari kedua {values[1]}, dan hari ketiga {values[2]}. "
            "Jika pola kenaikannya tetap, jumlah peserta pada hari keempat adalah..."
        ),
        "pilihan": choices,
        "jawaban": answer,
        "pembahasan": (
            f"Kenaikan dari hari pertama ke kedua adalah {values[1]} - {values[0]} = {step}. "
            f"Kenaikan dari hari kedua ke ketiga juga {values[2]} - {values[1]} = {step}. "
            f"Jadi, hari keempat adalah {values[2]} + {step} = {next_value}."
        ),
        "konsep_kunci": "Pola bilangan aritmetika",
        "tips_pengerjaan": "Cari selisih antar data berurutan, lalu gunakan pola yang sama untuk data berikutnya.",
        "butuh_visual": False,
        "deskripsi_visual": "",
    }


def validate_caption(caption, answer):
    caption_text = caption.get("caption", "")
    hashtags = caption.get("hashtag", [])
    required_hashtags = {"#UTBK2026", "#LatsoalUTBK", "#BelajarUTBK", "#SoalUTBK"}
    hashtag_set = set(hashtags)
    issues = []
    score_penalty = 0

    if any(year in caption_text or year in " ".join(hashtags) for year in ["UTBK2024", "UTBK2025", "SNBT2024", "SNBT2025"]):
        issues.append("Caption/hashtag memakai tahun lama.")
        score_penalty += 20
    if not required_hashtags.issubset(hashtag_set):
        issues.append("Hashtag wajib belum lengkap.")
        score_penalty += 15
    if answer and re.search(rf"\b(?:jawaban|kunci)\s*(?:adalah|:)?\s*{re.escape(answer)}\b", caption_text, re.I):
        issues.append("Caption kemungkinan membocorkan jawaban.")
        score_penalty += 30
    if len(caption_text.split()) > 180:
        issues.append("Caption terlalu panjang.")
        score_penalty += 10
    if len(caption_text.strip()) < 3:
        issues.append("Caption kosong.")
        score_penalty += 10
    return {
        "lolos": score_penalty == 0,
        "issues": issues,
        "score_penalty": score_penalty,
    }


def local_validation(question, caption=None):
    choices = question.get("pilihan", {})
    answer = question.get("jawaban", "")
    required = ["mapel", "topik", "level", "soal", "pilihan", "jawaban", "pembahasan"]
    missing = [key for key in required if not question.get(key)]
    valid_choices = sorted(choices.keys()) == ["A", "B", "C", "D", "E"]
    answer_ok = answer in choices
    score = 100
    if missing:
        score -= 25
    if not valid_choices:
        score -= 25
    if not answer_ok:
        score -= 25
    if len(question.get("pembahasan", "")) < 80:
        score -= 10
    if len(set(str(value).strip().lower() for value in choices.values())) != len(choices):
        score -= 15
    if "pilihan sementara" in json.dumps(choices, ensure_ascii=False).lower():
        score -= 30
    if len(question.get("soal", "").split()) < 12:
        score -= 10
    if len(question.get("soal", "")) > 850:
        score -= 10
    caption_result = validate_caption(caption or {"caption": "", "hashtag": []}, answer)
    score -= caption_result["score_penalty"]
    issues = []
    if missing:
        issues.append(f"Field kosong: {', '.join(missing)}")
    if not valid_choices:
        issues.append("Pilihan harus tepat A sampai E.")
    if not answer_ok:
        issues.append("Jawaban tidak cocok dengan pilihan.")
    if len(question.get("pembahasan", "")) < 80:
        issues.append("Pembahasan terlalu pendek.")
    if len(set(str(value).strip().lower() for value in choices.values())) != len(choices):
        issues.append("Ada opsi duplikat.")
    if "pilihan sementara" in json.dumps(choices, ensure_ascii=False).lower():
        issues.append("Masih ada placeholder.")
    issues.extend(caption_result["issues"])
    return {
        "lolos_validasi": score >= 80,
        "skor": max(score, 0),
        "issues": issues,
        "catatan": {
            "struktur": "Lengkap" if not missing else f"Field kosong: {', '.join(missing)}",
            "pilihan": "A sampai E tersedia" if valid_choices else "Pilihan harus tepat A sampai E",
            "jawaban": "Jawaban ada di pilihan" if answer_ok else "Jawaban tidak cocok dengan pilihan",
            "duplikasi_opsi": "Tidak ada opsi duplikat" if len(set(str(value).strip().lower() for value in choices.values())) == len(choices) else "Ada opsi duplikat",
            "placeholder": "Tidak ada placeholder" if "pilihan sementara" not in json.dumps(choices, ensure_ascii=False).lower() else "Masih ada placeholder",
            "caption": "Caption bersih" if caption_result["lolos"] else "; ".join(caption_result["issues"]),
        },
        "saran_perbaikan": "" if score >= 80 else "Perbaiki struktur soal sebelum diposting.",
    }


def draft_caption(question):
    caption = f"{question['mapel']}\n{question['topik']}"
    return {
        "caption": caption,
        "hashtag": [
            "#UTBK2026",
            "#LatsoalUTBK",
            "#BelajarUTBK",
            "#SoalUTBK",
            "#PejuangUTBK",
            "#BelajarSMA",
            "#MasukPTN",
            "#SNPMB",
            "#TryoutUTBK",
            "#TipsUTBK",
        ],
    }


def normalize_caption(question, caption):
    normalized = dict(caption or {})
    short = draft_caption(question)
    normalized["caption"] = short["caption"]
    hashtags = normalized.get("hashtag")
    if not isinstance(hashtags, list) or not hashtags:
        hashtags = short["hashtag"]
    required = short["hashtag"][:4]
    merged = []
    for tag in [*required, *hashtags]:
        tag = str(tag).strip()
        if not tag:
            continue
        if not tag.startswith("#"):
            tag = f"#{tag}"
        if tag not in merged:
            merged.append(tag)
    normalized["hashtag"] = merged
    return normalized


PAREN_HINT_WORD_RE = re.compile(
    r"\b(?:hint|petunjuk|gunakan|pakai|perhatikan|lihat|cek|misal|misalnya|contoh|"
    r"gambar|diagram|bantu|sketsa|asumsikan|ingat|anggap)\b",
    re.I,
)
PAREN_MATH_RE = re.compile(r"[=<>+\-*/^≤≥≠√∠π²³]|\b-?\d+(?:[.,]\d+)?\s*,\s*-?\d+(?:[.,]\d+)?\b")


def _is_removable_question_parenthetical(body, context):
    body = str(body or "").strip()
    if not body:
        return True
    if PAREN_HINT_WORD_RE.search(body):
        return True
    if PAREN_MATH_RE.search(body):
        return False
    if re.fullmatch(r"[A-Ea-e]", body):
        return False

    context_lower = str(context or "").lower()
    math_context = any(
        keyword in context_lower
        for keyword in (
            "persamaan linear",
            "pertidaksamaan linear",
            "aljabar",
            "fungsi linear",
            "sistem persamaan",
        )
    )
    if math_context and re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ]", body):
        return True
    return False


def _remove_question_hint_parentheses(text, context=""):
    def replace(match):
        body = match.group(1)
        if _is_removable_question_parenthetical(body, context):
            return ""
        return match.group(0)

    cleaned = re.sub(r"\s*\(([^()]*)\)", replace, str(text or ""))
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    cleaned = re.sub(r"\s+([,.!?;:])", r"\1", cleaned)
    return cleaned.strip()


def normalize_question(question):
    normalized = dict(question or {})
    context = " ".join(
        str(normalized.get(key, ""))
        for key in ("mapel", "topik", "level", "soal")
    )
    normalized["soal"] = _remove_question_hint_parentheses(normalized.get("soal", ""), context)
    return normalized


def generate_content(mapel, topic, level, mode="auto", account="@utbk_neareducation", provider="gemini"):
    GEMINI_USAGE.clear()
    run_id = _now_id()
    storage_path = None
    run_dir = None

    provider = provider if provider in {"gemini", "kimi"} else "gemini"
    provider_key = "GEMINI_API_KEY" if provider == "gemini" else "KIMI_API_KEY"
    fallback_provider_key = "NVIDIA_API_KEY" if provider == "kimi" else None
    has_provider_key = bool(os.getenv(provider_key) or (fallback_provider_key and os.getenv(fallback_provider_key)))
    use_ai = mode != "draft" and has_provider_key
    source = "draft"
    fallbacks = []
    errors = {}

    if use_ai:
        source = provider
        try:
            question = _ai_json(
                build_question_prompt(mapel, topic, level),
                "soal",
                schema=QUESTION_SCHEMA,
                provider=provider,
            )
        except Exception as exc:
            source = "fallback"
            if mapel in {"Pengetahuan Kuantitatif", "Penalaran Matematika"}:
                question = deterministic_quant_question(mapel, topic, level, run_id)
            else:
                question = draft_question(mapel, topic, level)
            fallbacks.append("question")
            errors["question"] = clean_error_message(exc)

        if GEMINI_VALIDATE and "question" not in fallbacks:
            try:
                validation = _ai_json(
                    build_validation_prompt(question),
                    "validasi",
                    retries=2,
                    schema=VALIDATION_SCHEMA,
                    provider=provider,
                )
            except Exception as exc:
                validation = local_validation(question)
                validation["saran_perbaikan"] = (
                    validation.get("saran_perbaikan", "")
                    + f" Fallback lokal dipakai karena validasi {provider.capitalize()} gagal diparse: {exc}"
                ).strip()
                fallbacks.append("validation")
                errors["validation"] = clean_error_message(exc)
        else:
            validation = local_validation(question)
            fallbacks.append("validation")

        if GEMINI_CAPTION and "question" not in fallbacks:
            try:
                caption = _ai_json(
                    build_caption_prompt(question),
                    "caption",
                    retries=2,
                    schema=CAPTION_SCHEMA,
                    provider=provider,
                )
            except Exception as exc:
                caption = draft_caption(question)
                fallbacks.append("caption")
                errors["caption"] = clean_error_message(exc)
        else:
            caption = draft_caption(question)
            fallbacks.append("caption")
    else:
        if mapel in {"Pengetahuan Kuantitatif", "Penalaran Matematika"}:
            question = deterministic_quant_question(mapel, topic, level, run_id)
        else:
            question = draft_question(mapel, topic, level)
        caption = draft_caption(question)
        validation = local_validation(question, caption)

    question = normalize_question(question)
    caption = normalize_caption(question, caption)
    if not GEMINI_VALIDATE or source in {"draft", "fallback"}:
        validation = local_validation(question, caption)
    question["akun"] = account
    storage_path = build_storage_path(question, run_id)
    run_dir = OUTPUT_DIR / storage_path
    run_dir.mkdir(parents=True, exist_ok=True)
    all_image_paths, render_engine = render_content_images(question, run_dir)
    numbered_image_paths = render_numbered_jpg_images(all_image_paths, run_dir)
    explanation_start = next(
        (
            index
            for index, path in enumerate(all_image_paths)
            if Path(path).name.startswith("pembahasan-")
        ),
        len(all_image_paths),
    )
    numbered_explanation_paths = numbered_image_paths[explanation_start:]
    dedup = check_duplicate(question)
    review_status = "needs_review" if "question" in fallbacks else "ready"
    if errors:
        review_status = "needs_review"
    if dedup["is_duplicate"]:
        review_status = "needs_review"
        validation["lolos_validasi"] = False
        validation["skor"] = min(validation.get("skor", 0), 74)
        validation.setdefault("catatan", {})["duplikasi"] = (
            f"Mirip {dedup['similarity']} dengan run {dedup['matched_run_id']}"
        )
        validation["saran_perbaikan"] = (
            validation.get("saran_perbaikan", "")
            + " Soal terdeteksi mirip dengan saved item; ubah konteks, angka, atau struktur."
        ).strip()

    metadata = {
        "ok": True,
        "run_id": run_id,
        "source": source,
        "fallback_used": bool(fallbacks),
        "fallback_reason": "; ".join(fallbacks) if fallbacks else None,
        "fallbacks": fallbacks,
        "errors": errors,
        "review_status": review_status,
        "dedup": dedup,
        "validator": {
            "passed": bool(validation.get("lolos_validasi")),
            "issues": validation.get("issues", []),
        },
        "usage": {
            "input_tokens": sum(item.get("prompt_tokens") or 0 for item in GEMINI_USAGE),
            "output_tokens": sum(item.get("output_tokens") or 0 for item in GEMINI_USAGE),
        },
        "ai_usage": {
            "calls": GEMINI_USAGE.copy(),
            "total_prompt_tokens": sum(item.get("prompt_tokens") or 0 for item in GEMINI_USAGE),
            "total_output_tokens": sum(item.get("output_tokens") or 0 for item in GEMINI_USAGE),
            "total_tokens": sum(item.get("total_tokens") or 0 for item in GEMINI_USAGE),
        },
        "provider": provider if source in {"gemini", "kimi"} else None,
        "model": DEFAULT_MODEL if source == "gemini" else KIMI_MODEL if source == "kimi" else None,
        "render_engine": render_engine,
        "storage_path": storage_path.as_posix(),
        "created_at": dt.datetime.now().isoformat(timespec="seconds"),
        "question": question,
        "validation": validation,
        "caption": caption,
        "files": {
            "question": str(run_dir / "soal.json"),
            "caption": str(run_dir / "caption.txt"),
            "image": str(numbered_image_paths[0]) if numbered_image_paths else None,
            "images": [str(path) for path in numbered_image_paths],
            "thumbnail": str(numbered_image_paths[0]) if numbered_image_paths else None,
            "explanation": str(numbered_explanation_paths[0]) if numbered_explanation_paths else None,
            "explanations": [str(path) for path in numbered_explanation_paths],
        },
    }

    (run_dir / "soal.json").write_text(
        json.dumps(question, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    caption_text = caption.get("caption", "")
    hashtags = " ".join(caption.get("hashtag", []))
    (run_dir / "caption.txt").write_text(f"{caption_text}\n\n{hashtags}\n", encoding="utf-8")
    (run_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return metadata


def render_images_for_metadata(metadata_path):
    metadata_path = Path(metadata_path).resolve()
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    run_dir = metadata_path.parent
    question = metadata.get("question") or {}
    if not question:
        raise ValueError("Metadata tidak memiliki question.")
    all_image_paths, render_engine = render_content_images(question, run_dir)
    numbered_image_paths = render_numbered_jpg_images(all_image_paths, run_dir)
    explanation_start = next(
        (
            index
            for index, path in enumerate(all_image_paths)
            if Path(path).name.startswith("pembahasan-")
        ),
        len(all_image_paths),
    )
    numbered_explanation_paths = numbered_image_paths[explanation_start:]
    metadata.setdefault("files", {})
    metadata["files"]["image"] = str(numbered_image_paths[0]) if numbered_image_paths else None
    metadata["files"]["images"] = [str(path) for path in numbered_image_paths]
    metadata["files"]["thumbnail"] = str(numbered_image_paths[0]) if numbered_image_paths else None
    metadata["files"]["explanation"] = str(numbered_explanation_paths[0]) if numbered_explanation_paths else None
    metadata["files"]["explanations"] = [str(path) for path in numbered_explanation_paths]
    metadata["render_engine"] = render_engine
    metadata["image_generated_at"] = dt.datetime.now().isoformat(timespec="seconds")
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "run_id": metadata.get("run_id") or run_dir.name,
        "files": metadata["files"],
    }


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    parser = JsonArgumentParser()
    parser.add_argument("--mapel", default="Penalaran Umum", choices=sorted(MAPEL_TOPICS.keys()))
    parser.add_argument("--topik", default="")
    parser.add_argument("--level", default="sedang", choices=["mudah", "sedang", "sulit"])
    parser.add_argument("--mode", default="auto", choices=["auto", "gemini", "draft"])
    parser.add_argument("--provider", default=os.getenv("AI_PROVIDER", "gemini"), choices=["gemini", "kimi"])
    parser.add_argument("--account", default="@utbk_neareducation")
    parser.add_argument("--render-images", default="")
    try:
        args = parser.parse_args()
        if args.render_images:
            json_stdout(render_images_for_metadata(args.render_images))
            return
        topic = args.topik or MAPEL_TOPICS[args.mapel][0]
        mode = "auto" if args.mode == "gemini" else args.mode
        metadata = generate_content(args.mapel, topic, args.level, mode, args.account, args.provider)
        json_stdout(metadata)
    except SystemExit:
        raise
    except Exception as exc:
        error = classify_error(exc)
        detail = clean_error_message(exc)
        json_stdout({
            "ok": False,
            "error": error,
            "detail": detail,
            "fallback_used": False,
            "fallback_reason": None,
        })
        print(f"[ERROR] {error}: {detail}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
