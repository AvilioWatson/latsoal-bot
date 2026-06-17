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
            self.assertTrue((run_dir / "metadata.json").exists())
            self.assertTrue((run_dir / "soal.json").exists())
            self.assertTrue((run_dir / "caption.txt").exists())
            self.assertTrue((run_dir / "thumbnail.png").exists())
            self.assertTrue((run_dir / "post-1.png").exists())
            self.assertTrue((run_dir / "pembahasan-1.jpg").exists())
            self.assertTrue((run_dir / "1.jpg").exists())
            from PIL import Image
            with Image.open(run_dir / "thumbnail.png") as image:
                self.assertEqual(image.size, (1080, 1080))
            with Image.open(run_dir / "1.jpg") as image:
                self.assertEqual(image.size, (1080, 1080))
            self.assertTrue(result["files"]["images"])
            self.assertTrue(all(Path(path).suffix.lower() == ".jpg" for path in result["files"]["images"]))
            self.assertTrue(Path(result["files"]["images"][0]).name == "1.jpg")
            self.assertTrue(result["files"]["thumbnail"])
            self.assertTrue(result["files"]["explanations"])

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
            self.assertIn("(160.0,135.4)", visual)


if __name__ == "__main__":
    unittest.main()
