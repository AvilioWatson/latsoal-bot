import re
from pathlib import Path

from .config import TAXONOMY


def slugify(value):
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")


SUBTEST_CODES = {
    slugify(mapel): code
    for mapel, code in TAXONOMY.get("subtest_codes", {}).items()
}
TOPIC_ALIASES = {
    (slugify(mapel), slugify(topic)): canonical
    for mapel, aliases in TAXONOMY.get("topic_aliases", {}).items()
    for topic, canonical in aliases.items()
}
CANONICAL_TOPICS = {
    (slugify(mapel), slugify(topic)): topic
    for mapel, topics in TAXONOMY.get("topics", {}).items()
    for topic in topics
}


def subtest_code(mapel):
    slug = slugify(mapel)
    return SUBTEST_CODES.get(slug, slug.upper() or "LAINNYA")


def canonical_topic(mapel, topic):
    raw_topic = topic or "umum"
    key = (slugify(mapel), slugify(raw_topic))
    return TOPIC_ALIASES.get(key, CANONICAL_TOPICS.get(key, raw_topic))


def build_storage_path(question, run_id):
    return Path(subtest_code(question.get("mapel"))) / slugify(canonical_topic(question.get("mapel"), question.get("topik"))) / run_id
