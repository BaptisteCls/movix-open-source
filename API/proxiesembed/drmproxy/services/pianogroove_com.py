import builtins
import json
import re
from html import unescape
from os.path import join

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_last_path, get_valid_filename, get_ext_from_url, get_base_url, get_nr_paths


class pianogroove_com(BaseService):
    DEMO_URLS = [
        "https://www.pianogroove.com/jazz-piano-lessons/jazz-piano-foundations/",
        "https://www.pianogroove.com/bossa-nova-lessons/jovino-santos-neto-masterclasses/",
        "https://www.pianogroove.com/blues-piano-lessons/blues-left-hand-shuffle-patterns/",
        "https://www.pianogroove.com/blues-piano-lessons/minor-blues-introduction/",
    ]

    ADMIN_PHP_URL = 'https://www.pianogroove.com/wp-admin/admin-ajax.php'
    VIMEO_URL = 'https://vimeo.com'

    @staticmethod
    def test_service():
        main_service.run_service(pianogroove_com)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return pianogroove_com

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {pianogroove_com.__name__} service'
        )

    @staticmethod
    def get_key_url(manifest):
        response = requests.get(manifest).content.decode()
        response = re.findall(r'(https?://\S+)', response)[-1]

        response = requests.get(response).content.decode()
        response = re.findall(r',URI="([^"]+)"', response)

        if len(response) == 0:
            return None
        return response[0]

    @staticmethod
    def get_video_data(source_element):
        response = requests.get(source_element.url).content.decode()
        response = re.findall(r'data-item="([^"]+)"', response)
        if len(response) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="No content has been found",
                solution="Do not attempt to download it"
            ))

        response = json.loads(unescape(response[0]))
        response["sources"] = sorted(response["sources"], key=lambda r: r.get("type", ""))
        manifest = None
        orig_duration = response.get("duration", None)

        for source in response["sources"]:
            if source.get("src", None) is None:
                continue
            manifest = source
            break

        if source_element.element is None:
            source_element.element = response.get("fv_title", get_last_path(source_element.url))
            source_element.element = get_valid_filename(source_element.element)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                pianogroove_com.__name__
            )

        subtitles = []
        if response.get("chapters", None) is not None:
            srt_ext = get_ext_from_url(response["chapters"])

            subtitles.append((False, BaseElement(
                url=response["chapters"],
                collection=join(source_element.collection, source_element.element),
                element=f'subtitle_1_chapters{srt_ext}'
            )))

        key = None
        if "mp4" in manifest["type"].lower():
            response = requests.post(
                pianogroove_com.ADMIN_PHP_URL,
                headers={'Referer': source_element.url},
                data={
                    'action': 'fv_fp_get_vimeo',
                    'sources[0][src]': manifest["src"]
                }
            ).content.decode()

            response = re.findall(r'<FVFLOWPLAYER>(.+)</FVFLOWPLAYER>', response)[0]
            response = json.loads(response)
            vimeo_duration = response.get("video", {}).get("duration", None)
            if vimeo_duration != orig_duration:
                subtitles = []

            response = response["request"]
            index = len(subtitles)
            for text_track in response.get("text_tracks", []):
                index += 1
                srt_url = f'{pianogroove_com.VIMEO_URL}{text_track["url"]}'
                srt_ext = get_ext_from_url(srt_url)

                subtitles.append((False, BaseElement(
                    url=srt_url,
                    collection=join(source_element.collection, source_element.element),
                    element=f'subtitle_{index}_{text_track["lang"]}{srt_ext}'
                )))

            response = response["files"]
            for file in response:
                stream = response[file]
                manifest = stream["cdns"][stream["default_cdn"]]["url"]
                manifest = manifest.replace("master.json", "master.mpd")
                break
        else:
            manifest = manifest["src"]

            key_url = pianogroove_com.get_key_url(manifest)
            if key_url is not None:
                requests.post(
                    pianogroove_com.ADMIN_PHP_URL,
                    data={
                        'action': 'fv_player_performance',
                        'summary': manifest
                    }
                )
                response = requests.get(key_url)
                key = response.content.hex()

        return manifest, None, {
            "AES": {"KEY": key},
            "SUBTITLES": subtitles
        }

    @staticmethod
    def get_collection_elements(collection_url):
        if get_nr_paths(collection_url.split(get_base_url(collection_url))[1]) != 2:
            return None

        response = requests.get(collection_url).content.decode()
        if "#course-info" in response:
            content_title = get_valid_filename(get_last_path(collection_url))
            collection = []
            index = 1
            if check_range(False, None, index) not in [True, False]:
                collection.append(BaseElement(
                    url=collection_url,
                    collection=join(join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        pianogroove_com.__name__
                    ), content_title),
                    element=f'Course_{index}'
                            f'_'
                            f'Introduction'
                ))

            soup = BeautifulSoup(response, 'html5lib')
            for li in soup.find_all('li'):
                node = li.find('div', class_=True)
                if not node:
                    continue
                node = node.find('input', {'data-course_name': True})
                if not node:
                    continue

                title = unescape(node["data-course_name"])
                node = li.find('a')
                if not node:
                    continue

                index += 1
                check = check_range(False, None, index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                collection.append(BaseElement(
                    url=node["href"],
                    collection=join(join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        pianogroove_com.__name__
                    ), content_title),
                    element=f'Course_{index}'
                            f'_'
                            f'{get_valid_filename(title)}'
                ))

            return collection
        return [BaseElement(url=collection_url)]
