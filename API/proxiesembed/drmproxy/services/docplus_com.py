import builtins
import json
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, clean_url


class docplus_com(BaseService):
    DEMO_URLS = [
        "https://www.docplus.com/details/we-are-oscar-mike/JPyypQpb/",
        "https://www.docplus.com/details/kobe-bryant-a-tribute/dGgz7pVK/",
        "https://www.docplus.com/category/films/o8VaZNFs/",
        "https://www.docplus.com/category/the-royals/qVyLLHgs/",
    ]

    MEDIA_URL = "https://cdn.jwplayer.com/v2/media/{media_id}"
    PLAYLIST_URL = "https://cdn.jwplayer.com/v2/playlists/{playlist_id}"
    CONTENT_URL = "https://www.docplus.com/details/content/{content_id}"

    PAGE_LIMIT = 500

    @staticmethod
    def test_service():
        main_service.run_service(docplus_com)

    @staticmethod
    def get_additional_params(additional):
        return [("MUXER", lambda s: s.format(args="mkv:muxer=mkvmerge"))]

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return docplus_com

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {docplus_com.__name__} service'
        )

    @staticmethod
    def get_video_data(source_element):
        media_id = source_element.url.split("/")[-1]
        response = requests.get(docplus_com.MEDIA_URL.format(media_id=media_id))
        if 400 <= response.status_code < 500:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = response.content.decode()
        response = json.loads(response)
        playlist = response.get("playlist", [])
        playlist = filter(lambda p: p.get("mediaid", "") == media_id, playlist)
        playlist = list(playlist)[0]

        if source_element.element is None:
            title = response.get("title", playlist.get("title", ""))
            if title in ["", None]:
                title = source_element.url.split("/")[-2]
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                docplus_com.__name__
            )

        sources = playlist.get("sources", [])
        sources = filter(lambda s: "mpeg" in s.get("type", ""), sources)
        sources = list(sources)[0]
        manifest = sources["file"]

        return manifest, None, {}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/details/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/category/" not in collection_url:
            return None

        category_id = collection_url.split("/")[-1]
        response = requests.get(
            docplus_com.PLAYLIST_URL.format(playlist_id=category_id),
            params={"page_limit": docplus_com.PAGE_LIMIT}
        )
        if 400 <= response.status_code < 500:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = response.content.decode()
        response = json.loads(response)
        collection_title = response.get("title", None)
        if collection_title in ["", None]:
            collection_title = collection_url.split("/")[-2]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                docplus_com.__name__
            ),
            get_valid_filename(f'Category_{collection_title}')
        )

        collection = []
        visited = []
        media_index = 0
        prev_url = None
        while True:
            links = response.get("links", {})
            if links is None:
                links = {}

            playlist = response.get("playlist", [])
            for media in playlist:
                media_index += 1
                check = check_range(False, None, media_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                media_id = media["mediaid"]
                if media_id in visited:
                    continue
                visited.append(media_id)

                media_title = media.get("title", media_id)
                media_title = f'Media_{media_index}_{media_title}'
                media_url = docplus_com.CONTENT_URL.format(content_id=media_id)

                collection.append(BaseElement(
                    url=media_url,
                    collection=collection_title,
                    element=get_valid_filename(media_title)
                ))

            next_url = links.get("next", None)
            if next_url in ["", None] or len(playlist) == 0:
                break
            if prev_url == next_url:
                break
            prev_url = next_url

            response = requests.get(str(next_url))
            response = response.content.decode()
            response = json.loads(response)

        return collection
