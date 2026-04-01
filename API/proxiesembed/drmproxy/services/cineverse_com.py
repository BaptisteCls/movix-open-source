import builtins
import json
import re
from os.path import join
from urllib.parse import parse_qs, urlparse

import browser_cookie3
import requests
from bs4 import BeautifulSoup
from slugify import slugify

from utils.constants.macros import APP_ERROR, ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, get_ext_from_url, update_url_params


class cineverse_com(BaseService):
    DEMO_URLS = [
        "https://www.cineverse.com/watch/1000000022997/On-Fire?vod_type=",
        "https://www.cineverse.com/watch/1000000025139/Big-Freaking-Snake?vod_type=trailer",
        "https://www.cineverse.com/watch/DMR00005120/FBI-Files:-Hired-Gun&vod_type=",
        "https://www.cineverse.com/livetv?q=ComedyDynamics",
        "https://www.cineverse.com/livetv?q=realmadrid",
        "https://www.cineverse.com/details/1000000029521/Dog-Whisperer-with-Cesar-Millan",
        "https://www.cineverse.com/details/BOOGIEPOPPHANTOM/Boogiepop-Phantom",
    ]

    BASE_URL = "https://www.cineverse.com"
    VIDEO_URL = BASE_URL + "/watch/{video_id}/{video_title}"

    AUTH_TOKEN = None
    LOGIN_COOKIES = None

    @staticmethod
    def test_service():
        main_service.run_service(cineverse_com)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/livetv?" in content

    @staticmethod
    def credentials_needed():
        return {
            "OPTIONAL": True,
            "FIREFOX_COOKIES": True
        }

    @staticmethod
    def get_auth_token():
        response = requests.get(cineverse_com.BASE_URL).content.decode()
        response = re.findall(r'<script[^<>]*src="([^"]*app-[^"]*.js)"[^<>]*>', response)
        response = response[0]
        if not response.startswith("http"):
            response = f'{cineverse_com.BASE_URL}{response}'

        response = requests.get(response).content.decode()
        response = re.findall(r'Authorization:"Basic ([^"]+)"', response)
        return response[0]

    @staticmethod
    def get_login_cookies():
        cookie_dict = {}
        try:
            for c in browser_cookie3.firefox(domain_name='cineverse.com'):
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
        if cineverse_com.LOGIN_COOKIES is None:
            cineverse_com.LOGIN_COOKIES = cineverse_com.get_login_cookies()
        if cineverse_com.AUTH_TOKEN is None:
            cineverse_com.AUTH_TOKEN = cineverse_com.get_auth_token()
        return cineverse_com

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
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                cineverse_com.__name__
            )

        response = requests.get(
            source_element.url,
            cookies=cineverse_com.LOGIN_COOKIES
        ).content.decode()

        soup = BeautifulSoup(response, 'html5lib')
        script = soup.find_all('script', {'type': 'application/json'})
        script = [s for s in script if s.get("id", None) == "__NEXT_DATA__"][0]
        script = json.loads(script.string)

        if "/livetv?" in source_element.url:
            params_dict = parse_qs(urlparse(source_element.url).query)
            channel_query = params_dict["q"][0]

            live_channel = script["props"]["pageProps"].get("liveChannelListURL", None)
            if live_channel in ["", None]:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="Need American IP to access content",
                    solution="Use a VPN"
                ))

            live_feeds = []
            for _ in range(0, 2):
                response = json.loads(requests.get(
                    live_channel,
                    headers={"Authorization": f"Basic {cineverse_com.AUTH_TOKEN}"}
                ).content.decode())

                live_feeds = response.get("liveFeeds", [])
                if len(live_feeds) > 0:
                    break
                if "jloc=us" in live_channel:
                    break
                live_channel = update_url_params(live_channel, {"jloc": "us"})

            live_feeds = list(filter(lambda lf: lf.get("item_id", None) == channel_query, live_feeds))
            if len(live_feeds) == 0:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content wasn't found or you need a VPN",
                    solution="Do not attempt to download it or use a VPN that lets you see the livestream in your browser"
                ))

            live_feed = live_feeds[0]
            if source_element.element is None:
                title = live_feed.get("title", channel_query)
                source_element.element = get_valid_filename(f"Live_{title}")

            manifest = live_feed["content"]["hls_url"]
            return manifest, None, {}

        page_props = script["props"]["pageProps"]
        details = page_props["idetails"]
        dms_data = page_props.get("dmsData", {})
        err_code = dms_data.get("code", None)
        err_msg = page_props.get("dmsMsg", dms_data.get("message", "")).lower()

        if err_code in [0, None]:
            err_code = details.get("err_code", None)
        if err_msg in ["", None]:
            err_msg = details.get("err_msg", "").lower()

        if err_code == 1002 or "access" in err_msg:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason='Need account for this content, it is paid or it is not available',
                solution="Sign into your account using Firefox or don't attempt to download it"
            ))
        if err_code == 1400 or ("available" in err_msg and "location" in err_msg):
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need American IP to access content",
                solution="Use a VPN"
            ))

        is_trailer = details.get("trailer", False)
        if not is_trailer:
            is_trailer = "trailer" in script.get("query", {}).get("vod_type", "").lower()
        if not is_trailer:
            is_trailer = "vod_type=trailer" in source_element.url

        if source_element.element is None:
            title = details.get("title", None)
            if title is None:
                title = details.get("details", {}).get("title", None)
            if title is None:
                title = script.get("query", {}).get("play-asset-title", None)
            if title is None:
                title = source_element.url.split("/watch/")[1]

            if is_trailer:
                title = f"Trailer_{title}"
            source_element.element = get_valid_filename(title)

        has_drm = details.get("is_drm_encrypted", False) is True
        additional = {}

        if has_drm:
            drm_info = details["drm_info"]
            manifest = drm_info.get("wv_dash_url", None)
            if manifest is None:
                manifest = drm_info["wv_hls_url"]

            license_url = drm_info.get("wv_drm_server", None)
            if license_url is None:
                license_url = drm_info["drm_server"]
            additional["license_url"] = license_url

        else:
            manifest = details.get("url", None)
            if manifest is None and is_trailer:
                manifest = details["details"]["media_trailer_url"]

        subtitles = []
        srt_url = details.get("subtitle_url", None)
        if srt_url in [None, ""]:
            srt_url = details.get("cc_url_vtt", None)

        if srt_url not in [None, ""]:
            srt_ext = get_ext_from_url(srt_url)
            subtitles.append((False, BaseElement(
                url=srt_url,
                collection=join(source_element.collection, source_element.element),
                element=f'subtitle{srt_ext}'
            )))

        additional["SUBTITLES"] = subtitles
        try:
            if not has_drm:
                raise

            pssh_value = str(min(re.findall(
                r'<[^<>]*cenc:pssh[^<>]*>(.*?)</[^<>]*cenc:pssh[^<>]*>',
                requests.get(manifest).content.decode()
            ), key=len))
        except:
            pssh_value = None

        if has_drm and pssh_value is None:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {manifest}. Can't extract pssh",
                solution=f"Extend the {cineverse_com.__name__} service"
            ))

        return manifest, pssh_value, additional

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("/")
        if "/watch/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/livetv?" in collection_url and "q=" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/details/" not in collection_url:
            return None
        collection_url = collection_url.split("?")[0].split("#")[0].rstrip("/")
        response = requests.get(
            collection_url,
            cookies=cineverse_com.LOGIN_COOKIES
        ).content.decode()

        soup = BeautifulSoup(response, 'html5lib')
        script = soup.find_all('script', {'type': 'application/json'})
        script = [s for s in script if s.get("id", None) == "__NEXT_DATA__"][0]
        script = json.loads(script.string)

        if script["props"]["pageProps"].get("locationAllowed", True) is False:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="Need American IP to access content",
                solution="Use a VPN"
            ))

        item_details = script["props"]["pageProps"]["itemDetailsData"]
        err_code = item_details.get("code", None)
        err_msg = item_details.get("message", "").lower()
        if err_code == 1001 or "not available" in err_msg:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=collection_url,
                reason="This content isn't available",
                solution='Do not attempt to download it'
            ))

        collection_title = item_details.get("title", None)
        if collection_title is None:
            collection_title = script.get("query", {}).get("item-title", None)
        if collection_title is None:
            collection_title = collection_url.split("/")[-1]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                cineverse_com.__name__
            ),
            get_valid_filename(collection_title)
        )

        seasons = script["props"]["pageProps"].get("seasonEpisodes", [])
        seasons = sorted(seasons, key=lambda s: s["season"])
        collection = []

        for season in seasons:
            season_index = season["season"]
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            episodes = season.get("episodes", [])
            episodes = sorted(episodes, key=lambda e: e["episode"])

            for episode in episodes:
                episode_index = episode["episode"]
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episode_title = f'Episode_{episode_index} {episode.get("title", "")}'
                episode_title = get_valid_filename(episode_title)
                episode_url = cineverse_com.VIDEO_URL.format(
                    video_id=episode["item_id"],
                    video_title=slugify(episode.get("title", "title"))
                )

                collection.append(BaseElement(
                    url=episode_url,
                    collection=join(collection_title, f'Season_{season_index}'),
                    element=episode_title
                ))

        return collection
