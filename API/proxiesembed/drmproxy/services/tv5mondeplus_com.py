import builtins
import json
import os
import re
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, has_only_roman_chars


class tv5mondeplus_com(BaseService):
    DEMO_URLS = [
        "https://www.tv5mondeplus.com/en/series-et-films-tv/comedie/la-maison-bleue-s-1-e2-le-projet-de-societe/play",
        "https://www.tv5mondeplus.com/en/podcast/subcategory/dingue-14884767_74079A/play",
        "https://www.tv5mondeplus.com/en/cinema/policier-et-suspense/mille-milliards-de-dollars",
        "https://www.tv5mondeplus.com/en/series-et-films-tv/comedie/la-maison-bleue",
        "https://www.tv5mondeplus.com/en/podcast/subcategory/micro-sciences",
        "https://www.tv5mondeplus.com/en/series-et-films-tv/policier-et-suspense/avocats-associes",
    ]

    AUTH_URL = 'https://api.tv5mondeplus.com/v2/customer/TV5MONDE/businessunit/TV5MONDEplus/auth/anonymous'
    GRAPHQL_URL = 'https://www.tv5mondeplus.com/api/graphql/v1/'
    PLAY_URL = 'https://api.tv5mondeplus.com/v2/customer/TV5MONDE/businessunit/TV5MONDEplus/entitlement/{play_id}/play'
    ASSET_URL = 'https://api.tv5mondeplus.com/v1/customer/TV5MONDE/businessunit/TV5MONDEplus/content/asset/{asset_id}'

    BEARER_TOKEN = None

    @staticmethod
    def test_service():
        main_service.run_service(tv5mondeplus_com)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_bearer_token():
        return json.loads(requests.post(
            tv5mondeplus_com.AUTH_URL,
            json={'device': {}, 'deviceId': 'deviceId'}
        ).content.decode())["sessionToken"]

    @staticmethod
    def initialize_service():
        if tv5mondeplus_com.BEARER_TOKEN is None:
            tv5mondeplus_com.BEARER_TOKEN = tv5mondeplus_com.get_bearer_token()

        return tv5mondeplus_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"],
            data=challenge
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def generate_segment_m3u8(output_path, manifest, content_info):
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
        m3u8_content += f'#EXTINF:{content_info.get("durationInMilliseconds", 1)},\n'
        m3u8_content += f'{manifest}\n'

        m3u8_content += "#EXT-X-ENDLIST\n"
        with open(output_path, "w") as f:
            f.write(m3u8_content)

    @staticmethod
    def generate_master_m3u8(source_element, manifest, extension, content_info):
        output_path = str(join(source_element.collection, source_element.element))
        if not os.path.exists(output_path):
            os.makedirs(output_path)
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"

        title = f'audio.m3u8'
        tv5mondeplus_com.generate_segment_m3u8(join(output_path, title), manifest, content_info)
        m3u8_content += f"#EXT-X-STREAM-INF:BANDWIDTH=1000,TYPE=AUDIO,MIME-TYPE=\"audio/{extension}\"\n"
        m3u8_content += f'{title}\n'

        output_path = join(output_path, "master.m3u8")
        with open(output_path, "w") as f:
            f.write(m3u8_content)
        return output_path

    @staticmethod
    def get_video_data(source_element):
        video_slug = source_element.url.split("/play")[0].split("/")[-1]
        language = source_element.url.split("/")[3]

        response = requests.post(
            tv5mondeplus_com.GRAPHQL_URL,
            json={
                'operationName': 'VODContentDetails',
                'variables': {'contentId': 'redbee:' + video_slug + ':' + language},
                'extensions': {'persistedQuery': {
                    'version': 1,
                    'sha256Hash': 'e396131572f170605ea7a9f13139568323ab9e398a350741952e690be38efb30'
                }}
            }
        )

        if response.status_code == 400:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Unknown language format",
                solution="Use a valid content URL"
            ))
        if response.status_code == 404:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))
        response = json.loads(response.content.decode())

        if source_element.element is None:
            video_title = response["data"]["lookupContent"]["title"]
            episode_index = response["data"]["lookupContent"].get("episodeNumber", None)
            if episode_index is not None:
                video_title = f'{video_title}_{episode_index}'

            source_element.element = get_valid_filename(video_title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                tv5mondeplus_com.__name__
            )

        play_id = response["data"]["lookupContent"]["id"].split(":")[0]
        response = json.loads(requests.get(
            tv5mondeplus_com.PLAY_URL.format(play_id=play_id),
            headers={'Authorization': f'Bearer {tv5mondeplus_com.BEARER_TOKEN}'},
            params={
                'supportedFormats': 'dash,hls,mss,mp3',
                'supportedDrms': 'widevine'
            }
        ).content.decode())

        formats = response["formats"]
        drm_free = list(filter(lambda f: f.get("drm", None) in ["", None, {}], formats))
        license_url = None

        if len(drm_free) == 0:
            drm_widevine = list(filter(lambda f: f.get("drm", None) not in ["", None, {}], formats))
            drm_widevine = list(filter(
                lambda f: len([w for w in f["drm"].keys() if "widevine" in w.lower()]) > 0,
                drm_widevine
            ))

            if len(drm_widevine) == 0:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))
            drm_widevine = drm_widevine[0]

            for k, v in drm_widevine["drm"].items():
                if "widevine" not in k.lower():
                    continue
                license_url = v["licenseServerUrl"]
                break

            selected_drm = drm_widevine
        else:
            selected_drm = drm_free[0]

        manifest = selected_drm["mediaLocator"]
        manifest_format = selected_drm["format"].lower()

        pssh_value = None
        if license_url is not None:
            try:
                if manifest_format in ["mp3"]:
                    raise

                pssh_value = str(min(re.findall(
                    r'<[^<>]*cenc:pssh[^<>]*>(.*?)</[^<>]*cenc:pssh[^<>]*>',
                    requests.get(manifest).content.decode()
                ), key=len))
            except:
                pass

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {tv5mondeplus_com.__name__} service"
                ))

        if manifest_format in ["mp3"]:
            manifest = tv5mondeplus_com.generate_master_m3u8(source_element, manifest, manifest_format, response)
        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_locale_name(content, language):
        content_name = None
        for i in range(0, 2):
            for local in content.get("localized", []):
                if i == 0:
                    valid_title = local.get("locale", "").lower() in ["en", "eng", language]
                    if not valid_title:
                        continue

                valid_title = has_only_roman_chars(local.get("title", None))
                if valid_title:
                    content_name = local["title"]
                else:
                    valid_title = has_only_roman_chars(local.get("sortingTitle", None))
                    if valid_title:
                        content_name = local["sortingTitle"]
                if content_name is not None and len(content_name.strip()) > 0:
                    break

            if content_name is not None:
                break
        return content_name

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.split("?")[0].split("#")[0].rstrip("/")
        if collection_url.endswith("/play"):
            return [BaseElement(url=collection_url)]

        series_slug = collection_url.split("/")[-1]
        language = collection_url.split("/")[3]
        response = requests.get(
            tv5mondeplus_com.ASSET_URL.format(asset_id=series_slug),
            params={
                'fieldSet': 'ALL',
                'types': 'MOVIE,TV_SHOW,PODCAST',
                'onlyPublished': 'true',
                'includeEpisodes': 'true',
                'client': 'json'
            }
        )
        if response.status_code == 404:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        collection = []
        response = json.loads(response.content.decode())
        collection_name = tv5mondeplus_com.get_locale_name(response, language)

        if collection_name is None:
            collection_name = series_slug
        collection_name = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                tv5mondeplus_com.__name__
            ),
            get_valid_filename(collection_name)
        )

        seasons = []
        for season in response.get("seasons", []):
            season_index = season.get("season", 1)
            try:
                season_index = int(season_index)
            except:
                season_index = 1
            seasons.append((season_index, season))
        seasons = sorted(seasons, key=lambda s: s[0])

        for season_index, season in seasons:
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            for episode in season.get("episodes", []):
                episode_index = int(episode.get("episode", 1))
                check = check_range(False, season_index, episode_index)
                if check in [True, False]:
                    continue

                episode_name = tv5mondeplus_com.get_locale_name(episode, language)
                episode_url = collection_url.split("/")
                try:
                    episode_url[-1] = episode["slugs"][0]
                except:
                    episode_url[-1] = episode["assetId"]

                if episode_name is None:
                    episode_name = episode_url[-1]
                episode_url.append("play")
                episode_url = "/".join(episode_url)

                collection.append(BaseElement(
                    url=episode_url,
                    collection=join(collection_name, f'Season_{season_index}'),
                    element=f'Episode_{episode_index}'
                            f'_'
                            f'{get_valid_filename(episode_name)}'
                ))

        if len(collection) > 0:
            return collection

        response = requests.post(
            tv5mondeplus_com.GRAPHQL_URL,
            json={
                'operationName': 'VODContentDetails',
                'variables': {'contentId': f'redbee:{series_slug}:{language}'},
                'extensions': {'persistedQuery': {
                    'version': 1,
                    'sha256Hash': 'e396131572f170605ea7a9f13139568323ab9e398a350741952e690be38efb30'
                }}
            }
        )

        response = json.loads(response.content.decode())
        content_id = response["data"]["lookupContent"]["id"].split(":")[0]

        response = requests.post(
            tv5mondeplus_com.GRAPHQL_URL,
            json={
                'operationName': 'VODContentEpisodes',
                'variables': {'contentId': f'PODCAST:{content_id}:{language}'},
                'extensions': {'persistedQuery': {
                    'version': 1,
                    'sha256Hash': '3ef37000cba42e64e4f2505fa4fa48d42f84e4335039c4e82f5ca24c11db0676'
                }}
            }
        )
        response = json.loads(response.content.decode())

        try:
            episodes = response["data"]["lookupContent"]["episodes"]["items"]
            assert len(episodes) > 0
        except:
            return [BaseElement(url=collection_url)]

        episode_index = 0
        for episode in episodes:
            episode_index += 1
            check = check_range(False, None, episode_index)
            if check is True:
                continue
            elif check is False:
                return collection

            episode_url = collection_url.split("/")
            episode_url[-1] = episode["id"].split(":")[0]
            episode_url.append("play")
            episode_url = "/".join(episode_url)

            if has_only_roman_chars(episode.get("title", None)):
                episode_name = episode["title"]
            else:
                episode_name = episode["id"]

            collection.append(BaseElement(
                url=episode_url,
                collection=collection_name,
                element=f'Podcast_{episode_index}'
                        f'_'
                        f'{get_valid_filename(episode_name)}'
            ))
        return collection
