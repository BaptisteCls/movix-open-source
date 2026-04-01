import builtins
import json
import re
from os.path import join

import requests

from utils.constants.macros import USER_ERROR, ERR_MSG
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, clean_url


class filmzie_com(BaseService):
    DEMO_URLS = [
        "https://filmzie.com/content/before-the-dawn-2019?sourceId=613744175971e8001d714ce6",
        "https://filmzie.com/content/trump-the-art-of-the-insult",
        "https://filmzie.com/content/3-athletes-4-seasons-slovak-compilation-2018",
        "https://filmzie.com/content/vegan-mashup-2012",
        "https://filmzie.com/content/tough-rides-2013",
        "https://filmzie.com/content/inner-worlds-the-series-2012",
    ]

    STREAM_URL = 'https://filmzie.com/api/v1/video/stream/{stream_id}'

    @staticmethod
    def test_service():
        main_service.run_service(filmzie_com)

    @staticmethod
    def get_additional_params(additional):
        return [("MUXER", lambda s: s.format(args="mkv:muxer=mkvmerge"))]

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return filmzie_com

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {filmzie_com.__name__} service'
        )

    @staticmethod
    def get_video_data(source_element):
        stream_id = source_element.additional["stream_id"]
        response = requests.get(filmzie_com.STREAM_URL.format(stream_id=stream_id))
        response = response.content.decode()
        response = json.loads(response)
        response = response["data"]["source"]

        manifest = None
        for s in response.get("sources", []):
            if s.get("file", None) not in ["", None]:
                manifest = s["file"]
                break
        if manifest is None:
            manifest = response["hlsV2"]

        return manifest, None, {}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        response = requests.get(collection_url).content.decode()
        response = re.findall(r"window\['APP_STATE'][^=]*=[^{]({.*});", response)
        response = json.loads(response[0])

        response = response.get("contentPage", {})
        if response in [{}, None, ""]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        metadata = response.get("content", {})
        seo_tags = metadata.get("seoTags", {})
        if seo_tags is None:
            seo_tags = {}

        collection_title = metadata.get("title", seo_tags.get("title", None))
        if collection_title in ["", None]:
            collection_title = collection_url.split("/")[-1]
        collection_title = get_valid_filename(collection_title)

        if metadata.get("type", "").lower() not in ["tv_show"]:
            stream_id = metadata["videos"]
            stream_id = filter(lambda v: v["type"] not in ["TRAILER"], stream_id)
            stream_id = list(stream_id)[0]["id"]

            return [BaseElement(
                url=collection_url,
                element=collection_title,
                collection=join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    filmzie_com.__name__
                ),
                additional={"stream_id": stream_id}
            )]

        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                filmzie_com.__name__
            ),
            collection_title
        )
        collection = []

        seasons = response.get("seasons", [])
        seasons = sorted(seasons, key=lambda s: s["seasonNumber"])
        for season in seasons:
            season_index = season["seasonNumber"]
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            season_title = f'S{season_index}_{season.get("title", "")}'
            season_title = get_valid_filename(season_title)
            episodes = season.get("episodes", [])
            episode_index = 0

            for episode in episodes:
                episode_index += 1
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                stream_id = episode["videoId"]
                episode_title = episode.get("title", stream_id)
                collection.append(BaseElement(
                    url=collection_url + f"/s{season_index}_e{episode_index}",
                    collection=join(collection_title, season_title),
                    element=get_valid_filename(f'Episode_{episode_index}_{episode_title}'),
                    additional={"stream_id": stream_id}
                ))

        return collection
