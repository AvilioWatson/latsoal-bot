from .base import DEFAULT_PROFILE, RenderProfile
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
    return PROFILES.get(str(mapel or "").strip(), DEFAULT_PROFILE)
