import argparse
import datetime as dt
import html
import json
import os
import re
import textwrap
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "outputs"
DEFAULT_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")


MAPEL_TOPICS = {
    "Matematika": ["Statistika", "Trigonometri", "Limit", "Peluang", "Fungsi"],
    "Fisika": ["Kinematika", "Dinamika", "Gelombang", "Listrik", "Usaha dan Energi"],
    "Kimia": ["Stoikiometri", "Asam Basa", "Termokimia", "Elektrokimia", "Ikatan Kimia"],
    "Biologi": ["Sel", "Genetika", "Metabolisme", "Ekologi", "Sistem Organ"],
    "TPS": ["Penalaran Umum", "Penalaran Kuantitatif", "Penalaran Analitis"],
    "Bahasa Indonesia": ["Pemahaman Bacaan", "Ejaan", "Tata Bahasa", "Paragraf"],
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


def _gemini_generate(prompt):
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
            "maxOutputTokens": 2048,
            "responseMimeType": "application/json",
        },
    }
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

    try:
        return raw["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as exc:
        raise RuntimeError("Format response Gemini tidak dikenali.") from exc


def build_question_prompt(mapel, topic, level):
    base_rules = """
Kamu adalah generator soal latihan UTBK untuk platform Instagram edukatif.
Buat soal orisinal, tidak menyalin soal UTBK yang sudah ada.
Gunakan bahasa Indonesia baku. Setiap soal punya tepat 5 pilihan A sampai E,
hanya 1 jawaban benar, dan pembahasan jelas untuk pelajar SMA.
Output harus JSON valid tanpa markdown.
""".strip()

    schema = {
        "mapel": mapel,
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
        f"Buatkan 1 soal latihan UTBK mata pelajaran {mapel}.\n"
        f"Topik: {topic}\n"
        f"Tingkat kesulitan: {level}\n\n"
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
        "Buat caption 100 sampai 150 kata, ada hook, CTA jawab di komentar, "
        "motivasi singkat, dan hashtag relevan. Output JSON valid.\n\n"
        f"{json.dumps(question, ensure_ascii=False)}\n\n"
        'Kembalikan JSON: {"caption": "", "hashtag": []}'
    )


def draft_question(mapel, topic, level):
    return {
        "mapel": mapel,
        "topik": topic,
        "level": level,
        "soal": (
            f"Sebuah latihan {mapel} topik {topic} disiapkan untuk level {level}. "
            "Jika nilai akhir ditentukan dari pola yang diberikan, pilihan mana yang paling tepat?"
        ),
        "pilihan": {
            "A": "Pilihan sementara A",
            "B": "Pilihan sementara B",
            "C": "Pilihan sementara C",
            "D": "Pilihan sementara D",
            "E": "Pilihan sementara E",
        },
        "jawaban": "C",
        "pembahasan": (
            "Ini adalah draft lokal karena GEMINI_API_KEY belum tersedia atau mode draft dipilih. "
            "Gunakan hasil ini untuk mengecek layout, alur review, dan output file."
        ),
        "konsep_kunci": topic,
        "tips_pengerjaan": "Identifikasi informasi penting, eliminasi opsi yang tidak konsisten, lalu cek jawaban.",
        "butuh_visual": False,
        "deskripsi_visual": "",
    }


def local_validation(question):
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
    return {
        "lolos_validasi": score >= 80,
        "skor": max(score, 0),
        "catatan": {
            "struktur": "Lengkap" if not missing else f"Field kosong: {', '.join(missing)}",
            "pilihan": "A sampai E tersedia" if valid_choices else "Pilihan harus tepat A sampai E",
            "jawaban": "Jawaban ada di pilihan" if answer_ok else "Jawaban tidak cocok dengan pilihan",
        },
        "saran_perbaikan": "" if score >= 80 else "Perbaiki struktur soal sebelum diposting.",
    }


def draft_caption(question):
    caption = (
        f"Latihan {question['mapel']} hari ini: {question['topik']}.\n\n"
        "Coba kerjakan dulu sebelum melihat pembahasan. Fokus pada informasi kunci, "
        "lalu eliminasi pilihan yang tidak sesuai.\n\n"
        "Jawab di kolom komentar! Belajar sedikit setiap hari tetap lebih kuat daripada menunggu sempurna."
    )
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


def wrap_lines(text, width):
    lines = []
    for paragraph in str(text).splitlines() or [""]:
        if not paragraph.strip():
            lines.append("")
            continue
        lines.extend(textwrap.wrap(paragraph, width=width, break_long_words=False))
    return lines


def svg_text_block(lines, x, y, size=28, weight=500, color="oklch(0.22 0.02 255)", line_height=1.35):
    output = []
    cursor = y
    for line in lines:
        safe = html.escape(line)
        output.append(
            f'<text x="{x}" y="{cursor}" font-size="{size}" font-weight="{weight}" '
            f'fill="{color}">{safe}</text>'
        )
        cursor += int(size * line_height)
    return "\n".join(output), cursor


def render_svg(question, output_path, variant):
    title = "Latihan UTBK" if variant == "soal" else "Pembahasan"
    accent = "#2767d8"
    ink = "#252a33"
    muted = "#69707d"
    bg = "#f8f9fb"
    panel = "#eceff4"

    blocks = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">',
        f'<rect width="1080" height="1080" fill="{bg}"/>',
        f'<rect x="62" y="64" width="956" height="952" rx="8" fill="{panel}" stroke="#d1d7e2"/>',
        f'<text x="88" y="126" font-size="34" font-weight="700" fill="{ink}">{title}</text>',
        f'<text x="88" y="170" font-size="22" font-weight="600" fill="{accent}">{html.escape(question["mapel"])} / {html.escape(question["topik"])} / {html.escape(question["level"])}</text>',
    ]

    if variant == "soal":
        text, y = svg_text_block(wrap_lines(question["soal"], 42), 88, 244, 31, 650, ink)
        blocks.append(text)
        y += 34
        for key, value in question["pilihan"].items():
            blocks.append(f'<circle cx="106" cy="{y - 9}" r="17" fill="{accent}"/>')
            blocks.append(f'<text x="100" y="{y}" font-size="19" font-weight="800" fill="{bg}">{key}</text>')
            lines = wrap_lines(value, 48)
            text, y = svg_text_block(lines, 142, y, 25, 500, ink)
            blocks.append(text)
            y += 20
    else:
        answer = f"Jawaban: {question.get('jawaban', '')}"
        blocks.append(f'<text x="88" y="246" font-size="30" font-weight="750" fill="{accent}">{html.escape(answer)}</text>')
        text, y = svg_text_block(wrap_lines(question["pembahasan"], 48), 88, 312, 27, 500, ink)
        blocks.append(text)
        y += 28
        tip = question.get("tips_pengerjaan") or question.get("konsep_kunci") or ""
        if tip:
            blocks.append(f'<text x="88" y="{y}" font-size="24" font-weight="700" fill="{muted}">Tips</text>')
            text, _ = svg_text_block(wrap_lines(tip, 52), 88, y + 42, 23, 500, muted)
            blocks.append(text)

    blocks.extend(
        [
            f'<text x="88" y="958" font-size="20" font-weight="600" fill="{muted}">Manual review sebelum upload</text>',
            f'<text x="844" y="958" font-size="20" font-weight="700" fill="{muted}">@namaakun</text>',
            "</svg>",
        ]
    )
    output_path.write_text("\n".join(blocks), encoding="utf-8")


def generate_content(mapel, topic, level, mode="auto", account="@namaakun"):
    run_id = _now_id()
    run_dir = OUTPUT_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    use_gemini = mode != "draft" and bool(os.getenv("GEMINI_API_KEY"))
    source = "draft"

    if use_gemini:
        question = _extract_json(_gemini_generate(build_question_prompt(mapel, topic, level)))
        validation = _extract_json(_gemini_generate(build_validation_prompt(question)))
        caption = _extract_json(_gemini_generate(build_caption_prompt(question)))
        source = "gemini"
    else:
        question = draft_question(mapel, topic, level)
        validation = local_validation(question)
        caption = draft_caption(question)

    question["akun"] = account
    render_svg(question, run_dir / "post-soal.svg", "soal")
    render_svg(question, run_dir / "post-pembahasan.svg", "pembahasan")

    metadata = {
        "run_id": run_id,
        "source": source,
        "model": DEFAULT_MODEL if source == "gemini" else None,
        "created_at": dt.datetime.now().isoformat(timespec="seconds"),
        "question": question,
        "validation": validation,
        "caption": caption,
        "files": {
            "question": str(run_dir / "soal.json"),
            "caption": str(run_dir / "caption.txt"),
            "post_soal": str(run_dir / "post-soal.svg"),
            "post_pembahasan": str(run_dir / "post-pembahasan.svg"),
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapel", default="Matematika", choices=sorted(MAPEL_TOPICS.keys()))
    parser.add_argument("--topik", default="")
    parser.add_argument("--level", default="sedang", choices=["mudah", "sedang", "sulit"])
    parser.add_argument("--mode", default="auto", choices=["auto", "gemini", "draft"])
    parser.add_argument("--account", default="@namaakun")
    args = parser.parse_args()

    topic = args.topik or MAPEL_TOPICS[args.mapel][0]
    mode = "auto" if args.mode == "gemini" else args.mode
    metadata = generate_content(args.mapel, topic, args.level, mode, args.account)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
