import builtins
import json
import re
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_default_kid, get_pssh_from_playready
from utils.tools.common import get_valid_filename, clean_url


class ninateka_pl(BaseService):
    DEMO_URLS = [
        "https://ninateka.pl/movies,1/kompozycje-przestrzenne-katarzyny-kobro--jozef-robakowski,6349",
        "https://ninateka.pl/series,2/zubr-pompik-odcinki,28044/odcinek-13,S01E13,11171",
        "https://ninateka.pl/audio,153683/mistrz-i-malgorzata--michail-bulhakow-odcinki,36460/odcinek-2,S01E02,5610",
        "https://ninateka.pl/series,2/pamietnik-florki-odcinki,48956",
        "https://ninateka.pl/audio,153683/proces--franz-kafka-odcinki,24524",
    ]

    PLAYLIST_URL = 'https://ninateka.pl/api/products/{video_id}/{video_type}/playlist'
    VODS_URL = 'https://ninateka.pl/api/products/vods/{video_id}'
    SEASONS_URL = 'https://ninateka.pl/api/products/vods/serials/{show_id}/seasons'
    EPISODES_URL = 'https://ninateka.pl/api/products/vods/serials/{show_id}/seasons/{season_id}/episodes'
    SHOW_URL = 'https://ninateka.pl/api/products/vods/serials/{show_id}'

    @staticmethod
    def test_service():
        main_service.run_service(ninateka_pl)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return ninateka_pl

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        video_id = source_element.url.split(",")[-1]
        video_type = "videos"
        if "/audio," in source_element.url:
            video_type = "audios"

        response = requests.get(
            ninateka_pl.PLAYLIST_URL.format(
                video_id=video_id,
                video_type=video_type
            ),
            params={
                'videoType': 'MOVIE',
                'platform': 'BROWSER'
            }
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        error = response.get("code", "").lower()

        if 400 <= status_code < 500 or "not_exists" in error:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        drm = response.get("drm", {})
        if drm is None:
            drm = {}
        drms = [d.lower() for d in drm.keys()]
        has_drm = len(drms) > 0

        license_url = None
        if has_drm:
            if "widevine" not in drms:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))
            license_url = drm["WIDEVINE"]["src"]

        manifest = None
        for m in ["DASH", "SS", "HLS"]:
            try:
                manifest = response["sources"][m][0]["src"]
                if not manifest.startswith("https:"):
                    manifest = "https:" + manifest
                break
            except:
                continue

        pssh_value = None
        if has_drm:
            manifest_content = requests.get(manifest).content.decode()
            try:
                pssh_value = get_pssh_from_default_kid(manifest_content)
            except:
                pssh_value = None

            if pssh_value is None:
                try:
                    pssh_value = get_pssh_from_playready(manifest_content)
                except:
                    pssh_value = None

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}. Can't extract pssh",
                    solution=f"Extend the {ninateka_pl.__name__} service"
                ))

        if source_element.element is None:
            response = requests.get(
                ninateka_pl.VODS_URL.format(video_id=video_id),
                params={'platform': 'BROWSER'}
            )
            response = response.content.decode()
            response = json.loads(response)

            title = response.get("title", None)
            if title in ["", None]:
                title = source_element.url.split("/")[-1]
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                ninateka_pl.__name__
            )
        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/movies," in collection_url:
            return [BaseElement(url=collection_url)]
        if "/series," not in collection_url and "/audio," not in collection_url:
            return None

        content_id = re.findall(r',([^,/]+)', collection_url)
        if len(content_id) > 2:
            return [BaseElement(url=collection_url)]
        content_id = content_id[1]

        response = requests.get(
            ninateka_pl.SHOW_URL.format(show_id=content_id),
            params={'platform': 'BROWSER'}
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)

        error = response.get("code", "").lower()
        if 400 <= status_code < 500 or "not_exists" in error:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        collection_title = response.get("title", response.get("slug", None))
        if collection_title in [None, ""]:
            collection_title = collection_url.split(content_id)[0].split("/")[-1]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                ninateka_pl.__name__
            ),
            get_valid_filename(collection_title)
        )

        response = requests.get(
            ninateka_pl.SEASONS_URL.format(show_id=content_id),
            params={'platform': 'BROWSER'}
        )
        response = response.content.decode()
        response = json.loads(response)
        seasons = sorted(response, key=lambda s: s["number"])

        collection = []
        for season in seasons:
            season_index = season["number"]
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            season_id = season["id"]
            response = requests.get(
                ninateka_pl.EPISODES_URL.format(show_id=content_id, season_id=season_id),
                params={'platform': 'BROWSER'}
            )
            response = response.content.decode()
            response = json.loads(response)

            episodes = sorted(response, key=lambda e: e["number"])
            for episode in episodes:
                episode_index = episode["number"]
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episode_url = episode["webUrl"]
                episode_title = episode.get("title", episode["id"])
                episode_title = get_valid_filename(f'Episode_{episode_index}_{episode_title}')
                collection.append(BaseElement(
                    url=episode_url,
                    collection=join(collection_title, f'Season_{season_index}'),
                    element=episode_title
                ))

        return collection
