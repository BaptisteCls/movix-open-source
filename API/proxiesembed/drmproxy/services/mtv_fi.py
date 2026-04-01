import builtins
import json
import re
from os.path import join
from urllib.parse import unquote

import browser_cookie3
import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, clean_url


class mtv_fi(BaseService):
    DEMO_URLS = [
        "https://www.mtv.fi/video/34b759d7d68e32d863b6/samu-sirkan-joulutervehdys-2024",
        "https://www.mtv.fi/video/14866e70feb4bb53d04c/cliffhanger-kuilun-partaalla",
        "https://www.mtv.fi/video/62eba76d8b449b3bf6d0/jakso-4-porvoon-mitalla",
        "https://www.mtv.fi/lyhyet/da2fce85b18a2b7e6235/video-tytar-saara-muistelee-kultainen-venla-elamantyopalkinnon-saanutta-isaansa-heikki-silvennoista?first=129d8e9702d4f67430c3&playlist=2e5SUdVLjYGe3DWt6gGO39&isAutoplay=false",
        "https://www.mtv.fi/hae/finland%20europe",
        "https://www.mtv.fi/ohjelma/970e8c6279e5cf05de1a/hautalehto",
    ]

    BASE_URL = "https://www.mtv.fi"
    PLAY_URL = None
    AUTH_URL = None
    GRAPHQL_URL = None

    BEARER_TOKEN = None
    CLIENT_VERSION = '5.3.0'
    PAGE_LIMIT = 50
    VIDEO_URL = BASE_URL + "/{video_type}/{video_id}/{video_slug}"

    @staticmethod
    def test_service():
        main_service.run_service(mtv_fi)

    @staticmethod
    def credentials_needed():
        return {"FIREFOX_COOKIES": True}

    @staticmethod
    def set_api_endpoints():
        response = requests.get(mtv_fi.BASE_URL).content.decode()
        soup = BeautifulSoup(response, 'html5lib')
        script = soup.find_all('script', {'type': 'application/json'})
        script = [s for s in script if s.get("id", None) == "__NEXT_DATA__"][0]
        script = json.loads(script.string)

        response = script["runtimeConfig"]
        mtv_fi.PLAY_URL = response["PLAYBACK_API"] + "/play/{vod_id}"
        mtv_fi.AUTH_URL = response["AUTH_API"] + "/oauth/refresh"
        mtv_fi.GRAPHQL_URL = response["GRAPHQL_URL"] + "/graphql"

    @staticmethod
    def set_bearer_token():
        cookie_dict = {}
        for c in browser_cookie3.firefox(domain_name='mtv.fi'):
            cookie_dict[c.name] = c.value

        refresh_token = cookie_dict.get("mtv-refresh-token", None)
        if refresh_token in ["", None]:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=f'from {mtv_fi.__name__}',
                reason='Need account for this service',
                solution='Sign into your account using Firefox'
            ))

        response = requests.post(mtv_fi.AUTH_URL, json={'refresh_token': refresh_token})
        response = response.content.decode()
        response = json.loads(response)
        mtv_fi.BEARER_TOKEN = response["access_token"]

    @staticmethod
    def initialize_service():
        if mtv_fi.PLAY_URL is None:
            mtv_fi.set_api_endpoints()
        if mtv_fi.BEARER_TOKEN is None:
            mtv_fi.set_bearer_token()
        return mtv_fi

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"],
            headers={'x-dt-auth-token': additional["license_token"]},
            data=challenge
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        vod_id = None
        for f in ["/video/", "/lyhyet/"]:
            if f in source_element.url:
                vod_id = re.search(fr"{f}([^/?]*)", source_element.url).group(1)
                break

        response = requests.get(
            mtv_fi.PLAY_URL.format(vod_id=vod_id),
            params={
                'service': 'mtv', 'device': 'device',
                'protocol': 'hls,dash', 'drm': 'widevine'
            },
            headers={'x-jwt': f'Bearer {mtv_fi.BEARER_TOKEN}'}
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        error_code = response.get("errorCode", "").lower()

        if status_code in [403] or "missing_subscription" in error_code:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't download paid content",
                solution='Do not attempt to download it'
            ))
        if status_code in [404] or "asset_not_found" in error_code:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))
        if status_code in [401] or "invalid_geo_location" in error_code or "proxy_blocked" in error_code:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Finnish IP to access content",
                solution="Use a VPN (a good one that is not detected)"
            ))

        if source_element.element is None:
            metadata = response["metadata"]
            title = metadata.get("title", None)
            if title in ["", None]:
                title = metadata.get("seriesTitle", None)
            if title in ["", None]:
                title = source_element.url.split("/")[-1]

            temp_title = ""
            for f in ["seasonNumber", "episodeNumber"]:
                if metadata.get(f, None) in ["", None]:
                    temp_title = ""
                    break
                temp_title += " " + f[0] + str(metadata[f])

            title = title + temp_title
            source_element.element = get_valid_filename(title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                mtv_fi.__name__
            )

        playback = response["playbackItem"]
        manifest = playback["manifestUrl"]
        license_url = None
        license_token = None
        pssh_value = None

        try:
            license_url = playback["license"]["castlabsServer"]
            license_token = playback["license"]["castlabsToken"]
        except:
            pass

        if license_url is not None:
            manifest_content = requests.get(manifest).content.decode()
            try:
                pssh_value = re.search(r'base64,(AAAA[^"]+)"', manifest_content).group(1)
            except:
                pssh_value = None

            if pssh_value is None:
                try:
                    pssh_value = get_pssh_from_cenc_pssh(manifest_content)
                except:
                    pssh_value = None

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {mtv_fi.__name__} service"
                ))

        return manifest, pssh_value, {
            "license_url": license_url,
            "license_token": license_token,
            "FORCE_SHAKA": True
        }

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/lyhyet/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/video/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/hae/" in collection_url:
            search_text = re.search(r"/hae/([^/?]*)", collection_url).group(1)
            search_text = unquote(search_text)
            collection_name = join(join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                mtv_fi.__name__
            ), get_valid_filename("Search clips " + search_text))
            collection = []

            offset = -mtv_fi.PAGE_LIMIT
            clip_index = 0
            while True:
                offset += mtv_fi.PAGE_LIMIT
                response = requests.get(
                    mtv_fi.GRAPHQL_URL,
                    params={
                        'operationName': 'ListSearch',
                        'variables': json.dumps({"input": {
                            "limit": mtv_fi.PAGE_LIMIT, "offset": offset,
                            "includeUpsell": True,
                            "query": search_text, "types": ["CLIP", "SHORT"]
                        }}),
                        'extensions': json.dumps({"persistedQuery": {
                            "version": 1,
                            "sha256Hash": "f3e6a09f1f4ccea89fb4d0c6af2e91fa898902db4b457223c509218d0ee25ca7"
                        }})
                    },
                    headers={
                        'client-name': 'client-name',
                        'client-version': mtv_fi.CLIENT_VERSION,
                        'authorization': f'Bearer {mtv_fi.BEARER_TOKEN}'
                    }
                )
                response = response.content.decode()
                response = json.loads(response)

                try:
                    clips = response["data"]["listSearch"]["items"]
                except:
                    clips = []
                if len(clips) == 0:
                    break

                try:
                    has_next_page = response["data"]["listSearch"]["pageInfo"]["hasNextPage"]
                    assert type(has_next_page) is bool
                except:
                    has_next_page = False

                for clip in clips:
                    clip_index += 1
                    check = check_range(False, None, clip_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    clip_url = mtv_fi.VIDEO_URL.format(
                        video_type="lyhyet",
                        video_id=clip["id"],
                        video_slug=clip.get("slug", "clip")
                    )
                    clip_title = clip.get("title", clip.get("slug", ""))
                    clip_title = get_valid_filename(f'Clip {clip_index} {clip_title}')

                    collection.append(BaseElement(
                        url=clip_url,
                        collection=collection_name,
                        element=clip_title
                    ))

                if not has_next_page:
                    break

            return collection

        if "/ohjelma/" in collection_url:
            series_id = re.search(r"/ohjelma/([^/?]*)", collection_url).group(1)
            collection = []
            seasons_response = requests.get(
                mtv_fi.GRAPHQL_URL,
                params={
                    'operationName': 'ContentDetailsPage',
                    'variables': json.dumps({"mediaId": series_id}),
                    'extensions': json.dumps({"persistedQuery": {
                        "version": 1,
                        "sha256Hash": "5dac39a55f8ca745ab7e974260bc685c0de11349eb1df85023e90e3f6477f084"
                    }})
                },
                headers={
                    'client-name': 'client-name',
                    'client-version': mtv_fi.CLIENT_VERSION,
                    'authorization': f'Bearer {mtv_fi.BEARER_TOKEN}'
                }
            )
            seasons_response = seasons_response.content.decode()
            seasons_response = json.loads(seasons_response)
            seasons_response = seasons_response["data"]["media"]

            if seasons_response is None:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=collection_url,
                    reason="The content isn't available",
                    solution="Do not attempt to download it"
                ))

            collection_name = seasons_response.get("title", seasons_response.get("slug", ""))
            if collection_name in ["", None]:
                collection_name = collection_url.split("/")[-1]
            collection_name = join(join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                mtv_fi.__name__
            ), collection_name)

            try:
                seasons = seasons_response["allSeasonLinks"]
                assert len(seasons) > 0
            except:
                seasons = []

            season_index = 0
            for season in seasons:
                season_index += 1
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                season_id = season["seasonId"]
                season_title = season.get("title", "")
                season_title = get_valid_filename(f'Season {season_index} {season_title}')

                episode_offset = -mtv_fi.PAGE_LIMIT
                episode_index = 0
                while True:
                    episode_offset += mtv_fi.PAGE_LIMIT
                    episode_response = requests.get(
                        mtv_fi.GRAPHQL_URL,
                        params={
                            'operationName': 'SeasonEpisodes',
                            'variables': json.dumps({
                                "seasonId": season_id,
                                "input": {
                                    "limit": mtv_fi.PAGE_LIMIT,
                                    "offset": episode_offset
                                }
                            }),
                            'extensions': json.dumps({"persistedQuery": {
                                "version": 1,
                                "sha256Hash": "f705d5420f2d1cf2331f18059313bd93a6ccaaf18c4e96b38efee220ea116413"
                            }})
                        },
                        headers={
                            'client-name': 'client-name',
                            'client-version': mtv_fi.CLIENT_VERSION,
                            'authorization': f'Bearer {mtv_fi.BEARER_TOKEN}'
                        }
                    )
                    episode_response = episode_response.content.decode()
                    episode_response = json.loads(episode_response)

                    try:
                        episodes = episode_response["data"]["season"]["episodes"]["items"]
                    except:
                        episodes = []
                    if len(episodes) == 0:
                        break

                    try:
                        has_next_page = episode_response["data"]["season"]["episodes"]["pageInfo"]["hasNextPage"]
                        assert type(has_next_page) is bool
                    except:
                        has_next_page = False

                    for episode in episodes:
                        episode_index += 1
                        check = check_range(False, season_index, episode_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                        episode_url = mtv_fi.VIDEO_URL.format(
                            video_type="video",
                            video_id=episode["id"],
                            video_slug=episode.get("slug", "episode")
                        )
                        episode_title = episode.get("title", episode.get("slug", ""))
                        episode_title = get_valid_filename(f'Episode {episode_index} {episode_title}')

                        collection.append(BaseElement(
                            url=episode_url,
                            collection=join(collection_name, season_title),
                            element=episode_title
                        ))

                    if not has_next_page:
                        break

            return collection
        return None
