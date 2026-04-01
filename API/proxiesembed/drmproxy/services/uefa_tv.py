import builtins
import json
import os
import re
import threading
from os.path import join
from urllib.parse import parse_qs, urlparse

import browser_cookie3
import m3u8
import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, CACHE_DIR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, clean_url, dict_to_file, file_to_dict


class uefa_tv(BaseService):
    DEMO_URLS = [
        "https://www.uefa.tv/video/vod/159916/",
        "https://www.uefa.tv/video/vod/644523/?playlistId=23974",
        "https://www.uefa.tv/match/vod/676686/2040798",
        "https://www.uefa.tv/video/vod/153377/?bucketExId=Vg~M&lastSeen=0%3A153377&section=UCL",
        "https://www.uefa.tv/playlist/5649",
        "https://www.uefa.tv/playlist/8415",
        "https://www.uefa.tv/search/videos?q=Messi%20UEFA",
        "https://www.uefa.tv/competition/UCL",
        "https://www.uefa.tv/competition/U-17",
    ]

    GET_JWT_URL = 'https://idp-prod.uefa.tv/accounts.getJWT'
    GIGYA_JWT_URL = 'https://dce-frontoffice.imggaming.com/api/v2/user/gigya/jwt'
    CHUNK_JS_URL = 'https://www.uefa.tv/static/js/{chunk_id}.{chunk_str}.chunk.js'
    STREAM_VOD_URL = 'https://dce-frontoffice.imggaming.com/api/v2/stream/vod/{vod_id}'
    REFRESH_TOKEN_URL = 'https://dce-frontoffice.imggaming.com/api/v2/token/refresh'
    VOD_METADATA_URL = 'https://dce-frontoffice.imggaming.com/api/v2/vod/{vod_id}'
    PLAYLIST_URL = 'https://dce-frontoffice.imggaming.com/api/v2/vod/playlist/{playlist_id}'
    SEARCH_QUERY_URL = 'https://{app_id}-dsn.algolia.net/1/indexes/prod-dce.uefa-livestreaming-events/query'
    COMP_BUCKET_URL = 'https://dce-frontoffice.imggaming.com/api/v4/content/{competition_id}/bucket/{bucket_id}'
    COMP_CONTENT_URL = 'https://dce-frontoffice.imggaming.com/api/v2/content/{competition_id}'
    VOD_URL = 'https://www.uefa.tv/video/vod/{vod_id}'
    BASE_URL = 'https://www.uefa.tv'

    LOCK = None
    CACHE_FILE = None
    USER_AGENT = None
    ACCOUNT_TOKENS = None
    LOGIN_COOKIES = None
    LOGIN_TOKEN = None
    API_KEY = None
    REALM_DICT = None
    PAGE_SIZE = 50

    @staticmethod
    def test_service():
        main_service.run_service(uefa_tv)

    @staticmethod
    def credentials_needed():
        return {"FIREFOX_COOKIES": True}

    @staticmethod
    def get_login_cookies():
        cookie_dict = {}
        for c in browser_cookie3.firefox(domain_name='uefa.tv'):
            cookie_dict[c.name] = c.value
            if uefa_tv.LOGIN_TOKEN is None and c.name.startswith("glt_"):
                uefa_tv.LOGIN_TOKEN = c.value
                uefa_tv.API_KEY = c.name[len("glt_"):]

        try:
            assert uefa_tv.LOGIN_TOKEN is not None
            assert uefa_tv.API_KEY is not None
            assert len(cookie_dict.keys()) > 0
        except:
            return None
        return cookie_dict

    @staticmethod
    def set_account_tokens():
        response = requests.post(
            uefa_tv.GET_JWT_URL,
            cookies=uefa_tv.LOGIN_COOKIES,
            data={
                'fields': 'firstName,lastName,email',
                'APIKey': uefa_tv.API_KEY,
                'login_token': uefa_tv.LOGIN_TOKEN,
                'sdk': 'js_latest',
                'authMode': 'cookie',
                'format': 'json'
            }
        )

        response = response.content.decode()
        response = json.loads(response)
        response = response["id_token"]

        response = requests.post(
            uefa_tv.GIGYA_JWT_URL,
            headers={
                'realm': uefa_tv.REALM_DICT["REALM_ID"],
                'x-api-key': uefa_tv.REALM_DICT["REALM_API_KEY"]
            },
            json={'jwt': response}
        )

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        message = str(response.get("messages", "")).lower()

        if status_code == 401 or "api key" in message:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=f'from {uefa_tv.__name__}',
                reason="Can't access the video content because the API key was changed",
                solution=f'Delete the {uefa_tv.CACHE_FILE} cache manually or add the parameter --fresh to your command'
            ))

        uefa_tv.ACCOUNT_TOKENS = response

    @staticmethod
    def get_realm_dict():
        try:
            file_dict = file_to_dict(uefa_tv.CACHE_FILE)
            assert len(file_dict.keys()) == 4
            return file_dict
        except:
            pass

        response = requests.get(
            uefa_tv.BASE_URL,
            headers={'User-Agent': uefa_tv.USER_AGENT}
        ).content.decode()
        response = re.findall(r'"static/js/".*"\.chunk\.js"', response)[0]
        response = re.findall(r'(\d+:"[^"]+")', response)

        for chunk in response:
            chunk = chunk.replace('"', "").split(":")
            chunk_js = requests.get(
                uefa_tv.CHUNK_JS_URL.format(
                    chunk_id=chunk[0],
                    chunk_str=chunk[1]
                ),
                headers={'User-Agent': uefa_tv.USER_AGENT}
            ).content.decode()

            try:
                realm_id = re.findall(r'REACT_APP_DICE_REALM_ID:"([^"]+)"', chunk_js)[0]
                realm_api_key = re.findall(r'REACT_APP_DICE_API_KEY:"([^"]+)"', chunk_js)[0]
                algolia_app_id = re.findall(r'REACT_APP_ALGOLIA_APP_ID:"([^"]+)"', chunk_js)[0]
                algolia_api_key = re.findall(r'REACT_APP_ALGOLIA_API_KEY:"([^"]+)"', chunk_js)[0]

                assert realm_id is not None
                assert realm_api_key is not None
                assert algolia_app_id is not None
                assert algolia_api_key is not None

                realm_dict = {
                    "REALM_ID": realm_id,
                    "REALM_API_KEY": realm_api_key,
                    "ALGOLIA_APP_ID": algolia_app_id,
                    "ALGOLIA_API_KEY": algolia_api_key
                }
                dict_to_file(uefa_tv.CACHE_FILE, realm_dict)
                return realm_dict
            except:
                pass
        raise "Failed to extract site information"

    @staticmethod
    def initialize_service():
        if uefa_tv.CACHE_FILE is None:
            uefa_tv.CACHE_FILE = join(CACHE_DIR, f'{uefa_tv.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(uefa_tv.CACHE_FILE, {})
        if uefa_tv.USER_AGENT is None:
            uefa_tv.USER_AGENT = builtins.CONFIG["USER_AGENT"]

        if uefa_tv.LOGIN_COOKIES is None:
            uefa_tv.LOGIN_COOKIES = uefa_tv.get_login_cookies()
            if uefa_tv.LOGIN_COOKIES is None:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=f'from {uefa_tv.__name__}',
                    reason='Need account for this service',
                    solution='Sign into your account using Firefox'
                ))

        if uefa_tv.REALM_DICT is None:
            uefa_tv.REALM_DICT = uefa_tv.get_realm_dict()
            uefa_tv.SEARCH_QUERY_URL = uefa_tv.SEARCH_QUERY_URL.format(
                app_id=uefa_tv.REALM_DICT["ALGOLIA_APP_ID"].lower()
            )
        if uefa_tv.ACCOUNT_TOKENS is None:
            uefa_tv.set_account_tokens()
        if uefa_tv.LOCK is None:
            uefa_tv.LOCK = threading.Lock()
        return uefa_tv

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {uefa_tv.__name__} service'
        )

    @staticmethod
    def refresh_account_tokens():
        old_auth_token = uefa_tv.ACCOUNT_TOKENS["authorisationToken"]
        with uefa_tv.LOCK:
            if old_auth_token == uefa_tv.ACCOUNT_TOKENS["authorisationToken"]:
                response = requests.post(
                    uefa_tv.REFRESH_TOKEN_URL,
                    headers={
                        'realm': uefa_tv.REALM_DICT["REALM_ID"],
                        'x-api-key': uefa_tv.REALM_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {uefa_tv.ACCOUNT_TOKENS["authorisationToken"]}'
                    },
                    json={'refreshToken': uefa_tv.ACCOUNT_TOKENS["refreshToken"]}
                )

                response = response.content.decode()
                response = json.loads(response)
                uefa_tv.ACCOUNT_TOKENS = response

    @staticmethod
    def generate_master_m3u8(output_path, manifest):
        m3u8_content = requests.get(manifest).content.decode()
        if not os.path.exists(output_path):
            os.makedirs(output_path)

        base_url = clean_url(manifest).split("/")
        del base_url[-1]
        base_url = "/".join(base_url)

        m3u8_content = m3u8.loads(m3u8_content)
        for segment in m3u8_content.playlists + m3u8_content.media:
            if not segment.uri.startswith("http"):
                dots = segment.uri.count("../")
                temp_base_url = base_url.split("/")
                temp_base_url = temp_base_url[0:len(temp_base_url) - dots]
                temp_base_url = "/".join(temp_base_url)

                segment.uri = segment.uri.replace("../", "")
                if not segment.uri.startswith("/"):
                    segment.uri = "/" + segment.uri
                segment.uri = temp_base_url + segment.uri

        output_path = join(output_path, "master.m3u8")
        with open(output_path, "w") as f:
            f.write(m3u8_content.dumps())
        return output_path

    @staticmethod
    def get_video_data(source_element):
        vod_id = re.search(r"/vod/([^/?]*)", source_element.url).group(1)
        response = None

        for i in range(0, 2):
            if i == 1:
                uefa_tv.refresh_account_tokens()

            response = requests.get(
                url=uefa_tv.STREAM_VOD_URL.format(vod_id=vod_id),
                headers={
                    'realm': uefa_tv.REALM_DICT["REALM_ID"],
                    'x-api-key': uefa_tv.REALM_DICT["REALM_API_KEY"],
                    'Authorization': f'Bearer {uefa_tv.ACCOUNT_TOKENS["authorisationToken"]}'
                }
            )

            status_code = response.status_code
            response = response.content.decode()
            response = json.loads(response)
            message = str(response.get("messages", "")).lower()

            if i == 0:
                if status_code == 401 and "bearer token" in message:
                    continue
            if 400 <= status_code < 500:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available",
                    solution="Do not attempt to download it"
                ))
            break

        assert response is not None
        response = response["playerUrlCallback"]
        response = requests.get(response)

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        message = str(response.get("message", "")).lower()

        if status_code == 403 and "not available in your location" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available in your location",
                solution="Use a VPN"
            ))

        if source_element.element is None:
            metadata = {}
            for i in range(0, 2):
                if i == 1:
                    uefa_tv.refresh_account_tokens()

                metadata = requests.get(
                    uefa_tv.VOD_METADATA_URL.format(vod_id=vod_id),
                    headers={
                        'realm': uefa_tv.REALM_DICT["REALM_ID"],
                        'x-api-key': uefa_tv.REALM_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {uefa_tv.ACCOUNT_TOKENS["authorisationToken"]}'
                    }
                )

                status_code = metadata.status_code
                metadata = metadata.content.decode()
                metadata = json.loads(metadata)
                message = str(metadata.get("messages", "")).lower()

                if i == 0:
                    if status_code == 401 and "bearer token" in message:
                        continue
                break

            title = metadata.get("title", f'Vod_{vod_id}')
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                uefa_tv.__name__
            )

        manifest = response.get("hlsUrl", None)
        if manifest in ["", None]:
            for f in ["hls", "dash", "smoothStreaming"]:
                try:
                    manifest = response[f]["url"]
                    assert manifest not in ["", None]
                    break
                except:
                    pass

        assert manifest not in ["", None]
        manifest = uefa_tv.generate_master_m3u8(
            join(source_element.collection, source_element.element),
            manifest
        )
        return manifest, None, {}

    @staticmethod
    def get_playlist(collection_url):
        playlist_id = re.search(r"/playlist/([^/?]*)", collection_url).group(1)
        response = None
        p = 0
        total = None
        collection_title = None

        vod_index = 0
        collection = []
        while True:
            p += 1
            for i in range(0, 2):
                if i == 1:
                    uefa_tv.refresh_account_tokens()

                response = requests.get(
                    uefa_tv.PLAYLIST_URL.format(playlist_id=playlist_id),
                    params={'p': p},
                    headers={
                        'realm': uefa_tv.REALM_DICT["REALM_ID"],
                        'x-api-key': uefa_tv.REALM_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {uefa_tv.ACCOUNT_TOKENS["authorisationToken"]}'
                    }
                )

                status_code = response.status_code
                response = response.content.decode()
                response = json.loads(response)
                message = str(response.get("messages", "")).lower()

                if i == 0:
                    if status_code == 401 and "bearer token" in message:
                        continue
                if 400 <= status_code < 500:
                    raise CustomException(ERR_MSG.format(
                        type=f'{USER_ERROR}',
                        url=collection_url,
                        reason="The content isn't available",
                        solution="Do not attempt to download it"
                    ))
                break

            if collection_title is None:
                collection_title = response.get("title", f'Playlist_{playlist_id}')
                collection_title = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        uefa_tv.__name__
                    ),
                    get_valid_filename(collection_title)
                )

            response = response.get("videos", {})
            if total is None:
                total = response.get("totalPages", None)

            vods = response.get("vods", [])
            for vod in vods:
                vod_index += 1
                check = check_range(False, None, vod_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                if vod.get("type", "").lower() not in ["vod"]:
                    continue
                vod_url = uefa_tv.VOD_URL.format(vod_id=vod["id"])
                vod_title = vod.get("title", vod["id"])
                vod_title = f'Vod_{vod_index}_{vod_title}'

                collection.append(BaseElement(
                    url=vod_url,
                    collection=collection_title,
                    element=get_valid_filename(vod_title)
                ))

            if (total is not None and p >= total) or len(vods) == 0:
                break

        return collection

    @staticmethod
    def get_search(collection_url):
        params_dict = parse_qs(urlparse(collection_url).query)
        query = params_dict["q"][0]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                uefa_tv.__name__
            ),
            get_valid_filename(f'Search_{query}')
        )

        page = -1
        total = None
        collection = []
        vod_index = 0
        while True:
            page += 1

            response = requests.post(
                url=uefa_tv.SEARCH_QUERY_URL,
                params={
                    'x-algolia-application-id': uefa_tv.REALM_DICT["ALGOLIA_APP_ID"],
                    'x-algolia-api-key': uefa_tv.REALM_DICT["ALGOLIA_API_KEY"]
                },
                data=json.dumps({
                    'query': query, 'page': page,
                    'hitsPerPage': uefa_tv.PAGE_SIZE,
                    'filters': 'type:LIVE_EVENT OR type:VOD_VIDEO'
                })
            )

            status_code = response.status_code
            response = response.content.decode()
            response = json.loads(response)
            message = response.get("message", "").lower()

            if status_code == 403 or "api key" in message:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=f'from {uefa_tv.__name__}',
                    reason="Can't access the video content because the API key was changed",
                    solution=f'Delete the {uefa_tv.CACHE_FILE} cache manually or add the parameter --fresh to your command'
                ))
            if total is None:
                total = response.get("nbPages", None)

            vods = response.get("hits", [])
            for vod in vods:
                vod_index += 1
                check = check_range(False, None, vod_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                if vod.get("type", "").lower() not in ["vod_video"]:
                    continue
                vod_url = uefa_tv.VOD_URL.format(vod_id=vod["id"])
                vod_title = vod.get("name", vod["id"])
                vod_title = f'Vod_{vod_index}_{vod_title}'

                collection.append(BaseElement(
                    url=vod_url,
                    collection=collection_title,
                    element=get_valid_filename(vod_title)
                ))
            if (total is not None and page + 1 >= total) or len(vods) == 0:
                break
        return collection

    @staticmethod
    def get_competition(collection_url):
        competition_id = collection_url.split("/")[-1]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                uefa_tv.__name__
            ),
            get_valid_filename(f'Competition_{competition_id}')
        )

        bucket_page = 0
        bucket_total = None
        bucket_index = 0
        visited_vods = []
        collection = []
        while True:
            bucket_page += 1
            buckets_response = None

            for i in range(0, 2):
                if i == 1:
                    uefa_tv.refresh_account_tokens()

                buckets_response = requests.get(
                    uefa_tv.COMP_CONTENT_URL.format(competition_id=competition_id),
                    params={'bp': bucket_page},
                    headers={
                        'realm': uefa_tv.REALM_DICT["REALM_ID"],
                        'x-api-key': uefa_tv.REALM_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {uefa_tv.ACCOUNT_TOKENS["authorisationToken"]}'
                    }
                )

                status_code = buckets_response.status_code
                buckets_response = buckets_response.content.decode()
                buckets_response = json.loads(buckets_response)
                message = str(buckets_response.get("messages", "")).lower()

                if i == 0:
                    if status_code == 401 and "bearer token" in message:
                        continue
                break

            if bucket_total is None:
                bucket_total = buckets_response.get("totalPages", None)
            buckets_response = buckets_response.get("buckets", [])

            for bucket in buckets_response:
                bucket_index += 1
                check = check_range(True, bucket_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection
                if bucket.get("type", "").lower() not in ["vod_video"]:
                    continue

                bucket_id = bucket["exid"]
                bucket_title = bucket.get("name", bucket_id)
                bucket_title = get_valid_filename(f'Rail_{bucket_index}_{bucket_title}')

                bucket_params = {}
                vod_index = 0
                while True:
                    vods_response = None

                    for i in range(0, 2):
                        if i == 1:
                            uefa_tv.refresh_account_tokens()

                        vods_response = requests.get(
                            uefa_tv.COMP_BUCKET_URL.format(
                                competition_id=competition_id,
                                bucket_id=bucket_id
                            ),
                            params=bucket_params,
                            headers={
                                'realm': uefa_tv.REALM_DICT["REALM_ID"],
                                'x-api-key': uefa_tv.REALM_DICT["REALM_API_KEY"],
                                'Authorization': f'Bearer {uefa_tv.ACCOUNT_TOKENS["authorisationToken"]}'
                            }
                        )

                        status_code = vods_response.status_code
                        vods_response = vods_response.content.decode()
                        vods_response = json.loads(vods_response)
                        message = str(vods_response.get("messages", "")).lower()

                        if i == 0:
                            if status_code == 401 and "bearer token" in message:
                                continue
                        break

                    vods = vods_response.get("contentList", [])
                    for vod in vods:
                        vod_index += 1
                        check = check_range(False, bucket_index, vod_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection
                        if vod.get("type", "").lower() not in ["vod"]:
                            continue

                        if vod["id"] in visited_vods:
                            continue
                        visited_vods.append(vod["id"])
                        vod_title = vod.get("title", vod["id"])
                        vod_title = f'Vod_{vod_index}_{vod_title}'

                        collection.append(BaseElement(
                            url=uefa_tv.VOD_URL.format(vod_id=vod["id"]),
                            collection=join(collection_title, bucket_title),
                            element=get_valid_filename(vod_title)
                        ))

                    if vods_response.get("paging", {}).get("moreDataAvailable", False) is False or len(vods) == 0:
                        break
                    bucket_params = {"lastSeen": vods_response["paging"]["lastSeen"]}

            if (bucket_total is not None and bucket_page >= bucket_total) or len(buckets_response) == 0:
                break
        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        if "/live/" in collection_url:
            return None
        if "/search/videos?q=" in collection_url:
            return uefa_tv.get_search(collection_url)

        collection_url = clean_url(collection_url)
        if "/video/vod/" in collection_url or "/match/vod/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/playlist/" in collection_url:
            return uefa_tv.get_playlist(collection_url)
        if "/competition/" in collection_url:
            return uefa_tv.get_competition(collection_url)
        return None
