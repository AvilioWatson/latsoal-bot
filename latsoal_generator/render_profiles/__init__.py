from .base import RenderProfile
from .literasi_bahasa_indonesia import PROFILE as LITERASI_BAHASA_INDONESIA
from .literasi_bahasa_inggris import PROFILE as LITERASI_BAHASA_INGGRIS
from .pemahaman_bacaan_menulis import PROFILE as PEMAHAMAN_BACAAN_MENULIS
from .penalaran_matematika import PROFILE as PENALARAN_MATEMATIKA
from .penalaran_umum import PROFILE as PENALARAN_UMUM
from .pengetahuan_kuantitatif import PROFILE as PENGETAHUAN_KUANTITATIF
from .pengetahuan_pemahaman_umum import PROFILE as PENGETAHUAN_PEMAHAMAN_UMUM


PROFILES = {
    profile.subtest: profile
    for profile in [
        PENALARAN_UMUM,
        PENGETAHUAN_PEMAHAMAN_UMUM,
        PEMAHAMAN_BACAAN_MENULIS,
        LITERASI_BAHASA_INDONESIA,
        LITERASI_BAHASA_INGGRIS,
        PENGETAHUAN_KUANTITATIF,
        PENALARAN_MATEMATIKA,
    ]
}


def get_render_profile(mapel):
    subtest = str(mapel or "").strip()
    profile = PROFILES.get(subtest)
    if profile is None:
        supported = ", ".join(sorted(PROFILES))
        raise ValueError(
            f"Generator gambar belum tersedia untuk subtes '{subtest or 'kosong'}'. "
            f"Subtes yang didukung: {supported}."
        )
    return profile
