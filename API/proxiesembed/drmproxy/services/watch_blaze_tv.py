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
from utils.tools.common import clean_url, get_valid_filename


class watch_blaze_tv(BaseService):
    DEMO_URLS = [
        "https://watch.blaze.tv/watch/replay/38169103",
        "https://watch.blaze.tv/watch/replay/94743/karens-big-idea",
        "https://watch.blaze.tv/live/553",
        "https://watch.blaze.tv/live/1235",
        "https://watch.blaze.tv/series/Ancient+Aliens",
        "https://watch.blaze.tv/shows/6cf0dc93-baf5-11ea-9b31-0626f8704156/hardcore-pawn",
        "https://watch.blaze.tv/page/catchup",
    ]

    STREAM_URL = '{stream_type}/stream/{stream_id}'
    GUIDE_URL = 'https://watch.blaze.tv/guide'

    PLATFORM = "chrome"
    API_KEY = None

    @staticmethod
    def test_service():
        main_service.run_service(watch_blaze_tv)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/live/" in content

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def set_endpoints():
        js_dict = json.loads(re.findall(
            r'config[^={]*=[^{]*({.*?});',
            requests.get(watch_blaze_tv.GUIDE_URL).content.decode(),
            flags=re.DOTALL
        )[0])["api"]

        watch_blaze_tv.API_KEY = js_dict["key"]
        js_dict = js_dict["endpoints"]

        stream_url = js_dict["streams"] + js_dict["internal"].replace("https://", "")
        stream_url += watch_blaze_tv.STREAM_URL
        watch_blaze_tv.STREAM_URL = stream_url

    @staticmethod
    def initialize_service():
        if watch_blaze_tv.API_KEY is None:
            watch_blaze_tv.set_endpoints()
        return watch_blaze_tv

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {watch_blaze_tv.__name__} service'
        )

    @staticmethod
    def get_video_data(source_element):
        if "/watch/" in source_element.url:
            search = re.search(r'/watch/([^/]+)/([^/]+)', source_element.url)
            stream_type = search.group(1)
            if stream_type in ["vod"]:
                stream_type = "replay"
            stream_id = search.group(2)
        else:
            search = re.search(r'/live/([^/]+)', source_element.url)
            stream_type = "live"
            stream_id = search.group(1)

        response = requests.post(
            watch_blaze_tv.STREAM_URL.format(
                stream_type=stream_type,
                stream_id=stream_id
            ),
            params={
                'key': watch_blaze_tv.API_KEY,
                'platform': watch_blaze_tv.PLATFORM
            }
        )

        response = response.content.decode()
        if response == "api-streams":
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Invalid stream type",
                solution="Write a valid URL"
            ))

        response = json.loads(response)
        err_msg = response.get("response", {}).get("error", "").lower()
        if "not found" in err_msg:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = response.get("response", {})
        has_drm = response.get("drm", False) is True
        if has_drm:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Widevine DRM not supported",
                solution=f"Extend the {watch_blaze_tv.__name__} service"
            ))

        if source_element.element is None:
            video_title = f'{stream_type}_{source_element.url.split("/")[-1]}'
            source_element.element = get_valid_filename(video_title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                watch_blaze_tv.__name__
            )
        return response["stream"], None, {}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/watch/" in collection_url or "/live/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/catchup" not in collection_url:
            if "/shows/" not in collection_url and "/series/" not in collection_url:
                return None

        collection = []
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                watch_blaze_tv.__name__
            ),
            get_valid_filename(collection_url.split("/")[-1])
        )

        response = requests.get(collection_url)
        response = response.content.decode()
        if ">errors_geo_title<" in response.lower():
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="Need British IP to access content",
                solution="Use a VPN"
            ))

        soup = BeautifulSoup(response, 'html5lib')
        a_nodes = soup.find_all('a', href=True)
        a_nodes = [a for a in a_nodes if "/watch/" in a["href"]]

        if "/page/catchup" in collection_url:
            video_index = 0
            for a_node in a_nodes:
                video_index += 1

                check = check_range(False, None, video_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                video_title = a_node["href"].split("/")[-1]
                collection.append(BaseElement(
                    url=a_node["href"],
                    collection=collection_title,
                    element=f'Video_{video_index}_{get_valid_filename(video_title)}'
                ))
            return collection

        episodes = []
        for a_node in a_nodes:
            episode_title = a_node.text
            if episode_title is None:
                episode_title = ""
            episode_title = episode_title.strip()
            if len(episode_title) == 0:
                episode_title = a_node["href"].split("/")[-1]

            episodes.append((a_node["href"], episode_title))
        episodes = list(reversed(episodes))

        spans = soup.find_all('span', {"data-content-type": "season-episode"})
        contents = []

        for span in spans:
            span_text = re.findall(r"S\d+:E\d+", span.text, flags=re.IGNORECASE)
            if len(span_text) == 0:
                continue

            span_text = span_text[0].split(":")
            try:
                season_index = int(span_text[0][1:])
                episode_index = int(span_text[1][1:])
            except:
                continue

            episode = episodes.pop()
            found = False
            for c_s, c_e in contents:
                if c_s == season_index:
                    c_e.append((episode_index, episode))
                    found = True
                    break

            if not found:
                contents.append((season_index, [(episode_index, episode)]))

        contents = sorted(contents, key=lambda ct: ct[0])
        for season_index, episodes in contents:
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            episodes = sorted(episodes, key=lambda ep: ep[0])
            for episode_index, episode in episodes:
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                collection.append(BaseElement(
                    url=episode[0],
                    collection=join(collection_title, f'Season_{season_index}'),
                    element=f'Episode_{episode_index}_{get_valid_filename(episode[1])}'
                ))

        return collection
