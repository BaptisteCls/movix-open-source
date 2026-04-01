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
from utils.tools.common import get_valid_filename, clean_url


class watch_tbn_uk(BaseService):
    DEMO_URLS = [
        "https://watch.tbn.uk/watch/replay/19118141/john-mcginley",
        "https://watch.tbn.uk/watch/vod/52157303/identity-and-belonging",
        "https://watch.tbn.uk/live/1197",
        "https://watch.tbn.uk/shows/c171a631-ca92-4715-9df4-51567542481c/the-sessions-with-cynthia-garrett",
        "https://watch.tbn.uk/shows/906eb770-23de-4fc7-a369-e87167a5256d/praise-uk",
    ]

    STREAM_URL = '/api/{stream_type}/stream/{stream_id}'
    BASE_URL = "https://watch.tbn.uk"

    API_KEY = None

    @staticmethod
    def test_service():
        main_service.run_service(watch_tbn_uk)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/live/" in content

    @staticmethod
    def get_additional_params(additional):
        return [("MUXER", lambda s: s.format(args="mkv:muxer=mkvmerge"))]

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def set_api_info():
        response = requests.get(watch_tbn_uk.BASE_URL)
        response = response.content.decode()
        response = re.findall(r'config[^=]*=[^{]*({[^;]+});', response)
        response = json.loads(response[0])["api"]

        watch_tbn_uk.API_KEY = response["key"]
        response = response["endpoints"]
        watch_tbn_uk.STREAM_URL = response["streams"] + watch_tbn_uk.STREAM_URL

    @staticmethod
    def initialize_service():
        if watch_tbn_uk.API_KEY is None:
            watch_tbn_uk.set_api_info()
        return watch_tbn_uk

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {watch_tbn_uk.__name__} service'
        )

    @staticmethod
    def get_video_data(source_element):
        response = requests.get(source_element.url)
        response_html = response.content.decode()
        response = re.findall(r'data-uvid="([^"]+)"', response_html)
        if len(response) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        stream_id = response[0]
        response = re.findall(r'this.url.params[^=]*=[^{]*({[^}]+})', response_html)
        if len(response) == 0:
            response = re.findall(r'programme[^{]*({[^}]+})', response_html)
        response = re.findall(r"type[^:]*:[^']*'([^']+)'", response[0])
        stream_type = response[0].lower()

        response = requests.post(
            watch_tbn_uk.STREAM_URL.format(stream_type=stream_type, stream_id=stream_id),
            params={'key': watch_tbn_uk.API_KEY, 'platform': 'chrome'}
        )
        response = response.content.decode()
        response = json.loads(response).get("response", {})
        if "not found" in response.get("error", "").lower():
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        if response.get("drm", False) is True:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Widevine DRM not supported",
                solution=f"Extend the {watch_tbn_uk.__name__} service"
            ))

        manifest = response.get("stream", "")
        if manifest in ["", None]:
            response = response["ads"]
            manifest = response["prefix"] + response["session"]
            manifest = requests.post(manifest)
            manifest = manifest.content.decode()
            manifest = json.loads(manifest)
            manifest = response["prefix"] + manifest["manifestUrl"]

        if source_element.element is None:
            response_html = BeautifulSoup(response_html, 'html5lib')
            try:
                title = response_html.title.text
                assert len(title) > 0
            except:
                title = f'Video_{source_element.url.split("/")[-1]}'
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                watch_tbn_uk.__name__
            )

        return manifest, None, {}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        for f in ["vod", "replay"]:
            if f"/watch/{f}/" in collection_url:
                return [BaseElement(url=collection_url)]
        if "/live/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/shows/" not in collection_url:
            return None

        response = requests.get(collection_url)
        response = response.content.decode()

        try:
            collection_title = re.findall(r'"af_content"[^:]*:[^"]*"([^"]+)"', response)
            collection_title = collection_title[0]
            assert len(collection_title) > 0
        except:
            collection_title = collection_url.split("/")[-1]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                watch_tbn_uk.__name__
            ),
            get_valid_filename(collection_title)
        )

        response_soup = BeautifulSoup(response, 'html5lib')
        card_nodes = response_soup.find_all('div', class_=lambda c: c and "card-body" in c)
        seasons = {}
        for card_node in card_nodes:
            try:
                card_title = card_node.find(class_=lambda c: c and "card-title" in c)
                card_title = card_title.find("a", attrs={"href": True})
                episode_url = card_title["href"]
                assert len(episode_url) > 0

                season_index = card_node.find("span", attrs={"data-content-type": "season"})
                season_index = season_index.get_text().strip()
                season_index = re.search(r'season\s*(\d+)', season_index, flags=re.IGNORECASE)
                season_index = int(season_index.group(1))

                episode_index = card_node.find("span", attrs={"data-content-type": "episode"})
                episode_index = episode_index.get_text().strip()
                episode_index = re.search(r'episode\s*(\d+)', episode_index, flags=re.IGNORECASE)
                episode_index = int(episode_index.group(1))
            except:
                continue

            try:
                episode_title = card_title.get_text().strip()
                assert len(episode_title) > 0
            except:
                episode_title = episode_url.split("/")[-1]
            episode_title = f'Episode_{episode_index}_{episode_title}'

            if seasons.get(season_index, None) is None:
                seasons[season_index] = []
            seasons[season_index].append((episode_index, {
                "title": episode_title,
                "url": episode_url
            }))

        collection = []
        for season_index, episodes in sorted(seasons.items()):
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            if len(episodes) == 0:
                continue
            episodes = sorted(episodes, key=lambda e: e[0])

            for episode_index, episode in episodes:
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                collection.append(BaseElement(
                    url=episode["url"],
                    collection=join(collection_title, f'Season_{season_index}'),
                    element=get_valid_filename(episode["title"])
                ))

        return collection
