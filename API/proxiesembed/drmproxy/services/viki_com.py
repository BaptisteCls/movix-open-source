import base64
import builtins
import json
import re
from os.path import join

import browser_cookie3
import requests

from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class viki_com(BaseService):
    DEMO_URLS = [
        "https://www.viki.com/tv/35630c-because-this-is-my-first-life",
        "https://www.viki.com/tv/40179c-perfect-marriage-revenge",
        "https://www.viki.com/tv/38381c-from-now-on-showtime",
        "https://www.viki.com/movies/37657c-project-gutenberg",
        "https://www.viki.com/videos/1249930v-makemate1-episode-3",
        "https://www.viki.com/videos/1123051v",
        "https://www.viki.com/videos/1233367v",
    ]

    CONTAINER_URL = 'https://api.viki.io/v4/containers/{id}/{resource}.json'
    VIDEO_JSON_URL = "https://api.viki.io/v4/videos/{id}.json"
    VIDEO_URL = 'https://www.viki.com/api/videos/{video_id}'
    BASE_URL = "https://www.viki.com"

    APP_ID, APP_VER = None, '1.1.1'
    PAGE_SIZE = 50
    LOGIN_COOKIES = None

    @staticmethod
    def test_service():
        main_service.run_service(viki_com)

    @staticmethod
    def credentials_needed():
        return {
            "OPTIONAL": True,
            "FIREFOX_COOKIES": True
        }

    @staticmethod
    def get_app_info():
        response = requests.get(viki_com.BASE_URL).content.decode()
        app_id = re.findall(r'"appID":"(.*?)"', response)[0]
        return app_id

    @staticmethod
    def get_login_cookies():
        cookie_dict = {}
        try:
            for c in browser_cookie3.firefox(domain_name='viki.com'):
                cookie_dict[c.name] = c.value
        except browser_cookie3.BrowserCookieError:
            pass

        try:
            assert len(cookie_dict.keys()) > 0
            return cookie_dict
        except:
            return {}

    @staticmethod
    def initialize_service():
        if viki_com.LOGIN_COOKIES is None:
            viki_com.LOGIN_COOKIES = viki_com.get_login_cookies()
        if viki_com.APP_ID is None:
            viki_com.APP_ID = viki_com.get_app_info()
        return viki_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_title(video_info, only_title=False):
        video_title = ""
        temp_title = ""
        if video_info.get("titles", None) not in [None, "", {}]:
            titles = video_info["titles"]
            if titles.get("en", None) not in [None, "", {}]:
                temp_title = titles["en"]
                video_title += "_" + titles["en"]

        if only_title:
            return temp_title

        for f in ["type", "number"]:
            if video_info.get(f, None) not in [None, "", {}]:
                video_title += "_" + str(video_info[f])

        if video_info.get("container", None) not in [None, "", {}]:
            video_info = video_info["container"]

        if video_info.get("titles", None) not in [None, "", {}]:
            titles = video_info["titles"]
            if titles.get("en", None) not in [None, "", {}]:
                if temp_title != titles["en"]:
                    video_title = titles["en"] + video_title
            elif video_info.get("i18n_title") not in [None, "", {}]:
                if temp_title != video_info["i18n_title"]:
                    video_title = video_info["i18n_title"] + video_title

        if len(video_title) == 0:
            video_title = None
        elif video_title[0] == "_":
            video_title = video_title[1:]
        return video_title

    @staticmethod
    def get_video_data(source_element):
        video_id = re.search(r"/videos/([^-?#/]*)", source_element.url).group(1)
        response = requests.get(
            viki_com.VIDEO_URL.format(video_id=video_id),
            headers={'x-viki-app-ver': viki_com.APP_VER},
            cookies=viki_com.LOGIN_COOKIES
        )
        status_code = response.status_code
        response = response.content.decode()

        try:
            response = json.loads(response)
        except Exception as e:
            response = response.lower()
            if ("429" in response and "too many requests" in response) or status_code in [429]:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="You downloaded too much content recently",
                    solution="Wait 30-45 minutes. Change the value of MEDIA_DOWNLOADER to 1 (from config json file). "
                             "Remove the -mt N_m3u8DL-RE parameter"
                ))
            raise e

        if response.get("error", None) not in ["", {}, None]:
            status_code = response["error"].get("status", None)
            if status_code == 404:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available",
                    solution="Do not attempt to download it"
                ))
            if status_code == 403:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The VPN was detected",
                    solution="Get a better VPN or don't use one"
                ))

        if source_element.element is None:
            video_title = None
            if response.get("video", None) not in [None, "", {}]:
                video_title = viki_com.get_video_title(response["video"])

            if video_title is None:
                video_title = source_element.url.split("/videos/")[-1]
            source_element.element = get_valid_filename(video_title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                viki_com.__name__
            )

        manifest = response.get("queue", [])
        manifest = [m for m in manifest if m["type"] == "video"]
        if len(manifest) == 0:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't download paid content or the video isn't available yet",
                solution='Do not attempt to download it or wait until you can watch it'
            ))

        manifest = manifest[0]["url"]
        license_url = None
        pssh_value = None
        if response.get("drm", None) not in ["", {}, None]:
            drm = json.loads(base64.b64decode(response["drm"]).decode())

            if drm.get("dt3", None) not in ["", {}, None]:
                license_url = drm["dt3"]
            else:
                drm_types = list(drm.keys())
                drm_types = [d for d in drm_types if re.match(r"dt\d+", d.lower())]

                if len(drm_types) > 0:
                    drm_types = max(drm_types, key=lambda d: int(d[2:]))
                    if drm[drm_types] not in ["", {}, None]:
                        license_url = drm[drm_types]

            try:
                pssh_value = str(min(re.findall(
                    r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                    requests.get(manifest).content.decode()
                ), key=len))
            except:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))

        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.split("#")[0].split("?")[0].rstrip("/")
        if "/videos/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/tv/" in collection_url or "/movies/" in collection_url:
            content_id = re.search(
                fr"{viki_com.BASE_URL}/[^/]+/([^-?#/]*)",
                collection_url
            ).group(1)

            response = requests.get(
                viki_com.VIDEO_JSON_URL.format(id=content_id),
                params={"app": viki_com.APP_ID}
            )
            status_code = response.status_code
            response = response.content.decode()

            try:
                response = json.loads(response)
            except Exception as e:
                response = response.lower()
                if ("429" in response and "too many requests" in response) or status_code in [429]:
                    raise CustomException(ERR_MSG.format(
                        type=f'{USER_ERROR}',
                        url=collection_url,
                        reason="You downloaded too much content recently",
                        solution="Wait 30-45 minutes. Change the value of MEDIA_DOWNLOADER to 1 (from config json file). "
                                 "Remove the -mt N_m3u8DL-RE parameter"
                    ))
                raise e

            if response.get("vcode", None) == 404:
                return []

            collection_name = viki_com.get_video_title(response)
            if collection_name is None:
                collection_name = collection_url.split("/tv/")[-1]
            collection_name = get_valid_filename(collection_name)
            collection_name = join(join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                viki_com.__name__
            ), collection_name)

            season_index = 0
            collection = []
            for season in ["episodes", "clips", "trailers"]:
                season_index += 1
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                page = 0
                temp_ep_index = 0
                while True:
                    page += 1

                    if season == "episodes":
                        params = {
                            'token': 'undefined', 'direction': 'asc',
                            'with_upcoming': 'true', 'sort': 'number',
                            'blocked': 'true', 'app': viki_com.APP_ID,
                            'page': page, 'per_page': viki_com.PAGE_SIZE
                        }
                    else:
                        params = {
                            'sort': 'newest_video', 'app': viki_com.APP_ID,
                            'page': page, 'per_page': viki_com.PAGE_SIZE
                        }

                    episodes = json.loads(requests.get(
                        viki_com.CONTAINER_URL.format(id=content_id, resource=season),
                        params=params
                    ).content.decode()).get("response", [])
                    if len(episodes) == 0:
                        break

                    for episode in episodes:
                        temp_ep_index += 1
                        episode_index = temp_ep_index if episode["number"] == 0 else episode["number"]
                        check = check_range(False, season_index, episode_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                        episode_url = episode["url"]["web"]
                        episode_title = viki_com.get_video_title(episode, only_title=True)
                        if episode_title in ["", None]:
                            episode_title = f'Episode_{episode_index}'
                        else:
                            episode_title = get_valid_filename(episode_title)
                            episode_title = f'Episode_{episode_index}_{episode_title}'

                        collection.append(BaseElement(
                            url=episode_url,
                            collection=join(collection_name, f'Season_{season_index}_{season}'),
                            element=episode_title
                        ))

            return collection
        return None
