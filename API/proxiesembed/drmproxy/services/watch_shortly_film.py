import builtins
import json
from os.path import join
from urllib.parse import parse_qs, urlparse

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR, CACHE_DIR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, clean_url, dict_to_file, file_to_dict


class watch_shortly_film(BaseService):
    DEMO_URLS = [
        "https://watch.shortly.film/play/f-for-freaks",
        "https://watch.shortly.film/play/the-virus",
        "https://watch.shortly.film/tag/11-15-min_23192C",
        "https://watch.shortly.film/search?q=horror",
        "https://watch.shortly.film/search?q=uk",
    ]

    ASSET_URL = 'https://exposure.api.redbee.live/v1/customer/ShortlyFilm/businessunit/ShortlyOTT/content/asset/{asset_id}'
    PLAY_URL = 'https://exposure.api.redbee.live/v2/customer/ShortlyFilm/businessunit/ShortlyOTT/entitlement/{asset_id}/play'
    LOGIN_URL = 'https://exposure.api.redbee.live/v3/customer/ShortlyFilm/businessunit/ShortlyOTT/auth/login'
    TAG_SEARCH_URL = 'https://exposure.api.redbee.live/v1/customer/ShortlyFilm/businessunit/ShortlyOTT/content/asset'
    QUERY_SEARCH_URL = 'https://exposure.api.redbee.live/v3/customer/ShortlyFilm/businessunit/ShortlyOTT/content/search/query/{query}'
    VIDEO_URL = 'https://watch.shortly.film/play/{asset_id}'

    EMAIL = "YOUR_EMAIL"
    PASSWORD = "YOUR_PASSWORD"
    BEARER_TOKEN = None
    CACHE_FILE = None
    PAGE_SIZE = 50

    @staticmethod
    def test_service():
        main_service.run_service(watch_shortly_film)

    @staticmethod
    def credentials_needed():
        return {
            "EMAIL": watch_shortly_film.EMAIL,
            "PASSWORD": watch_shortly_film.PASSWORD
        }

    @staticmethod
    def get_bearer_token():
        try:
            return file_to_dict(watch_shortly_film.CACHE_FILE)["bearer_token"]
        except:
            pass

        class_name = watch_shortly_film.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            assert type(credentials["EMAIL"]) is str
            assert type(credentials["PASSWORD"]) is str
        except:
            return None

        response = requests.post(
            watch_shortly_film.LOGIN_URL,
            json={
                'username': credentials["EMAIL"],
                'password': credentials["PASSWORD"],
                'device': {'deviceId': 'deviceId'}
            }
        )

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        message = response.get("message", "").lower()
        if status_code == 401 and message == "incorrect_credentials":
            return None

        bearer_token = response["sessionToken"]
        dict_to_file(watch_shortly_film.CACHE_FILE, {"bearer_token": bearer_token})
        return bearer_token

    @staticmethod
    def initialize_service():
        if watch_shortly_film.CACHE_FILE is None:
            watch_shortly_film.CACHE_FILE = join(CACHE_DIR, f'{watch_shortly_film.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(watch_shortly_film.CACHE_FILE, {})

        if watch_shortly_film.BEARER_TOKEN is None:
            watch_shortly_film.BEARER_TOKEN = watch_shortly_film.get_bearer_token()
            if watch_shortly_film.BEARER_TOKEN is None:
                return None
        return watch_shortly_film

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
        asset_id = source_element.url.split("/")[-1]
        response = requests.get(watch_shortly_film.ASSET_URL.format(asset_id=asset_id))

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        message = response.get("message", "").lower()

        if status_code == 404 and "unknown_asset" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            title = None
            localized = response.get("localized", [])
            localized = list(filter(lambda lc: lc.get("locale", "").lower() in ["en"], localized))
            if len(localized) > 0:
                localized = localized[0]
                title = localized.get("title", localized.get("sortingTitle", ""))

            if title in [None, ""]:
                title = response.get("originalTitle", None)
            if title in [None, ""]:
                title = f'Film_{asset_id}'
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                watch_shortly_film.__name__
            )

        asset_id = response["assetId"]
        response = requests.get(
            watch_shortly_film.PLAY_URL.format(asset_id=asset_id),
            params={'supportedFormats': 'dash', 'supportedDrms': 'widevine'},
            headers={'authorization': f'Bearer {watch_shortly_film.BEARER_TOKEN}'}
        )

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        message = response.get("message", "").lower()

        if status_code == 401 and "session_token" in message:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't access the video content because the cached token expired",
                solution=f'Delete the {watch_shortly_film.CACHE_FILE} cache manually or add the parameter --fresh to your command'
            ))

        response = response["formats"][0]
        manifest = response["mediaLocator"]
        license_url = response.get("drm", {}).get("com.widevine.alpha", {}).get("licenseServerUrl", None)
        pssh_value = None

        if license_url is not None:
            manifest_content = requests.get(manifest).content.decode()
            try:
                pssh_value = get_pssh_from_cenc_pssh(manifest_content)
            except:
                pssh_value = None

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}. Can't extract pssh",
                    solution=f"Extend the {watch_shortly_film.__name__} service"
                ))

        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_tags(collection_url, search_query=None):
        if search_query is None:
            search_query = {}

        tag = search_query.get("tag_id", None)
        collection_title = search_query.get("collection_title", None)
        collection = search_query.get("collection", None)
        video_index = search_query.get("video_index", None)
        visited = search_query.get("visited", None)

        if tag is None:
            tag = collection_url.split("/")[-1]
            tag = f'tags.other:{tag}'
            collection_title = f'Tag_{tag}'
            collection_title = join(
                join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    watch_shortly_film.__name__
                ),
                get_valid_filename(collection_title)
            )
            collection = []
            video_index = 0
            visited = []

        page = 0
        while True:
            page += 1
            response = requests.get(
                watch_shortly_film.TAG_SEARCH_URL,
                params={
                    'pageSize': watch_shortly_film.PAGE_SIZE,
                    'fieldSet': 'ALL', 'pageNumber': page,
                    'query': tag
                }
            )

            response = response.content.decode()
            response = json.loads(response)
            videos = response.get("items", [])
            if len(videos) == 0:
                break

            for video in videos:
                try:
                    asset_id = video["slugs"][0]
                    assert len(asset_id) > 0
                except:
                    asset_id = video["assetId"]

                if asset_id in visited:
                    continue
                visited.append(asset_id)

                video_index += 1
                check = check_range(False, None, video_index)
                if check is True:
                    continue
                elif check is False:
                    return collection
                video_url = watch_shortly_film.VIDEO_URL.format(asset_id=asset_id)

                video_title = None
                localized = video.get("localized", [])
                localized = list(filter(lambda lc: lc.get("locale", "").lower() in ["en"], localized))
                if len(localized) > 0:
                    localized = localized[0]
                    video_title = localized.get("title", localized.get("sortingTitle", ""))

                if video_title in [None, ""]:
                    video_title = video.get("originalTitle", None)
                if video_title in [None, ""]:
                    video_title = asset_id
                video_title = get_valid_filename(f'Film_{video_index}_{video_title}')

                collection.append(BaseElement(
                    url=video_url,
                    collection=collection_title,
                    element=video_title
                ))

        return collection

    @staticmethod
    def get_search(collection_url):
        params_dict = parse_qs(urlparse(collection_url).query)
        query = params_dict["q"][0]
        if query in ["", None]:
            return []
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                watch_shortly_film.__name__
            ),
            get_valid_filename(f'Search_{query}')
        )

        response = requests.get(
            watch_shortly_film.QUERY_SEARCH_URL.format(query=query),
            params={
                'fieldSet': 'ALL', 'locale': 'en',
                'types': 'MOVIE,TV_SHOW,EPISODE,TV_CHANNEL,LIVE_EVENT,EVENT',
                'schemes': ['other', 'genre', 'category']
            }
        )

        response = response.content.decode()
        response = json.loads(response)
        videos = response.get("assetHits", {}).get("items", [])

        video_index = 0
        collection = []
        visited = []
        for video in videos:
            video = video["asset"]
            try:
                asset_id = video["slugs"][0]
                assert len(asset_id) > 0
            except:
                asset_id = video["assetId"]

            if asset_id in visited:
                continue
            visited.append(asset_id)

            video_index += 1
            check = check_range(False, None, video_index)
            if check is True:
                continue
            elif check is False:
                return collection

            video_url = watch_shortly_film.VIDEO_URL.format(asset_id=asset_id)
            video_title = None
            localized = video.get("localized", [])
            localized = list(filter(lambda lc: lc.get("locale", "").lower() in ["en"], localized))
            if len(localized) > 0:
                localized = localized[0]
                video_title = localized.get("title", localized.get("sortingTitle", ""))

            if video_title in [None, ""]:
                video_title = video.get("originalTitle", None)
            if video_title in [None, ""]:
                video_title = asset_id
            video_title = get_valid_filename(f'Film_{video_index}_{video_title}')

            collection.append(BaseElement(
                url=video_url,
                collection=collection_title,
                element=video_title
            ))

        tag_ids = [t["tag"]["tagId"] for t in response.get("tagHits", {}).get("items", [])]
        if len(tag_ids) == 0:
            return collection

        tag_ids = " OR ".join(tag_ids)
        collection = watch_shortly_film.get_tags(
            collection_url,
            search_query={
                "tag_id": f'tags.tagId:{tag_ids}',
                "collection_title": collection_title,
                "collection": collection,
                "video_index": video_index,
                "visited": visited
            }
        )
        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        if "/search?q=" in collection_url:
            return watch_shortly_film.get_search(collection_url)
        collection_url = clean_url(collection_url)

        if "/play/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/tag/" in collection_url:
            return watch_shortly_film.get_tags(collection_url)
        return None
