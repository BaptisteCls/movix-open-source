import builtins
import json
import re
from os.path import join

import requests

from utils.constants.macros import USER_ERROR, ERR_MSG, CACHE_DIR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import clean_url, get_valid_filename, dict_to_file, file_to_dict


class maoriplus_co_nz(BaseService):
    DEMO_URLS = [
        "https://www.maoriplus.co.nz/movie/bernie-the-dolphin/play",
        "https://www.maoriplus.co.nz/movie/a-son/play",
        "https://www.maoriplus.co.nz/show/ariki/play/6353035454112",
        "https://www.maoriplus.co.nz/show/frenemies/play/5830339283001",
        "https://www.maoriplus.co.nz/live-tv/whakaata-maori",
        "https://www.maoriplus.co.nz/live-tv/te-reo",
        "https://www.maoriplus.co.nz/show/marae-diy",
        "https://www.maoriplus.co.nz/show/matariki-awards-2019",
        "https://www.maoriplus.co.nz/show/nga-manu-korero-2024",
        "https://www.maoriplus.co.nz/show/school-of-training",
    ]

    PLAYBACK_URL = 'https://edge.api.brightcove.com/playback/v1/accounts/{account_id}/videos/{video_id}'
    SESSION_URL = 'https://api.one.accedo.tv/session'
    METADATA_URL = 'https://api.one.accedo.tv/metadata'
    ENTRY_URL = 'https://api.one.accedo.tv/content/entry/alias/{alias}'
    ENTRIES_URL = 'https://api.one.accedo.tv/content/entries'
    EPISODES_URL = 'https://cms.maoriplus.co.nz/playlists/{season_id}/videos'
    BASE_URL = 'https://www.maoriplus.co.nz'

    API_DICT = None
    CACHE_FILE = None
    SESSION_KEY = None
    PAGE_SIZE = 50
    MPD_PRIORITY = {"": 0, "application/dash+xml": 1, "application/x-mpegURL": 2}

    @staticmethod
    def test_service():
        main_service.run_service(maoriplus_co_nz)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/live-tv/" in content

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_session_key(app_key):
        response = requests.get(
            maoriplus_co_nz.SESSION_URL,
            params={'uuid': 'uuid', 'appKey': app_key}
        )
        response = response.content.decode()
        response = json.loads(response)
        return response["sessionKey"]

    @staticmethod
    def get_api_dict():
        try:
            api_dict = file_to_dict(maoriplus_co_nz.CACHE_FILE)
            assert len(api_dict.keys()) == 3
            maoriplus_co_nz.SESSION_KEY = maoriplus_co_nz.get_session_key(api_dict["app_key"])
            return api_dict
        except:
            pass

        response = requests.get(maoriplus_co_nz.BASE_URL).content.decode()
        response = re.findall(r'src="([^"]*index[^"]*\.js)"', response)[0]
        if response[0] != "/":
            response = "/" + response
        response = maoriplus_co_nz.BASE_URL + response

        response = requests.get(response).content.decode()
        response = re.findall(r'="https://api.one.accedo.tv"[^"]*="([^"]*)"', response)
        response = sorted(response, key=len, reverse=True)[0]

        app_key = response
        maoriplus_co_nz.SESSION_KEY = maoriplus_co_nz.get_session_key(app_key)

        response = requests.get(
            maoriplus_co_nz.METADATA_URL,
            headers={'X-Session': maoriplus_co_nz.SESSION_KEY}
        )
        response = response.content.decode()
        response = json.loads(response)
        response = response["brightcovePlayer"]

        api_dict = {
            "app_key": app_key,
            "account_id": response["accountId"],
            "policy_key": response["playerPolicyKey"]
        }
        dict_to_file(maoriplus_co_nz.CACHE_FILE, api_dict)
        return api_dict

    @staticmethod
    def initialize_service():
        if maoriplus_co_nz.CACHE_FILE is None:
            maoriplus_co_nz.CACHE_FILE = join(CACHE_DIR, f'{maoriplus_co_nz.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(maoriplus_co_nz.CACHE_FILE, {})

        if maoriplus_co_nz.API_DICT is None:
            maoriplus_co_nz.API_DICT = maoriplus_co_nz.get_api_dict()
        return maoriplus_co_nz

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {maoriplus_co_nz.__name__} service'
        )

    @staticmethod
    def get_video_data(source_element):
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                maoriplus_co_nz.__name__
            )

        video_id = None
        if "/live-tv/" in source_element.url:
            alias = source_element.url.split("/")[-1] + "-live"
            offset = -maoriplus_co_nz.PAGE_SIZE
            while True:
                offset += maoriplus_co_nz.PAGE_SIZE

                response = requests.get(
                    maoriplus_co_nz.ENTRIES_URL,
                    params={
                        'typeAlias': 'live-channels',
                        "size": maoriplus_co_nz.PAGE_SIZE,
                        "offset": offset
                    },
                    headers={'X-Session': maoriplus_co_nz.SESSION_KEY}
                )
                response = response.content.decode()
                response = json.loads(response)

                entries = response.get("entries", [])
                if len(entries) == 0:
                    break

                for entry in entries:
                    if entry.get("_meta", {}).get("entryAlias", "") == alias:
                        video_id = entry["bcChannelId"]
                        break

                if video_id is not None:
                    break

            if video_id is None:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available",
                    solution="Don't attempt to download it"
                ))
        else:
            alias = re.findall(r'/([^/]+)/play[^/]*', source_element.url)[0]
            if not source_element.url.endswith("/play"):
                video_id = source_element.url.split("/")[-1]

        if video_id is None:
            response = requests.get(
                maoriplus_co_nz.ENTRY_URL.format(alias=alias),
                headers={'X-Session': maoriplus_co_nz.SESSION_KEY}
            )
            response = response.content.decode()
            response = json.loads(response)

            if response.get("drmProtected", False) is True:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine was found",
                    solution=f"Extend the {maoriplus_co_nz.__name__} service"
                ))

            if source_element.element is None:
                title = response.get("title", alias)
                source_element.element = get_valid_filename(title)
            video_id = response.get("brightcoveId", None)

        if video_id is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))

        response = requests.get(
            maoriplus_co_nz.PLAYBACK_URL.format(
                account_id=maoriplus_co_nz.API_DICT["account_id"],
                video_id=video_id
            ),
            headers={'Accept': f'pk={maoriplus_co_nz.API_DICT["policy_key"]}'}
        )
        response = response.content.decode()
        response = json.loads(response)

        message = str(response).lower()
        if "client_geo" in message and "access_denied" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need New Zealander IP to access content",
                solution="Use a VPN"
            ))
        if "video_not_found" in message or "resource_not_found" in message:
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
                solution=f'Delete the {maoriplus_co_nz.CACHE_FILE} cache manually or add the parameter --fresh to your command'
            ))

        if source_element.element is None:
            title = response.get("name", None)
            if title in ["", None]:
                title = alias
                fields = response.get("custom_fields", {})

                for f in ["season_number", "episode_number"]:
                    try:
                        title += " " + f[0] + fields[f]
                    except:
                        pass
            source_element.element = get_valid_filename(title)

        sources = response.get("sources", [])
        sources = filter(lambda s: s.get("container", None) in ["", None], sources)
        sources = sorted(
            list(sources),
            key=lambda s: maoriplus_co_nz.MPD_PRIORITY.get(s.get("type", ""), 0),
            reverse=True
        )

        manifest = sources[0]["src"]
        return manifest, None, {}

    @staticmethod
    def has_episodes(season_id):
        episodes = json.loads(requests.get(
            maoriplus_co_nz.EPISODES_URL.format(season_id=season_id),
            params={'limit': 1, 'offset': 0}
        ).content.decode())
        return type(episodes) is list and len(episodes) > 0

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/play/" in collection_url or collection_url.endswith("/play") or "/live-tv/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/show/" not in collection_url:
            return None

        alias = collection_url.split("/")[-1]
        response = requests.get(
            maoriplus_co_nz.ENTRY_URL.format(alias=alias),
            headers={'X-Session': maoriplus_co_nz.SESSION_KEY}
        )
        response = response.content.decode()
        response = json.loads(response)

        error = response.get("error", {})
        message = error.get("status", "").lower()
        code = error.get("code", "")
        if "not found" in message or code in ["404"]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))

        collection_title = response.get("title", alias)
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                maoriplus_co_nz.__name__
            ),
            get_valid_filename(collection_title)
        )
        seasons_id = ",".join(response.get("seasons", []))

        seasons_offset = -maoriplus_co_nz.PAGE_SIZE
        season_index = 0
        collection = []
        while True:
            seasons_offset += maoriplus_co_nz.PAGE_SIZE

            seasons = requests.get(
                maoriplus_co_nz.ENTRIES_URL,
                headers={'X-Session': maoriplus_co_nz.SESSION_KEY},
                params={
                    'id': seasons_id,
                    'offset': seasons_offset,
                    'size': maoriplus_co_nz.PAGE_SIZE
                }
            )
            seasons = seasons.content.decode()
            seasons = json.loads(seasons)
            seasons = seasons.get("entries", [])
            if len(seasons) == 0:
                break

            for season in seasons:
                season_id = season["playlistId"]
                if not maoriplus_co_nz.has_episodes(season_id):
                    continue

                season_index += 1
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                season_title = season.get("title", season.get("seasonTitle", ""))
                if season_title is None:
                    season_title = ""
                season_title = get_valid_filename(f'S{season_index} {season_title}')

                episodes_offset = -maoriplus_co_nz.PAGE_SIZE
                while True:
                    episodes_offset += maoriplus_co_nz.PAGE_SIZE

                    episodes = requests.get(
                        maoriplus_co_nz.EPISODES_URL.format(season_id=season_id),
                        params={
                            'limit': maoriplus_co_nz.PAGE_SIZE,
                            'offset': episodes_offset
                        }
                    )
                    episodes = episodes.content.decode()
                    episodes = json.loads(episodes)
                    if len(episodes) == 0:
                        break

                    for episode in episodes:
                        episode_index = int(episode["custom_fields"]["episode_number"])
                        check = check_range(False, season_index, episode_index)
                        if check in [True, False]:
                            continue

                        episode_title = episode.get("name", "")
                        episode_title = get_valid_filename(f'E{episode_index} {episode_title}')
                        episode_url = f'{collection_url}/play/{episode["id"]}'

                        collection.append(BaseElement(
                            url=episode_url,
                            collection=join(collection_title, season_title),
                            element=episode_title
                        ))

        return collection
