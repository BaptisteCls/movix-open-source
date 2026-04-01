import base64
import builtins
import os
import re

import requests
from pywidevine import PSSH, Cdm, Device

from utils.constants.macros import DEFAULT_WVD_PATH, PLAYREADY_SCHEME_ID


def search_cdm_wvd():
    for wvd_file in os.listdir("."):
        if not wvd_file.endswith(".wvd"):
            continue
        return wvd_file
    return DEFAULT_WVD_PATH


def init_cdm(pssh_value):
    try:
        if pssh_value is None:
            raise
        device = Device.load(builtins.CONFIG["CDM_WVD_FILE_PATH"])
        assert device.security_level == 3
    except:
        return None, None, None

    pssh_value = PSSH(pssh_value)
    if pssh_value.system_id == PSSH.SystemId.PlayReady:
        pssh_value.to_widevine()

    cdm = Cdm.from_device(device)
    cdm_session_id = cdm.open()
    challenge = cdm.get_license_challenge(cdm_session_id, pssh_value)
    return cdm, cdm_session_id, challenge


def close_cdm(cdm, cdm_session_id, response):
    cdm.parse_license(cdm_session_id, response)
    keys = []
    for key in cdm.get_keys(cdm_session_id):
        if "CONTENT" in key.type:
            keys += [f"{key.kid.hex}:{key.key.hex()}"]
    cdm.close(cdm_session_id)
    return keys


def get_pssh_from_init(init_url):
    content = requests.get(init_url).content
    offsets = []
    offset = 0

    while True:
        offset = content.find(b'pssh', offset)
        if offset == -1:
            break

        size = int.from_bytes(content[offset - 4:offset], byteorder='big')
        pssh_offset = offset - 4

        offsets.append(content[pssh_offset:pssh_offset + size])
        offset += size

    pssh_list = [base64.b64encode(wv_offset).decode() for wv_offset in offsets]
    for pssh in pssh_list:
        if 70 < len(pssh) < 190:
            return pssh
    return None


def get_pssh_from_default_kid(manifest_content, xml_node="cenc:default_KID", default_kid=None):
    if default_kid is None:
        default_kid = re.search(fr'{xml_node}="([a-fA-F0-9-]+)"', manifest_content).group(1)
        default_kid = default_kid.replace('-', '')
    pssh = f'000000387073736800000000edef8ba979d64acea3c827dcd51d21ed000000181210{default_kid}48e3dc959b06'
    pssh = base64.b64encode(bytes.fromhex(pssh)).decode()
    return pssh


def get_pssh_from_cenc_pssh(manifest_content, xml_node="cenc:pssh"):
    return str(min(re.findall(
        fr'<[^<>]*{xml_node}[^<>]*>(.*?)</[^<>]*{xml_node}[^<>]*>',
        manifest_content
    ), key=len))


def get_pssh_from_playready(manifest_content):
    psshs = re.findall(
        fr'<ProtectionHeader[^<>"]*"[^<>"]*{PLAYREADY_SCHEME_ID}[^<>"]*"[^<>]*>(.*?)</ProtectionHeader>',
        manifest_content,
        re.DOTALL | re.IGNORECASE
    )
    return str(min(psshs, key=len))
