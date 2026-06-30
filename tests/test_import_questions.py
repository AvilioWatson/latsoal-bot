import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def question(stem="Jika semua peserta belajar, simpulan yang benar adalah?"):
    return {
        "mapel": "Penalaran Umum",
        "kelompok_tes": "TPS",
        "topik": "Penalaran Deduktif",
        "level": "sedang",
        "soal": stem,
        "pilihan": {
            "A": "Semua peserta lulus.",
            "B": "Sebagian peserta belajar.",
            "C": "Tidak ada peserta belajar.",
            "D": "Semua peserta menyerah.",
            "E": "Tidak dapat disimpulkan.",
        },
        "jawaban": "B",
        "pembahasan": "Premis menyatakan seluruh peserta belajar sehingga pilihan B paling aman.",
        "konsep_kunci": "Penalaran deduktif",
        "tips_pengerjaan": "Gunakan hanya informasi pada premis.",
        "butuh_visual": False,
        "deskripsi_visual": "",
        "sumber_pdf": {"nama_file": "", "halaman": ""},
    }


def passage_question(number, total=5, passage_id="PM-001"):
    item = question(f"Berdasarkan bacaan, pernyataan nomor {number} yang paling tepat adalah?")
    item["mapel"] = "Penalaran Matematika"
    item["kelompok_tes"] = "Tes Literasi"
    item["topik"] = "Aljabar Dan Fungsi"
    item["pilihan"] = {
        "A": f"Pernyataan benar {number}.",
        "B": f"Pernyataan keliru {number}.",
        "C": f"Pernyataan tidak relevan {number}.",
        "D": f"Pernyataan terlalu luas {number}.",
        "E": f"Pernyataan bertentangan {number}.",
    }
    item["bacaan"] = {
        "id": passage_id,
        "judul": "Model Pertumbuhan",
        "teks": "Sebuah UMKM mencatat pertumbuhan produksi secara linear selama lima bulan dan membandingkannya dengan biaya tetap.",
        "bahasa": "id",
        "nomor_soal": number,
        "total_soal": total,
        "sumber_pdf": {"nama_file": "", "halaman": ""},
    }
    return item


def run_importer(data_root, payload, *args):
    environment = {
        **os.environ,
        "LATSOAL_DATA_ROOT": str(data_root),
        "LATSOAL_RENDER_ENGINE": "pil",
        "PYTHONIOENCODING": "utf-8",
    }
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "import_questions.py"), "-", *args],
        cwd=ROOT,
        env=environment,
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        check=False,
    )
    return result, json.loads(result.stdout)


class ImportQuestionsTest(unittest.TestCase):
    def test_batch_marks_later_similar_question_for_confirmation(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = question()
            second = question("Jika semua peserta rajin belajar, simpulan yang benar adalah?")
            result, payload = run_importer(Path(tmp), {"questions": [first, second]}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["items"][0]["status"], "valid")
            self.assertEqual(payload["items"][1]["status"], "similar")
            self.assertEqual(payload["items"][1]["dedup"]["matched_batch_index"], 0)

    def test_similar_question_requires_confirmation_before_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            questions = [question(), question("Jika semua peserta rajin belajar, simpulan yang benar adalah?")]
            result, payload = run_importer(Path(tmp), {
                "questions": questions,
                "selected_indices": [0, 1],
                "confirmed_similar_indices": [],
            }, "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(payload["imported"]), 1)
            self.assertEqual(payload["rejected"][0]["index"], 1)

    def test_exact_duplicate_in_batch_is_not_selectable(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, payload = run_importer(Path(tmp), {"questions": [question(), question()]}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["items"][1]["status"], "exact_duplicate")
            self.assertFalse(payload["items"][1]["selectable"])

    def test_unknown_topic_is_normalized_without_invalidating_question(self):
        with tempfile.TemporaryDirectory() as tmp:
            item = question()
            item["mapel"] = "Pengetahuan Kuantitatif"
            item["topik"] = "Judul Sub Topik Dari PDF"
            result, payload = run_importer(Path(tmp), {"questions": [item]}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["items"][0]["status"], "valid")
            self.assertEqual(payload["items"][0]["question"]["topik"], "Aljabar Dan Fungsi")
            self.assertTrue(payload["items"][0]["warnings"])

    def test_empty_topic_is_normalized_without_invalidating_question(self):
        with tempfile.TemporaryDirectory() as tmp:
            item = question()
            item["topik"] = ""
            result, payload = run_importer(Path(tmp), {"questions": [item]}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["items"][0]["status"], "valid")
            self.assertEqual(payload["items"][0]["question"]["topik"], "Penalaran Induktif")
            self.assertTrue(payload["items"][0]["warnings"])

    def test_passage_subtest_requires_exactly_five_questions_per_passage(self):
        with tempfile.TemporaryDirectory() as tmp:
            items = [passage_question(index) for index in range(1, 5)]
            result, payload = run_importer(Path(tmp), {"questions": items}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["invalid"], 4)
            self.assertIn("harus dipakai tepat 5 soal", payload["items"][0]["errors"][0])

    def test_passage_subtest_accepts_five_question_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            items = [passage_question(index) for index in range(1, 6)]
            result, payload = run_importer(Path(tmp), {"questions": items}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["invalid"], 0)
            self.assertEqual(payload["items"][0]["question"]["bacaan"]["total_soal"], 5)


if __name__ == "__main__":
    unittest.main()
