import builtins
import json
import re
from os.path import join
from urllib.parse import parse_qs, urlparse

import requests

from utils.constants.macros import CACHE_DIR, ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, dict_to_file, file_to_dict, clean_url


class tg4_ie(BaseService):
    DEMO_URLS = [
        "https://www.tg4.ie/en/player/categories/top-documentaries/play/?pid=6318469898112&title=Moving%20West&series=Moving%20West&genre=Faisneis",
        "https://www.tg4.ie/ga/player/catagoir/nuacht/seinn/?pid=6353807078112&title=%C3%89ire%20Aontaithe&series=Ini%C3%BAchadh%20TG4&genre=Cursai%20Reatha",
        "https://www.tg4.ie/en/player/online-boxsets/?series=Bailte&genre=Faisneis",
        "https://www.tg4.ie/ga/player/catagoir/saolchlar/?series=%C3%93%20Cuisine&genre=Saolchlar",
    ]

    PLAYBACK_URL = 'https://edge.api.brightcove.com/playback/v1/accounts/{account_id}/videos/{video_id}'
    EPISODES_URL = 'https://playerapi.tg4tech.com/series/videos'
    WATCH_LIVE_URL = 'https://www.tg4.ie/en/player/watch-live/'
    CATEGORIES_URL = 'https://www.tg4.ie/en/player/categories/'
    BASE_URL = 'https://www.tg4.ie'

    API_DICT = None
    CACHE_FILE = None

    @staticmethod
    def test_service():
        main_service.run_service(tg4_ie)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_api_dict():
        try:
            api_dict = file_to_dict(tg4_ie.CACHE_FILE)
            assert len(api_dict.keys()) == 3
            return api_dict
        except:
            pass

        response = requests.get(tg4_ie.WATCH_LIVE_URL).content.decode()
        response = re.findall(r'src="([^"]*index\.min\.js)"', response)[0]
        account_id = re.findall(r'(\d{5}\d+)', response)[0]

        response = requests.get(response).content.decode()
        policy_key = re.findall(r'policyKey:"([^"]+)"', response)[0]

        response = requests.get(tg4_ie.CATEGORIES_URL).content.decode()
        api_key = re.findall(r'"x-api-key"[^:]*:[^"]*"([^"]+)"', response)[0]

        api_dict = {
            "account_id": account_id,
            "policy_key": policy_key,
            "api_key": api_key
        }
        dict_to_file(tg4_ie.CACHE_FILE, api_dict)
        return api_dict

    @staticmethod
    def initialize_service():
        if tg4_ie.CACHE_FILE is None:
            tg4_ie.CACHE_FILE = join(CACHE_DIR, f'{tg4_ie.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(tg4_ie.CACHE_FILE, {})

        if tg4_ie.API_DICT is None:
            tg4_ie.API_DICT = tg4_ie.get_api_dict()
        return tg4_ie

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"],
            data=challenge
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        params_dict = parse_qs(urlparse(source_element.url).query)
        video_id = params_dict["pid"][0]
        try:
            alias = params_dict["title"][0]
        except:
            alias = f"Video_{video_id}"

        if video_id is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))

        response = requests.get(
            tg4_ie.PLAYBACK_URL.format(
                account_id=tg4_ie.API_DICT["account_id"],
                video_id=video_id
            ),
            headers={
                'Accept': f'pk={tg4_ie.API_DICT["policy_key"]}',
                'Origin': tg4_ie.BASE_URL
            }
        )
        response = response.content.decode()
        response = json.loads(response)

        message = str(response).lower()
        if "video_not_found" in message or "resource_not_found" in message or "video_not_playable" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))
        if "account_not_found" in message or "invalid_policy_key" in message:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't access the video content because the account id/policy key expired",
                solution=f'Delete the {tg4_ie.CACHE_FILE} cache manually or add the parameter --fresh to your command'
            ))

        if source_element.element is None:
            title = response.get("name", None)
            if title in ["", None]:
                title = alias
                fields = response.get("custom_fields", {})

                for f in ["series", "episode"]:
                    try:
                        title += " " + f[0] + fields[f]
                    except:
                        pass
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                tg4_ie.__name__
            )

        license_url = None
        manifest = None
        for source in response.get("sources", []):
            key_systems = source.get("key_systems", {})
            if len(key_systems.items()) > 0:
                if "widevine" not in str(source).lower():
                    continue

                for k, v in key_systems.items():
                    if "widevine" not in k.lower():
                        continue
                    license_url = v.get("license_url", None)

                if license_url is None:
                    continue
            manifest = source.get("src", None)
            if manifest is not None:
                break

        try:
            if license_url is None:
                raise

            pssh_value = str(min(
                re.findall(
                    r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                    requests.get(manifest).content.decode()
                ), key=len
            ))
        except:
            pssh_value = None

        if license_url is not None and pssh_value is None:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {manifest}. Can't extract pssh",
                solution=f"Extend the {tg4_ie.__name__} service"
            ))

        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_collection_elements(collection_url):
        for f in ["play", "seinn"]:
            if (f"/{f}?" in collection_url or f"/{f}/" in collection_url) and "pid=" in collection_url:
                return [BaseElement(url=collection_url)]
        for f in ["watch-live", "feach-beo"]:
            if f"/{f}/" in collection_url:
                return None
        if "series=" not in collection_url:
            return None

        params_dict = parse_qs(urlparse(collection_url).query)
        series = params_dict["series"][0]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                tg4_ie.__name__
            ),
            get_valid_filename(series)
        )

        response = requests.get(
            tg4_ie.EPISODES_URL,
            params={'seriesTitle': series},
            headers={'x-api-key': tg4_ie.API_DICT["api_key"]}
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)

        err_msg = ""
        if type(response) is dict:
            err_msg = response.get("message", "").lower()
        if status_code == 403 or "forbidden" == err_msg:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=collection_url,
                reason="Can't access the video content because the api key expired",
                solution=f'Delete the {tg4_ie.CACHE_FILE} cache manually or add the parameter --fresh to your command'
            ))
        if len(response) == 0:
            return []

        collection = []
        episode_url = clean_url(collection_url) + "/play/?pid="
        seasons = {}
        for episode in response:
            try:
                series_index = int(episode["custom_fields"]["series"])
                episode_index = int(episode["custom_fields"]["episode"])
                if seasons.get(series_index, None) is None:
                    seasons[series_index] = []
                seasons[series_index].append((episode_index, episode))
            except:
                pass

        for season_index, episodes in sorted(seasons.items()):
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            if len(episodes) == 0:
                continue
            episodes = sorted(episodes, key=lambda e: e[0])

            for episode_index, episode in episodes:
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episode_id = episode.get("videoId", None)
                if episode_id in ["", None]:
                    episode_id = episode["id"]

                episode_title = episode.get("name", None)
                if episode_title in ["", None]:
                    episode_title = episode["custom_fields"].get("title", None)
                if episode_title in ["", None]:
                    episode_title = episode_id
                episode_title = f'Episode_{episode_index}_{episode_title}'

                collection.append(BaseElement(
                    url=episode_url + episode_id,
                    collection=join(collection_title, f'Season_{season_index}'),
                    element=get_valid_filename(episode_title)
                ))

        return collection
