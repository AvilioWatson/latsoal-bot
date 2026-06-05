import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path


def load_generator(data_root):
    os.environ["LATSOAL_DATA_ROOT"] = str(data_root)
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
            run_dir = data_root / "outputs" / result["run_id"]
            self.assertTrue((run_dir / "metadata.json").exists())
            self.assertTrue((run_dir / "soal.json").exists())
            self.assertTrue((run_dir / "caption.txt").exists())
            self.assertTrue((run_dir / "post-1.png").exists())
            self.assertTrue((run_dir / "pembahasan-1.jpg").exists())
            self.assertTrue(result["files"]["images"])
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
                    run_dir = data_root / "outputs" / result["run_id"]
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


if __name__ == "__main__":
    unittest.main()
