import builtins
import json
import re
from os.path import join
from urllib.parse import parse_qs, urlparse

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, clean_url


class stirr_com(BaseService):
    DEMO_URLS = [
        "https://stirr.com/watch/5726/nautical-channel",
        "https://stirr.com/watch/5691/the-surprising-world-of-rabbits",
        "https://stirr.com/watch/6423/the-bagman-official-trailer",
        "https://stirr.com/watch/6134/of-souls-plus-water-the-elder",
        "https://stirr.com/watch/4246?type=series&series_id=174&season_id=238",
        "https://stirr.com/live?channel_id=5735",
        "https://stirr.com/tv-shows/174/beyond-the-beaten-path",
        "https://stirr.com/tv-shows/170/epic-trails",
    ]

    PLAYABLE_URL = 'https://stirr.com/api/v2/videos/{video_id}/playable'
    SERIES_URL = 'https://stirr.com/api/series/list/{series_id}'
    SEASONS_URL = 'https://stirr.com/api/season/list/{series_id}'
    EPISODES_URL = 'https://stirr.com/api/season/data?series_id={series_id}&season_id={season_id}&page={page}&paginate=1'
    EPISODE_URL = "https://stirr.com/watch/{video_id}"
    BASE_URL = 'https://stirr.com'

    @staticmethod
    def test_service():
        main_service.run_service(stirr_com)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/live?channel_id=" in content or additional.get("IS_LIVE", False) is True

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return stirr_com

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {stirr_com.__name__} service'
        )

    @staticmethod
    def get_video_data(source_element):
        if "/live?channel_id" in source_element.url:
            is_live = True
            params_dict = parse_qs(urlparse(source_element.url).query)
            video_id = params_dict["channel_id"][0]
        else:
            is_live = None
            video_id = re.search(r"/watch/([^/?]*)", source_element.url).group(1)
        response = requests.post(stirr_com.PLAYABLE_URL.format(video_id=video_id))

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        error = response.get("error_code", "").lower()
        message = response.get("message", "").lower()

        if status_code == 403 and "region" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need American IP to access content",
                solution="Use a VPN"
            ))

        if 400 <= status_code < 500 or "video_not_found" in error:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = response["data"]
        if type(response) is not list:
            response = [response]
        response = [r for r in response if str(r["content"]["videoid"]) == video_id][0]
        if is_live is None:
            is_live = response["content"].get("content_type_label", "").lower() in ["live"]

        if source_element.element is None:
            title = response["content"].get("title", None)
            if title in ["", None]:
                title = source_element.url.split("/")[-1]

            if is_live:
                title = f'Livestream_{title}'
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                stirr_com.__name__
            )

        if response["content"].get("drm_protected", "").lower() not in ["", "no"]:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"DRM not supported. Widevine found",
                solution=f"Extend the {stirr_com.__name__} service"
            ))

        manifest = None
        if manifest is None:
            for k, f in [("media", None), ("_media", "src"), ("media_v2", "url")]:
                if response.get(k, []) not in [None, []]:
                    if type(response[k]) is not list:
                        response[k] = [response[k]]

                    manifest = response[k][0]
                    if f is not None:
                        manifest = manifest.get(f, None)
                    if manifest is not None:
                        break

        if manifest is None and is_live:
            manifest = response["content"]["live"]
        assert manifest not in [None, ""]
        return manifest, None, {"IS_LIVE": is_live}

    @staticmethod
    def get_collection_elements(collection_url):
        if "/watch/" in collection_url or "/live?channel_id=" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/tv-shows/" not in collection_url:
            return None

        collection_url = clean_url(collection_url)
        series_id = re.search(r"/tv-shows/([^/?]*)", collection_url).group(1)
        response = requests.get(stirr_com.SERIES_URL.format(series_id=series_id))

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        message = response.get("message", "").lower()

        if 400 <= status_code < 500 and "found" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        collection_name = None
        for series in response.get("series", {}).get("series_by_id", []):
            if str(series["series_id"]) != series_id:
                continue

            collection_name = series.get("series_name", None)
            if collection_name not in ["", None]:
                break

        if collection_name in ["", None]:
            collection_name = collection_url.split("/")[-1]
        collection_name = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                stirr_com.__name__
            ),
            get_valid_filename(collection_name)
        )

        response = requests.get(stirr_com.SEASONS_URL.format(series_id=series_id))
        response = response.content.decode()
        response = json.loads(response)
        seasons = response.get("data", {}).get("seasons", [])
        seasons = sorted(seasons, key=lambda s: s["sequence"])

        collection = []
        episode_count = 0
        for season in seasons:
            season_index = season["sequence"]
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            season_id = season["season_id"]
            page = 0
            episode_index = 0
            while True:
                page += 1
                response = requests.get(stirr_com.EPISODES_URL.format(
                    series_id=series_id, season_id=season_id, page=page
                ))
                response = response.content.decode()
                response = json.loads(response)

                episodes = response.get("data", {}).get("data", [])
                if len(episodes) == 0:
                    break

                for episode in episodes:
                    # episode_index += 1
                    episode_index = episode["sequence"]
                    episode_index = episode_index - episode_count
                    check = check_range(False, season_index, episode_index)
                    if check in [True, False]:
                        continue

                    episode_id = episode["videoid"]
                    episode_title = episode.get("title", None)
                    episode_url = None

                    for f in ["watch_url", "url", "shareable"]:
                        if episode.get(f, "") in ["", None]:
                            continue
                        episode_url = episode[f]
                        break

                    if episode_url is None:
                        episode_url = stirr_com.EPISODE_URL.format(video_id=episode_id)
                    elif not episode_url.startswith("http"):
                        episode_url = stirr_com.BASE_URL + episode_url

                    if episode_title in ["", None]:
                        episode_title = clean_url(episode_url).split("/")[-1]
                    episode_title = f'Episode_{episode_index}_{episode_title}'

                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(collection_name, f'Season_{season_index}'),
                        element=get_valid_filename(episode_title)
                    ))
            episode_count += season["episode_count"]

        return collection
