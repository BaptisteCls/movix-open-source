import builtins
import json
import re
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, clean_url


class video_telequebec_tv(BaseService):
    DEMO_URLS = [
        "https://video.telequebec.tv/player/46320/stream?assetType=episodes",
        "https://video.telequebec.tv/player/47446/stream?assetType=episodes&playlist_id=379",
        "https://video.telequebec.tv/player/35829/stream?assetType=episodes&playlist_id=439",
        "https://video.telequebec.tv/en%20vedette/details/31828?playlist_id=411",
        "https://video.telequebec.tv/details/44539?playlist_id=358",
        "https://video.telequebec.tv/jeunesse/details/35777?playlist_id=439",
    ]

    ANONYMOUS_LOGIN_URL = 'https://beacon.playback.api.brightcove.com/telequebec/api/account/anonymous_login'
    ASSET_INFO_URL = 'https://beacon.playback.api.brightcove.com/telequebec/api/account/{account_token}/asset_info/{asset_id}'
    CONFIG_JSON_URL = 'https://players.brightcove.net/{account_id}/{config_id}_default/config.json'
    CONFIGS_JSON_URL = 'https://video.telequebec.tv/assets/configs/config.json'
    API_SETTINGS_URL = 'https://beacon.playback.api.brightcove.com/telequebec/api/settings'
    PLAYBACK_URL = 'https://edge.api.brightcove.com/playback/v1/accounts/{account_id}/videos/{video_id}'
    EPISODES_URL = 'https://beacon.playback.api.brightcove.com/telequebec/api/tvshow/{show_id}/season/{season_id}/episodes'
    SEASONS_URL = 'https://beacon.playback.api.brightcove.com/telequebec/api/assets/{show_id}'
    VIDEO_URL = 'https://video.telequebec.tv/player/{video_id}/stream'

    AUTH_TOKEN = None
    ACCOUNT_TOKEN = None
    ACCOUNT_ID = None
    POLICY_KEY = None
    PAGE_LIMIT = 500

    @staticmethod
    def test_service():
        main_service.run_service(video_telequebec_tv)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def set_anonymous_account():
        response = requests.post(
            video_telequebec_tv.ANONYMOUS_LOGIN_URL,
            params={'device_type': 'web', 'duid': 'duid'}
        )
        response = response.content.decode()
        response = json.loads(response)

        video_telequebec_tv.AUTH_TOKEN = response["auth_token"]
        video_telequebec_tv.ACCOUNT_TOKEN = response["account_token"]

    @staticmethod
    def set_policy_key():
        response = requests.get(
            video_telequebec_tv.API_SETTINGS_URL,
            params={
                'device_type': 'web',
                'device_layout': 'web',
                'build_version': 'build_version'
            }
        )
        response = response.content.decode()
        response = json.loads(response)
        config_id = response["data"]["feature_flags"]["bc_web_player_id"]["vod"]

        response = requests.get(video_telequebec_tv.CONFIGS_JSON_URL)
        response = response.content.decode()
        response = json.loads(response)
        video_telequebec_tv.ACCOUNT_ID = response["brightcoveAccounts"][0]["accountId"]

        response = requests.get(
            video_telequebec_tv.CONFIG_JSON_URL.format(
                account_id=video_telequebec_tv.ACCOUNT_ID,
                config_id=config_id
            )
        )
        response = response.content.decode()
        response = json.loads(response)
        video_telequebec_tv.POLICY_KEY = response["video_cloud"]["policy_key"]

    @staticmethod
    def initialize_service():
        if video_telequebec_tv.ACCOUNT_TOKEN is None:
            video_telequebec_tv.set_anonymous_account()
        if video_telequebec_tv.POLICY_KEY is None:
            video_telequebec_tv.set_policy_key()
        return video_telequebec_tv

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
        asset_id = re.search(r"/player/([^/?]+)", source_element.url).group(1)

        response = requests.get(
            video_telequebec_tv.ASSET_INFO_URL.format(
                account_token=video_telequebec_tv.ACCOUNT_TOKEN,
                asset_id=asset_id
            ),
            params={'device_type': 'web', 'ngsw-bypass': '1'},
            headers={'Authorization': f'Bearer {video_telequebec_tv.AUTH_TOKEN}'}
        )

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        error = response.get("error", "").lower()

        if 400 <= status_code < 500 or "pas valide" in error:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))
        video_id = response["data"]["video_playback_details"][0]["video_id"]

        response = requests.get(
            video_telequebec_tv.PLAYBACK_URL.format(
                account_id=video_telequebec_tv.ACCOUNT_ID,
                video_id=video_id
            ),
            headers={'Accept': f'application/json;pk={video_telequebec_tv.POLICY_KEY}'}
        )
        response = response.content.decode()
        response = json.loads(response)

        if source_element.element is None:
            title = response.get("name", None)
            if title not in ["", None]:
                fields = response.get("custom_fields", {})

                for f in ["beacon_episode_seriename", "beacon_episode_seasonnumber", "beacon_episode_number"]:
                    try:
                        title += " " + fields[f]
                    except:
                        pass
            else:
                title = asset_id
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                video_telequebec_tv.__name__
            )

        sources = response["sources"]
        no_drm = list(filter(
            lambda s:
            s.get("key_systems", None) is None or
            (type(s["key_systems"]) is dict and len(s["key_systems"].keys()) == 0),
            sources
        ))

        has_drm = len(no_drm) == 0
        if not has_drm:
            sources = no_drm

        manifest = None
        license_url = None
        for source in sources:
            manifest = source["src"]
            if has_drm:
                keys = list(source["key_systems"].keys())
                keys = [k for k in keys if "widevine" in k.lower()]

                if len(keys) > 0:
                    license_url = source["key_systems"][keys[0]]["license_url"]

            if manifest is not None:
                if has_drm and license_url is not None:
                    break
                if not has_drm:
                    break

        pssh_value = None
        if has_drm:
            if license_url is None:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))

            try:
                manifest_content = requests.get(manifest)
                manifest_content = manifest_content.content.decode()
                pssh_value = get_pssh_from_cenc_pssh(manifest_content)
            except:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}. Can't extract pssh",
                    solution=f"Extend the {video_telequebec_tv.__name__} service"
                ))

        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/player/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/details/" not in collection_url:
            return None

        show_id = re.search(r"/details/([^/?]+)", collection_url).group(1)
        response = requests.get(
            video_telequebec_tv.SEASONS_URL.format(show_id=show_id),
            params={
                'device_type': 'web',
                'device_layout': 'web',
                'asset_id': show_id
            }
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)

        error = response.get("error", "").lower()
        if 400 <= status_code < 500 or "not found" in error:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = response["data"]
        asset = response.get("asset", {})
        if asset is None:
            asset = {}

        collection_title = asset.get("name", asset.get("original_name", ""))
        collection_title += " " + asset.get("subtitle", "")
        collection_title = collection_title.strip()

        if len(collection_title) == 0:
            collection_title = asset.get("seo", {}).get("name", "")
        if len(collection_title) == 0:
            collection_title = asset.get("slug", "")
        if len(collection_title) == 0:
            collection_title = show_id

        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                video_telequebec_tv.__name__
            ),
            get_valid_filename(collection_title)
        )

        response = response["screen"]["blocks"]
        seasons = []
        visited = []
        for block in response:
            for widget in block["widgets"]:
                playlist = widget["playlist"]
                if playlist["type"].lower() not in ["seasons"]:
                    continue

                for content in playlist["contents"]:
                    if content["season_number"] in visited:
                        continue
                    seasons.append((content["season_number"], content["slug"]))
                    visited.append(content["season_number"])

        seasons = sorted(seasons, key=lambda s: s[0])
        collection = []
        for season_index, season_id in seasons:
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            page = 0
            while True:
                page += 1

                response = requests.get(
                    video_telequebec_tv.EPISODES_URL.format(
                        show_id=show_id,
                        season_id=season_id
                    ),
                    params={
                        'device_type': 'web',
                        'device_layout': 'web',
                        'layout_id': '1',
                        'page': page,
                        'limit': video_telequebec_tv.PAGE_LIMIT
                    }
                )
                response = response.content.decode()
                response = json.loads(response)

                episodes = response.get("data", [])
                if episodes is None:
                    episodes = []
                if len(episodes) == 0:
                    break

                for episode in episodes:
                    check = check_range(False, season_index, episode["episode_number"])
                    if check in [True, False]:
                        continue

                    episode_title = episode.get("name", None)
                    if episode_title in ["", None]:
                        episode_title = episode["id"]
                    episode_title = f'Episode_{episode["episode_number"]}_{episode_title}'

                    collection.append(BaseElement(
                        url=video_telequebec_tv.VIDEO_URL.format(
                            video_id=episode["id"]
                        ),
                        collection=join(collection_title, f'Season_{season_index}'),
                        element=get_valid_filename(episode_title)
                    ))

        return collection
