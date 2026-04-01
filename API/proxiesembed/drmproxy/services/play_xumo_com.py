import builtins
import json
import re
from os.path import join

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, clean_url, update_url_params, get_ext_from_url


class play_xumo_com(BaseService):
    DEMO_URLS = [
        "https://play.xumo.com/free-movies/doc-holliday/XM0KLO5UBLRFZ7",
        "https://play.xumo.com/free-movies/anacondas-trail-of-blood/XM02D5MTHWY69Z",
        "https://play.xumo.com/free-movies/decision-at-sundown/XM099Z665IVEUP",
        "https://play.xumo.com/tv-shows/family-affair/XM0G6RCH6S9MBW",
        "https://play.xumo.com/tv-shows/the-joy-of-painting-with-bob-ross/XM0EH52ODUEUVA",
        "https://play.xumo.com/tv-shows/comanche-moon-the-second-chapter-in-the-lonesome-dove-saga/XM02N0DYOW6L05",
        "https://play.xumo.com/tv-shows/deal-or-no-deal-australia/XM0SJGVW8YW3OQ",
    ]

    DEVICE_URL = "/v2/devices/device/id.json"
    LICENSE_URL = None
    ASSET_URL = "/v2/assets/asset/{asset_id}.json"
    BASE_URL = "https://play.xumo.com"

    API_KEY = None
    DEVICE_ID = None
    CLIENT_VERSION = None
    HOST = None

    @staticmethod
    def test_service():
        main_service.run_service(play_xumo_com)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def set_variables():
        response = requests.post(
            play_xumo_com.DEVICE_URL,
            headers={'Authorization': f'XumoValenciaId id={play_xumo_com.API_KEY}'}
        )
        response = json.loads(response.content.decode())
        play_xumo_com.DEVICE_ID = response["id"]

    @staticmethod
    def set_api_endpoints():
        response = requests.get(play_xumo_com.BASE_URL).content.decode()
        soup = BeautifulSoup(response, 'html5lib')
        script = soup.find_all('script', id="__NEXT_DATA__")
        script = script[0].string
        script = json.loads(script)

        script = script["runtimeConfig"]
        play_xumo_com.CLIENT_VERSION = script["APP_VERSION"]
        play_xumo_com.API_KEY = script["XUMO_API_KEY"]

        play_xumo_com.HOST = script["XUMO_API_URL"]
        base_url = f'https://{play_xumo_com.HOST}'
        play_xumo_com.DEVICE_URL = base_url + play_xumo_com.DEVICE_URL
        play_xumo_com.ASSET_URL = base_url + play_xumo_com.ASSET_URL

        app_js = soup.find_all('script', attrs={"src": True})
        for a in app_js:
            a = a["src"]
            if "_app-" in a.split("/")[-1]:
                app_js = play_xumo_com.BASE_URL + a
                break

        app_js = requests.get(app_js).content.decode()
        app_js = re.findall(r'[^_]WIDEVINE:"([^"]+)"', app_js)
        play_xumo_com.LICENSE_URL = app_js[0]

    @staticmethod
    def initialize_service():
        if play_xumo_com.API_KEY is None:
            play_xumo_com.set_api_endpoints()
        if play_xumo_com.DEVICE_ID is None:
            play_xumo_com.set_variables()
        return play_xumo_com

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
        content_id = source_element.url.split("/")[-1]
        response = requests.get(
            play_xumo_com.ASSET_URL.format(asset_id=content_id),
            params={'f': ['providers', 'title', 'episodeTitle']}
        )
        if 400 <= response.status_code < 500:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))
        response = json.loads(response.content.decode())

        providers = response.get("providers", [])
        if len(providers) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{APP_ERROR}',
                url=source_element.url,
                reason=f"No manifest has been found for content id: {content_id}",
                solution=f"Debug the {play_xumo_com.__name__} service"
            ))

        if source_element.element is None:
            video_title = response.get("title", None)
            if video_title in ["", None]:
                video_title = source_element.url.split("/")[-2]
            source_element.element = get_valid_filename(video_title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                play_xumo_com.__name__
            )

        provider_id = None
        has_drm = False
        manifest = None
        captions = None

        for provider in providers:
            provider_id = provider["id"]
            captions = provider.get("captions", [])

            for source in provider.get("sources", []):
                drm = source.get("drm", None)
                if drm is None or drm.get("widevine", False) is True:
                    manifest = source["uri"]
                    has_drm = drm is not None
                    break

            if manifest is not None:
                break

        if captions is None:
            captions = []
        subtitles = []

        srt_index = 0
        output_path = join(source_element.collection, source_element.element)
        for caption in captions:
            srt_url = caption.get("file", caption.get("url", None))
            if srt_url is None:
                continue

            srt_ext = get_ext_from_url(srt_url)
            if srt_ext not in [".srt", ".vtt"]:
                continue
            srt_index += 1
            srt_lang = caption.get("lang", caption.get("language", "unknown"))

            subtitles.append((False, BaseElement(
                url=srt_url,
                collection=output_path,
                element=f'subtitle_{srt_index}_{get_valid_filename(srt_lang)}{srt_ext}'
            )))

        pssh = None
        additional = {"SUBTITLES": subtitles}
        if has_drm:
            try:
                manifest_content = requests.get(manifest).content.decode()
                pssh = get_pssh_from_cenc_pssh(manifest_content)
            except:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {play_xumo_com.__name__} service"
                ))

            additional["license_url"] = update_url_params(
                play_xumo_com.LICENSE_URL,
                {
                    "CustomData": json.dumps({
                        "host": play_xumo_com.HOST,
                        "deviceId": play_xumo_com.DEVICE_ID,
                        "clientVersion": play_xumo_com.CLIENT_VERSION,
                        "providerId": provider_id,
                        "assetId": content_id
                    })
                }
            )

        return manifest, pssh, additional

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/free-movies/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/tv-shows/" not in collection_url:
            return None

        response = requests.get(collection_url).content.decode()
        if "/geo-block" in response:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="Need American IP to access content",
                solution="Use a VPN"
            ))

        soup = BeautifulSoup(response, 'html5lib')
        script = soup.find_all('script', id="__NEXT_DATA__")
        script = script[0].string
        script = json.loads(script)

        for f in ["entity", "seoObj"]:
            try:
                page_props = script["props"]["pageProps"]
                if f == "entity":
                    page_props = page_props["page"]

                collection_title = page_props[f]["title"]
                assert len(collection_title) > 0
                break
            except:
                collection_title = None
        if collection_title is None:
            collection_title = collection_url.split("/")[-2]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                play_xumo_com.__name__
            ),
            get_valid_filename(collection_title)
        )

        try:
            seasons = script["props"]["pageProps"]["page"]["entity"]["seasons"]
            if type(seasons) is not list:
                seasons = [seasons]
        except:
            seasons = []

        for season in seasons:
            try:
                season["season"]["number"] = int(season["season"]["number"])
            except:
                season["season"]["number"] = 0

        collection = []
        video_url = collection_url.replace("/tv-shows/", "/free-movies/").split("/")

        seasons = list(sorted(seasons, key=lambda s: s["season"]["number"]))
        for season in seasons:
            season_index = season["season"]["number"]
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            try:
                episodes = season["cards"]
                if type(episodes) is not list:
                    episodes = [episodes]
            except:
                episodes = []

            for episode in episodes:
                try:
                    episode["episode"] = int(episode["episode"])
                except:
                    episode["episode"] = 0

            episodes = list(sorted(episodes, key=lambda e: e["episode"]))
            for episode in episodes:
                episode_index = episode["episode"]
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                collection.append(BaseElement(
                    url="/".join(video_url + [episode["id"]]),
                    collection=join(collection_title, f'Season_{season_index}'),
                    element=get_valid_filename(
                        f'Episode_{episode_index}'
                        f'_'
                        f'{episode["title"]}'
                    )
                ))

        return collection
