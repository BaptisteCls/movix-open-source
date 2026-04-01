import builtins
import json
import threading
from json import JSONDecodeError
from os.path import join

import requests

from utils.constants.macros import USER_ERROR, ERR_MSG
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, clean_url


class vix_com(BaseService):
    DEMO_URLS = [
        "https://vix.com/es-es/video/video-4564160",
        "https://vix.com/es-es/video/video-4326106",
        "https://vix.com/es-es/video/video-4561911",
        "https://vix.com/es-es/detail/series-502",
        "https://vix.com/es-es/detail/series-4715",
        "https://vix.com/es-es/detail/series-4027",
    ]

    PLAY_URL = "https://nxs.mp.lura.live/v1/play/{play_id}"
    TOKEN_URL = 'https://vix.com/api/video/token'
    ANON_URL = 'https://vix.com/api/proxy/user/create-anon-user'
    GRAPHQL_URL = 'https://client-api.vix.com/gql/v2'
    VIDEO_URL = "https://vix.com/video/video-{video_id}"

    MANIFEST_PRIORITY = {"application/dash+xml": 1, 'application/x-mpegurl': 0}
    BEARER_TOKEN = None
    LOCK = None
    PAGE_SIZE = 50
    APP_PLATFORM = 'web'
    APP_VERSION = 'v0.0.0'
    APP_DEVICE = 'desktop'

    @staticmethod
    def test_service():
        main_service.run_service(vix_com)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        if vix_com.LOCK is None:
            vix_com.LOCK = threading.Lock()
        return vix_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        play_id = source_element.url.split("/video-")[-1]
        response = requests.get(
            vix_com.TOKEN_URL,
            params={'videoId': play_id},
            headers={'x-video-type': 'VOD'}
        )
        response = response.content.decode()
        try:
            response = json.loads(response)
        except JSONDecodeError:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Colombian IP to access content",
                solution="Use a VPN"
            ))

        response = requests.post(
            vix_com.PLAY_URL.format(play_id=play_id),
            data={'token': response["token"]}
        )
        status_code = response.status_code
        response = response.content.decode()
        message = response.lower()

        if status_code in [404] and "not found" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))
        response = json.loads(response)
        response = response["content"]

        if source_element.element is None:
            title = response.get("title", None)
            if title in ["", None]:
                title = f"Video_{play_id}"
            source_element.element = get_valid_filename(title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                vix_com.__name__
            )

        manifest = []
        media = response.get("media", [])
        if media is None:
            media = []
        for m in media:
            try:
                m["type"] = m["type"].lower()
            except:
                continue

            if m["type"] in vix_com.MANIFEST_PRIORITY.keys():
                manifest.append(m)

        manifest = sorted(manifest, key=lambda mn: vix_com.MANIFEST_PRIORITY[mn["type"]], reverse=True)
        manifest = manifest[0]
        license_url = manifest.get('licenseUrl', None)
        manifest = manifest["url"]

        manifest_content = requests.get(manifest).content.decode()
        try:
            pssh_value = get_pssh_from_cenc_pssh(manifest_content, xml_node=":pssh")
        except:
            pssh_value = None

        if pssh_value is None:
            license_url = None
        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/video/" in collection_url and "/video-" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/canales/" in collection_url:
            return None

        if "/detail/" not in collection_url or "/series-" not in collection_url:
            return None
        if vix_com.BEARER_TOKEN is None:
            with vix_com.LOCK:
                if vix_com.BEARER_TOKEN is None:
                    response = requests.post(
                        vix_com.ANON_URL, json={'installationId': 'installationId'}
                    )
                    response = response.content.decode()

                    try:
                        response = json.loads(response)
                        vix_com.BEARER_TOKEN = response["accessToken"]
                        assert len(vix_com.BEARER_TOKEN) > 0
                    except (JSONDecodeError, KeyError, AssertionError):
                        raise CustomException(ERR_MSG.format(
                            type=f'{USER_ERROR}',
                            url=collection_url,
                            reason="Need Colombian IP to access content",
                            solution="Use a VPN"
                        ))

        show_id = collection_url.split("/series-")[-1]
        series_id = f'series:mcp:{show_id}'
        collection_title = None
        collection = []

        season_after_id = None
        season_index = 0
        while True:
            seasons_response = requests.post(
                vix_com.GRAPHQL_URL,
                headers={
                    'authorization': f'Bearer {vix_com.BEARER_TOKEN}',
                    'x-vix-platform': vix_com.APP_PLATFORM,
                    'x-vix-app-version': vix_com.APP_VERSION,
                    'x-vix-device-type': vix_com.APP_DEVICE
                },
                json={
                    'operationName': 'DetailData',
                    'variables': {
                        'id': series_id, 'navigationSection': {'urlPath': ''},
                        'pagination': {'first': vix_com.PAGE_SIZE, 'after': season_after_id}
                    },
                    'query': '''
                        query DetailData($id: ID!, $pagination: PaginationParams!) {
                            videoById(id: $id) {
                                ...VideoContentFullFragment videoTypeData {
                                    ... on VideoTypeSeriesData { ...SeasonsConnectionBasicFragment }
                                }
                            }
                        }
                        fragment VideoContentFullFragment on VideoContent { ...VideoContentBasicFragment }
                        fragment VideoContentBasicFragment on VideoContent { title videoType }
                        fragment SeasonsConnectionBasicFragment on VideoTypeSeriesData {
                            seasonsConnection(pagination: $pagination) { edges { node { id title } } }
                        }
                    '''
                }
            )

            seasons_response = seasons_response.content.decode()
            seasons_response = json.loads(seasons_response)
            if collection_title is None:
                try:
                    collection_title = seasons_response["data"]["videoById"]["title"]
                    collection_title = get_valid_filename(collection_title)
                    assert len(collection_title) > 0
                except:
                    collection_title = f"Series {show_id}"
                collection_title = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        vix_com.__name__
                    ),
                    get_valid_filename(collection_title)
                )

            try:
                seasons = seasons_response["data"]["videoById"]["videoTypeData"]["seasonsConnection"]["edges"]
            except:
                seasons = []
            if len(seasons) == 0:
                break
            season_after_id = None

            for season in seasons:
                season = season.get("node", None)
                if season is None:
                    continue
                season_id = season.get("id", "")
                if season_id == "":
                    continue
                season_after_id = season_id

                season_index += 1
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                season_title = season.get("title", "")
                season_title = join(
                    collection_title,
                    get_valid_filename(f'Season_{season_index} {season_title}')
                )

                episode_after_id = None
                while True:
                    episodes_response = requests.post(
                        vix_com.GRAPHQL_URL,
                        headers={
                            'authorization': f'Bearer {vix_com.BEARER_TOKEN}',
                            'x-vix-platform': vix_com.APP_PLATFORM,
                            'x-vix-app-version': vix_com.APP_VERSION,
                            'x-vix-device-type': vix_com.APP_DEVICE
                        },
                        json={
                            'operationName': 'SeasonById',
                            'variables': {
                                'seriesId': series_id, 'seasonId': season_id,
                                'episodePagination': {
                                    'first': vix_com.PAGE_SIZE,
                                    'after': episode_after_id
                                },
                                'navigationSection': {'urlPath': ''}
                            },
                            'query': '''
                            query SeasonById(
                                $seriesId: ID!, $seasonId: ID!, $episodePagination: PaginationParams!
                            ) {
                                seasonById(seriesId: $seriesId, seasonId: $seasonId) { ...SeasonByIdFragment }
                            }
                            fragment SeasonByIdFragment on Season {
                                episodesConnection(pagination: $episodePagination) {
                                    edges { node { ...EpisodeFullFragment } }
                                }
                            }
                            fragment EpisodeFullFragment on VideoContent {
                                id title videoTypeData { ...VideoTypeEpisodeFullFragment }
                            }
                            fragment VideoTypeEpisodeFullFragment on VideoTypeEpisodeData { episodeNumber }
                            '''
                        }
                    )

                    episodes_response = episodes_response.content.decode()
                    episodes_response = json.loads(episodes_response)
                    try:
                        episodes = episodes_response["data"]["seasonById"]["episodesConnection"]["edges"]
                    except:
                        episodes = []
                    if len(episodes) == 0:
                        break
                    episode_after_id = None

                    for episode in episodes:
                        episode = episode.get("node", None)
                        if episode is None:
                            continue
                        episode_id = episode.get("id", "").split(":")[-1]
                        if episode_id == "":
                            continue
                        episode_after_id = episode["id"]

                        episode_index = episode["videoTypeData"]["episodeNumber"]
                        check = check_range(False, season_index, episode_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                        episode_url = vix_com.VIDEO_URL.format(video_id=episode_id)
                        episode_title = episode.get("title", None)
                        if episode_title in ["", None]:
                            episode_title = f"Id_{episode_id}"
                        episode_title = f'Episode_{episode_index} {episode_title}'
                        episode_title = get_valid_filename(episode_title)

                        collection.append(BaseElement(
                            url=episode_url,
                            collection=season_title,
                            element=episode_title
                        ))

                    if episode_after_id is None:
                        break

            if season_after_id is None:
                break
        return collection
