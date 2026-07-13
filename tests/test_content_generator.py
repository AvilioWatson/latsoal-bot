import importlib
import json
import os
import tempfile
import unittest
from dataclasses import replace
from unittest import mock
from pathlib import Path


def load_generator(data_root):
    os.environ["LATSOAL_DATA_ROOT"] = str(data_root)
    os.environ["LATSOAL_RENDER_ENGINE"] = "pil"
    os.environ.pop("GEMINI_API_KEY", None)
    os.environ.pop("KIMI_API_KEY", None)
    os.environ.pop("NVIDIA_API_KEY", None)
    import content_generator
    return importlib.reload(content_generator)


def passage_question(number, total=3, passage_id="PM-001"):
    return {
        "mapel": "Penalaran Matematika",
        "kelompok_tes": "Tes Literasi",
        "topik": "Aljabar Dan Fungsi",
        "level": "sedang",
        "soal": f"Berdasarkan bacaan, pernyataan nomor {number} yang paling tepat adalah?",
        "pilihan": {
            "A": f"Pernyataan benar {number}.",
            "B": f"Pernyataan keliru {number}.",
            "C": f"Pernyataan tidak relevan {number}.",
            "D": f"Pernyataan terlalu luas {number}.",
            "E": f"Pernyataan bertentangan {number}.",
        },
        "jawaban": "A",
        "pembahasan": f"Pembahasan soal {number} mengacu pada bagian relevan di bacaan.",
        "konsep_kunci": "Informasi eksplisit",
        "tips_pengerjaan": "Baca bacaan sekali, lalu cocokkan dengan detail tiap opsi.",
        "butuh_visual": False,
        "deskripsi_visual": "",
        "bacaan": {
            "id": passage_id,
            "judul": "Model Pertumbuhan",
            "teks": (
                "Sebuah UMKM mencatat pertumbuhan produksi secara linear selama beberapa bulan "
                "dan membandingkannya dengan biaya tetap untuk menentukan titik impas usaha."
            ),
            "bahasa": "id",
            "nomor_soal": number,
            "total_soal": total,
            "sumber_pdf": {"nama_file": "", "halaman": ""},
        },
    }


class ContentGeneratorTest(unittest.TestCase):
    def test_extract_json_accepts_wrapped_or_loose_gemini_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            wrapped = 'Berikut JSON-nya:\n```json\n{"caption":"A","hashtag":["#UTBK"]}\n```'
            self.assertEqual(generator._extract_json(wrapped)["caption"], "A")

            loose_newline = '{"pembahasan":"Langkah 1: Hitung nilai.\nLangkah 2: Simpulkan.","jawaban":"A"}'
            parsed = generator._extract_json(loose_newline)
            self.assertIn("Langkah 2", parsed["pembahasan"])

            raw_latex_escape = r'{"pembahasan":"Langkah 1: Gunakan \frac{1}{2} sebagai rasio.","jawaban":"A"}'
            parsed_latex = generator._extract_json(raw_latex_escape)
            self.assertIn(r"\frac", parsed_latex["pembahasan"])

    def test_explanation_pagination_fills_page_without_orphaning_step_heading(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            groups = [
                [
                    {"kind": "step", "label": "Langkah 1", "number": 1, "height": 38},
                    {"kind": "text", "line": "Isi panjang", "height": 166},
                    {"kind": "gap", "height": 16},
                ],
                [
                    {"kind": "step", "label": "Langkah 2", "number": 2, "height": 38},
                    {"kind": "text", "line": "Baris pertama", "height": 50},
                    {"kind": "text", "line": "Baris kedua", "height": 50},
                    {"kind": "text", "line": "Baris ketiga", "height": 50},
                    {"kind": "gap", "height": 16},
                ],
            ]

            with mock.patch.object(generator, "_structured_explanation_groups", return_value=groups):
                pages = generator._paginate_structured_explanation(None, {"pembahasan": "isi"}, {})

            self.assertEqual([row["line"] for row in pages[0] if row["kind"] == "text"][-2:], [
                "Baris pertama",
                "Baris kedua",
            ])
            self.assertEqual(pages[1][0]["kind"], "text")
            self.assertEqual(pages[1][0]["line"], "Baris ketiga")

    def test_local_validation_accepts_complete_question_and_caption(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = generator.draft_question("Penalaran Umum", "Penalaran deduktif", "mudah")
            caption = generator.draft_caption(question)

            result = generator.local_validation(question, caption)

            self.assertTrue(result["lolos_validasi"])
            self.assertGreaterEqual(result["skor"], 80)
            self.assertEqual(result["issues"], [])

    def test_local_validation_rejects_duplicate_choices_and_bad_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = generator.draft_question("Penalaran Umum", "Penalaran deduktif", "mudah")
            question["pilihan"]["E"] = question["pilihan"]["D"]
            question["jawaban"] = "Z"

            result = generator.local_validation(question, generator.draft_caption(question))

            self.assertFalse(result["lolos_validasi"])
            self.assertIn("Jawaban tidak cocok dengan pilihan.", result["issues"])
            self.assertIn("Ada opsi duplikat.", result["issues"])

    def test_review_explanation_falls_back_when_ai_json_is_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            question = generator.draft_question("Penalaran Umum", "Penalaran deduktif", "mudah")
            run_dir = data_root / "saved" / "20990101-010101"
            run_dir.mkdir(parents=True)
            metadata_path = run_dir / "metadata.json"
            metadata_path.write_text(
                json.dumps({"run_id": "20990101-010101", "question": question}, ensure_ascii=False),
                encoding="utf-8",
            )

            with mock.patch.object(generator, "_ai_json", side_effect=ValueError("Gemini mengembalikan JSON yang tidak valid.")):
                result = generator.review_explanation_for_metadata(metadata_path)

            review = result["explanation_review"]
            self.assertTrue(result["ok"])
            self.assertTrue(review["fallback_used"])
            self.assertEqual(review["question_revisi"]["soal"], question["soal"])
            self.assertEqual(review["pembahasan_revisi"], question["pembahasan"])
            self.assertIn("Fallback lokal", review["catatan"][0])

    def test_review_explanation_reviews_passage_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            saved_root = data_root / "saved"
            questions = [passage_question(index, total=3) for index in range(1, 4)]
            metadata_path = None
            for question in questions:
                run_dir = saved_root / f"20990101-01010{question['bacaan']['nomor_soal']}"
                run_dir.mkdir(parents=True)
                current_path = run_dir / "metadata.json"
                current_path.write_text(
                    json.dumps({"run_id": run_dir.name, "question": question}, ensure_ascii=False),
                    encoding="utf-8",
                )
                if question["bacaan"]["nomor_soal"] == 2:
                    metadata_path = current_path

            revised = [
                {**question, "pembahasan": f"Langkah 1: Revisi soal {index}. Kesimpulan: jawaban A."}
                for index, question in enumerate(questions, start=1)
            ]
            ai_result = {
                "lolos": True,
                "skor": 96,
                "akurasi": "Akurat",
                "bahasa_formal": "Formal",
                "catatan": [],
                "saran_revisi": [],
                "pembahasan_revisi": revised[1]["pembahasan"],
                "question_revisi": revised[1],
                "question_group_revisi": revised,
            }

            with mock.patch.object(generator, "_ai_json", return_value=ai_result) as ai_json:
                result = generator.review_explanation_for_metadata(metadata_path)

            prompt = ai_json.call_args.args[0]
            review = result["explanation_review"]
            self.assertIn("question_group_revisi", prompt)
            self.assertEqual(len(review["question_group_revisi"]), 3)
            self.assertEqual(review["question_revisi"]["bacaan"]["nomor_soal"], 2)
            self.assertIn("Revisi soal 2", review["pembahasan_revisi"])

    def test_check_duplicate_reads_bank_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            run_id = "20990101-010101"
            question = generator.draft_question("Penalaran Umum", "Penalaran deduktif", "mudah")
            saved_dir = data_root / "saved" / run_id
            bank_dir = data_root / "bank"
            saved_dir.mkdir(parents=True)
            bank_dir.mkdir(parents=True)
            (saved_dir / "metadata.json").write_text(
                json.dumps({"question": question}, ensure_ascii=False),
                encoding="utf-8",
            )
            (bank_dir / "index.json").write_text(
                json.dumps([{"run_id": run_id, "status": "approved"}]),
                encoding="utf-8",
            )

            result = generator.check_duplicate(question)

            self.assertTrue(result["is_duplicate"])
            self.assertEqual(result["matched_run_id"], run_id)
            self.assertEqual(result["matched_status"], "approved")

    def test_check_duplicate_can_exclude_current_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            run_id = "20990101-010101"
            question = generator.draft_question("Penalaran Umum", "Penalaran deduktif", "mudah")
            saved_dir = data_root / "saved" / run_id
            bank_dir = data_root / "bank"
            saved_dir.mkdir(parents=True)
            bank_dir.mkdir(parents=True)
            (saved_dir / "metadata.json").write_text(
                json.dumps({"question": question}, ensure_ascii=False), encoding="utf-8"
            )
            (bank_dir / "index.json").write_text(
                json.dumps([{"run_id": run_id, "status": "saved"}]), encoding="utf-8"
            )

            result = generator.check_duplicate(question, exclude_run_id=run_id)

            self.assertFalse(result["is_duplicate"])
            self.assertEqual(result["similarity"], 0.0)
            self.assertIsNone(result["matched_run_id"])

    def test_check_duplicate_same_question_remains_duplicate_when_passage_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            run_id = "20990101-010101"
            saved_question = passage_question(1, total=3, passage_id="PM-001")
            current_question = json.loads(json.dumps(saved_question))
            current_question["bacaan"]["id"] = "PM-002"
            current_question["bacaan"]["judul"] = "Survei Transportasi"
            current_question["bacaan"]["teks"] = (
                "Komunitas sekolah mencatat perubahan pilihan transportasi siswa setelah "
                "jadwal masuk pagi disesuaikan selama satu semester."
            )
            saved_dir = data_root / "saved" / run_id
            bank_dir = data_root / "bank"
            saved_dir.mkdir(parents=True)
            bank_dir.mkdir(parents=True)
            (saved_dir / "metadata.json").write_text(
                json.dumps({"question": saved_question}, ensure_ascii=False), encoding="utf-8"
            )
            (bank_dir / "index.json").write_text(
                json.dumps([{"run_id": run_id, "status": "saved"}]), encoding="utf-8"
            )

            result = generator.check_duplicate(current_question)

            self.assertTrue(result["is_duplicate"])
            self.assertEqual(result["question_similarity"], 1.0)
            self.assertLess(result["passage_similarity"], 1.0)

    def test_check_duplicate_same_passage_with_different_question_is_not_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            run_id = "20990101-010101"
            saved_question = passage_question(1, total=3, passage_id="PM-001")
            current_question = passage_question(2, total=3, passage_id="PM-001")
            current_question["bacaan"]["judul"] = saved_question["bacaan"]["judul"]
            current_question["bacaan"]["teks"] = saved_question["bacaan"]["teks"]
            current_question["soal"] = "Manakah pernyataan yang tidak dapat disimpulkan dari bacaan?"
            current_question["pilihan"] = {
                "A": "Data biaya tetap dapat dibandingkan.",
                "B": "Pertumbuhan produksi dicatat beberapa bulan.",
                "C": "Seluruh biaya berubah setiap hari.",
                "D": "Titik impas dapat dikaji dari data.",
                "E": "Produksi dibahas dalam konteks UMKM.",
            }
            saved_dir = data_root / "saved" / run_id
            bank_dir = data_root / "bank"
            saved_dir.mkdir(parents=True)
            bank_dir.mkdir(parents=True)
            (saved_dir / "metadata.json").write_text(
                json.dumps({"question": saved_question}, ensure_ascii=False), encoding="utf-8"
            )
            (bank_dir / "index.json").write_text(
                json.dumps([{"run_id": run_id, "status": "saved"}]), encoding="utf-8"
            )

            result = generator.check_duplicate(current_question)

            self.assertFalse(result["is_duplicate"])
            self.assertEqual(result["matched_run_id"], run_id)
            self.assertTrue(result["same_passage"])
            self.assertEqual(result["passage_similarity"], 1.0)
            self.assertLess(result["question_similarity"], result["threshold"])
            self.assertEqual(result["algorithm"], "weighted-question-v2")

    def test_resolve_render_questions_reads_saved_passage_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            saved_root = data_root / "saved"
            questions = [passage_question(index, total=3) for index in [2, 3, 1]]
            metadata_path = None

            for index, question in enumerate(questions, start=1):
                run_dir = saved_root / f"20990101-01010{index}"
                run_dir.mkdir(parents=True)
                current_metadata_path = run_dir / "metadata.json"
                current_metadata_path.write_text(
                    json.dumps({"question": question}, ensure_ascii=False),
                    encoding="utf-8",
                )
                if question["bacaan"]["nomor_soal"] == 2:
                    metadata_path = current_metadata_path

            resolved = generator._resolve_render_questions(questions[0], metadata_path=metadata_path)

            self.assertEqual(len(resolved), 3)
            self.assertEqual(
                [item["bacaan"]["nomor_soal"] for item in resolved],
                [1, 2, 3],
            )

    def test_reading_passages_normalizes_multiple_passages(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = passage_question(1, total=1)
            question.pop("bacaan")
            question["bacaan_list"] = [
                {
                    "id": "LBI-001-A",
                    "judul": "Pasar Buku",
                    "teks": "Teks pertama membahas kebiasaan membaca siswa.",
                    "bahasa": "id",
                },
                {
                    "id": "LBI-001-B",
                    "judul": "Library Survey",
                    "teks": "The second text compares library visits.",
                    "bahasa": "en",
                    "label": "Text 2",
                },
            ]

            passages = generator._reading_passages(question, prefer_list=True)

            self.assertEqual([item["label"] for item in passages], ["Teks 1", "Text 2"])
            self.assertEqual(generator._passage_heading(passages[0]), "Teks 1: Pasar Buku")
            self.assertEqual(generator._passage_heading(passages[1]), "Text 2: Library Survey")

    def test_paginate_passage_intro_segments_keeps_heading_per_passage(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            from PIL import Image, ImageDraw

            question = passage_question(1, total=1)
            question.pop("bacaan")
            question["bacaan_list"] = [
                {
                    "id": "LBI-001-A",
                    "judul": "Pasar Buku",
                    "teks": "Teks pertama membahas kebiasaan membaca siswa.",
                    "bahasa": "id",
                },
                {
                    "id": "LBI-001-B",
                    "judul": "Perpustakaan Sekolah",
                    "teks": "Teks kedua menjelaskan perubahan kunjungan perpustakaan.",
                    "bahasa": "id",
                },
            ]
            image = Image.new("RGB", (1000, 1000), "#f5f0e8")
            fonts = {"body": generator._load_font(24, family="anthropic_sans")}

            segments = generator._paginate_passage_intro_segments(ImageDraw.Draw(image), question, fonts)

            self.assertEqual([item["heading"] for item in segments], ["Teks 1: Pasar Buku", "Teks 2: Perpustakaan Sekolah"])

    def test_render_content_images_routes_bacaan_list_to_multi_passage_pil(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = passage_question(1, total=1)
            question.pop("bacaan")
            question["bacaan_list"] = [
                {
                    "id": "LBI-001-A",
                    "judul": "Pasar Buku",
                    "teks": "Teks pertama membahas kebiasaan membaca siswa.",
                    "bahasa": "id",
                },
                {
                    "id": "LBI-001-B",
                    "judul": "Perpustakaan Sekolah",
                    "teks": "Teks kedua menjelaskan perubahan kunjungan perpustakaan.",
                    "bahasa": "id",
                },
            ]
            question["soal"] = "Berdasarkan kedua teks, simpulan yang tepat adalah ..."

            rendered, engine = generator.render_content_images(question, Path(tmp))

            self.assertEqual(engine, "pil_multi_passage")
            self.assertTrue((Path(tmp) / "thumbnail.png").exists())
            self.assertTrue((Path(tmp) / "post-1.png").exists())
            self.assertGreaterEqual(len(rendered), 4)

    def test_wrap_passage_paragraphs_keeps_tight_new_paragraphs_without_uppercase_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            from PIL import Image, ImageDraw

            image = Image.new("RGB", (1000, 1000), "#f5f0e8")
            draw = ImageDraw.Draw(image)
            font = generator._load_font(24, family="anthropic_sans")
            paragraphs = generator._wrap_passage_paragraphs(
                draw,
                "Paragraf pertama baris satu.\nParagraf pertama baris dua.\n\n(2) paragraf kedua.",
                font,
                700,
                profile=generator._render_profile({"mapel": "Penalaran Umum"}),
            )

            self.assertEqual(len(paragraphs), 2)
            self.assertTrue(any("Paragraf pertama" in line for line in paragraphs[0]))
            self.assertTrue(any("(2) paragraf kedua" in line for line in paragraphs[1]))
            self.assertFalse(paragraphs[1][0].startswith(generator.PASSAGE_INDENT_MARKER))

    def test_wrap_passage_paragraphs_marks_only_wrapped_paragraphs_for_indent(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            from PIL import Image, ImageDraw

            image = Image.new("RGB", (1000, 1000), "#f5f0e8")
            draw = ImageDraw.Draw(image)
            font = generator._load_font(24, family="anthropic_sans")
            paragraphs = generator._wrap_passage_paragraphs(
                draw,
                "Paragraf pendek.\n\n"
                "Paragraf kedua sangat panjang sehingga perlu turun ke beberapa baris saat dibungkus di area teks yang sempit.",
                font,
                220,
                profile=generator._render_profile({"mapel": "Penalaran Umum"}),
            )

            self.assertFalse(paragraphs[0][0].startswith(generator.PASSAGE_INDENT_MARKER))
            self.assertTrue(paragraphs[1][0].startswith(generator.PASSAGE_INDENT_MARKER))

    def test_wrap_question_paragraphs_indents_new_paragraphs(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            from PIL import Image, ImageDraw

            image = Image.new("RGB", (1000, 1000), "#f5f0e8")
            draw = ImageDraw.Draw(image)
            font = generator._load_font(29, family="anthropic_sans")
            paragraphs = generator._wrap_question_paragraphs(
                draw,
                "Paragraf pertama berisi konteks soal.\n\nParagraf kedua berisi pertanyaan lanjutan.",
                font,
                790,
                profile=generator._render_profile({"mapel": "Penalaran Umum"}),
            )

            self.assertFalse(paragraphs[0][0].startswith(generator.PASSAGE_INDENT_MARKER))
            self.assertTrue(paragraphs[1][0].startswith(generator.PASSAGE_INDENT_MARKER))

    def test_render_profile_is_selected_by_subtest(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            pu_profile = generator._render_profile({"mapel": "Penalaran Umum"})
            lbi_profile = generator._render_profile({"mapel": "Literasi Bahasa Indonesia"})

            self.assertEqual(pu_profile.subtest, "Penalaran Umum")
            self.assertEqual(lbi_profile.subtest, "Literasi Bahasa Indonesia")
            self.assertIsNot(pu_profile, lbi_profile)
            self.assertEqual(pu_profile.question_font_size, 32)
            self.assertEqual(pu_profile.choice_font_size, 32)

    def test_render_profile_rejects_subtest_without_own_generator(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            with self.assertRaisesRegex(ValueError, "Generator gambar belum tersedia"):
                generator._render_profile({"mapel": "Subtes Palsu"})

    def test_question_indent_can_be_changed_per_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            from PIL import Image, ImageDraw

            image = Image.new("RGB", (1000, 1000), "#f5f0e8")
            draw = ImageDraw.Draw(image)
            font = generator._load_font(29, family="anthropic_sans")
            base_profile = generator._render_profile({"mapel": "Penalaran Umum"})
            no_indent_profile = replace(base_profile, indent_question_paragraphs=False)
            paragraphs = generator._wrap_question_paragraphs(
                draw,
                "Paragraf pertama berisi konteks soal.\n\nParagraf kedua berisi pertanyaan lanjutan.",
                font,
                790,
                profile=no_indent_profile,
            )

            self.assertFalse(paragraphs[1][0].startswith(generator.PASSAGE_INDENT_MARKER))

    def test_paginate_quiz_uses_tight_paragraph_breaks_for_question_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            from PIL import Image, ImageDraw

            question = {
                "mapel": "Penalaran Umum",
                "soal": "Paragraf pertama berisi konteks soal.\n\nParagraf kedua berisi pertanyaan lanjutan.",
                "pilihan": {
                    "A": "Pilihan A.",
                    "B": "Pilihan B.",
                    "C": "Pilihan C.",
                    "D": "Pilihan D.",
                    "E": "Pilihan E.",
                },
            }
            image = Image.new("RGB", (1000, 1000), "#f5f0e8")
            draw = ImageDraw.Draw(image)
            fonts = {
                "question": generator._load_font(29, family="anthropic_sans"),
                "body": generator._load_font(29, family="anthropic_sans"),
            }

            pages = generator._paginate_quiz(draw, question, fonts)
            lines = pages[0]["question_lines"]

            self.assertIn(generator.PASSAGE_PARAGRAPH_BREAK, lines)
            self.assertEqual(generator._drawable_line_count(lines), 2)
            self.assertEqual(len(pages[0]["choices"]), 5)

    def test_render_images_for_metadata_groups_passage_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            run_dir = data_root / "saved" / "20990101-010101"
            run_dir.mkdir(parents=True)
            questions = [passage_question(index, total=3) for index in range(1, 4)]
            metadata_path = run_dir / "metadata.json"
            metadata_path.write_text(
                json.dumps({
                    "run_id": "20990101-010101",
                    "question": questions[0],
                    "question_group": questions,
                    "files": {"question": str(run_dir / "soal.json"), "caption": str(run_dir / "caption.txt")},
                }, ensure_ascii=False),
                encoding="utf-8",
            )

            result = generator.render_images_for_metadata(metadata_path)

            self.assertTrue(result["ok"])
            self.assertEqual(result["render_group"]["kind"], "passage_bundle")
            self.assertEqual(result["render_group"]["question_count"], 3)
            self.assertGreaterEqual(len(result["files"]["images"]), 5)
            self.assertTrue((run_dir / "thumbnail.png").exists())
            self.assertTrue((run_dir / "post-1.png").exists())
            self.assertTrue((run_dir / "pembahasan-1.jpg").exists())

    def test_paginate_quiz_keeps_five_short_choices_on_same_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            from PIL import Image, ImageDraw

            question = {
                "mapel": "Penalaran Umum",
                "soal": "Bentuk pe-an pada kata pengecekan dalam kalimat (3) mempunyai makna yang sama dengan bentuk pe-an pada kalimat ....",
                "pilihan": {
                    "A": "Kami sudah mempunyai pekarangan untuk mendirikan rumah.",
                    "B": "Hasil ikan yang ditangkap nelayan langsung dibawa ke pelelangan.",
                    "C": "Juleha senang menceritakan pengalaman selama berada di luar negeri.",
                    "D": "Pemandian umum itu sudah lama tidak dipakai sehingga bernuansa horor.",
                    "E": "Perjalanan itu menjadi pengalaman berharga bagi semua peserta.",
                },
            }
            image = Image.new("RGB", (1000, 1000), "#f5f0e8")
            draw = ImageDraw.Draw(image)
            fonts = {
                "question": generator._load_font(29, family="anthropic_sans"),
                "body": generator._load_font(29, family="anthropic_sans"),
            }

            pages = generator._paginate_quiz(draw, question, fonts)

            self.assertEqual(len(pages), 1)
            self.assertEqual(len(pages[0]["choices"]), 5)

    def test_question_prompt_samples_three_same_topic_saved_examples(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            saved_root = data_root / "saved"
            same_topic_questions = []
            for index in range(4):
                run_dir = saved_root / f"20990101-01010{index}"
                run_dir.mkdir(parents=True)
                question = {
                    "mapel": "Pengetahuan Kuantitatif",
                    "topik": "Persamaan Linear",
                    "level": "mudah",
                    "soal": f"Contoh database persamaan linear {index}",
                    "pilihan": {"A": "1", "B": "2", "C": "3", "D": "4", "E": "5"},
                    "jawaban": "A",
                    "pembahasan": f"Pembahasan persamaan linear {index}",
                    "konsep_kunci": "Persamaan linear",
                    "butuh_visual": False,
                }
                same_topic_questions.append(question)
                (run_dir / "metadata.json").write_text(
                    json.dumps({"question": question}, ensure_ascii=False),
                    encoding="utf-8",
                )
            other_dir = saved_root / "20990101-020202"
            other_dir.mkdir(parents=True)
            (other_dir / "metadata.json").write_text(
                json.dumps({
                    "question": {
                        "mapel": "Pengetahuan Kuantitatif",
                        "topik": "Statistika",
                        "soal": "Contoh database statistika yang tidak boleh masuk",
                        "pilihan": {"A": "1"},
                    }
                }, ensure_ascii=False),
                encoding="utf-8",
            )

            prompt = generator.build_question_prompt(
                "Pengetahuan Kuantitatif",
                "Aljabar Dan Fungsi",
                "mudah",
            )

            included = [
                question for question in same_topic_questions
                if question["soal"] in prompt
            ]
            self.assertEqual(len(included), 3)
            self.assertIn("Contoh soal database untuk topik yang sama", prompt)
            self.assertIn('"Langkah 1:"', prompt)
            self.assertIn('"Kesimpulan:"', prompt)
            self.assertNotIn("Contoh database statistika yang tidak boleh masuk", prompt)

    def test_generate_content_auto_uses_local_fallback_when_no_provider_or_examples_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            with mock.patch.dict(os.environ, {
                "GEMINI_API_KEY": "",
                "KIMI_API_KEY": "",
                "NVIDIA_API_KEY": "",
            }, clear=False):
                result = generator.generate_content(
                    "Pengetahuan Kuantitatif",
                    "Aljabar Dan Fungsi",
                    "mudah",
                    mode="auto",
                    account="@quality",
                )

            self.assertTrue(result["ok"])
            self.assertEqual(result["source"], "draft")
            self.assertFalse(result["fallback_used"])

    def test_generate_content_draft_writes_expected_files_to_data_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)

            result = generator.generate_content(
                "Pengetahuan Kuantitatif",
                "Aritmetika",
                "mudah",
                mode="draft",
                account="@quality",
            )

            self.assertTrue(result["ok"])
            self.assertEqual(result["source"], "draft")
            self.assertEqual(result["question"]["akun"], "@quality")
            run_dir = data_root / "outputs" / result["storage_path"]
            metadata = json.loads((run_dir / "metadata.json").read_text(encoding="utf-8"))
            question = json.loads((run_dir / "soal.json").read_text(encoding="utf-8"))
            caption_text = (run_dir / "caption.txt").read_text(encoding="utf-8")

            self.assertTrue((run_dir / "metadata.json").exists())
            self.assertTrue((run_dir / "soal.json").exists())
            self.assertTrue((run_dir / "caption.txt").exists())
            self.assertTrue((run_dir / "thumbnail.png").exists())
            self.assertTrue((run_dir / "post-1.png").exists())
            self.assertTrue((run_dir / "pembahasan-1.jpg").exists())
            self.assertTrue((run_dir / "1.jpg").exists())

            self.assertEqual(metadata["run_id"], result["run_id"])
            self.assertEqual(metadata["storage_path"], result["storage_path"])
            self.assertEqual(metadata["question"], question)
            self.assertEqual(metadata["caption"], result["caption"])
            self.assertEqual(metadata["files"], result["files"])
            self.assertEqual(question, result["question"])
            self.assertIn("visual_latex", question)
            self.assertEqual(question["visual_latex"]["type"], "cartesian_2d")
            self.assertFalse(question["visual_latex"]["generated"])
            self.assertIn(result["caption"]["caption"], caption_text)
            for hashtag in result["caption"]["hashtag"]:
                self.assertIn(hashtag, caption_text)

            expected_file_keys = {
                "question",
                "caption",
                "image",
                "images",
                "thumbnail",
                "explanation",
                "explanations",
            }
            self.assertEqual(set(result["files"].keys()), expected_file_keys)
            self.assertEqual(Path(result["files"]["question"]).name, "soal.json")
            self.assertEqual(Path(result["files"]["caption"]).name, "caption.txt")

            numbered_names = [Path(path).name for path in result["files"]["images"]]
            self.assertEqual(
                numbered_names,
                [f"{index}.jpg" for index in range(1, len(numbered_names) + 1)],
            )
            self.assertEqual(Path(result["files"]["image"]).name, "1.jpg")
            self.assertEqual(Path(result["files"]["thumbnail"]).name, "1.jpg")
            self.assertTrue(set(result["files"]["explanations"]).issubset(set(result["files"]["images"])))
            self.assertEqual(result["files"]["explanation"], result["files"]["explanations"][0])

            from PIL import Image
            with Image.open(run_dir / "thumbnail.png") as image:
                self.assertEqual(image.size, (1080, 1080))
            with Image.open(run_dir / "post-1.png") as image:
                self.assertEqual(image.size, (1000, 1000))
            with Image.open(run_dir / "pembahasan-1.jpg") as image:
                self.assertEqual(image.size, (1000, 1000))
            for index, image_path in enumerate(result["files"]["images"], start=1):
                self.assertEqual(Path(image_path).suffix.lower(), ".jpg")
                with Image.open(image_path) as image:
                    expected_size = (1080, 1080) if index == 1 else (1000, 1000)
                    self.assertEqual(image.size, expected_size)
            self.assertTrue(result["files"]["images"])
            self.assertTrue(result["files"]["thumbnail"])
            self.assertTrue(result["files"]["explanations"])

    def test_generate_content_uses_unique_run_id_when_timestamp_collides(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)
            generator._now_id = lambda: "20260619-120000"

            first = generator.generate_content(
                "Pengetahuan Kuantitatif",
                "Bilangan",
                "mudah",
                mode="draft",
                account="@quality",
            )
            second = generator.generate_content(
                "Pengetahuan Kuantitatif",
                "Bilangan",
                "mudah",
                mode="draft",
                account="@quality",
            )

            self.assertNotEqual(first["run_id"], second["run_id"])
            self.assertTrue((data_root / "outputs" / first["storage_path"] / "metadata.json").exists())
            self.assertTrue((data_root / "outputs" / second["storage_path"] / "metadata.json").exists())

    def test_generate_content_draft_covers_every_default_subtest(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            generator = load_generator(data_root)

            for mapel, topics in generator.MAPEL_TOPICS.items():
                with self.subTest(mapel=mapel):
                    result = generator.generate_content(
                        mapel,
                        topics[0],
                        "mudah",
                        mode="draft",
                        account="@quality",
                    )
                    run_dir = data_root / "outputs" / result["storage_path"]
                    metadata = json.loads((run_dir / "metadata.json").read_text(encoding="utf-8"))
                    question = json.loads((run_dir / "soal.json").read_text(encoding="utf-8"))
                    caption_text = (run_dir / "caption.txt").read_text(encoding="utf-8")

                    self.assertTrue(result["ok"])
                    self.assertEqual(result["source"], "draft")
                    self.assertEqual(result["question"]["mapel"], mapel)
                    self.assertEqual(result["question"]["topik"], topics[0])
                    self.assertEqual(result["question"], question)
                    self.assertEqual(metadata["run_id"], result["run_id"])
                    self.assertEqual(sorted(result["question"]["pilihan"].keys()), ["A", "B", "C", "D", "E"])
                    self.assertIn(result["question"]["jawaban"], result["question"]["pilihan"])
                    self.assertIn("#UTBK", caption_text)
                    self.assertIn("#UTBK2027", caption_text)

    def test_normalize_question_removes_parenthetical_hint_in_linear_question(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar dasar",
                "level": "sedang",
                "soal": "Tentukan nilai x dari persamaan linear 2x + 3 = 11 (gunakan operasi invers).",
            }

            normalized = generator.normalize_question(question)

            self.assertEqual(
                normalized["soal"],
                "Tentukan nilai x dari persamaan linear 2x + 3 = 11.",
            )

    def test_normalize_question_keeps_math_parentheses(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar dasar",
                "level": "sedang",
                "soal": "Bentuk setara dari y = (x - 1)^2 - 16 adalah garis melalui titik (0, 1).",
            }

            normalized = generator.normalize_question(question)

            self.assertIn("(x - 1)^2", normalized["soal"])
            self.assertIn("(0, 1)", normalized["soal"])

    def test_normalize_question_spaces_equals_signs(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar Dan Fungsi",
                "level": "sedang",
                "soal": "Jika f(x)=2x+1 dan x>=2, tentukan f(2).",
                "pilihan": {"A": "f(2)=3", "B": "5", "C": "6", "D": "7", "E": "8"},
                "jawaban": "B",
                "pembahasan": "f(2)=2(2)+1=5.",
            }

            normalized = generator.normalize_question(question)

            self.assertEqual(normalized["soal"], "Jika f(x) = 2x+1 dan x>=2, tentukan f(2).")
            self.assertEqual(normalized["pilihan"]["A"], "f(2) = 3")
            self.assertEqual(normalized["pembahasan"], "f(2) = 2(2)+1 = 5.")

    def test_latex_explanation_uses_consistent_cartesian_visual(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Pertidaksamaan Linear",
                "level": "sedang",
                "soal": "Pada bidang kartesius, daerah solusi memenuhi y >= 2x + 1.",
                "pilihan": {
                    "A": "Kuadran I saja",
                    "B": "Kuadran II saja",
                    "C": "Kuadran III saja",
                    "D": "Kuadran IV saja",
                    "E": "Semua kuadran memiliki solusi",
                },
                "jawaban": "E",
                "pembahasan": (
                    "Buat garis y >= 2x + 1 terlebih dahulu. "
                    "Karena tanda pertidaksamaan memuat lebih besar sama dengan, "
                    "daerah solusi berada pada sisi atas garis. "
                    "Dari sketsa terlihat daerah solusi dapat menyentuh semua kuadran."
                ),
                "butuh_visual": True,
                "akun": "@quality",
            }

            sources = generator._latex_explanation_sources(question)

            self.assertTrue(sources)
            self.assertNotIn("ILUSTRASI GRAFIK", sources[0])
            self.assertIn("shadegreen, opacity=0.52, blend mode=multiply", sources[0])
            self.assertIn("graphgreen", sources[0])
            self.assertIn("{6}", sources[0])
            self.assertIn("{-6}", sources[0])
            visual = generator._cartesian_visual_code(question)
            self.assertNotIn("fill=panel", visual)
            self.assertNotIn("Sketsa bantu", visual)

    def test_latex_quiz_keeps_visual_inside_question_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Pertidaksamaan Linear",
                "level": "sedang",
                "soal": (
                    "Diketahui daerah solusi pada bidang kartesius memenuhi "
                    "y >= 2x + 1 dan y > 1/2x - 1. Perhatikan grafik berikut. "
                    "Tentukan kuadran yang masih memiliki daerah solusi."
                ),
                "pilihan": {
                    "A": "Kuadran I saja",
                    "B": "Kuadran II saja",
                    "C": "Kuadran III saja",
                    "D": "Kuadran IV saja",
                    "E": "Semua kuadran memiliki solusi",
                },
                "jawaban": "E",
                "pembahasan": "Daerah solusi berada pada sisi atas kedua garis sehingga semua kuadran masih tersentuh.",
                "butuh_visual": True,
                "akun": "@quality",
            }

            sources = generator._latex_quiz_sources(question)
            first_page = sources[0]

            self.assertNotIn("ILUSTRASI GRAFIK", first_page)
            self.assertLess(first_page.index("Diketahui"), first_page.index(r"\begin{scope}"))
            self.assertLess(first_page.index(r"\end{scope}"), first_page.index("Tentukan"))
            self.assertIn(r"\mbox{$y>1/2x-1$}", first_page)
            self.assertNotIn("Sketsa bantu", first_page)
            self.assertIn("{6}", first_page)
            self.assertIn("{-6}", first_page)

    def test_latex_quiz_keeps_algebra_expression_compact(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar Dan Fungsi",
                "level": "sedang",
                "soal": "Jika a² + b² = z dan ab = y, manakah di bawah ini yang ekuivalen dengan 4z + 8y?",
                "pilihan": {
                    "A": "2(a+b)²",
                    "B": "2(2a+b)²",
                    "C": "(4a+4b)²",
                    "D": "(4a+8b)²",
                    "E": "4(a+b)²",
                },
                "jawaban": "E",
                "pembahasan": "Karena 4z + 8y = 4(a²+b²)+8ab = 4(a+b)².",
                "butuh_visual": False,
            }

            first_page = generator._latex_quiz_sources(question)[0]

            self.assertIn("4z+8y", first_page)
            self.assertNotIn("4z +", first_page)

    def test_question_ratio_stays_compact_before_wrapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            formatted = generator._format_question_text(
                "Perbandingan novel, komik, dan ensiklopedia adalah 3 : 4 : 7."
            )

            self.assertIn("3:4:7", formatted)
            self.assertNotIn("3 : 4", formatted)

    def test_question_removes_arbitrary_line_breaks_inside_sentence(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            formatted = generator._format_question_text(
                "7% dari a adalah 490 dan 1,5% dari b adalah\n\n"
                "45. Maka nilai (2/7000)a - (1/900)b adalah...."
            )

            self.assertEqual(
                formatted,
                "7% dari a adalah 490 dan 1,5% dari b adalah 45. "
                "Maka nilai (2/7000)a - (1/900)b adalah....",
            )
            self.assertNotIn("\n", formatted)

    def test_numbered_statements_start_on_separate_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            formatted = generator._format_question_text(
                "Berapakah nilai xy jika x > 0? (1) y = x^2. (2) 2y+6=2(x+3)."
            )

            self.assertEqual(
                formatted,
                "Berapakah nilai xy jika x > 0?\n(1) y = x^2.\n(2) 2y+6 = 2(x+3).",
            )

    def test_single_parenthetical_number_stays_inline(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            formatted = generator._format_question_text("Nilai fungsi pada x = (1) adalah 2.")

            self.assertEqual(formatted, "Nilai fungsi pada x = (1) adalah 2.")

    def test_plain_wrap_keeps_parenthetical_phrase_on_one_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            lines = generator._wrap_plain_lines(
                "Kabut disebut juga (fog tebal sekali) dalam bacaan.",
                width=20,
            )

            self.assertIn("(fog tebal sekali)", lines)
            self.assertFalse(any("(fog" in line and ")" not in line for line in lines))

    def test_wrap_units_preserves_math_function_spacing(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            self.assertEqual(generator._wrap_units("Nilai f(x) adalah 2."), ["Nilai", "f(x)", "adalah", "2."])

    def test_pixel_wrap_keeps_parenthetical_phrase_on_one_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            from PIL import Image, ImageDraw, ImageFont

            draw = ImageDraw.Draw(Image.new("RGB", (400, 100)))
            lines = generator._wrap_text(
                draw,
                "Kabut (fog tebal sekali) menghalangi pandangan.",
                ImageFont.load_default(),
                90,
            )

            self.assertTrue(any("(fog tebal sekali)" in line for line in lines))
            self.assertFalse(any("(fog" in line and ")" not in line for line in lines))

    def test_latex_explanation_title_only_appears_on_first_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Penalaran Umum",
                "topik": "Simpulan logis",
                "pembahasan": " ".join(
                    f"Kalimat penjelasan nomor {index} memberikan alasan yang lengkap."
                    for index in range(1, 45)
                ),
                "pilihan": {"A": "Jawaban benar"},
                "jawaban": "A",
            }

            sources = generator._latex_explanation_sources(question)

            self.assertGreater(len(sources), 1)
            self.assertIn("Pembahasan", sources[0])
            self.assertTrue(all("Pembahasan" not in source for source in sources[1:]))

    def test_data_sufficiency_explanation_keeps_logical_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            explanation = (
                "(1) y = x^2. xy = x^3. Tergantung nilai x, tidak bisa ditentukan nilai pasti. "
                "TIDAK CUKUP. (2) 2y+6=2x+6 menghasilkan y=x. xy=x^2. "
                "Tergantung nilai x, tidak bisa ditentukan nilai pasti. TIDAK CUKUP. "
                "Bersama-sama: y=x^2 dan y=x menghasilkan x=1. "
                "Diketahui x>0, jadi x=1 dan y=1. BERSAMA-SAMA CUKUP. Jawaban C."
            )

            formatted = generator._format_explanation_text(explanation, sentence_per_line=True)

            self.assertIn("\n\n(2) 2y+6=2x+6", formatted)
            self.assertIn("\n\nTIDAK CUKUP.", formatted)
            self.assertIn("\n\nBersama-sama:", formatted)
            self.assertIn("\n\nBERSAMA-SAMA CUKUP.", formatted)
            self.assertIn("\n\nJawaban C.", formatted)

    def test_pil_explanation_uses_compact_gaps_between_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            from PIL import Image, ImageDraw

            question = {
                "pembahasan": (
                    "x = (y+4)/2\n"
                    "Sehingga, (g o f)(x) = (x+4)/2.\n"
                    "Substitusikan x = 2 ke dalam fungsi komposisi tersebut:\n"
                    "g(f(2)) = (2+4)/2 = 3"
                )
            }
            font = generator._load_font(29, family="anthropic_sans")
            image = Image.new("RGB", (1000, 1000), "#f5f0e8")
            pages = generator._paginate_explanation_pages(
                ImageDraw.Draw(image),
                question,
                {"body": font},
            )

            self.assertTrue(pages)
            self.assertEqual(len(pages), 1)
            self.assertIn("", pages[0])
            self.assertEqual(
                generator._explanation_visual_height(["Langkah 1", "", "Langkah 2"], 40),
                92,
            )

            steps = generator._build_explanation_steps(question["pembahasan"])
            self.assertEqual(len(steps), 1)
            self.assertTrue(steps[0]["parts"][0]["formula"])
            self.assertTrue(any(not part["formula"] for part in steps[0]["parts"]))
            self.assertTrue(any(part["formula"] for part in steps[0]["parts"]))

            groups = generator._structured_explanation_groups(
                ImageDraw.Draw(image),
                question["pembahasan"],
                {
                    "explanation": generator._load_font(27, family="anthropic_sans"),
                    "formula": generator._load_font(26, family="anthropic_mono"),
                },
            )
            self.assertFalse(any(row["kind"] == "step" for row in groups[0]))
            text_rows = [
                row
                for group in groups
                for row in group
                if row["kind"] == "text"
            ]
            self.assertTrue(text_rows)
            self.assertGreaterEqual(text_rows[0]["height"], 40)

            single_groups = generator._structured_explanation_groups(
                ImageDraw.Draw(image),
                "Gunakan definisi fungsi untuk memperoleh jawaban yang benar.",
                {
                    "explanation": generator._load_font(27, family="anthropic_sans"),
                    "formula": generator._load_font(26, family="anthropic_mono"),
                },
            )
            self.assertFalse(any(row["kind"] == "step" for row in single_groups[0]))

            labeled_steps = generator._build_explanation_steps(
                "Langkah 1: Tentukan nilai x.\n"
                "Gunakan persamaan yang diberikan.\n"
                "Langkah 2: Substitusikan nilai x.\n"
                "Kesimpulan: Jawaban yang benar adalah C."
            )
            self.assertEqual(len(labeled_steps), 3)
            self.assertEqual(len(labeled_steps[0]["parts"]), 2)
            self.assertTrue(labeled_steps[-1]["conclusion"])

    def test_latex_explanation_preserves_paragraph_spacing(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Kecukupan Data",
                "level": "sedang",
                "soal": "Tentukan nilai xy.",
                "pilihan": {key: key for key in "ABCDE"},
                "jawaban": "C",
                "pembahasan": (
                    "(1) y=x^2. TIDAK CUKUP. (2) y=x. TIDAK CUKUP. "
                    "Bersama-sama: x=1 dan y=1. BERSAMA-SAMA CUKUP. Jawaban C."
                ),
                "butuh_visual": False,
            }

            source = generator._latex_explanation_sources(question)[0]

            self.assertIn(r"\mbox{}", source)

    def test_answer_display_text_does_not_repeat_answer_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            self.assertEqual(generator._answer_display_text("B", "Nilai x adalah 2"), "Nilai x adalah 2")
            self.assertEqual(generator._answer_display_text("B", "B. Nilai x adalah 2"), "Nilai x adalah 2")
            self.assertNotIn("B.", generator._answer_display_text("B", "B) Nilai x adalah 2"))

    def test_pil_text_converts_common_latex_instead_of_showing_raw_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            rendered = generator._latex_to_plain_text(
                r"$f^{-1}$ dan $g^{-1}$, $(f^{-1}\circ g^{-1})(x)=2x-4$, "
                r"$g(x)=\frac{x-1}{x+2}$"
            )

            self.assertIn("f⁻¹ dan g⁻¹", rendered)
            self.assertIn("f⁻¹∘ g⁻¹", rendered)
            self.assertIn("(x-1)/(x+2)", rendered)
            self.assertNotIn("$", rendered)
            self.assertNotIn(r"\frac", rendered)
            self.assertNotIn(r"\circ", rendered)

    def test_pil_text_converts_latex_fraction_choices(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            self.assertEqual(generator._latex_to_plain_text(r"$-\frac{5}{4}$"), "-5/4")
            self.assertEqual(generator._latex_to_plain_text(r"$\sqrt{40}=2\sqrt{10}$"), "√40 = 2√10")

    def test_symbolic_quadratic_parameter_does_not_render_cartesian_visual(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar Dan Fungsi",
                "level": "sedang",
                "soal": (
                    "Sebuah kurva parabolik memiliki fungsi f(x)=2x²+bx+5 dengan b≠0 "
                    "memotong sumbu x di dua titik yang berbeda. Dibawah ini pernyataan "
                    "yang benar terkait b adalah...."
                ),
                "pilihan": {
                    "A": "b > 0",
                    "B": "b < 0",
                    "C": "b² > 40",
                    "D": "b² < 40",
                    "E": "b = 0",
                },
                "jawaban": "C",
                "pembahasan": "Dua titik potong berbeda terjadi saat diskriminan lebih dari nol.",
                "butuh_visual": True,
            }

            self.assertFalse(generator._needs_cartesian_visual(question))
            self.assertEqual(generator._cartesian_visual_code(question), "")

    def test_symbolic_linear_parameter_does_not_render_cartesian_visual(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar Dan Fungsi",
                "level": "sedang",
                "soal": "Diketahui grafik garis y = ax + 2 memotong sumbu y di titik tertentu. Pernyataan yang benar tentang a adalah...",
                "butuh_visual": True,
            }

            self.assertFalse(generator._needs_cartesian_visual(question))
            self.assertEqual(generator._cartesian_visual_code(question), "")

    def test_cartesian_positive_y_is_drawn_above_origin(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar Dan Fungsi",
                "level": "sedang",
                "soal": "Pada bidang kartesius, grafik garis y = x + 1 memotong sumbu y di titik (0, 1).",
                "butuh_visual": True,
            }

            visual = generator._cartesian_visual_code(question)

            self.assertIn(r"\fill[graphgreen]", visual)
            self.assertIn("(160.0,184.6)", visual)
            self.assertNotIn(" grid[", visual)

    def test_math_question_gets_cartesian_latex_visual_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Penalaran Matematika",
                "topik": "Grafik Fungsi",
                "level": "sedang",
                "soal": "Pada bidang kartesius, grafik garis y = x + 1 memotong sumbu y di titik (0, 1).",
                "butuh_visual": True,
            }

            enriched = generator.attach_cartesian_latex_visual(question)

            self.assertTrue(enriched["visual_latex"]["generated"])
            self.assertEqual(enriched["visual_latex"]["type"], "cartesian_2d")
            self.assertEqual(enriched["visual_latex"]["format"], "tikz")
            self.assertIn(r"\begin{scope}", enriched["visual_latex"]["source"])
            self.assertIn(r"\draw[graphgreen", enriched["visual_latex"]["source"])

    def test_math_question_without_cartesian_graph_gets_empty_visual_latex_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aritmetika",
                "level": "mudah",
                "soal": "Jika 2x + 3 = 11, nilai x adalah...",
                "butuh_visual": False,
            }

            enriched = generator.attach_cartesian_latex_visual(question)

            self.assertFalse(enriched["visual_latex"]["generated"])
            self.assertEqual(enriched["visual_latex"]["source"], "")
            self.assertEqual(enriched["visual_latex"]["reason"], "not_cartesian_or_unparseable")

    def test_explanation_can_graph_after_symbolic_variable_is_solved(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar Dan Fungsi",
                "level": "sedang",
                "soal": "Diketahui grafik garis y = ax + 2 melalui titik (1, 4). Tentukan grafik garis tersebut.",
                "pilihan": {
                    "A": "y = x + 2",
                    "B": "y = 2x + 2",
                    "C": "y = 3x + 2",
                    "D": "y = 2x - 2",
                    "E": "y = x - 2",
                },
                "jawaban": "B",
                "pembahasan": "Substitusi titik (1,4) ke y = ax + 2 menghasilkan 4 = a + 2, sehingga a = 2. Jadi grafiknya y = 2x + 2.",
                "butuh_visual": True,
            }

            self.assertFalse(generator._needs_cartesian_visual(question))
            self.assertTrue(generator._needs_cartesian_visual(question, include_explanation=True))
            self.assertEqual(generator._cartesian_visual_code(question), "")
            self.assertIn(r"\draw[graphgreen", generator._cartesian_visual_code(question, include_explanation=True))

    def test_latex_explanation_keeps_algebra_expression_compact(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar Dan Fungsi",
                "level": "sedang",
                "soal": "Jika a² + b² = z dan ab = y, bentuk ekuivalen 4z + 8y adalah...",
                "pilihan": {"A": "2(a+b)²", "B": "2(2a+b)²", "C": "(4a+4b)²", "D": "(4a+8b)²", "E": "4(a+b)²"},
                "jawaban": "E",
                "pembahasan": "Karena 4z + 8y = 4(a² + b²) + 8ab = 4(a² + 2ab + b²) = 4(a+b)². Maka, jawabannya E.",
                "butuh_visual": False,
            }

            source = generator._latex_explanation_sources(question)[0]

            self.assertIn("4z+8y", source)
            self.assertIn(r"a^2+b^2", source)
            self.assertIn(r"\mbox{}\\Maka", source)

    def test_pk_latex_explanation_breaks_after_sentence_periods(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar Dan Fungsi",
                "level": "sedang",
                "soal": "Tentukan nilai x dari persamaan linear.",
                "pilihan": {"A": "1", "B": "2", "C": "3", "D": "4", "E": "5"},
                "jawaban": "B",
                "pembahasan": "Substitusi nilai ke persamaan. Hasilnya x = 2. Maka, jawaban yang tepat adalah B.",
                "butuh_visual": False,
            }

            source = generator._latex_explanation_sources(question)[0]

            self.assertIn(r"persamaan.\\Hasilnya", source)
            self.assertIn("anchor=center", source)


if __name__ == "__main__":
    unittest.main()
