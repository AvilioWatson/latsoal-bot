import argparse
import copy
import datetime as dt
import importlib
import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
import latsoal_generator.config as generator_config
import latsoal_generator.storage as generator_storage

generator_config = importlib.reload(generator_config)
generator_storage = importlib.reload(generator_storage)

from latsoal_generator.config import (
    BANK_DIR,
    BANK_INDEX_PATH,
    DATA_ROOT,
    DEDUP_THRESHOLD,
    LATEX_COMMAND,
    LOGO_PATH,
    MAPEL_TOPICS,
    OUTPUT_DIR,
    PATTERN_FILES,
    PDF_CONVERTER,
    RENDER_ENGINE,
    RENDER_TIMEOUT_SECONDS,
    ROOT,
    SAVED_DIR,
    TAXONOMY,
)
from latsoal_generator.storage import (
    SUBTEST_CODES,
    TOPIC_ALIASES,
    build_storage_path,
    canonical_topic,
    slugify,
    subtest_code,
)
from latsoal_generator.schemas import (
    CAPTION_SCHEMA,
    EXPLANATION_REVIEW_SCHEMA,
    QUESTION_SCHEMA,
    VALIDATION_SCHEMA,
)
from latsoal_generator.prompts import (
    InsufficientTopicExamplesError,
    build_caption_prompt,
    build_explanation_review_prompt,
    build_question_prompt,
    build_validation_prompt,
    load_patterns,
    require_topic_examples,
)
from latsoal_generator.validation import (
    PAREN_HINT_WORD_RE,
    PAREN_MATH_RE,
    _is_removable_question_parenthetical,
    _remove_question_hint_parentheses,
    draft_caption,
    local_validation,
    normalize_caption,
    normalize_question,
    validate_caption,
)
from latsoal_generator.dedup import STOPWORDS, check_duplicate, jaccard_similarity, normalize_terms

def json_stdout(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def classify_error(exc):
    message = clean_error_message(exc) if "clean_error_message" in globals() else str(exc)
    if isinstance(exc, InsufficientTopicExamplesError):
        return "insufficient_topic_examples"
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


def _now_id():
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def _unique_run_id(seed_run_id, question):
    try:
        current = dt.datetime.strptime(seed_run_id, "%Y%m%d-%H%M%S")
    except ValueError:
        current = dt.datetime.now()

    for _ in range(86400):
        run_id = current.strftime("%Y%m%d-%H%M%S")
        storage_path = build_storage_path(question, run_id)
        candidates = [
            OUTPUT_DIR / storage_path,
            SAVED_DIR / storage_path,
            OUTPUT_DIR / run_id,
            SAVED_DIR / run_id,
        ]
        if not any(candidate.exists() for candidate in candidates):
            return run_id
        current += dt.timedelta(seconds=1)
    raise RuntimeError("Tidak bisa membuat run_id unik untuk output baru.")


def _extract_json(text):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```$", "", text)
    decoder = json.JSONDecoder()
    last_error = None

    for index, char in enumerate(text):
        if char != "{":
            continue
        candidate = text[index:].strip()
        sanitized = _escape_json_string_control_chars(candidate)
        for source in (candidate, sanitized):
            try:
                value, _end = decoder.raw_decode(source)
            except json.JSONDecodeError as exc:
                last_error = exc
                continue
            if isinstance(value, dict):
                if source == candidate and sanitized != candidate and _json_has_suspicious_control_chars(value):
                    try:
                        sanitized_value, _sanitized_end = decoder.raw_decode(sanitized)
                    except json.JSONDecodeError:
                        return value
                    if isinstance(sanitized_value, dict):
                        return sanitized_value
                return value

    if last_error:
        raise ValueError(f"Response JSON tidak valid: {last_error.msg}") from last_error
    raise ValueError("Response tidak berisi JSON.")


def _json_has_suspicious_control_chars(value):
    if isinstance(value, str):
        return any(char in value for char in ("\b", "\f", "\t"))
    if isinstance(value, list):
        return any(_json_has_suspicious_control_chars(item) for item in value)
    if isinstance(value, dict):
        return any(
            _json_has_suspicious_control_chars(key) or _json_has_suspicious_control_chars(item)
            for key, item in value.items()
        )
    return False


def _escape_json_string_control_chars(text):
    output = []
    in_string = False
    escaped = False
    valid_escape_chars = {'"', "\\", "/", "b", "f", "n", "r", "t", "u"}

    for index, char in enumerate(text):
        if escaped:
            next_char = text[index + 1] if index + 1 < len(text) else ""
            if in_string and (
                char not in valid_escape_chars
                or (char in {"b", "f", "n", "r", "t"} and next_char.isalpha())
            ):
                output.append("\\")
            output.append(char)
            escaped = False
            continue
        if char == "\\":
            output.append(char)
            escaped = True
            continue
        if char == '"':
            output.append(char)
            in_string = not in_string
            continue
        if in_string and char == "\n":
            output.append("\\n")
            continue
        if in_string and char == "\r":
            output.append("\\r")
            continue
        if in_string and char == "\t":
            output.append("\\t")
            continue
        output.append(char)

    return "".join(output)


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

    if family == "anthropic_sans":
        font_names = [
            "AnthropicSans-Bold.otf" if bold else "AnthropicSans-Regular.otf",
            "AnthropicSans-Bold.ttf" if bold else "AnthropicSans-Regular.ttf",
            "Anthropic Sans Bold.otf" if bold else "Anthropic Sans Regular.otf",
            "Anthropic Sans Bold.ttf" if bold else "Anthropic Sans Regular.ttf",
            "arialbd.ttf" if bold else "arial.ttf",
            "segoeuib.ttf" if bold else "segoeui.ttf",
        ]
    elif family == "anthropic_mono":
        font_names = [
            "AnthropicMono-Bold.otf" if bold else "AnthropicMono-Regular.otf",
            "AnthropicMono-Bold.ttf" if bold else "AnthropicMono-Regular.ttf",
            "Anthropic Mono Bold.otf" if bold else "Anthropic Mono Regular.otf",
            "Anthropic Mono Bold.ttf" if bold else "Anthropic Mono Regular.ttf",
            "consolab.ttf" if bold else "consola.ttf",
            "courbd.ttf" if bold else "cour.ttf",
        ]
    elif family == "lora":
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
MATH_TEXT_CHARS.update("∘·πθαβγ∥△∼≡…⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎")
_MATH_FONT_CACHE = {}

LATEX_PLAIN_SYMBOLS = {
    "circ": "∘", "cdot": "·", "times": "×", "div": "÷", "pm": "±",
    "pi": "π", "theta": "θ", "alpha": "α", "beta": "β", "gamma": "γ",
    "le": "≤", "leq": "≤", "ge": "≥", "geq": "≥", "ne": "≠", "neq": "≠",
    "approx": "≈", "equiv": "≡", "in": "∈", "notin": "∉", "parallel": "∥",
    "angle": "∠", "triangle": "△", "sim": "∼", "ldots": "…", "infty": "∞",
    "to": "→", "rightarrow": "→", "Rightarrow": "⇒", "cap": "∩", "cup": "∪",
    "sin": "sin", "cos": "cos", "tan": "tan", "log": "log", "ln": "ln",
}
SUPERSCRIPT_CHARS = str.maketrans("0123456789+-=()n", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ")
SUBSCRIPT_CHARS = str.maketrans("0123456789+-=()", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎")


def _latex_group(source, index):
    if index >= len(source) or source[index] != "{":
        return "", index
    depth = 1
    cursor = index + 1
    while cursor < len(source) and depth:
        if source[cursor] == "{":
            depth += 1
        elif source[cursor] == "}":
            depth -= 1
        cursor += 1
    return source[index + 1:cursor - 1], cursor


def _plain_math_operand(value):
    value = value.strip()
    return value if re.fullmatch(r"[A-Za-z0-9πθαβγ√.⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+", value) else f"({value})"


def _latex_to_plain_text(value):
    source = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    output = []
    index = 0
    while index < len(source):
        char = source[index]
        if char == "$":
            index += 1
            continue
        if char == "\\":
            if index + 1 < len(source) and source[index + 1] == "\\":
                output.append("\n")
                index += 2
                continue
            match = re.match(r"\\([A-Za-z]+)", source[index:])
            if not match:
                if index + 1 < len(source):
                    output.append(source[index + 1])
                index += 2
                continue
            command = match.group(1)
            index += len(match.group(0))
            if command in {"left", "right"}:
                continue
            if command in {"quad", "qquad", "enspace", "space"}:
                output.append(" ")
                continue
            if command in {"frac", "dfrac", "tfrac"}:
                numerator, index = _latex_group(source, index)
                denominator, index = _latex_group(source, index)
                top = _plain_math_operand(_latex_to_plain_text(numerator))
                bottom = _plain_math_operand(_latex_to_plain_text(denominator))
                output.append(f"{top}/{bottom}")
                continue
            if command == "sqrt":
                radicand, index = _latex_group(source, index)
                rendered = _latex_to_plain_text(radicand)
                output.append(f"√{_plain_math_operand(rendered)}")
                continue
            if command == "binom":
                total, index = _latex_group(source, index)
                selected, index = _latex_group(source, index)
                output.append(f"C({_latex_to_plain_text(total)}, {_latex_to_plain_text(selected)})")
                continue
            if command in {"text", "mathrm", "mathbf", "operatorname"}:
                content, index = _latex_group(source, index)
                output.append(_latex_to_plain_text(content))
                continue
            if command in {",", ";", ":", "!"}:
                continue
            output.append(LATEX_PLAIN_SYMBOLS.get(command, command))
            continue
        if char in "^_":
            is_super = char == "^"
            index += 1
            if index < len(source) and source[index] == "{":
                content, index = _latex_group(source, index)
            else:
                content = source[index:index + 1]
                index += 1
            rendered = _latex_to_plain_text(content)
            translated = rendered.translate(SUPERSCRIPT_CHARS if is_super else SUBSCRIPT_CHARS)
            if translated == rendered and not rendered.isalpha():
                translated = f"^({rendered})" if is_super else f"_({rendered})"
            output.append(translated)
            continue
        if char in "{}":
            index += 1
            continue
        output.append(" " if char == "~" else char)
        index += 1
    rendered = "".join(output)
    rendered = re.sub(r"(?<![<>=!])\s*=\s*(?![=>])", " = ", rendered)
    rendered = re.sub(r"[ \t]{2,}", " ", rendered)
    return rendered.strip()


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


def _wrap_units(text):
    """Split text into words while keeping balanced parentheticals intact."""
    source = str(text or "")
    units = []
    index = 0
    while index < len(source):
        while index < len(source) and source[index].isspace():
            index += 1
        if index >= len(source):
            break

        start = index
        depth = 0
        while index < len(source):
            char = source[index]
            if char == "(":
                depth += 1
            elif char == ")" and depth:
                depth -= 1
            elif char.isspace() and depth == 0:
                break
            index += 1
        units.append(re.sub(r"\s+", " ", source[start:index]).strip())
    return [unit for unit in units if unit]


def _wrap_text(draw, text, font, max_width):
    lines = []
    normalized_text = _latex_to_plain_text(text)
    for source_line in normalized_text.split("\n"):
        words = _wrap_units(source_line)
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
    paragraph_break = "__LATSOAL_QUESTION_PARAGRAPH_BREAK__"
    formatted = re.sub(r"(?<=[.!?:])\s*\n\s*\n+", f" {paragraph_break} ", formatted)
    # LLM output can contain arbitrary hard wraps or blank lines in the middle
    # of a sentence. Treat those as spaces, then add back only the structural
    # line breaks that the renderer intentionally supports below.
    formatted = re.sub(r"\s+", " ", formatted).strip()
    formatted = re.sub(r"(?<![<>=!])\s*=\s*(?![=>])", " = ", formatted)
    formatted = re.sub(
        r"\b\d+(?:\s*:\s*\d+){1,}\b",
        lambda match: re.sub(r"\s*:\s*", ":", match.group(0)),
        formatted,
    )
    dot_numbered_items = re.findall(r"(?<!\d)([1-9]\d?)\.(?=\s+\S)", formatted)
    if dot_numbered_items[:2] == ["1", "2"]:
        formatted = re.sub(r"\s+(?=[1-9]\d?\.\s+)", "\n", formatted)
    numbered_statements = re.findall(r"\([1-9]\d?\)(?=\s)", formatted)
    if len(numbered_statements) >= 2:
        formatted = re.sub(r"\s+(?=\([1-9]\d?\)(?=\s))", "\n", formatted)
    formatted = re.sub(r"\s+(Simpulan\b)", r"\n\1", formatted)
    formatted = formatted.replace(f" {paragraph_break} ", "\n\n").replace(paragraph_break, "\n\n")
    return re.sub(r"\n{3,}", "\n\n", formatted).strip()


def _question_formula_parts(text):
    """Split a question into intro, formula row, and conclusion when possible."""
    plain = _latex_to_plain_text(_format_question_text(text))
    match = re.match(
        r"^(.*?\bJika)\s*:?[\s,]*(.+?)[\s,]+(?:maka)\s+(.+)$",
        plain,
        flags=re.I | re.S,
    )
    if not match:
        return None

    intro = match.group(1).strip().rstrip(" ,.;:") + ":"
    formula_source = match.group(2).strip().rstrip(" ,.;")
    conclusion = "Maka " + match.group(3).strip()
    if "=" not in formula_source:
        return None

    formulas = [
        part.strip(" ,.;")
        for part in re.split(r"\s+dan\s+(?=[^,.;]*=)", formula_source, flags=re.I)
        if part.strip(" ,.;")
    ]
    if not formulas:
        return None
    return {
        "intro": intro,
        "formulas": formulas[:3],
        "conclusion": conclusion,
    }


PASSAGE_PARAGRAPH_BREAK = "\u2029"
PASSAGE_INDENT_MARKER = "\u2060"
QUESTION_INDENT_PX = 28


def _is_numbered_paragraph(text):
    return bool(re.match(r"^(?:\([1-9]\d?\)|[1-9]\d?\.|[A-E]\.)\s+", str(text or "").strip()))


def _strip_indent_marker(line):
    line = str(line or "")
    return line[len(PASSAGE_INDENT_MARKER):] if line.startswith(PASSAGE_INDENT_MARKER) else line


def _drawable_line_count(lines):
    return sum(1 for line in lines if line != PASSAGE_PARAGRAPH_BREAK)


def _wrap_question_paragraphs(draw, text, font, max_width):
    formatted = _format_question_text(text).replace("\r\n", "\n").replace("\r", "\n")
    raw_paragraphs = [
        paragraph.strip()
        for paragraph in re.split(r"\n{2,}|\n", formatted)
        if paragraph.strip()
    ]
    paragraphs = []
    for index, paragraph in enumerate(raw_paragraphs):
        indent = index > 0 and not _is_numbered_paragraph(paragraph)
        wrap_width = max_width - QUESTION_INDENT_PX if indent else max_width
        wrapped = _wrap_text(draw, paragraph, font, wrap_width)
        if indent and wrapped:
            wrapped[0] = f"{PASSAGE_INDENT_MARKER}{wrapped[0]}"
        paragraphs.append(wrapped)
    return paragraphs or [[""]]


def _wrap_passage_paragraphs(draw, text, font, max_width):
    source = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()

    paragraphs = []
    for paragraph in re.split(r"\n{2,}", source):
        paragraph = re.sub(r"\s*\n\s*", " ", paragraph).strip()
        if paragraph:
            wrapped = _wrap_text(draw, paragraph, font, max_width)
            if len(wrapped) > 1:
                wrapped[0] = f"{PASSAGE_INDENT_MARKER}{wrapped[0]}"
            paragraphs.append(wrapped)
    return paragraphs or [[""]]


def _flatten_paragraphs(paragraphs):
    lines = []
    for index, paragraph in enumerate(paragraphs):
        if index:
            lines.append(PASSAGE_PARAGRAPH_BREAK)
        lines.extend(paragraph)
    return _trim_blank_lines(lines)


def _paginate_paragraph_lines(paragraphs, first_capacity, next_capacity, paragraph_gap=0):
    pages = []
    current = []
    current_count = 0

    def capacity_for_next_page():
        return first_capacity if not pages else next_capacity

    for paragraph in paragraphs:
        line_index = 0
        needs_gap = bool(current and paragraph_gap > 0)

        while line_index < len(paragraph):
            capacity = capacity_for_next_page()
            remaining = capacity - current_count

            if needs_gap:
                if remaining <= paragraph_gap:
                    if current:
                        pages.append(_trim_blank_lines(current))
                    current = []
                    current_count = 0
                    continue
                current.extend([""] * paragraph_gap)
                current_count += paragraph_gap
                needs_gap = False
                remaining = capacity - current_count
            elif current and current[-1] != PASSAGE_PARAGRAPH_BREAK and line_index == 0:
                current.append(PASSAGE_PARAGRAPH_BREAK)

            if remaining <= 0:
                if current:
                    pages.append(_trim_blank_lines(current))
                current = []
                current_count = 0
                continue

            take = min(remaining, len(paragraph) - line_index)
            current.extend(paragraph[line_index:line_index + take])
            current_count += take
            line_index += take

            if line_index < len(paragraph):
                pages.append(_trim_blank_lines(current))
                current = []
                current_count = 0

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


def _display_question_text(question):
    text = str(question.get("soal", "") or "")
    passage = question.get("bacaan")
    if not isinstance(passage, dict) or not str(passage.get("teks", "")).strip():
        return text
    title = str(passage.get("judul", "") or "").strip()
    passage_text = str(passage.get("teks", "") or "").strip()
    try:
        total = int(passage.get("total_soal") or 0)
    except (TypeError, ValueError):
        total = 0
    if total <= 1:
        parts = [title, passage_text, text] if title else [passage_text, text]
        return "\n\n".join(part for part in parts if part)
    number = passage.get("nomor_soal")
    label = "Bacaan"
    if title:
        label = f"{label}: {title}"
    question_label = "Soal"
    if number and total:
        question_label = f"Soal {number}/{total}"
    return f"{label}\n{passage_text}\n\n{question_label}\n{text}"


def _question_group_candidates(question, metadata=None):
    candidates = []
    for source in [
        (metadata or {}).get("question_group"),
        question.get("question_group") if isinstance(question, dict) else None,
    ]:
        if not isinstance(source, list):
            continue
        for item in source:
            if isinstance(item, dict) and isinstance(item.get("question"), dict):
                candidates.append(item["question"])
            elif isinstance(item, dict):
                if isinstance(question, dict) and "nomor_soal" in item and "soal" in item:
                    expanded = copy.deepcopy(question)
                    expanded["soal"] = item.get("soal", "")
                    expanded["pilihan"] = dict(item.get("pilihan") or {})
                    expanded["jawaban"] = item.get("jawaban", "")
                    expanded["pembahasan"] = item.get("pembahasan", "")
                    expanded["konsep_kunci"] = item.get("konsep_kunci", "")
                    expanded["tips_pengerjaan"] = item.get("tips_pengerjaan", "")
                    expanded["butuh_visual"] = bool(item.get("butuh_visual"))
                    expanded["deskripsi_visual"] = item.get("deskripsi_visual", "")
                    passage = copy.deepcopy(expanded.get("bacaan") or {})
                    passage["nomor_soal"] = int(item.get("nomor_soal") or 0)
                    passage["total_soal"] = int(question.get("group_total_soal") or passage.get("total_soal") or 0)
                    expanded["bacaan"] = passage
                    expanded.pop("question_group", None)
                    candidates.append(expanded)
                else:
                    candidates.append(item)
    return candidates


def _question_group_fingerprint(question):
    if not isinstance(question, dict):
        return ""
    cloned = copy.deepcopy(question)
    cloned.pop("visual_latex", None)
    cloned.pop("question_group", None)
    return json.dumps(cloned, ensure_ascii=False, sort_keys=True)


def _normalize_passage_question_group(question, candidates):
    passage = question.get("bacaan") if isinstance(question.get("bacaan"), dict) else None
    if not passage:
        return [question]

    passage_id = str(passage.get("id") or "").strip()
    passage_text = str(passage.get("teks") or "").strip()
    mapel = str(question.get("mapel") or "").strip()
    try:
        expected_total = int(passage.get("total_soal") or 0)
    except (TypeError, ValueError):
        expected_total = 0
    if not passage_id or not passage_text or expected_total < 1:
        return [question]

    grouped = {}
    fingerprints = {}
    for candidate in [question, *candidates]:
        if not isinstance(candidate, dict):
            continue
        candidate_passage = candidate.get("bacaan") if isinstance(candidate.get("bacaan"), dict) else None
        if not candidate_passage:
            continue
        if str(candidate.get("mapel") or "").strip() != mapel:
            continue
        if str(candidate_passage.get("id") or "").strip() != passage_id:
            continue
        if str(candidate_passage.get("teks") or "").strip() != passage_text:
            continue
        try:
            number = int(candidate_passage.get("nomor_soal") or 0)
            total = int(candidate_passage.get("total_soal") or 0)
        except (TypeError, ValueError):
            return [question]
        fingerprint = _question_group_fingerprint(candidate)
        if total != expected_total or number < 1 or number > expected_total:
            return [question]
        if number in grouped:
            if fingerprints.get(number) == fingerprint:
                continue
            return [question]
        grouped[number] = candidate
        fingerprints[number] = fingerprint

    ordered_numbers = list(range(1, expected_total + 1))
    if [number for number in ordered_numbers if number in grouped] != ordered_numbers:
        return [question]
    return [grouped[number] for number in ordered_numbers]


def _load_saved_passage_question_group(question, metadata_path):
    passage = question.get("bacaan") if isinstance(question.get("bacaan"), dict) else None
    if not passage or not metadata_path:
        return [question]

    metadata_path = Path(metadata_path).resolve()
    try:
        metadata_path.relative_to(SAVED_DIR.resolve())
    except ValueError:
        return [question]

    candidates = []
    for candidate_path in SAVED_DIR.rglob("metadata.json"):
        try:
            metadata = json.loads(candidate_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        candidate_question = metadata.get("question")
        if isinstance(candidate_question, dict):
            candidates.append(candidate_question)
    return _normalize_passage_question_group(question, candidates)


def _resolve_render_questions(question, metadata_path=None, metadata=None):
    explicit_group = _question_group_candidates(question, metadata=metadata)
    if explicit_group:
        resolved = _normalize_passage_question_group(question, explicit_group)
        if resolved:
            return resolved
    return _load_saved_passage_question_group(question, metadata_path)


def _is_passage_bundle(question_group):
    if not question_group:
        return False
    first = question_group[0]
    passage = first.get("bacaan") if isinstance(first.get("bacaan"), dict) else None
    if not passage or not str(passage.get("teks") or "").strip():
        return False
    try:
        total = int(passage.get("total_soal") or len(question_group) or 0)
    except (TypeError, ValueError):
        total = len(question_group)
    return total > 1 and len(question_group) > 1


def _clone_group_render_question(question, number, total):
    cloned = copy.deepcopy(question)
    topic = str(cloned.get("topik") or cloned.get("mapel", "Soal")).strip()
    label = f"Soal {number}/{total}"
    cloned["topik"] = f"{topic} • {label}"
    cloned["soal"] = str(cloned.get("soal", "") or "").strip()
    cloned.pop("question_group", None)
    cloned.pop("bacaan", None)
    return attach_cartesian_latex_visual(cloned)


def _paginate_passage_intro(draw, question, fonts):
    passage = question.get("bacaan") if isinstance(question.get("bacaan"), dict) else {}
    passage_text = str(passage.get("teks") or "").strip()
    paragraphs = _wrap_passage_paragraphs(draw, passage_text, fonts["body"], 764)
    return _paginate_paragraph_lines(paragraphs, 20, 20, paragraph_gap=0) or [[""]]


def _count_passage_intro_pages(question):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return 0

    probe = Image.new("RGB", (1000, 1000), "#f5f0e8")
    fonts = {
        "body": _load_font(24, family="anthropic_sans"),
    }
    return len(_paginate_passage_intro(ImageDraw.Draw(probe), question, fonts))


def render_passage_intro_images(question, question_count, run_dir, page_offset=0, total_pages=None, start_index=1):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return []

    width = height = 1000
    colors = {
        "bg": "#f6f0e6",
        "panel": "#fffaf2",
        "ink": "#201a14",
        "muted": "#7f7466",
        "line": "#d9cec0",
        "accent": "#26405a",
        "accent_soft": "#dbe5ee",
    }
    fonts = {
        "category": _load_font(23, bold=True, family="anthropic_sans"),
        "title": _load_font(34, bold=True, family="anthropic_sans"),
        "passage_title": _load_font(28, bold=True, family="anthropic_sans"),
        "body": _load_font(24, family="anthropic_sans"),
        "small": _load_font(22, family="anthropic_sans"),
        "small_bold": _load_font(22, bold=True, family="anthropic_sans"),
    }

    probe = Image.new("RGB", (width, height), colors["bg"])
    pages = _paginate_passage_intro(ImageDraw.Draw(probe), question, fonts)
    display_total = total_pages or len(pages)
    logo = _load_quiz_logo()
    passage = question.get("bacaan") if isinstance(question.get("bacaan"), dict) else {}
    title = str(passage.get("judul") or "").strip()
    title_lines = _wrap_text(ImageDraw.Draw(probe), title, fonts["passage_title"], 764)[:3] if title else []
    output_paths = []

    for page_index, lines in enumerate(pages, start=1):
        image = Image.new("RGB", (width, height), colors["bg"])
        draw = ImageDraw.Draw(image)
        account = question.get("akun", "@utbk_neareducation")

        draw.rectangle((0, 0, width, height), fill=colors["bg"])
        if logo:
            image.paste(logo, (928 - logo.width, 68), logo)
        _draw_page_header(draw, question, fonts, colors)
        content_start_y = 236

        line_h = _line_height(draw, fonts["body"]) + 9
        title_block_h = 0
        if page_index == 1 and title_lines:
            title_block_h = len(title_lines) * _line_height(draw, fonts["passage_title"]) + max(len(title_lines) - 1, 0) * 8 + 20
            content_start_y += title_block_h

        drawable_lines = [line for line in lines if line != PASSAGE_PARAGRAPH_BREAK]
        line_count = max(len(drawable_lines), 1)
        text_block_h = (line_count - 1) * line_h + _line_height(draw, fonts["body"])
        content_bottom = int(content_start_y + text_block_h + 34)
        panel_bottom = min(896, max(792, content_bottom))
        panel = (72, 188, 928, panel_bottom)
        draw.rounded_rectangle(panel, radius=18, fill=colors["panel"], outline=colors["line"], width=2)

        if page_index == 1 and title_lines:
            title_y = 236
            for title_line in title_lines:
                title_w = _text_width(draw, title_line, fonts["passage_title"])
                _draw_text_with_math(draw, (width - title_w) / 2, title_y, title_line, fonts["passage_title"], colors["ink"])
                title_y += _line_height(draw, fonts["passage_title"]) + 8

        text_y = content_start_y
        starts_paragraph = True
        for index, line in enumerate(lines):
            if line == PASSAGE_PARAGRAPH_BREAK:
                starts_paragraph = True
                continue
            has_indent = line.startswith(PASSAGE_INDENT_MARKER)
            if has_indent:
                line = line[len(PASSAGE_INDENT_MARKER):]
            next_line = lines[index + 1] if index + 1 < len(lines) else ""
            justify_line = bool(line.strip()) and next_line != PASSAGE_PARAGRAPH_BREAK and bool(next_line.strip())
            line_x = 146 if starts_paragraph and has_indent else 118
            line_width = 736 if starts_paragraph and has_indent else 764
            _draw_justified_line(draw, line_x, text_y, line, fonts["body"], colors["ink"], line_width, justify=justify_line)
            starts_paragraph = False
            text_y += line_h

        draw.text((72, 942), account, font=fonts["small"], fill="#9ca3af")
        footer_right = 928
        if display_total > 1:
            page_text = f"{page_offset + page_index}/{display_total}"
            page_w = _text_width(draw, page_text, fonts["small"])
            draw.text((928 - page_w, 942), page_text, font=fonts["small"], fill=colors["muted"])
            footer_right = 928 - page_w - 32
        if page_index == len(pages):
            discussion_text = "Lanjut Soal  →"
            discussion_w = _text_width(draw, discussion_text, fonts["small_bold"])
            draw.text(
                (footer_right - discussion_w, 942),
                discussion_text,
                font=fonts["small_bold"],
                fill=colors["ink"],
            )

        output_path = run_dir / f"post-{start_index + page_index - 1}.png"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, format="PNG", optimize=True)
        output_paths.append(output_path)

    return output_paths


def _paginate_quiz(draw, question, fonts):
    display_text = _display_question_text(question)
    q_paragraphs = _wrap_question_paragraphs(draw, display_text, fonts["question"], 790)
    q_lines = _flatten_paragraphs(q_paragraphs)
    q_line_count = _drawable_line_count(q_lines)
    formula_parts = _question_formula_parts(display_text)
    choices = question.get("pilihan", {})
    choice_page_limit = 560 if q_line_count <= 8 else 742
    choice_pages = []
    current = []
    used = 0
    for key in ["A", "B", "C", "D", "E"]:
        lines = _wrap_text(draw, choices.get(key, ""), fonts["body"], 650)
        content_h = _lines_visual_height(draw, lines, fonts["body"], gap=8)
        block_h = max(74, content_h + 24)
        if current and used + block_h + 12 > choice_page_limit:
            choice_pages.append(current)
            current = []
            used = 0
        current.append((key, lines, block_h))
        used += block_h + 12
    if current:
        choice_pages.append(current)

    pages = []
    if q_line_count <= 8:
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


def _draw_page_header(draw, question, fonts, colors, title_override=None):
    title = str(question.get("mapel", "Kuis"))
    subtitle = title_override or str(question.get("topik") or question.get("mapel", "Pengetahuan Umum"))
    draw.text((72, 82), title[:42], font=fonts["title"], fill=colors["ink"])
    _draw_tracking_text(draw, 72, 132, subtitle.upper()[:48], fonts["category"], colors["muted"], tracking=2)


def _count_quiz_image_pages(question):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return 0

    width = height = 1000
    fonts = {
        "question": _load_font(30, bold=True, family="anthropic_sans"),
        "body": _load_font(29, family="anthropic_sans"),
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
        "category": _load_font(46, bold=True, family="anthropic_sans"),
        "title": _load_font(28, family="anthropic_sans"),
        "small": _load_font(18, family="anthropic_sans"),
    }

    image = Image.new("RGB", (width, height), colors["bg"])
    draw = ImageDraw.Draw(image)
    logo = _load_quiz_logo(target_width=260)
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


def render_quiz_images(question, run_dir, page_offset=0, total_pages=None, start_index=1):
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
        "white": "#fffdf8",
    }
    fonts = {
        "category": _load_font(23, bold=True, family="anthropic_sans"),
        "title": _load_font(34, bold=True, family="anthropic_sans"),
        "question": _load_font(29, family="anthropic_sans"),
        "body": _load_font(29, family="anthropic_sans"),
        "body_bold": _load_font(29, bold=True, family="anthropic_sans"),
        "mono": _load_font(27, family="anthropic_mono"),
        "small": _load_font(22, family="anthropic_sans"),
        "small_bold": _load_font(22, bold=True, family="anthropic_sans"),
    }

    probe = Image.new("RGB", (width, height), colors["bg"])
    probe_draw = ImageDraw.Draw(probe)
    pages = _paginate_quiz(probe_draw, question, fonts)
    display_total = total_pages or len(pages)
    logo = _load_quiz_logo()
    formula_parts = _question_formula_parts(_display_question_text(question))
    output_paths = []

    for page_index, page in enumerate(pages, start=1):
        image = Image.new("RGB", (width, height), colors["bg"])
        draw = ImageDraw.Draw(image)
        account = question.get("akun", "@utbk_neareducation")

        draw.rectangle((0, 0, width, height), fill=colors["bg"])
        if logo:
            image.paste(logo, (928 - logo.width, 68), logo)
        _draw_page_header(draw, question, fonts, colors)

        q_lines = page["question_lines"]
        q_line_count = _drawable_line_count(q_lines)
        has_question = q_line_count > 0
        has_choices = bool(page["choices"])
        formula_layout = bool(formula_parts and has_question and page_index == 1)
        q_line_h = _line_height(draw, fonts["question"]) + 8
        intro_lines = []
        formula_lines = []
        conclusion_lines = []
        formula_line_h = 0
        formula_h = 0
        if formula_layout:
            intro_lines = _wrap_text(draw, formula_parts["intro"], fonts["question"], 748)[:2]
            formula_text = "   |   ".join(formula_parts["formulas"])
            formula_lines = _wrap_text(draw, formula_text, fonts["mono"], 730)[:2]
            formula_line_h = _line_height(draw, fonts["mono"]) + 10
            formula_h = max(66, len(formula_lines) * formula_line_h + 24)
            conclusion_lines = _wrap_text(
                draw,
                formula_parts["conclusion"],
                fonts["question"],
                748,
            )[:2]
        if formula_layout:
            formula_content_h = (
                len(intro_lines) * q_line_h
                + 8
                + formula_h
                + 14
                + len(conclusion_lines) * q_line_h
            )
            formula_box_h = max(220, 24 + formula_content_h + 18)
            question_box = (72, 188, 928, min(480, 188 + formula_box_h))
        elif has_question and not has_choices:
            q_box_h = min(696, max(240, q_line_count * q_line_h + 56))
            available_top = 188
            q_box_top = available_top
            question_box = (72, q_box_top, 928, q_box_top + q_box_h)
        elif has_question:
            q_box_bottom = min(474, 188 + 24 + q_line_count * q_line_h + 30)
            question_box = (72, 188, 928, max(328, q_box_bottom))
        else:
            question_box = None

        if question_box:
            draw.rounded_rectangle(question_box, radius=7, fill=colors["white"], outline=colors["line"], width=2)

        if question_box:
            content_top = question_box[1] + 24
            if formula_layout:
                q_y = content_top
                for intro_line in intro_lines:
                    _draw_text_with_math(draw, 112, q_y, intro_line, fonts["question"], colors["ink"])
                    q_y += q_line_h

                formula_top = q_y + 8
                draw.rounded_rectangle(
                    (104, formula_top, 896, formula_top + formula_h),
                    radius=10,
                    fill=colors["panel"],
                    outline=colors["line"],
                    width=2,
                )
                formula_total_h = _lines_visual_height(draw, formula_lines, fonts["mono"], gap=10)
                formula_y = formula_top + (formula_h - formula_total_h) / 2
                for formula_line in formula_lines:
                    formula_bbox = _text_bbox(draw, formula_line, fonts["mono"])
                    _draw_text_with_math(
                        draw,
                        128,
                        formula_y - formula_bbox[1],
                        formula_line,
                        fonts["mono"],
                        colors["ink"],
                    )
                    formula_y += formula_line_h

                conclusion_y = formula_top + formula_h + 14
                for conclusion_line in conclusion_lines:
                    _draw_text_with_math(draw, 112, conclusion_y, conclusion_line, fonts["question"], colors["ink"])
                    conclusion_y += q_line_h
            else:
                glyph_h = _line_height(draw, fonts["question"])
                q_text_h = glyph_h + max(0, q_line_count - 1) * q_line_h
                q_y = question_box[1] + max(
                    0,
                    (question_box[3] - question_box[1] - q_text_h) // 2,
                )
            if not formula_layout:
                text_x = question_box[0] + 40
                text_w = question_box[2] - question_box[0] - 80
                starts_paragraph = True
                for line_index, line in enumerate(q_lines):
                    if line == PASSAGE_PARAGRAPH_BREAK:
                        starts_paragraph = True
                        continue
                    has_indent = line.startswith(PASSAGE_INDENT_MARKER)
                    line = _strip_indent_marker(line)
                    next_line = q_lines[line_index + 1] if line_index + 1 < len(q_lines) else ""
                    next_text = _strip_indent_marker(next_line)
                    justify_line = bool(line.strip()) and next_line != PASSAGE_PARAGRAPH_BREAK and bool(next_text.strip())
                    line_x = text_x + QUESTION_INDENT_PX if starts_paragraph and has_indent else text_x
                    line_w = text_w - QUESTION_INDENT_PX if starts_paragraph and has_indent else text_w
                    _draw_justified_line(
                        draw,
                        line_x,
                        q_y,
                        line,
                        fonts["question"],
                        colors["ink"],
                        line_w,
                        justify=justify_line,
                    )
                    starts_paragraph = False
                    q_y += q_line_h

        GAP = 12
        block_heights = []
        for _, lines, _ in page["choices"]:
            content_h = _lines_visual_height(draw, lines, fonts["body"], gap=8)
            block_heights.append(max(74, content_h + 24))

        area_top = (question_box[3] + 28) if question_box else 188
        y = area_top
        for (key, lines, _), block_h in zip(page["choices"], block_heights):
            draw.rounded_rectangle(
                (72, y, 928, y + block_h),
                radius=7,
                fill=colors["white"],
                outline=colors["line"],
                width=2,
            )
            badge_size = 48
            badge_left = 104
            badge_top = y + (block_h - badge_size) // 2
            draw.ellipse(
                (badge_left, badge_top, badge_left + badge_size, badge_top + badge_size),
                fill=colors["panel"],
                outline=colors["line"],
                width=2,
            )
            key_bbox = _text_bbox(draw, key, fonts["body_bold"])
            key_w = key_bbox[2] - key_bbox[0]
            key_h = key_bbox[3] - key_bbox[1]
            key_x = badge_left + (badge_size - key_w) / 2 - key_bbox[0]
            key_y = badge_top + (badge_size - key_h) / 2 - key_bbox[1]
            draw.text((key_x, key_y), key, font=fonts["body_bold"], fill=colors["ink"])

            total_text_h = _lines_visual_height(draw, lines, fonts["body"], gap=8)
            text_y = y + (block_h - total_text_h) // 2
            text_w = 700
            for line_index, line in enumerate(lines):
                line_bbox = _text_bbox(draw, line, fonts["body"])
                line_h = line_bbox[3] - line_bbox[1]
                _draw_justified_line(
                    draw,
                    178,
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
        footer_right = 928
        if display_total > 1:
            page_text = f"{page_offset + page_index}/{display_total}"
            page_w = _text_width(draw, page_text, fonts["small"])
            draw.text((928 - page_w, 942), page_text, font=fonts["small"], fill=colors["muted"])
            footer_right = 928 - page_w - 32
        if page_index == len(pages) and str(question.get("pembahasan") or "").strip():
            discussion_text = "Pembahasan  →"
            discussion_w = _text_width(draw, discussion_text, fonts["small_bold"])
            draw.text(
                (footer_right - discussion_w, 942),
                discussion_text,
                font=fonts["small_bold"],
                fill="#000000",
            )

        output_path = run_dir / f"post-{start_index + page_index - 1}.png"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, format="PNG", optimize=True)
        output_paths.append(output_path)

    return output_paths


def _format_explanation_text(text, max_paragraph_chars=230, sentence_per_line=False):
    raw = str(text).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return ""
    raw = re.sub(r"(?<![<>=!])\s*=\s*(?![=>])", " = ", raw)
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
    numbered_statements = re.findall(r"\([1-9]\d?\)(?=\s)", raw)
    if len(numbered_statements) >= 2:
        raw = re.sub(r"\s+(?=\([1-9]\d?\)(?=\s))", "\n", raw)
    raw = re.sub(
        r"\s+(?=(?:TIDAK\s+CUKUP|BERSAMA-SAMA\s+CUKUP|"
        r"BERSAMA-SAMA\s*:|GABUNGAN\s+(?:PERNYATAAN\s+)?(?:\(1\)|1)|"
        r"JAWABAN\s*:?\s*[A-E]\b))",
        "\n",
        raw,
        flags=re.I,
    )

    paragraphs = []
    for block in re.split(r"\n{2,}|\n", raw):
        block = block.strip()
        if not block:
            continue
        current = ""
        block_sentences = []
        for sentence in _split_sentences(block):
            if sentence_per_line:
                block_sentences.append(sentence)
                continue
            candidate = f"{current} {sentence}".strip()
            if current and len(candidate) > max_paragraph_chars:
                paragraphs.append(current)
                current = sentence
            else:
                current = candidate
        if current:
            paragraphs.append(current)
        if block_sentences:
            paragraphs.append("\n".join(block_sentences))
    return _compact_math_for_line_wrap("\n\n".join(paragraphs))


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


def _explanation_visual_height(lines, line_h, paragraph_gap=12):
    if not lines:
        return 0
    return sum(paragraph_gap if not line else line_h for line in lines)


def _answer_display_text(answer_key, answer_text):
    text = str(answer_text or "").strip()
    key = str(answer_key or "").strip().upper()
    if key and text:
        text = re.sub(rf"^\s*{re.escape(key)}\s*[.):\-]\s*", "", text, flags=re.I)
    return text or "Jawaban"


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
    current_height = 0
    paragraphs = _wrap_explanation_paragraphs(draw, explanation, fonts["body"], 748)
    line_h = _line_height(draw, fonts["body"]) + 8
    paragraph_gap = 12

    def capacity_for_next_page():
        return 442 if not pages else 574

    for paragraph_lines in paragraphs:
        remaining = list(paragraph_lines)
        while remaining:
            capacity = capacity_for_next_page()
            gap_height = paragraph_gap if current else 0
            available = capacity - current_height - gap_height
            fit_count = max(0, int(available // line_h))
            if fit_count == 0:
                pages.append(_trim_blank_lines(current))
                current = []
                current_height = 0
                continue

            take_count = min(len(remaining), fit_count)
            if current:
                current.append("")
                current_height += paragraph_gap
            current.extend(remaining[:take_count])
            current_height += take_count * line_h
            remaining = remaining[take_count:]

            if remaining:
                pages.append(_trim_blank_lines(current))
                current = []
                current_height = 0

    if current:
        pages.append(_trim_blank_lines(current))
    return [page for page in pages if page]


def _is_explanation_formula(text):
    plain = _latex_to_plain_text(text).strip()
    if not plain or "=" not in plain:
        return False
    identifiers = re.findall(r"[^\W\d_]+", plain, flags=re.UNICODE)
    math_names = {"sin", "cos", "tan", "log", "ln", "fpb", "kpk"}
    has_prose = any(len(name) > 1 and name.lower() not in math_names for name in identifiers)
    return not has_prose and len(plain) <= 140


def _build_explanation_steps(text):
    formatted = _format_explanation_text(text)
    blocks = [block.strip() for block in formatted.split("\n\n") if block.strip()]
    steps = []

    def append_part(step, content):
        formula = _is_explanation_formula(content)
        if formula and step["parts"] and step["parts"][-1]["formula"]:
            step["parts"][-1]["text"] = f"{step['parts'][-1]['text']}\n{content}"
            return
        step["parts"].append({"text": content, "formula": formula})

    for block in blocks:
        explicit = re.match(r"^(?:Langkah|Step)\s+(\d+)\s*[:.)-]?\s*(.*)$", block, re.I | re.S)
        conclusion = re.match(r"^Kesimpulan\s*:\s*(.*)$", block, re.I | re.S)
        content = (explicit.group(2) if explicit else conclusion.group(1) if conclusion else block).strip()
        if not content:
            continue
        if explicit or conclusion or not steps:
            steps.append({
                "number": int(explicit.group(1)) if explicit else len(steps) + 1,
                "conclusion": bool(conclusion),
                "parts": [],
            })
        append_part(steps[-1], content)
    return steps


def _structured_explanation_groups(draw, text, fonts):
    groups = []
    body_font = fonts["explanation"]
    formula_font = fonts["formula"]
    body_line_h = max(
        _line_height(draw, body_font) + 8,
        int(round(_font_size(body_font) * 1.5)),
    )
    formula_line_h = _line_height(draw, formula_font) + 8
    steps = _build_explanation_steps(text)
    main_step_count = sum(not step["conclusion"] for step in steps)
    for step in steps:
        label = "Kesimpulan" if step["conclusion"] else f"Langkah {step['number']}"
        show_label = step["conclusion"] or main_step_count > 1
        rows = []
        if show_label:
            rows.append({"kind": "step", "label": label, "number": step["number"], "height": 38})
        formula_lines = []

        def flush_formulas():
            if not formula_lines:
                return
            rows.append({
                "kind": "formula",
                "lines": list(formula_lines),
                "line_h": formula_line_h,
                "height": len(formula_lines) * formula_line_h + 24,
            })
            formula_lines.clear()

        for part in step["parts"]:
            if part["formula"]:
                formula_lines.extend(_wrap_text(draw, part["text"], formula_font, 680))
                continue
            flush_formulas()
            for line in _wrap_text(draw, part["text"], body_font, 748):
                rows.append({"kind": "text", "line": line, "height": body_line_h})
        flush_formulas()
        rows.append({"kind": "gap", "height": 16})
        groups.append(rows)
    return groups


def _paginate_structured_explanation(draw, question, fonts):
    explanation = str(question.get("pembahasan") or "").strip()
    if not explanation:
        return []
    groups = _structured_explanation_groups(draw, explanation, fonts)
    pages = []
    current = []
    used = 0

    def page_capacity():
        # Reserve an extra 10 px below the first-page section heading.
        return 380 if not pages else 618

    def finish_page():
        nonlocal current, used
        if current:
            while current and current[-1]["kind"] == "gap":
                current.pop()
            pages.append(current)
        current = []
        used = 0

    for group in groups:
        if current and group and group[0]["kind"] == "step":
            minimum_start_height = group[0]["height"]
            content_rows = 0
            for candidate in group[1:]:
                if candidate["kind"] == "gap":
                    break
                minimum_start_height += candidate["height"]
                if candidate["kind"] in {"text", "formula"}:
                    content_rows += 1
                if content_rows == 2:
                    break
            if used + minimum_start_height > page_capacity():
                finish_page()
        for row_index, row in enumerate(group):
            if current and used + row["height"] > page_capacity():
                finish_page()
            current.append(row)
            used += row["height"]
    finish_page()
    return pages


def _count_explanation_image_pages(question):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return 0

    width = height = 1000
    fonts = {
        "explanation": _load_font(27, family="anthropic_sans"),
        "formula": _load_font(26, family="anthropic_mono"),
    }
    probe = Image.new("RGB", (width, height), "#f5f0e8")
    return len(_paginate_structured_explanation(ImageDraw.Draw(probe), question, fonts))


def render_explanation_images(question, run_dir, page_offset=0, total_pages=None, start_index=1):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return []

    width = height = 1000
    colors = {
        "bg": "#f5f0e8",
        "panel": "#ede8df",
        "answer_panel": "#e7f3ee",
        "answer_badge": "#d6eadf",
        "answer_line": "#b8d8c8",
        "ink": "#1f1d1a",
        "muted": "#9c8f7e",
        "line": "#d4cdc2",
        "white": "#fffdf8",
        "step_accent": "#1f1d1a",
        "formula_panel": "#f7f0e5",
        "formula_ink": "#1f1d1a",
    }
    fonts = {
        "category": _load_font(23, bold=True, family="anthropic_sans"),
        "title": _load_font(34, bold=True, family="anthropic_sans"),
        "body": _load_font(29, family="anthropic_sans"),
        "body_bold": _load_font(29, bold=True, family="anthropic_sans"),
        "explanation": _load_font(27, family="anthropic_sans"),
        "formula": _load_font(26, family="anthropic_mono"),
        "step": _load_font(20, bold=True, family="anthropic_sans"),
        "explanation_title": _load_font(40, bold=True, family="anthropic_sans"),
        "small": _load_font(22, family="anthropic_sans"),
    }

    explanation = str(question.get("pembahasan") or "").strip()
    if not explanation:
        return []

    probe = Image.new("RGB", (width, height), colors["bg"])
    probe_draw = ImageDraw.Draw(probe)
    pages = _paginate_structured_explanation(probe_draw, question, fonts)
    display_total = total_pages or len(pages)

    logo = _load_quiz_logo()
    output_paths = []
    answer_key = str(question.get("jawaban") or "").strip().upper()
    choices = question.get("pilihan") or {}
    answer_text = choices.get(answer_key, "")
    main_step_count = sum(
        not step["conclusion"]
        for step in _build_explanation_steps(explanation)
    )

    for page_index, rows in enumerate(pages, start=1):
        image = Image.new("RGB", (width, height), colors["bg"])
        draw = ImageDraw.Draw(image)
        account = question.get("akun", "@utbk_neareducation")

        draw.rectangle((0, 0, width, height), fill=colors["bg"])
        if logo:
            image.paste(logo, (928 - logo.width, 68), logo)
        _draw_page_header(draw, question, fonts, colors)
        if page_index == 1:
            explanation_title = "Pembahasan"
            title_bbox = _text_bbox(draw, explanation_title, fonts["explanation_title"])
            title_w = title_bbox[2] - title_bbox[0]
            draw.text(
                (width / 2 - title_w / 2 - title_bbox[0], 172),
                explanation_title,
                font=fonts["explanation_title"],
                fill=colors["ink"],
            )

        panel_top = 230 if page_index == 1 else 180
        if page_index == 1:
            answer_box = (72, panel_top, 928, panel_top + 104)
            draw.rounded_rectangle(
                answer_box,
                radius=7,
                fill=colors["answer_panel"],
                outline=colors["answer_line"],
                width=2,
            )
            badge = (104, panel_top + 25, 164, panel_top + 79)
            draw.ellipse(
                badge,
                fill=colors["answer_badge"],
                outline=colors["answer_line"],
                width=2,
            )
            if answer_key:
                key_bbox = _text_bbox(draw, answer_key, fonts["body_bold"])
                key_w = key_bbox[2] - key_bbox[0]
                key_y = badge[1] + (54 - (key_bbox[3] - key_bbox[1])) // 2 - key_bbox[1]
                key_x = badge[0] + (60 - key_w) / 2 - key_bbox[0]
                draw.text((key_x, key_y), answer_key, font=fonts["body_bold"], fill=colors["ink"])

            answer_label = _answer_display_text(answer_key, answer_text)
            answer_lines = _wrap_text(draw, answer_label, fonts["body"], 690)
            answer_h = _lines_visual_height(draw, answer_lines[:2], fonts["body"], gap=8)
            answer_y = panel_top + (104 - answer_h) // 2
            for answer_line in answer_lines[:2]:
                line_bbox = _text_bbox(draw, answer_line, fonts["body"])
                _draw_text_with_math(draw, 190, answer_y - line_bbox[1], answer_line, fonts["body"], colors["ink"])
                answer_y += (line_bbox[3] - line_bbox[1]) + 8
            panel_top = 362

        content_h = sum(row["height"] for row in rows)
        first_page_gap_extra = 10 if page_index == 1 else 0
        panel_padding = 124 + first_page_gap_extra if page_index == 1 else 78
        panel_bottom = min(876, panel_top + content_h + panel_padding)
        draw.rounded_rectangle((72, panel_top, 928, panel_bottom), radius=7, fill=colors["white"], outline=colors["line"], width=2)
        if page_index == 1:
            section_y = panel_top + 32
            draw.ellipse((126, section_y + 5, 138, section_y + 17), fill=colors["step_accent"])
            section_label = "PEMBAHASAN INTI" if main_step_count <= 1 else "LANGKAH PENGERJAAN"
            draw.text((150, section_y), section_label, font=fonts["step"], fill=colors["step_accent"])
            text_y = panel_top + 78 + first_page_gap_extra
        else:
            text_y = panel_top + 32
        for row in rows:
            if row["kind"] == "step":
                draw.text((126, text_y + 4), row["label"], font=fonts["step"], fill=colors["ink"])
            elif row["kind"] == "text":
                _draw_justified_line(
                    draw,
                    126,
                    text_y,
                    row["line"],
                    fonts["explanation"],
                    colors["ink"],
                    748,
                    justify=False,
                )
            elif row["kind"] == "formula":
                formula_bottom = text_y + row["height"] - 4
                draw.rounded_rectangle(
                    (116, text_y, 884, formula_bottom),
                    radius=9,
                    fill=colors["formula_panel"],
                    outline=colors["line"],
                    width=1,
                )
                formula_y = text_y + 12
                for formula_line in row["lines"]:
                    _draw_text_with_math(
                        draw,
                        140,
                        formula_y,
                        formula_line,
                        fonts["formula"],
                        colors["formula_ink"],
                    )
                    formula_y += row["line_h"]
            text_y += row["height"]

        draw.text((72, 942), account, font=fonts["small"], fill="#9ca3af")
        if display_total > 1:
            page_text = f"{page_offset + page_index}/{display_total}"
            page_w = _text_width(draw, page_text, fonts["small"])
            draw.text((928 - page_w, 942), page_text, font=fonts["small"], fill=colors["muted"])

        output_path = run_dir / f"pembahasan-{start_index + page_index - 1}.jpg"
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
    normalized = re.sub(r"(?<![<>=!])\s*=\s*(?![=>])", " = ", str(text or ""))
    for paragraph in normalized.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        paragraph = re.sub(r"\s+", " ", paragraph).strip()
        if not paragraph:
            if lines:
                lines.append("")
            continue
        current = ""
        for unit in _wrap_units(paragraph):
            candidate = f"{current} {unit}".strip()
            if current and len(candidate) > width:
                lines.append(current)
                current = unit
            else:
                current = candidate
        lines.append(current)
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

    compacted = re.sub(
        r"\b([yf])\s*([=<>]=?|≤|≥)\s*([+-]?\s*\d*(?:/\d+)?(?:\.\d+)?)\s*x\s*([+-])?\s*(\d+(?:\.\d+)?)?",
        compact_line,
        str(text or ""),
        flags=re.I,
    )
    compacted = re.sub(
        r"(?<=[A-Za-z0-9)\]²³])\s*([+=<>≤≥≠*/])\s*(?=[A-Za-z0-9([])",
        r"\1",
        compacted,
    )
    compacted = re.sub(
        r"(?<=[A-Za-z0-9)\]²³])\s+(-)\s*(?=[A-Za-z0-9([])",
        r"\1",
        compacted,
    )
    return compacted


def _latex_lines(lines):
    return r"\\".join(_latex_format_inline(line) if line else r"\mbox{}" for line in lines)


def _node(x, y, width, lines, size=30, color="ink", align="left", weight="", family="sans"):
    font = rf"\fontsize{{{size}pt}}{{{int(size * 1.28)}pt}}\selectfont"
    font = (r"\ttfamily " if family == "mono" else r"\sffamily ") + font
    if weight == "bold":
        font = r"\bfseries " + font
    return (
        rf"\node[anchor=north west, text={color}, align={align}, text width={width}pt, "
        rf"font={{{font}}}] at ({x},{1080 - y}) {{{_latex_lines(lines)}}};"
    )


def _centered_node(x, y, width, height, lines, size=30, color="ink", weight=""):
    font = rf"\fontsize{{{size}pt}}{{{int(size * 1.28)}pt}}\selectfont"
    if weight == "bold":
        font = r"\bfseries " + font
    return (
        rf"\node[anchor=center, text={color}, align=center, inner sep=0pt, "
        rf"minimum width={width}pt, minimum height={height}pt, font={{{font}}}] "
        rf"at ({x + width / 2:.1f},{1080 - (y + height / 2):.1f}) "
        rf"{{{_latex_lines(lines)}}};"
    )


def _rect(x1, y1, x2, y2, fill="panel", draw="line", radius=7):
    return (
        rf"\draw[fill={fill}, draw={draw}, line width=2pt, rounded corners={radius}pt] "
        rf"({x1},{1080 - y1}) rectangle ({x2},{1080 - y2});"
    )


def _circle(center_x, center_y, radius, fill="softpanel", draw="line"):
    return (
        rf"\draw[fill={fill}, draw={draw}, line width=2pt] "
        rf"({center_x},{1080 - center_y}) circle ({radius}pt);"
    )


def _latex_quiz_logo(x=800, y=82, width=190):
    return (
        rf"\node[anchor=north west, inner sep=0pt] at ({x},{1080 - y}) "
        rf"{{\includegraphics[width={width}pt]{{near_education_logo.png}}}};"
    )


def _latex_document(body):
    return rf"""\documentclass{{article}}
\usepackage[papersize={{1080pt,1080pt}},margin=0pt]{{geometry}}
\usepackage[utf8]{{inputenc}}
\usepackage[T1]{{fontenc}}
\usepackage{{lmodern}}
\renewcommand{{\familydefault}}{{\sfdefault}}
\usepackage{{graphicx}}
\usepackage{{tikz}}
\usetikzlibrary{{arrows.meta}}
\pagestyle{{empty}}
\definecolor{{bg}}{{HTML}}{{F5F1E8}}
\definecolor{{panel}}{{HTML}}{{FFFDF8}}
\definecolor{{softpanel}}{{HTML}}{{F3EDE2}}
\definecolor{{answerpanel}}{{HTML}}{{E7F3EE}}
\definecolor{{answerbadge}}{{HTML}}{{D6EADF}}
\definecolor{{answerline}}{{HTML}}{{B8D8C8}}
\definecolor{{black}}{{HTML}}{{000000}}
\definecolor{{ink}}{{HTML}}{{342D25}}
\definecolor{{muted}}{{HTML}}{{786F64}}
\definecolor{{line}}{{HTML}}{{DCD3C3}}
\definecolor{{grid}}{{HTML}}{{E9E4DA}}
\definecolor{{accent}}{{HTML}}{{A88452}}
\definecolor{{accenttwo}}{{HTML}}{{745D3D}}
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
        _latex_quiz_logo(),
        r"\draw[line, line width=2pt] (78,810) -- (1002,810);",
        r"\draw[line, line width=2pt] (78,270) -- (1002,270);",
        _node(78, 408, 924, subtest, size=48, align="center", weight="bold"),
        _node(132, 542, 816, subtopic, size=30, color="muted", align="center"),
        _node(148, 1008, 500, [account], size=20, color="muted"),
    ])
    return _latex_document(body)


def _needs_cartesian_visual(question, include_explanation=False):
    mapel = slugify(question.get("mapel"))
    if mapel not in {"pengetahuan-kuantitatif", "penalaran-matematika"}:
        return False
    parse_text = _cartesian_parse_text(question, include_explanation=include_explanation)
    if _has_symbolic_cartesian_parameter(parse_text):
        return False
    text = " ".join([
        str(question.get("soal", "")),
        str(question.get("deskripsi_visual", "")),
        str(question.get("pembahasan", "")) if include_explanation else "",
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
    wants_visual = bool(question.get("butuh_visual")) or any(keyword in text for keyword in keywords)
    if not wants_visual:
        return False
    return bool(_parse_linear_equations(question, parse_text) or _parse_parabola(question, parse_text))


def _numeric_parameter_assignments(text):
    assignments = {}
    for match in re.finditer(r"\b([a-wz])\s*=\s*([+-]?\d+(?:\.\d+)?)\b", str(text or ""), re.I):
        assignments[match.group(1).lower()] = match.group(2).replace(" ", "")
    return assignments


def _format_coefficient(value):
    numeric = float(value)
    if numeric == 1:
        return ""
    if numeric == -1:
        return "-"
    if numeric.is_integer():
        return str(int(numeric))
    return str(numeric)


def _substitute_cartesian_parameters(text):
    source = str(text or "")
    assignments = _numeric_parameter_assignments(source)
    if not assignments:
        return source
    substituted = source
    for variable, value in assignments.items():
        substituted = re.sub(
            rf"(?<![A-Za-z]){re.escape(variable)}\s*x",
            f"{_format_coefficient(value)}x",
            substituted,
            flags=re.I,
        )
        substituted = re.sub(
            rf"(?<=[=<>+\-])\s*{re.escape(variable)}(?=\s*(?:[+\-.,;!?)]|$))",
            value,
            substituted,
            flags=re.I,
        )
    substituted = re.sub(r"\+\s*-", "-", substituted)
    substituted = re.sub(r"-\s*-", "+", substituted)
    substituted = re.sub(r"\+\s*\+", "+", substituted)
    substituted = re.sub(r"-\s*\+", "-", substituted)
    return substituted


def _cartesian_parse_text(question, include_explanation=False):
    parts = [
        str(question.get("soal", "")),
        str(question.get("deskripsi_visual", "")),
    ]
    if include_explanation:
        parts.append(str(question.get("pembahasan", "")))
    return _substitute_cartesian_parameters(" ".join(parts))


def _has_symbolic_cartesian_parameter(text):
    compact = re.sub(r"\s+", "", text.lower())
    equation_parts = re.findall(
        r"(?:f\(x\)|y)(?:=|!=|≠|<=|>=|≤|≥|<|>)[^.,;!?]*",
        compact,
        flags=re.I,
    )
    for part in equation_parts:
        part = part.replace("f(x)", "")
        if re.search(r"(?<![a-z])[a-wz]x", part):
            return True
        if re.search(r"x[+\-][a-wz](?![a-z])", part):
            return True
        if re.search(r"[+\-][a-wz](?![a-z])", part):
            return True
    return False


def _parse_linear_equations(question, text=None):
    if text is None:
        text = _cartesian_parse_text(question)
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


def _parse_parabola(question, text=None):
    if text is None:
        text = _cartesian_parse_text(question)
    if _has_symbolic_cartesian_parameter(text):
        return None
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


def _cartesian_visual_code(question, x=570, y=198, w=438, h=352, include_explanation=False):
    if not _needs_cartesian_visual(question, include_explanation=include_explanation):
        return ""

    parse_text = _cartesian_parse_text(question, include_explanation=include_explanation)
    lines = _parse_linear_equations(question, parse_text)
    parabola = _parse_parabola(question, parse_text)
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

    body.append(r"\end{scope}")
    return "\n".join(body)


def attach_cartesian_latex_visual(question):
    enriched = dict(question or {})
    mapel = slugify(enriched.get("mapel"))
    if mapel not in {"pengetahuan-kuantitatif", "penalaran-matematika"}:
        return enriched

    source_scope = "question"
    source = _cartesian_visual_code(enriched)
    if not source:
        source_scope = "explanation"
        source = _cartesian_visual_code(enriched, include_explanation=True)

    if source:
        enriched["visual_latex"] = {
            "type": "cartesian_2d",
            "format": "tikz",
            "source_scope": source_scope,
            "generated": True,
            "source": source,
        }
        return enriched

    reason = "not_cartesian_or_unparseable"
    parse_text = _cartesian_parse_text(enriched, include_explanation=True)
    if _has_symbolic_cartesian_parameter(parse_text):
        reason = "symbolic_parameter"
    enriched["visual_latex"] = {
        "type": "cartesian_2d",
        "format": "tikz",
        "source_scope": None,
        "generated": False,
        "source": "",
        "reason": reason,
    }
    return enriched


def _latex_quiz_sources(question):
    display_text = _display_question_text(question)
    question_text = _compact_math_for_line_wrap(_format_question_text(display_text))
    q_lines = _wrap_plain_lines(question_text, 76)
    formula_parts = _question_formula_parts(display_text)
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
    elif formula_parts and len(q_lines) <= 8:
        pages.append({"question": q_lines, "choices": list(choice_lines.items()), "visual": False, "formula": True})
    elif len(q_lines) <= 8:
        pages.append({"question": q_lines, "choices": list(choice_lines.items()), "visual": False})
    else:
        for chunk in _chunk_lines(q_lines, 13):
            pages.append({"question": chunk, "choices": [], "visual": False})
        pages.append({"question": [], "choices": list(choice_lines.items()), "visual": False})

    sources = []
    for page_number, page in enumerate(pages, start=1):
        body_parts = [
            _latex_quiz_logo(),
            _node(72, 78, 760, [str(question.get("mapel", "Kuis"))[:42]], size=36, weight="bold"),
            _node(72, 132, 760, [str(question.get("topik") or question.get("mapel", "Pengetahuan Umum")).upper()[:54]], size=25, color="muted"),
        ]
        if page.get("visual_inline"):
            top_lines = page.get("question_top") or []
            bottom_lines = page.get("question_bottom") or []
            body_parts.append(_rect(72, 190, 1008, 914, fill="panel"))
            if top_lines:
                body_parts.append(_node(112, 228, 860, top_lines, size=25))
            visual_y = 328 if len(top_lines) <= 2 else 356
            body_parts.append(_cartesian_visual_code(question, x=150, y=visual_y, w=780, h=500))
            bottom_y = visual_y + 540
            if bottom_lines:
                body_parts.append(_node(112, bottom_y, 860, bottom_lines, size=25))
            choice_top = 930
        elif page["question"]:
            if page.get("formula") and formula_parts:
                intro_lines = _wrap_plain_lines(formula_parts["intro"], 62, 2)
                formula_text = "   |   ".join(formula_parts["formulas"])
                formula_lines = _wrap_plain_lines(formula_text, 64, 2)
                intro_line_h = 36
                formula_line_h = 31
                formula_top = 230 + len(intro_lines) * intro_line_h + 8
                formula_h = max(72, len(formula_lines) * formula_line_h + 24)
                formula_bottom = formula_top + formula_h
                formula_y = formula_top + max(12, (formula_h - len(formula_lines) * formula_line_h) / 2)
                conclusion_lines = _wrap_plain_lines(formula_parts["conclusion"], 66, 2)
                conclusion_y = formula_bottom + 14
                q_height = max(
                    220,
                    conclusion_y + len(conclusion_lines) * intro_line_h + 18 - 190,
                )
                body_parts.append(_rect(72, 190, 1008, 190 + q_height, fill="panel"))
                body_parts.append(_node(112, 230, 856, intro_lines, size=28))
                body_parts.append(_rect(104, formula_top, 976, formula_bottom, fill="softpanel", radius=10))
                body_parts.append(_node(130, formula_y, 820, formula_lines, size=24, align="left", family="mono"))
                body_parts.append(_node(112, conclusion_y, 856, conclusion_lines, size=28))
                choice_top = 190 + q_height + 12
            else:
                q_height = max(118, 54 + len(page["question"]) * 42)
                if page.get("visual"):
                    q_height = max(260, q_height)
                    body_parts.append(_rect(72, 190, 548, 190 + q_height, fill="panel"))
                    body_parts.append(_node(112, 230, 396, page["question"], size=27))
                    visual = _cartesian_visual_code(question)
                    if visual:
                        body_parts.append(visual)
                else:
                    body_parts.append(_rect(72, 190, 1008, 190 + q_height, fill="panel"))
                    body_parts.append(_node(126, 230, 828, page["question"], size=29))
                choice_top = 220 + q_height
        else:
            choice_top = 210
        y = choice_top + 16
        for key, lines in page["choices"]:
            height = max(74, 30 + len(lines) * 34)
            badge_y = y + height / 2
            body_parts.append(_rect(72, y, 1008, y + height, fill="panel"))
            body_parts.append(_circle(134, badge_y, 27, fill="softpanel"))
            body_parts.append(_centered_node(107, badge_y - 27, 54, 54, [key], size=27, color="ink", weight="bold"))
            body_parts.append(_node(190, y + 24, 748, lines, size=29))
            y += height + 10
        account = str(question.get("akun", "@utbk_neareducation") or "@utbk_neareducation")
        body_parts.append(_node(72, 1010, 450, [account], size=22, color="muted"))
        if page_number == len(pages) and str(question.get("pembahasan") or "").strip():
            discussion_x = 650 if len(pages) > 1 else 700
            discussion_width = 250 if len(pages) > 1 else 308
            body_parts.append(
                _node(
                    discussion_x,
                    1010,
                    discussion_width,
                    ["Pembahasan  →"],
                    size=22,
                    color="black",
                    align="right",
                    weight="bold",
                )
            )
        if len(pages) > 1:
            body_parts.append(_node(930, 1010, 80, [f"{page_number}/{len(pages)}"], size=22, color="muted", align="right"))
        sources.append(_latex_document("\n".join(body_parts)))
    return sources


def _latex_explanation_sources(question):
    explanation = str(question.get("pembahasan") or "").strip()
    if not explanation:
        return []
    has_visual = _needs_cartesian_visual(question, include_explanation=True)
    sentence_per_line = slugify(question.get("mapel")) == "pengetahuan-kuantitatif"
    lines = _wrap_plain_lines(
        _format_explanation_text(explanation, sentence_per_line=sentence_per_line),
        44 if has_visual else 74,
    )
    chunks = _chunk_lines(lines, 12 if has_visual else 13)
    answer_key = str(question.get("jawaban") or "").strip().upper()
    answer_text = (question.get("pilihan") or {}).get(answer_key, "")
    sources = []
    for page_number, chunk in enumerate(chunks, start=1):
        body_parts = [
            _latex_quiz_logo(),
            _node(72, 78, 760, [str(question.get("mapel", "Kuis"))[:42]], size=36, weight="bold"),
            _node(
                72,
                132,
                760,
                [str(question.get("topik") or question.get("mapel", "Pengetahuan Umum")).upper()[:54]],
                size=25,
                color="muted",
            ),
        ]
        if page_number == 1:
            body_parts.append(
                _centered_node(350, 164, 380, 54, ["Pembahasan"], size=40, color="ink", weight="bold")
            )
        panel_top = 230 if page_number == 1 else 180
        if page_number == 1:
            body_parts.append(
                _rect(72, panel_top, 1008, panel_top + 104, fill="answerpanel", draw="answerline")
            )
            body_parts.append(
                _circle(134, panel_top + 52, 27, fill="answerbadge", draw="answerline")
            )
            body_parts.append(_centered_node(107, panel_top + 25, 54, 54, [answer_key], size=27, color="ink", weight="bold"))
            answer = _answer_display_text(answer_key, answer_text)
            body_parts.append(_node(190, panel_top + 34, 748, _wrap_plain_lines(answer, 58, 2), size=28))
            panel_top = 362
        panel_bottom = min(914, panel_top + 84 + len(chunk) * 38)
        if has_visual and page_number == 1:
            body_parts.append(_rect(72, panel_top, 532, 914, fill="panel"))
            body_parts.append(_node(116, panel_top + 40, 344, chunk, size=24))
            body_parts.append(
                _cartesian_visual_code(
                    question,
                    x=560,
                    y=panel_top,
                    w=448,
                    h=914 - panel_top,
                    include_explanation=True,
                )
            )
        else:
            body_parts.append(_rect(72, panel_top, 1008, panel_bottom, fill="panel"))
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


def _prepare_latex_assets(run_dir):
    logo_path = run_dir / "near_education_logo.png"
    if logo_path.exists():
        return
    logo = _load_quiz_logo(target_width=260)
    if logo:
        logo.save(logo_path, format="PNG")


def _render_latex_source(source, run_dir, stem):
    latex_path = run_dir / f"{stem}.tex"
    pdf_path = run_dir / f"{stem}.pdf"
    jpg_path = run_dir / f"{stem}.jpg"
    _prepare_latex_assets(run_dir)
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


def render_passage_bundle_content_images(question_group, run_dir):
    base_question = copy.deepcopy(question_group[0])
    question_count = len(question_group)
    thumbnail_question = copy.deepcopy(base_question)
    thumbnail_question["topik"] = str(base_question.get("topik") or base_question.get("mapel", "Bacaan")).strip()
    numbered_pages = _count_passage_intro_pages(base_question)
    cloned_questions = []
    for index, grouped_question in enumerate(question_group, start=1):
        cloned = _clone_group_render_question(grouped_question, index, question_count)
        cloned_questions.append(cloned)
        numbered_pages += _count_quiz_image_pages(cloned) + _count_explanation_image_pages(cloned)

    thumbnail_path = render_thumbnail_image(thumbnail_question, run_dir)
    rendered = [thumbnail_path] if thumbnail_path else []
    page_offset = 0
    quiz_index = 1
    explanation_index = 1

    intro_paths = render_passage_intro_images(
        base_question,
        question_count,
        run_dir,
        page_offset=page_offset,
        total_pages=numbered_pages,
        start_index=quiz_index,
    )
    rendered.extend(intro_paths)
    page_offset += len(intro_paths)
    quiz_index += len(intro_paths)

    for grouped_question in cloned_questions:
        quiz_paths = render_quiz_images(
            grouped_question,
            run_dir,
            page_offset=page_offset,
            total_pages=numbered_pages,
            start_index=quiz_index,
        )
        rendered.extend(quiz_paths)
        page_offset += len(quiz_paths)
        quiz_index += len(quiz_paths)

    for grouped_question in cloned_questions:
        explanation_paths = render_explanation_images(
            grouped_question,
            run_dir,
            page_offset=page_offset,
            total_pages=numbered_pages,
            start_index=explanation_index,
        )
        rendered.extend(explanation_paths)
        page_offset += len(explanation_paths)
        explanation_index += len(explanation_paths)

    return rendered


def render_content_images(question, run_dir, metadata_path=None, metadata=None):
    question_group = _resolve_render_questions(question, metadata_path=metadata_path, metadata=metadata)
    if _is_passage_bundle(question_group):
        return render_passage_bundle_content_images(question_group, run_dir), "pil_grouped"

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


def _ai_json(prompt, label, retries=MAX_GEMINI_RETRIES, schema=None, provider="gemini"):
    last_error = None
    provider_label = provider.capitalize()
    strict_prompt = (
        f"{prompt}\n\n"
        "PENTING: Balas hanya dengan satu objek JSON valid. "
        "Karakter pertama jawaban harus { dan karakter terakhir harus }. "
        "Jangan gunakan markdown, pagar kode, komentar, trailing comma, atau teks tambahan. "
        "Semua key dan string wajib memakai kutip ganda. "
        "Jika perlu baris baru di dalam string, tulis sebagai escape \\n, bukan enter mentah."
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
                "Awali langsung dengan { dan akhiri langsung dengan }. "
                "Jangan ada teks pembuka, markdown, trailing comma, atau newline mentah di dalam string. "
                "Gunakan escape \\n untuk pemisah baris di field teks."
            )
    raise ValueError(f"Gagal parse JSON {provider_label} untuk {label} setelah {retries} percobaan: {clean_error_message(last_error)}")


def _gemini_json(prompt, label, retries=MAX_GEMINI_RETRIES, schema=None):
    return _ai_json(prompt, label, retries=retries, schema=schema, provider="gemini")


def _ai_generate(prompt, schema=None, provider="gemini"):
    if provider == "kimi":
        return _kimi_generate(prompt)
    return _gemini_generate(prompt, schema=schema)


def _passage_question_number(question):
    passage = question.get("bacaan") if isinstance(question.get("bacaan"), dict) else {}
    try:
        return int(passage.get("nomor_soal") or 0)
    except (TypeError, ValueError):
        return 0


def _review_question_payload(question):
    payload = copy.deepcopy(question)
    payload.pop("visual_latex", None)
    payload.pop("question_group", None)
    return payload


def _build_explanation_review_input(question, question_group):
    if not _is_passage_bundle(question_group):
        return _review_question_payload(question)
    return {
        "current_question": _review_question_payload(question),
        "bacaan": copy.deepcopy((question_group[0].get("bacaan") or {})),
        "question_group": [_review_question_payload(item) for item in question_group],
    }


def _merge_review_question(original, revision):
    revision = revision if isinstance(revision, dict) else {}
    return normalize_question({
        **original,
        **revision,
        "pilihan": {
            **(original.get("pilihan") or {}),
            **(revision.get("pilihan") or {}),
        },
    })


def _normalize_review_question_group(question_group, review):
    raw_group = review.get("question_group_revisi")
    if not _is_passage_bundle(question_group) or not isinstance(raw_group, list):
        return None

    by_number = {}
    for item in raw_group:
        if not isinstance(item, dict):
            continue
        number = _passage_question_number(item)
        if number:
            by_number[number] = item

    normalized = []
    for index, original in enumerate(question_group):
        number = _passage_question_number(original)
        revision = by_number.get(number)
        if revision is None and index < len(raw_group) and isinstance(raw_group[index], dict):
            revision = raw_group[index]
        normalized.append(_merge_review_question(original, revision or {}))
    return normalized


def _fallback_explanation_review(question, provider, exc):
    revised_question = normalize_question(dict(question))
    explanation = str(revised_question.get("pembahasan") or "").strip()
    validation = local_validation(revised_question, draft_caption(revised_question))
    issue_text = clean_error_message(exc)
    return {
        "lolos": bool(validation.get("lolos_validasi")),
        "skor": int(validation.get("skor") or 0),
        "akurasi": "Belum direview AI karena respons provider tidak bisa diparse.",
        "bahasa_formal": "Perlu cek manual.",
        "catatan": [
            "Fallback lokal dipakai; cek akurasi pembahasan secara manual sebelum approve.",
            issue_text,
        ],
        "saran_revisi": [
            "Periksa kembali jawaban, langkah pembahasan, dan konsistensi pilihan jawaban.",
        ],
        "pembahasan_revisi": explanation,
        "question_revisi": revised_question,
        "fallback_used": True,
        "fallback_reason": issue_text,
        "provider": provider,
        "usage": list(GEMINI_USAGE),
    }


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

    if topic in {"Statistika", "Statistika dan Peluang", "Statistika Dan Peluang", "Data dan ketidakpastian", "Data dan Ketidakpastian", "Data Dan Ketidakpastian"}:
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

    if topic in {"Geometri", "Geometri dan Pengukuran", "Geometri Dan Pengukuran"}:
        length = rng.randint(8, 18)
        width = rng.randint(4, length - 1)
        area = length * width
        choices, answer = make_choices(area, [-2 * width, -width, 0, width, 2 * width])
        return {
            "mapel": mapel,
            "kelompok_tes": kelompok_tes,
            "topik": topic,
            "level": level,
            "tipe": "rectangle_area_context",
            "params": {"length": length, "width": width, "area": area},
            "soal": (
                f"Sebuah poster berbentuk persegi panjang memiliki panjang {length} cm dan lebar {width} cm. "
                "Luas poster tersebut adalah..."
            ),
            "pilihan": choices,
            "jawaban": answer,
            "pembahasan": (
                "Luas persegi panjang dihitung dengan rumus panjang x lebar. "
                f"Maka luas poster adalah {length} x {width} = {area} cm^2."
            ),
            "konsep_kunci": "Luas persegi panjang",
            "tips_pengerjaan": "Pastikan ukuran yang dikalikan adalah panjang dan lebar dengan satuan yang sama.",
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
    topic_examples = []

    if mode != "draft":
        topic_examples = require_topic_examples(mapel, topic)

    if use_ai:
        source = provider
        try:
            question = _ai_json(
                build_question_prompt(mapel, topic, level, topic_examples=topic_examples),
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
    question = attach_cartesian_latex_visual(question)
    run_id = _unique_run_id(run_id, question)
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
    question = attach_cartesian_latex_visual(question)
    metadata["question"] = question
    question_group = _resolve_render_questions(question, metadata_path=metadata_path, metadata=metadata)
    all_image_paths, render_engine = render_content_images(
        question,
        run_dir,
        metadata_path=metadata_path,
        metadata={"question_group": question_group},
    )
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
    metadata["render_group"] = {
        "kind": "passage_bundle",
        "question_count": len(question_group),
        "passage_id": ((question_group[0].get("bacaan") or {}).get("id") if question_group else None),
    } if _is_passage_bundle(question_group) else None
    metadata["image_generated_at"] = dt.datetime.now().isoformat(timespec="seconds")
    (run_dir / "soal.json").write_text(json.dumps(question, ensure_ascii=False, indent=2), encoding="utf-8")
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "run_id": metadata.get("run_id") or run_dir.name,
        "files": metadata["files"],
        "render_group": metadata["render_group"],
    }


def review_explanation_for_metadata(metadata_path, provider="gemini"):
    metadata_path = Path(metadata_path).resolve()
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    question = metadata.get("question") or {}
    if not question:
        raise ValueError("Metadata tidak memiliki question.")
    if not question.get("pembahasan"):
        raise ValueError("Pembahasan tidak tersedia untuk dicek.")
    provider = provider if provider in {"gemini", "kimi"} else "gemini"
    GEMINI_USAGE.clear()
    question_group = _resolve_render_questions(question, metadata_path=metadata_path, metadata=metadata)
    review_input = _build_explanation_review_input(question, question_group)
    try:
        review = _ai_json(
            build_explanation_review_prompt(review_input),
            "review pembahasan",
            retries=2,
            schema=EXPLANATION_REVIEW_SCHEMA,
            provider=provider,
        )
    except Exception as exc:
        review = _fallback_explanation_review(question, provider, exc)
        if _is_passage_bundle(question_group):
            review["question_group_revisi"] = [normalize_question(copy.deepcopy(item)) for item in question_group]
    revised_group = _normalize_review_question_group(question_group, review)
    if revised_group:
        review["question_group_revisi"] = revised_group
        current_number = _passage_question_number(question)
        revised_question = next(
            (item for item in revised_group if _passage_question_number(item) == current_number),
            revised_group[0],
        )
    else:
        revised_question = _merge_review_question(question, review.get("question_revisi") or {})
    review["question_revisi"] = revised_question
    review["pembahasan_revisi"] = str(
        revised_question.get("pembahasan") or review.get("pembahasan_revisi") or ""
    ).strip()
    review["checked_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    review["provider"] = provider
    review["usage"] = list(GEMINI_USAGE)
    return {
        "ok": True,
        "run_id": metadata.get("run_id") or metadata_path.parent.name,
        "explanation_review": review,
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
    parser.add_argument("--review-explanation", default="")
    try:
        args = parser.parse_args()
        if args.render_images:
            json_stdout(render_images_for_metadata(args.render_images))
            return
        if args.review_explanation:
            json_stdout(review_explanation_for_metadata(args.review_explanation, args.provider))
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
        payload = {
            "ok": False,
            "error": error,
            "detail": detail,
            "fallback_used": False,
            "fallback_reason": None,
        }
        if isinstance(exc, InsufficientTopicExamplesError):
            payload.update({
                "warning": detail,
                "required_examples": exc.required,
                "found_examples": exc.found,
            })
        json_stdout(payload)
        print(f"[ERROR] {error}: {detail}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
