import base64
import builtins
import json
import os
import re
from os.path import join

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import clean_url, get_valid_filename, get_ext_from_url


class rtve_es(BaseService):
    DEMO_URLS = [
        "https://www.rtve.es/play/videos/valle-salvaje/episodio-8/16259694/",
        "https://www.rtve.es/play/videos/telediario-2/inteligencia-artificial-centra-debates-davos-entre-lideres-empresariales-expertos/16421776/",
        "https://www.rtve.es/play/videos/valle-salvaje/",
        "https://www.rtve.es/play/videos/los-pilares-del-tiempo/",
    ]

    ZTNR_URL = "https://ztnr.rtve.es/ztnr"
    MANIFEST_RED_URL = ZTNR_URL + "/{asset_id}.{manifest_type}"
    MANIFEST_PNG_URL = ZTNR_URL + "/movil/thumbnail/rtveplayw/videos/{asset_id}.png"
    VIDEO_INFO_URL = "https://api-ztnr.rtve.es/api/videos/{asset_id}.json"
    TOKEN_URL = "https://api.rtve.es/api/token/{asset_id}"
    SUBTITLES_URL = "https://api2.rtve.es/api/videos/{asset_id}/subtitulos.json"
    BASE_URL = "https://www.rtve.es"

    MANIFEST_FORMATS = ["mpd", "mp4", "m3u8"]
    NON_MANIFEST_TYPES = ["mp4"]
    ALLOWED_COLLECTIONS = ["capitulos", "clips"]

    @staticmethod
    def test_service():
        main_service.run_service(rtve_es)

    @staticmethod
    def get_additional_params(additional):
        additional_params = BaseService.get_additional_params(additional)
        manifest_url = additional.get("manifest_url", None)
        if manifest_url is not None:
            manifest_url = clean_url(manifest_url)
            additional_params = [(
                "BASE_URL", lambda s: s.format(value=manifest_url)
            )] + additional_params
        return additional_params

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return rtve_es

    @staticmethod
    def get_keys(challenge, additional):
        headers = {}
        if additional.get("drm_token", None) not in ["", None]:
            headers = {"x-axdrm-message": additional["drm_token"]}
        licence = requests.post(
            additional["license_url"], data=challenge,
            headers=headers
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def read_byte(data, state):
        if state['bits_length'] == 0:
            if state['position'] >= len(data):
                return -1
            state['bits'] = data[state['position']]
            state['position'] += 1
            state['bits_length'] = 8

        state['bits_length'] -= 8
        return (state['bits'] >> state['bits_length']) & 0xFF

    @staticmethod
    def skip(data, state, count):
        for _ in range(count):
            rtve_es.read_byte(data, state)

    @staticmethod
    def read_chunk(data, state):
        bytes_data = data[state['position']:state['position'] + 4]
        state['position'] += 4
        length = int.from_bytes(bytes_data, byteorder='big')

        chunk_type = ''
        for _ in range(4):
            byte = rtve_es.read_byte(data, state)
            char = None if byte == -1 else chr(byte)

            if not char:
                break
            chunk_type += char

        chunk_data = [0] * length
        index = 0
        while index < length:
            byte = rtve_es.read_byte(data, state)
            if byte == -1:
                break
            chunk_data[index] = byte
            index += 1
        assert index == length

        rtve_es.skip(data, state, 4)
        return {'type': chunk_type, 'data': chunk_data}

    @staticmethod
    def translate(input_string):
        sources = []
        data = base64.b64decode(input_string)
        state = {'position': 0, 'bits': 0, 'bits_length': 0}
        rtve_es.skip(data, state, 8)
        chunk = rtve_es.read_chunk(data, state)

        while chunk['type'] != 'IEND':
            if chunk['type'] == 'tEXt':
                text = ''.join(chr(byte) for byte in chunk['data'] if byte != 0)
                text = text if '%%' not in text else text.split('#')[0] + '#' + text.split('#')[1].split('%%')[1]
                item = text

                hash_index = item.index('#')
                text = item[:hash_index]
                alphabet = ''
                char_index = 0
                step = 0
                for i in range(len(text)):
                    if step == 0:
                        alphabet += text[i]
                        char_index = (char_index + 1) % 4
                        step = char_index
                    else:
                        step -= 1

                text = item[hash_index + 1:]
                decoded = ''
                char_index = 0
                position = 3
                counter = 1
                number = 0

                for i in range(len(text)):
                    if char_index == 0:
                        number = int(text[i]) * 10
                        char_index = 1
                    else:
                        if position == 0:
                            number += int(text[i])
                            decoded += alphabet[number]
                            position = (counter + 3) % 4
                            char_index = 0
                            counter += 1
                        else:
                            position -= 1

                sources.append(decoded)
            chunk = rtve_es.read_chunk(data, state)
        return sources

    @staticmethod
    def fix_manifest(source_element, manifest_url, manifest_content, asset_content, manifest_type):
        is_valid_manifest = manifest_type not in rtve_es.NON_MANIFEST_TYPES
        if builtins.CONFIG.get("BASIC", False) is True and is_valid_manifest:
            return manifest_url
        if manifest_type in ["m3u8"]:
            return manifest_url

        output_path = str(join(source_element.collection, source_element.element))
        if not os.path.exists(output_path):
            os.makedirs(output_path)

        if not is_valid_manifest:
            output_path = join(output_path, 'video.m3u8')
            content_duration = asset_content.get("duration", 1000)
            m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
            m3u8_content += f'#EXTINF:{content_duration / 1000},\n'
            m3u8_content += f'{manifest_url}\n'

            m3u8_content += "#EXT-X-ENDLIST\n"
            with open(output_path, "w") as f:
                f.write(m3u8_content)
            return output_path

        output_path = join(output_path, f'master.{manifest_type}')
        with open(output_path, "w") as f:
            f.write(manifest_content)
        return output_path

    @staticmethod
    def get_video_data(source_element):
        try:
            asset_id = source_element.url.split("/")[-1]
            assert asset_id.isdigit()
        except:
            asset_id = None
        if asset_id is None:
            response = requests.get(source_element.url).text
            try:
                asset_id = re.findall(r'\s*data-idasset=[\s\'"]*([^\s,\'"L<>]+)', response)[0].lower()
            except:
                asset_id = None

            if asset_id is None:
                asset_id = re.findall(r'[\'"]idAsset[\'"]:[\'"\s]*([^\s,\'"]+)', response)[0].lower()

        response = requests.get(rtve_es.VIDEO_INFO_URL.format(asset_id=asset_id))
        response = json.loads(response.content.decode())
        try:
            response = response["page"]["items"]
            assert len(response) > 0
        except:
            response = []

        asset_content = None
        for item in response:
            if item.get("id", "") != asset_id:
                continue
            asset_content = item

        if asset_content is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            title = ""
            for f in ["longTitle", "title", "shortTitle"]:
                if asset_content.get(f, None) not in ["", None]:
                    title = asset_content[f]
                    break

            if len(title) == 0:
                title = f"Video {asset_id}"
            source_element.element = get_valid_filename(title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rtve_es.__name__
            )

        has_drm = asset_content.get("hasDRM", False)
        try:
            png_manifests = rtve_es.translate(requests.get(
                rtve_es.MANIFEST_PNG_URL.format(asset_id=asset_id)
            ).text)
        except:
            png_manifests = []

        asset_manifest = None
        manifest_content = None
        asset_type = None
        for manifest_type in rtve_es.MANIFEST_FORMATS:
            if asset_manifest is not None:
                break
            is_valid_manifest = manifest_type not in rtve_es.NON_MANIFEST_TYPES

            possible_manifests = [rtve_es.MANIFEST_RED_URL.format(asset_id=asset_id, manifest_type=manifest_type)]
            for png_manifest in png_manifests:
                temp_manifest = clean_url(png_manifest).split(".")[-1]
                if f"{manifest_type}" in temp_manifest:
                    possible_manifests += [png_manifest]
                    break

            for manifest_url in possible_manifests:
                status_code = requests.head(manifest_url).status_code
                if 300 <= status_code < 400:
                    response = requests.get(manifest_url, allow_redirects=False)
                    manifest_url = response.headers.get("location", None)
                    status_code = requests.head(manifest_url).status_code

                if status_code == 403:
                    raise CustomException(ERR_MSG.format(
                        type=f'{USER_ERROR}',
                        url=source_element.url,
                        reason="Need Spanish IP to access content",
                        solution="Use a VPN"
                    ))

                if 200 <= status_code < 300:
                    if is_valid_manifest:
                        manifest_content = requests.get(manifest_url).text
                    asset_manifest = manifest_url
                    asset_type = manifest_type
                    break

        if asset_manifest is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        if asset_manifest in png_manifests:
            has_drm = "_drm" in asset_manifest
        additional = {}
        is_valid_manifest = asset_type not in rtve_es.NON_MANIFEST_TYPES
        pssh_value = None

        if has_drm:
            if is_valid_manifest:
                try:
                    pssh_value = get_pssh_from_cenc_pssh(manifest_content)
                except:
                    pssh_value = None

                response = requests.get(rtve_es.TOKEN_URL.format(asset_id=asset_id))
                response = json.loads(response.content.decode())
                try:
                    license_url = response["widevineURL"]
                    assert license_url not in ["", None]
                except:
                    license_url = None

                if license_url is None:
                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=source_element.url,
                        reason=f"DRM not supported. Widevine wasn't found",
                        solution="Do not attempt to download it"
                    ))

                if "AxDrmMessage=" not in license_url:
                    additional["drm_token"] = response["token"]
                    license_url = clean_url(license_url)
                additional["license_url"] = license_url

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {asset_manifest}",
                    solution=f"Extend the {rtve_es.__name__} service"
                ))

        original_manifest = asset_manifest
        asset_manifest = rtve_es.fix_manifest(
            source_element, asset_manifest, manifest_content,
            asset_content, asset_type
        )
        if original_manifest != asset_manifest and is_valid_manifest:
            additional["manifest_url"] = original_manifest

        try:
            response = requests.get(rtve_es.SUBTITLES_URL.format(asset_id=asset_id))
            response = json.loads(response.content.decode())
            subtitles = response["page"]["items"]
            assert len(subtitles) > 0
        except:
            subtitles = []

        srt_index = 0
        srts = []
        srt_path = join(source_element.collection, source_element.element)
        for subtitle in subtitles:
            try:
                srt_index += 1
                srt_url = subtitle['src']
                assert srt_url.startswith("http")

                srt_title = subtitle.get("lang", "")
                srt_title = f'subtitle_{srt_index} {srt_title}'

                srts.append((False, BaseElement(
                    url=srt_url,
                    collection=srt_path,
                    element=f'{get_valid_filename(srt_title)}{get_ext_from_url(srt_url)}'
                )))
            except:
                pass

        additional["SUBTITLES"] = srts
        return asset_manifest, pssh_value, additional

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/play/videos/" not in collection_url:
            return None
        if "/play/videos/directo/" in collection_url:
            return None
        slash = collection_url.split("/play/videos/")[1].count("/")

        if slash >= 2:
            return [BaseElement(url=collection_url)]

        collection_title = collection_url.split("/play/videos/")[1].split("/")[0]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rtve_es.__name__
            ),
            get_valid_filename(collection_title)
        )

        page_response = requests.get(collection_url).text
        page_soup = BeautifulSoup(page_response, 'html5lib')

        modulos = page_soup.find_all(
            'a',
            attrs={'data-module': lambda x: x and "/modulos/" in x}
        )
        modulo_elements = []
        for modulo in modulos:
            modulo_type = None
            for a in rtve_es.ALLOWED_COLLECTIONS:
                if f'/{a}/' in modulo["data-module"]:
                    modulo_type = a
                    break
            if modulo_type is None:
                continue

            modulo_url = modulo["data-module"]
            if not modulo_url.startswith("http"):
                modulo_url = rtve_es.BASE_URL + modulo_url
            modulo_name = modulo.getText().strip()
            modulo_elements.append((modulo_url, modulo_name, modulo_type))

        seasons = []
        for modulo_url, modulo_name, modulo_type in modulo_elements:
            modulo_response = requests.get(modulo_url).text
            modulo_soup = BeautifulSoup(modulo_response, 'html5lib')
            sub_modulos = modulo_soup.find_all(
                'a',
                attrs={'href': lambda x: x and f"/modulos/{modulo_type}/" in x}
            )

            sub_modulo_elements = []
            for s in sub_modulos:
                sub_modulo_url = s["href"]
                if not sub_modulo_url.startswith("http"):
                    sub_modulo_url = rtve_es.BASE_URL + sub_modulo_url
                sub_modulo_name = s.getText().strip()
                sub_modulo_elements.append((sub_modulo_url, sub_modulo_name))

            if len(sub_modulo_elements) == 0:
                seasons.append((modulo_url, modulo_name))
            else:
                seasons.extend(sub_modulo_elements)

        season_index = 0
        collection = []
        for season_url, season_name in seasons:
            season_index += 1
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            season_name = get_valid_filename(f'Season {season_index} {season_name}')
            page_index = 0
            episode_index = 0
            visited = []
            episode_stop = False

            while not episode_stop:
                page_index += 1
                episodes_response = requests.get(
                    season_url, params={"page": page_index}
                )
                episodes_soup = BeautifulSoup(episodes_response.text, 'html5lib')

                status_code = episodes_response.status_code
                episodes = episodes_soup.find_all(
                    'a',
                    attrs={'href': lambda x: x and f"{rtve_es.BASE_URL}/play/videos/" in x}
                )

                if len(episodes) == 0 or status_code < 200 or status_code >= 300:
                    break

                for episode in episodes:
                    episode_url = episode["href"]
                    if episode_url in visited:
                        episode_stop = True
                        break
                    visited.append(episode_url)

                    episode_index += 1
                    check = check_range(False, season_index, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    try:
                        episode_id = clean_url(episode_url).split("/")[-1]
                        assert episode_id.isdigit()
                    except:
                        episode_id = None

                    episode_name = ""
                    if episode_id is not None:
                        data_share = episodes_soup.find_all(
                            lambda tag: tag.has_attr('data-idasset') and
                                        tag['data-idasset'] == episode_id and
                                        tag.has_attr('data-share')
                        )

                        try:
                            episode_name = json.loads(data_share[0]["data-share"])["contentTitle"]
                            assert len(episode_name) > 0
                        except:
                            episode_name = ""

                    episode_name = get_valid_filename(f'Episode {episode_index} {episode_name}')
                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(collection_title, season_name),
                        element=episode_name
                    ))

        return collection
