import base64
import builtins
import json
import time
from os.path import join

import browser_cookie3
import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, clean_url


class kanopy_com(BaseService):
    DEMO_URLS = [
        "https://www.kanopy.com/en/alplibrary/watch/video/15161814",
        "https://www.kanopy.com/en/alplibrary/video/113155",
        "https://www.kanopy.com/en/alplibrary/watch/video/14994123/14994127",
        "https://www.kanopy.com/en/alplibrary/video/14837778/15070509/15070524",
        "https://www.kanopy.com/en/alplibrary/watch/video/2567156",
        "https://www.kanopy.com/en/alplibrary/video/12489916",
        "https://www.kanopy.com/en/alplibrary/watch/video/2962529/2962535",
        "https://www.kanopy.com/en/alplibrary/video/14414459/14414465",

        "https://www.kanopy.com/en/alplibrary/video/14098194",
        "https://www.kanopy.com/en/alplibrary/video/15118812",
        "https://www.kanopy.com/en/alplibrary/video/14837931",
        "https://www.kanopy.com/en/alplibrary/video/3034173",
    ]

    MEMBERSHIPS_URL = 'https://www.kanopy.com/kapi/memberships'
    PLAYS_URL = 'https://www.kanopy.com/kapi/plays'
    LICENSE_URL = "https://www.kanopy.com/kapi/licenses/widevine/{drm_id}"
    VIDEO_INFO_URL = 'https://www.kanopy.com/kapi/videos/{video_id}'
    ITEMS_URL = 'https://www.kanopy.com/kapi/videos/{collection_id}/items'
    MANIFEST_URL = 'https://www.kanopy.com/kapi/manifests/{manifest_type}/{video_id}.{manifest_ext}'

    BEARER_TOKEN = None
    USER_ID = None
    DOMAIN_ID = None
    X_VERSION = "///"
    RETRIES_TIMER = 5
    RETRIES_COUNT = 3
    SRT_PRIORITY = {"srt": 2, "webvtt": 1, '': 0}

    @staticmethod
    def test_service():
        main_service.run_service(kanopy_com)

    @staticmethod
    def credentials_needed():
        return {"FIREFOX_COOKIES": True}

    @staticmethod
    def get_account_info():
        cookie_dict = {}
        for c in browser_cookie3.firefox(domain_name='kanopy.com'):
            cookie_dict[c.name] = c.value

        try:
            bearer_token = cookie_dict["kapi_token"]
            assert type(bearer_token) is str and len(bearer_token) > 0
            user_id = json.loads(base64.b64decode(bearer_token.split(".")[1] + "==").decode())["data"]["uid"]

            assert type(user_id) in [int, str] and user_id not in ["", None]
            return bearer_token, int(user_id)
        except:
            return None, None

    @staticmethod
    def get_domain_id():
        response = requests.get(
            kanopy_com.MEMBERSHIPS_URL,
            params={'userId': kanopy_com.USER_ID},
            headers={
                'Authorization': f'Bearer {kanopy_com.BEARER_TOKEN}',
                'x-Version': kanopy_com.X_VERSION
            }
        )
        if response.status_code in [401, 403]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}/{APP_ERROR}',
                url=f'from {kanopy_com.__name__}',
                reason='Refresh the site cookies',
                solution='Sign into your account using Firefox. '
                         'If it persists then debug the service'
            ))

        response = response.content.decode()
        response = json.loads(response)["list"]
        for domain in response:
            if domain.get("isDefault", False) is True:
                return int(domain["domainId"])
        return int(response[0]["domainId"])

    @staticmethod
    def initialize_service():
        if kanopy_com.BEARER_TOKEN is None or kanopy_com.USER_ID is None:
            kanopy_com.BEARER_TOKEN, kanopy_com.USER_ID = kanopy_com.get_account_info()
            if kanopy_com.BEARER_TOKEN is None or kanopy_com.USER_ID is None:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=f'from {kanopy_com.__name__}',
                    reason='Need account for this service',
                    solution='Sign into your account using Firefox'
                ))

        if kanopy_com.DOMAIN_ID is None:
            kanopy_com.DOMAIN_ID = kanopy_com.get_domain_id()
        return kanopy_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = None
        for i in range(1, kanopy_com.RETRIES_COUNT + 1):
            try:
                licence = requests.post(
                    additional["license_url"], data=challenge,
                    headers={
                        'Authorization': f'Bearer {kanopy_com.BEARER_TOKEN}',
                        'x-Version': kanopy_com.X_VERSION
                    }
                )
                licence.raise_for_status()
                break
            except Exception as e:
                response = e.response
                if response.status_code >= 300 or response.status_code < 200:
                    if i < kanopy_com.RETRIES_COUNT:
                        time.sleep(kanopy_com.RETRIES_TIMER)
                        continue
                raise e
        return licence.content

    @staticmethod
    def get_video_name(collection_id, video_id):
        responses = []
        if collection_id is None:
            response = requests.get(
                kanopy_com.VIDEO_INFO_URL.format(video_id=video_id),
                params={'domainId': kanopy_com.DOMAIN_ID},
                headers={
                    'Authorization': f'Bearer {kanopy_com.BEARER_TOKEN}',
                    'x-Version': kanopy_com.X_VERSION
                }
            )
            response = response.content.decode()
            try:
                response = json.loads(response)["video"]
            except:
                response = {"DEFAULT_VALUE": f"Video_id_{video_id}"}
            responses.append(response)
        else:
            response = requests.get(
                kanopy_com.VIDEO_INFO_URL.format(video_id=collection_id),
                params={'domainId': kanopy_com.DOMAIN_ID},
                headers={
                    'Authorization': f'Bearer {kanopy_com.BEARER_TOKEN}',
                    'x-Version': kanopy_com.X_VERSION
                }
            )
            response = response.content.decode()
            try:
                response = json.loads(response)
                response = response.get("playlist", response.get("collection", None))
                assert type(response) is dict
            except:
                response = {"DEFAULT_VALUE": f"Series_id_{collection_id}"}
            responses.append(response)

            response = requests.get(
                kanopy_com.ITEMS_URL.format(collection_id=collection_id),
                params={'domainId': kanopy_com.DOMAIN_ID},
                headers={
                    'Authorization': f'Bearer {kanopy_com.BEARER_TOKEN}',
                    'x-Version': kanopy_com.X_VERSION
                }
            )
            response = response.content.decode()
            try:
                response = json.loads(response).get("list", [])
                if type(response) is not list:
                    response = [response]

                for v in response:
                    v = v["video"]
                    if v["videoId"] == video_id:
                        response = v
                        break
                assert type(response) is dict
            except:
                response = {"DEFAULT_VALUE": f"Video_id_{video_id}"}
            responses.append(response)

        title = ""
        for r in responses:
            for f in ["title", "alias", "DEFAULT_VALUE"]:
                if r.get(f, None) not in ["", None]:
                    title += r[f] + " "
                    break
        return title.split()

    @staticmethod
    def get_video_data(source_element):
        ids = source_element.url.split("/video/")[1].split("/")
        assert len(ids) > 0
        if len(ids) == 1:
            collection_id, video_id = None, int(ids[0])
        else:
            collection_id, video_id = int(ids[-2]), int(ids[-1])

        response = requests.post(
            kanopy_com.PLAYS_URL,
            headers={
                'Authorization': f'Bearer {kanopy_com.BEARER_TOKEN}',
                'x-Version': kanopy_com.X_VERSION
            },
            json={'videoId': video_id, 'userId': kanopy_com.USER_ID, 'domainId': kanopy_com.DOMAIN_ID}
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        error = response.get("errorSubcode", "").lower()

        if status_code in [403] or "playregionrestricted" in error:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need specific country IP to access content",
                solution="Use a VPN for the country that lets you watch the video"
            ))
        if status_code in [404]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        manifests = response.get("manifests", [])
        if type(manifests) is not list:
            manifests = [manifests]

        license_url = None
        manifest = None
        for m in manifests:
            drm_id = m.get("drmLicenseID", None)
            drm_type = m.get("drmType", None)
            if type(drm_type) is str:
                drm_type = drm_type.lower()

            if drm_id not in ["", None] and drm_type not in [None, "", "none"]:
                if m.get("manifestType", "").lower() not in ["dash"]:
                    continue

                manifest = m.get("url", None)
                if manifest in ["", None]:
                    manifest = kanopy_com.MANIFEST_URL.format(
                        manifest_type="dash", video_id=video_id, manifest_ext="mpd"
                    )
                license_url = kanopy_com.LICENSE_URL.format(drm_id=m["drmLicenseID"])
                break

            manifest = m.get("url", None)
            if manifest in ["", None]:
                manifest = kanopy_com.MANIFEST_URL.format(
                    manifest_type="hls", video_id=video_id, manifest_ext="m3u8"
                )
            break

        if manifest is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        pssh_value = None
        additional = {}
        if license_url not in ["", None]:
            try:
                pssh_value = get_pssh_from_cenc_pssh(requests.get(manifest).text)
            except:
                pssh_value = None

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {kanopy_com.__name__} service"
                ))
            additional["license_url"] = license_url

        if source_element.element is None:
            title = kanopy_com.get_video_name(collection_id, video_id)
            source_element.element = get_valid_filename(title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                kanopy_com.__name__
            )

        try:
            captions = response["captions"]
            assert captions not in ["", None]
            if type(captions) is not list:
                captions = [captions]
            assert len(captions) > 0
        except:
            captions = []

        subtitle_index = 0
        subtitles = []
        subtitle_path = join(source_element.collection, source_element.element)
        for caption in captions:
            try:
                files = caption["files"]
                assert files not in ["", None]
                if type(files) is not list:
                    files = [files]
                assert len(files) > 0
            except:
                continue

            try:
                file = list(sorted(
                    files, reverse=True,
                    key=lambda f: kanopy_com.SRT_PRIORITY.get(f.get("type", "").lower(), 0)
                ))[0]
                subtitle_index += 1
                srt_title = caption.get("language", "")
                srt_title = f'subtitle_{subtitle_index} {srt_title}'

                subtitles.append((False, BaseElement(
                    url=file["url"],
                    collection=subtitle_path,
                    element=f'{get_valid_filename(srt_title)}.{file["type"]}'
                )))
            except:
                pass

        additional["SUBTITLES"] = subtitles
        return manifest, pssh_value, additional

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url).rstrip("/")
        if "/video/" not in collection_url:
            return None
        if "/watch/" in collection_url:
            return [BaseElement(url=collection_url)]
        if collection_url.split("/video/")[1].count("/") >= 1:
            return [BaseElement(url=collection_url)]

        watch_url = collection_url.replace("/video/", "/watch/video/")
        series_id = collection_url.split("/")[-1]
        response = requests.get(
            kanopy_com.VIDEO_INFO_URL.format(video_id=series_id),
            params={'domainId': kanopy_com.DOMAIN_ID},
            headers={
                'Authorization': f'Bearer {kanopy_com.BEARER_TOKEN}',
                'x-Version': kanopy_com.X_VERSION
            }
        )
        if response.status_code in [404]:
            return []

        response = response.content.decode()
        temp_response = None
        try:
            response = json.loads(response)
            temp_response = response
            response = response.get("collection", response.get("playlist", None))
            assert type(response) is dict
        except:
            try:
                temp_response = temp_response["video"]
                assert type(temp_response) is dict
                return [BaseElement(url=watch_url)]
            except:
                pass
            response = {}

        collection_title = None
        for f in ["title", "alias"]:
            if response.get(f, None) not in ["", None]:
                collection_title = response[f]
                break

        if collection_title in ["", None]:
            collection_title = f'Series_{series_id}'
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                kanopy_com.__name__
            ),
            get_valid_filename(collection_title)
        )

        response = requests.get(
            kanopy_com.ITEMS_URL.format(collection_id=series_id),
            params={'domainId': kanopy_com.DOMAIN_ID},
            headers={
                'Authorization': f'Bearer {kanopy_com.BEARER_TOKEN}',
                'x-Version': kanopy_com.X_VERSION
            }
        )
        response = response.content.decode()
        response = json.loads(response)
        try:
            contents = response["list"]
            assert contents not in ["", None]
            if type(contents) is not list:
                contents = [contents]
        except:
            contents = []

        seasons = []
        episodes = []
        for content in contents:
            content_type = content.get("type", "").lower()
            if content_type in ["playlist", "collection"]:
                seasons.append(content)
            elif content_type == "video":
                episodes.append(content)

        if len(episodes) >= 0:
            seasons.append(episodes)

        season_index = 0
        collection = []
        for season in seasons:
            season_index += 1
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            episode_index = 0
            if type(season) is list:
                season_title = f"Season_{season_index}"
                season_id = None
            else:
                season = season.get("playlist", season.get("collection", None))
                season_id = season["videoId"]

                season_title = None
                for f in ["title", "alias"]:
                    if season.get(f, None) not in ["", None]:
                        season_title = season[f]
                        break
                if season_title in ["", None]:
                    season_title = f'Id_{season_id}'
                season_title = get_valid_filename(f"Season_{season_index} {season_title}")

                response = requests.get(
                    kanopy_com.ITEMS_URL.format(collection_id=season_id),
                    params={'domainId': kanopy_com.DOMAIN_ID},
                    headers={
                        'Authorization': f'Bearer {kanopy_com.BEARER_TOKEN}',
                        'x-Version': kanopy_com.X_VERSION
                    }
                )
                response = response.content.decode()
                response = json.loads(response)
                try:
                    season = response["list"]
                    assert season not in ["", None]
                    if type(season) is not list:
                        season = [season]
                except:
                    season = []

            for episode in season:
                episode_index += 1
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                try:
                    episode = episode["video"]
                    episode_id = episode["videoId"]
                    assert type(episode_id) in [int, str] and episode_id != ""
                except:
                    continue

                if season_id is None:
                    episode_url = f'{watch_url}/{episode_id}'
                else:
                    episode_url = f'{watch_url}/{season_id}/{episode_id}'

                title = None
                for f in ["title", "alias"]:
                    if episode.get(f, None) not in ["", None]:
                        title = episode[f]
                        break
                if title in ["", None]:
                    title = f'Id_{episode_id}'

                collection.append(BaseElement(
                    url=episode_url,
                    collection=join(collection_title, season_title),
                    element=get_valid_filename(f'Episode_{episode_index} {title}')
                ))

        return collection
