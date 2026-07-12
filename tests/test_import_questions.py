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


def passage_question(number, total=3, passage_id="PM-001"):
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
        "teks": "Sebuah UMKM mencatat pertumbuhan produksi secara linear selama beberapa bulan dan membandingkannya dengan biaya tetap.",
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


def write_saved_question(data_root, run_id, item):
    saved_dir = data_root / "saved" / run_id
    bank_dir = data_root / "bank"
    saved_dir.mkdir(parents=True)
    bank_dir.mkdir(parents=True)
    (saved_dir / "metadata.json").write_text(
        json.dumps({"run_id": run_id, "question": item}, ensure_ascii=False),
        encoding="utf-8",
    )
    (bank_dir / "index.json").write_text(
        json.dumps([{"run_id": run_id, "status": "saved", "path": f"saved/{run_id}"}]),
        encoding="utf-8",
    )


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

    def test_passage_subtest_requires_question_count_to_match_total(self):
        with tempfile.TemporaryDirectory() as tmp:
            items = [passage_question(1, total=3), passage_question(2, total=3)]
            result, payload = run_importer(Path(tmp), {"questions": items}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["invalid"], 2)
            self.assertIn("harus dipakai sesuai total_soal", payload["items"][0]["errors"][0])

    def test_passage_subtest_accepts_variable_question_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            items = [passage_question(index, total=3) for index in range(1, 4)]
            result, payload = run_importer(Path(tmp), {"questions": items}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["invalid"], 0)
            self.assertEqual(payload["items"][0]["question"]["bacaan"]["total_soal"], 3)

    def test_passage_subtest_is_saved_as_one_group_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            items = [passage_question(index, total=3) for index in range(1, 4)]
            result, payload = run_importer(data_root, {"questions": items}, "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(payload["imported"]), 1)
            self.assertEqual(payload["imported"][0]["group_total_soal"], 3)
            self.assertEqual(payload["imported"][0]["indices"], [0, 1, 2])

            saved_question = json.loads(Path(payload["imported"][0]["path"], "soal.json").read_text(encoding="utf-8"))
            self.assertEqual(saved_question["group_total_soal"], 3)
            self.assertEqual(
                [item["nomor_soal"] for item in saved_question["question_group"]],
                [1, 2, 3],
            )
            self.assertEqual(saved_question["question_group"][1]["soal"], items[1]["soal"])

    def test_same_passage_text_with_different_ids_is_saved_as_one_group_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            items = [passage_question(index, total=3, passage_id=f"PM-00{index}") for index in range(1, 4)]
            result, payload = run_importer(data_root, {"questions": items}, "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["invalid"], 0)
            self.assertEqual(len(payload["imported"]), 1)
            self.assertEqual(payload["imported"][0]["indices"], [0, 1, 2])
            self.assertEqual(payload["imported"][0]["group_total_soal"], 3)

            saved_question = json.loads(Path(payload["imported"][0]["path"], "soal.json").read_text(encoding="utf-8"))
            self.assertEqual(saved_question["bacaan"]["id"], "PM-001")
            self.assertEqual(saved_question["group_total_soal"], 3)
            self.assertEqual(len(saved_question["question_group"]), 3)

    def test_passage_exact_duplicate_requires_same_passage_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            saved = passage_question(1, total=4, passage_id="PPU-001")
            write_saved_question(data_root, "20990101-010101", saved)
            items = [passage_question(index, total=4, passage_id="PPU-001") for index in range(1, 5)]
            for item in items:
                item["bacaan"]["judul"] = "Survei Transportasi"
                item["bacaan"]["teks"] = (
                    "Komunitas sekolah mencatat perubahan pilihan transportasi siswa setelah "
                    "jadwal masuk pagi disesuaikan selama satu semester."
                )

            result, payload = run_importer(data_root, {"questions": items}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["exact_duplicate"], 0)
            self.assertEqual(payload["summary"]["invalid"], 0)

    def test_import_rejects_incomplete_passage_group_after_duplicate_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_root = Path(tmp)
            items = [passage_question(index, total=3, passage_id="PPU-001") for index in range(1, 4)]
            write_saved_question(data_root, "20990101-010101", items[0])

            result, payload = run_importer(data_root, {
                "questions": items,
                "selected_indices": [0, 1, 2],
                "confirmed_similar_indices": [1, 2],
            }, "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["exact_duplicate"], 1)
            self.assertEqual(payload["imported"], [])
            self.assertEqual(
                sorted(item["index"] for item in payload["rejected"]),
                [0, 1, 2],
            )
            self.assertTrue(any("Grup bacaan tidak lengkap" in item["reason"] for item in payload["rejected"]))

    def test_passage_subtest_accepts_single_question_passage(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, payload = run_importer(Path(tmp), {"questions": [passage_question(1, total=1)]}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["invalid"], 0)
            self.assertNotIn("bacaan", payload["items"][0]["question"])
            self.assertIn("Sebuah UMKM mencatat", payload["items"][0]["question"]["soal"])

    def test_passage_subtest_accepts_single_question_without_passage(self):
        with tempfile.TemporaryDirectory() as tmp:
            item = passage_question(1, total=1)
            item.pop("bacaan")
            result, payload = run_importer(Path(tmp), {"questions": [item]}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["invalid"], 0)
            self.assertNotIn("bacaan", payload["items"][0]["question"])

    def test_passage_subtest_saves_single_question_as_standalone(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, payload = run_importer(Path(tmp), {"questions": [passage_question(1, total=1)]}, "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(payload["imported"]), 1)
            self.assertEqual(payload["imported"][0]["group_total_soal"], 1)

            saved_question = json.loads(Path(payload["imported"][0]["path"], "soal.json").read_text(encoding="utf-8"))
            self.assertNotIn("bacaan", saved_question)
            self.assertNotIn("question_group", saved_question)
            self.assertNotIn("group_total_soal", saved_question)
            self.assertIn("Sebuah UMKM mencatat", saved_question["soal"])

    def test_passage_subtest_warns_but_accepts_total_above_six(self):
        with tempfile.TemporaryDirectory() as tmp:
            items = [passage_question(index, total=7) for index in range(1, 8)]
            result, payload = run_importer(Path(tmp), {"questions": items}, "--validate-only", "--skip-render")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(payload["summary"]["invalid"], 0)
            self.assertTrue(any("lebih dari 6" in message for message in payload["items"][0]["warnings"]))


if __name__ == "__main__":
    unittest.main()
