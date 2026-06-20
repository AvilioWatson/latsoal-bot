import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path


def load_generator(data_root):
    os.environ["LATSOAL_DATA_ROOT"] = str(data_root)
    os.environ["LATSOAL_RENDER_ENGINE"] = "pil"
    os.environ.pop("GEMINI_API_KEY", None)
    import content_generator
    return importlib.reload(content_generator)


class ContentGeneratorTest(unittest.TestCase):
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
                "Aljabar dan Fungsi",
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

    def test_generate_content_auto_blocks_when_same_topic_examples_are_insufficient(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            with self.assertRaises(generator.InsufficientTopicExamplesError) as context:
                generator.generate_content(
                    "Pengetahuan Kuantitatif",
                    "Aljabar dan Fungsi",
                    "mudah",
                    mode="auto",
                    account="@quality",
                )

            self.assertEqual(context.exception.required, 3)
            self.assertEqual(context.exception.found, 0)
            self.assertIn("Butuh minimal 3 contoh", str(context.exception))

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
                    self.assertIn("#UTBK2026", caption_text)

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
                "topik": "Aljabar dan Fungsi",
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
                "topik": "Aljabar dan Fungsi",
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
            self.assertEqual(len(steps), 3)
            self.assertFalse(steps[1]["parts"][0]["formula"])
            self.assertTrue(steps[2]["parts"][1]["formula"])

            groups = generator._structured_explanation_groups(
                ImageDraw.Draw(image),
                question["pembahasan"],
                {
                    "explanation": generator._load_font(27, family="anthropic_sans"),
                    "formula": generator._load_font(26, family="anthropic_mono"),
                },
            )
            self.assertEqual(groups[0][0]["label"], "Langkah 1")
            text_rows = [
                row
                for group in groups
                for row in group
                if row["kind"] == "text"
            ]
            self.assertTrue(text_rows)
            self.assertGreaterEqual(text_rows[0]["height"], 40)

            labeled_steps = generator._build_explanation_steps(
                "Langkah 1: Tentukan nilai x.\n"
                "Langkah 2: Substitusikan nilai x.\n"
                "Kesimpulan: Jawaban yang benar adalah C."
            )
            self.assertEqual(len(labeled_steps), 3)
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

            self.assertEqual(
                rendered,
                "f⁻¹ dan g⁻¹, (f⁻¹∘ g⁻¹)(x)=2x-4, g(x)=(x-1)/(x+2)",
            )
            self.assertNotIn("$", rendered)
            self.assertNotIn(r"\frac", rendered)
            self.assertNotIn(r"\circ", rendered)

    def test_pil_text_converts_latex_fraction_choices(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))

            self.assertEqual(generator._latex_to_plain_text(r"$-\frac{5}{4}$"), "-5/4")
            self.assertEqual(generator._latex_to_plain_text(r"$\sqrt{40}=2\sqrt{10}$"), "√40=2√10")

    def test_symbolic_quadratic_parameter_does_not_render_cartesian_visual(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar dan Fungsi",
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
                "topik": "Aljabar dan Fungsi",
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
                "topik": "Aljabar dan Fungsi",
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
                "topik": "Aljabar dan Fungsi",
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
                "topik": "Aljabar dan Fungsi",
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
            self.assertNotIn(r"\mbox{}\\Maka", source)

    def test_pk_latex_explanation_breaks_after_sentence_periods(self):
        with tempfile.TemporaryDirectory() as tmp:
            generator = load_generator(Path(tmp))
            question = {
                "mapel": "Pengetahuan Kuantitatif",
                "topik": "Aljabar dan Fungsi",
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
