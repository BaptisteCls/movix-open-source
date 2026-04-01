import builtins
import json
import os
import re
import threading
from os.path import join

import m3u8
import requests

from utils.constants.macros import CACHE_DIR, ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import clean_url, get_valid_filename, dict_to_file, file_to_dict


class rugbypass_tv(BaseService):
    DEMO_URLS = [
        "https://rugbypass.tv/video/505498?seasonId=17639",
        "https://rugbypass.tv/video/693898?t=0",
        "https://rugbypass.tv/video/645717?t=0",
        "https://rugbypass.tv/playlist/24405",
        "https://rugbypass.tv/playlist/20513",
        "https://rugbypass.tv/playlist/22440",
        "https://rugbypass.tv/series/985",
        "https://rugbypass.tv/series/981",
        "https://rugbypass.tv/series/984",
        "https://rugbypass.tv/section/SVNS",
        "https://rugbypass.tv/section/Womens%20Home",
        "https://rugbypass.tv/section/IRELAND",
    ]

    REALM_URL = 'https://dce-frontoffice.imggaming.com/api/v1/init/'
    LOGIN_URL = 'https://dce-frontoffice.imggaming.com/api/v2/login'
    REFRESH_URL = 'https://dce-frontoffice.imggaming.com/api/v2/token/refresh'
    VOD_URL = 'https://dce-frontoffice.imggaming.com/api/v4/vod/{vod_id}'
    PLAYLIST_URL = 'https://dce-frontoffice.imggaming.com/api/v4/playlist/{playlist_id}'
    EPISODES_URL = 'https://dce-frontoffice.imggaming.com/api/v4/season/{season_id}'
    SEASONS_URL = 'https://dce-frontoffice.imggaming.com/api/v4/series/{series_id}'
    BUCKETS_URL = 'https://dce-frontoffice.imggaming.com/api/v4/content/{section_id}'
    BUCKET_VODS_URL = 'https://dce-frontoffice.imggaming.com/api/v4/content/{section_id}/bucket/{bucket_id}'
    BASE_URL = "https://rugbypass.tv"
    VIDEO_URL = BASE_URL + "/video/{vod_id}"

    EMAIL = "YOUR_EMAIL"
    PASSWORD = "YOUR_PASSWORD"
    SITE_DICT = None
    CACHE_FILE = None
    LOCK = None
    PAGE_SIZE = 25
    BUCKET_SIZE = 10

    @staticmethod
    def test_service():
        main_service.run_service(rugbypass_tv)

    @staticmethod
    def get_additional_params(additional):
        add_params = BaseService.get_additional_params(additional)
        if additional.get("USE_BASE_URL", False) is True:
            add_params += [("BASE_URL", lambda s: s.format(value=additional["MANIFEST_URL"]))]
        return add_params

    @staticmethod
    def credentials_needed():
        return {
            "EMAIL": rugbypass_tv.EMAIL,
            "PASSWORD": rugbypass_tv.PASSWORD
        }

    @staticmethod
    def refresh_account_tokens(source_url):
        old_auth_token = rugbypass_tv.SITE_DICT["AUTH_TOKEN"]
        with rugbypass_tv.LOCK:
            if old_auth_token == rugbypass_tv.SITE_DICT["AUTH_TOKEN"]:
                response = requests.post(
                    rugbypass_tv.REFRESH_URL,
                    headers={
                        'realm': rugbypass_tv.SITE_DICT["REALM_ID"],
                        'x-api-key': rugbypass_tv.SITE_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {rugbypass_tv.SITE_DICT["AUTH_TOKEN"]}'
                    },
                    json={'refreshToken': rugbypass_tv.SITE_DICT["REFRESH_TOKEN"]}
                )
                response = response.content.decode()
                response = json.loads(response)

                if response.get("authorisationToken", None) in ["", None]:
                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=source_url,
                        reason="Can't access the video content because the cached information expired",
                        solution=f'Delete the {rugbypass_tv.CACHE_FILE} cache manually or add the parameter --fresh to your command'
                    ))

                rugbypass_tv.SITE_DICT["AUTH_TOKEN"] = response["authorisationToken"]
                dict_to_file(rugbypass_tv.CACHE_FILE, rugbypass_tv.SITE_DICT)

    @staticmethod
    def set_site_dict():
        try:
            file_dict = file_to_dict(rugbypass_tv.CACHE_FILE)
            assert len(file_dict.keys()) == 4
            rugbypass_tv.SITE_DICT = file_dict
            return True
        except:
            pass

        class_name = rugbypass_tv.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            assert type(credentials["EMAIL"]) is str
            assert type(credentials["PASSWORD"]) is str
        except:
            return None

        response = requests.get(rugbypass_tv.BASE_URL).content.decode()
        app_js = re.findall(r'src="([^"]*app\.js)"', response)[0]
        if app_js[0] != "/":
            app_js = "/" + app_js
        app_js = rugbypass_tv.BASE_URL + app_js
        response = requests.get(app_js).content.decode()
        realm_api_key = re.findall(r'API_KEY:"([^"]+)"', response)[0]

        response = requests.get(
            rugbypass_tv.REALM_URL,
            headers={
                'x-api-key': realm_api_key,
                'Origin': rugbypass_tv.BASE_URL
            }
        )
        response = response.content.decode()
        response = json.loads(response)
        realm_id = response["settings"]["realm"]

        response = requests.post(
            rugbypass_tv.LOGIN_URL,
            headers={
                'x-api-key': realm_api_key, 'Realm': realm_id,
                'Authorization': f'Bearer {response["authentication"]["authorisationToken"]}'
            },
            json={
                'id': credentials["EMAIL"],
                'secret': credentials["PASSWORD"]
            }
        )
        response = response.content.decode()
        response = json.loads(response)
        message = str(response.get("messages", [])).lower()
        if response.get("status", "") in [404] and response.get("code", "").lower() in ["not_found"]:
            if "failedauthentication" in message:
                return None

        site_dict = {
            "REALM_ID": realm_id,
            "REALM_API_KEY": realm_api_key,
            "AUTH_TOKEN": response["authorisationToken"],
            "REFRESH_TOKEN": response["refreshToken"]
        }
        dict_to_file(rugbypass_tv.CACHE_FILE, site_dict)
        rugbypass_tv.SITE_DICT = site_dict
        return True

    @staticmethod
    def initialize_service():
        if rugbypass_tv.CACHE_FILE is None:
            rugbypass_tv.CACHE_FILE = join(CACHE_DIR, f'{rugbypass_tv.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(rugbypass_tv.CACHE_FILE, {})

        if rugbypass_tv.SITE_DICT is None:
            flag = rugbypass_tv.set_site_dict()
            if flag is None:
                return flag
        if rugbypass_tv.LOCK is None:
            rugbypass_tv.LOCK = threading.Lock()
        return rugbypass_tv

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {rugbypass_tv.__name__} service'
        )

    @staticmethod
    def generate_master_file(output_path, manifest, manifest_type):
        manifest_content = requests.get(manifest).content.decode()
        if not os.path.exists(output_path):
            os.makedirs(output_path)

        if manifest_type not in ["hls"]:
            output_path = join(output_path, "master.mpd")
            with open(output_path, "w") as f:
                f.write(manifest_content)
            return output_path

        base_url = clean_url(manifest).split("/")
        del base_url[-1]
        base_url = "/".join(base_url)

        manifest_content = m3u8.loads(manifest_content)
        for segment in manifest_content.playlists + manifest_content.media + manifest_content.segments:
            if not segment.uri.startswith("http"):
                if segment.uri.startswith("/"):
                    segment.uri = ".." + segment.uri

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
            f.write(manifest_content.dumps())
        return output_path

    @staticmethod
    def get_video_data(source_element):
        vod_id = re.search(r"/video/([^/?]*)", source_element.url).group(1)
        response = {}

        for i in range(0, 2):
            response = requests.get(
                rugbypass_tv.VOD_URL.format(vod_id=vod_id),
                params={'includePlaybackDetails': 'URL'},
                headers={
                    'realm': rugbypass_tv.SITE_DICT["REALM_ID"],
                    'x-api-key': rugbypass_tv.SITE_DICT["REALM_API_KEY"],
                    'Authorization': f'Bearer {rugbypass_tv.SITE_DICT["AUTH_TOKEN"]}'
                }
            )
            response = response.content.decode()
            response = json.loads(response)

            message = str(response.get("messages", [])).lower()
            if 400 <= response.get("status", 200) < 500 and " not found" in message:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available",
                    solution="Do not attempt to download it"
                ))

            if response.get("playerUrlCallback", None) in ["", None]:
                if i == 1:
                    break
                rugbypass_tv.refresh_account_tokens(source_element.url)
                continue
            break

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rugbypass_tv.__name__
            )
        if source_element.element is None:
            title = response.get("title", f'Video_{vod_id}')
            info = response.get("episodeInformation", {})
            for f in ["seasonNumber", "episodeNumber"]:
                try:
                    assert info[f] not in ["", None]
                    title += " " + f[0].upper() + str(info[f])
                except:
                    pass
            source_element.element = get_valid_filename(title)

        response = requests.get(response["playerUrlCallback"])
        response = response.content.decode()
        response = json.loads(response)

        manifest = None
        manifest_type = None
        for f in ["hls", "dash"]:
            try:
                manifest = response[f][0]["url"]
                assert manifest not in ["", None]
                manifest_type = f
                break
            except:
                pass

        additional = {
            "USE_BASE_URL": manifest_type in ["dash"],
            "MANIFEST_URL": clean_url(manifest)
        }
        manifest = rugbypass_tv.generate_master_file(
            join(source_element.collection, source_element.element),
            manifest, manifest_type
        )
        return manifest, None, additional

    @staticmethod
    def get_playlist(collection_url):
        playlist_id = re.search(r"/playlist/([^/?]*)", collection_url).group(1)
        response = {}
        last_seen = None
        collection_title = None

        collection = []
        vod_index = 0
        while True:
            playlist_params = {'rpp': rugbypass_tv.PAGE_SIZE}
            if last_seen is not None:
                playlist_params["lastSeen"] = last_seen

            for i in range(0, 2):
                response = requests.get(
                    rugbypass_tv.PLAYLIST_URL.format(playlist_id=playlist_id),
                    params=playlist_params,
                    headers={
                        'realm': rugbypass_tv.SITE_DICT["REALM_ID"],
                        'x-api-key': rugbypass_tv.SITE_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {rugbypass_tv.SITE_DICT["AUTH_TOKEN"]}'
                    }
                )
                response = response.content.decode()
                response = json.loads(response)

                if response.get("code", None) in ["UNAUTHORIZED"]:
                    if i == 1:
                        break
                    rugbypass_tv.refresh_account_tokens(collection_url)
                    continue
                break

            vods = response.get("vods", [])
            if len(vods) == 0:
                break

            if collection_title is None:
                collection_title = response.get("title", f'Playlist_{playlist_id}')
                collection_title = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        rugbypass_tv.__name__
                    ),
                    get_valid_filename(collection_title)
                )

            for vod in vods:
                vod_index += 1
                check = check_range(False, None, vod_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                if vod.get("type", "").lower() not in ["vod"]:
                    continue
                vod_url = rugbypass_tv.VIDEO_URL.format(vod_id=vod["id"])
                vod_title = vod.get("title", vod["id"])
                vod_title = f'Vod_{vod_index}_{vod_title}'

                collection.append(BaseElement(
                    url=vod_url,
                    collection=collection_title,
                    element=get_valid_filename(vod_title)
                ))

            paging = response.get("paging", {})
            if paging in ["", None]:
                break
            if paging.get("moreDataAvailable", False) in [None, False]:
                break
            last_seen = paging.get("lastSeen", None)
            if last_seen is None:
                break

        return collection

    @staticmethod
    def get_series(collection_url):
        series_id = re.search(r"/series/([^/?]*)", collection_url).group(1)
        seasons_response = {}
        seasons_last_seen = None
        collection_title = None

        collection = []
        season_index = 0
        while True:
            seasons_params = {'rpp': rugbypass_tv.PAGE_SIZE}
            if seasons_last_seen is not None:
                seasons_params["lastSeen"] = seasons_last_seen

            for i in range(0, 2):
                seasons_response = requests.get(
                    rugbypass_tv.SEASONS_URL.format(series_id=series_id),
                    params=seasons_params,
                    headers={
                        'realm': rugbypass_tv.SITE_DICT["REALM_ID"],
                        'x-api-key': rugbypass_tv.SITE_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {rugbypass_tv.SITE_DICT["AUTH_TOKEN"]}'
                    }
                )
                seasons_response = seasons_response.content.decode()
                seasons_response = json.loads(seasons_response)

                if seasons_response.get("code", None) in ["UNAUTHORIZED"]:
                    if i == 1:
                        break
                    rugbypass_tv.refresh_account_tokens(collection_url)
                    continue
                break

            seasons = seasons_response.get("seasons", [])
            if len(seasons) == 0:
                break

            if collection_title is None:
                collection_title = seasons_response.get("title", f'Series_{series_id}')
                collection_title = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        rugbypass_tv.__name__
                    ),
                    get_valid_filename(collection_title)
                )

            for season in seasons:
                season_index += 1
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                season_title = f'S{season_index} {season.get("title", "")}'
                season_title = get_valid_filename(season_title)
                season_id = season["id"]

                episodes_response = {}
                episodes_last_seen = None
                episode_index = 0
                while True:
                    episodes_params = {'rpp': rugbypass_tv.PAGE_SIZE}
                    if episodes_last_seen is not None:
                        episodes_params["lastSeen"] = episodes_last_seen

                    for i in range(0, 2):
                        episodes_response = requests.get(
                            rugbypass_tv.EPISODES_URL.format(season_id=season_id),
                            params=seasons_params,
                            headers={
                                'realm': rugbypass_tv.SITE_DICT["REALM_ID"],
                                'x-api-key': rugbypass_tv.SITE_DICT["REALM_API_KEY"],
                                'Authorization': f'Bearer {rugbypass_tv.SITE_DICT["AUTH_TOKEN"]}'
                            }
                        )
                        episodes_response = episodes_response.content.decode()
                        episodes_response = json.loads(episodes_response)

                        if episodes_response.get("code", None) in ["UNAUTHORIZED"]:
                            if i == 1:
                                break
                            rugbypass_tv.refresh_account_tokens(collection_url)
                            continue
                        break

                    episodes = episodes_response.get("episodes", [])
                    if len(episodes) == 0:
                        break

                    for episode in episodes:
                        episode_index += 1
                        check = check_range(False, season_index, episode_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                        if episode.get("type", "").lower() not in ["vod"]:
                            continue
                        episode_url = rugbypass_tv.VIDEO_URL.format(vod_id=episode["id"])
                        episode_title = episode.get("title", episode["id"])
                        episode_title = f'E{episode_index}_{episode_title}'

                        collection.append(BaseElement(
                            url=episode_url,
                            collection=join(collection_title, season_title),
                            element=get_valid_filename(episode_title)
                        ))

                    episodes_paging = episodes_response.get("paging", {})
                    if episodes_paging in ["", None]:
                        break
                    if episodes_paging.get("moreDataAvailable", False) in [None, False]:
                        break
                    episodes_last_seen = episodes_paging.get("lastSeen", None)
                    if episodes_last_seen is None:
                        break

            seasons_paging = seasons_response.get("paging", {})
            if seasons_paging in ["", None]:
                break
            if seasons_paging.get("moreDataAvailable", False) in [None, False]:
                break
            seasons_last_seen = seasons_paging.get("lastSeen", None)
            if seasons_last_seen is None:
                break

        return collection

    @staticmethod
    def get_section(collection_url):
        section_id = collection_url.split("/")[-1]
        buckets_response = {}
        buckets_last_seen = None
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rugbypass_tv.__name__
            ),
            get_valid_filename(f"Section {section_id}")
        )

        collection = []
        bucket_index = 0
        while True:
            buckets_params = {
                'bpp': rugbypass_tv.BUCKET_SIZE,
                'rpp': rugbypass_tv.PAGE_SIZE,
                'displaySectionLinkBuckets': 'SHOW',
                'displayEpgBuckets': 'HIDE',
                'displayEmptyBucketShortcuts': 'SHOW',
                'displayContentAvailableOnSignIn': 'SHOW',
                'displayGeoblocked': 'SHOW',
                'bspp': rugbypass_tv.BUCKET_SIZE
            }
            if buckets_last_seen is not None:
                buckets_params["lastSeen"] = buckets_last_seen

            for i in range(0, 2):
                buckets_response = requests.get(
                    rugbypass_tv.BUCKETS_URL.format(section_id=section_id),
                    params=buckets_params,
                    headers={
                        'realm': rugbypass_tv.SITE_DICT["REALM_ID"],
                        'x-api-key': rugbypass_tv.SITE_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {rugbypass_tv.SITE_DICT["AUTH_TOKEN"]}'
                    }
                )
                buckets_response = buckets_response.content.decode()
                buckets_response = json.loads(buckets_response)

                if buckets_response.get("code", None) in ["UNAUTHORIZED"]:
                    if i == 1:
                        break
                    rugbypass_tv.refresh_account_tokens(collection_url)
                    continue
                break

            buckets = buckets_response.get("buckets", [])
            if len(buckets) == 0:
                break

            for bucket in buckets:
                bucket_index += 1
                check = check_range(True, bucket_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                bucket_type = bucket.get("type", "").lower()
                if "vod" not in bucket_type and "video" not in bucket_type:
                    continue

                bucket_title = bucket.get("name", bucket.get("rowTypeData", {}).get("title", ""))
                bucket_title = get_valid_filename(f'Rail {bucket_index} {bucket_title}')
                bucket_id = bucket["exid"]

                vods_response = {}
                vods_last_seen = None
                vod_index = 0
                while True:
                    vods_params = {
                        'rpp': rugbypass_tv.PAGE_SIZE,
                        'displayContentAvailableOnSignIn': 'SHOW',
                        'displayGeoblocked': 'SHOW'
                    }
                    if vods_last_seen is not None:
                        vods_params["lastSeen"] = vods_last_seen

                    for i in range(0, 2):
                        vods_response = requests.get(
                            rugbypass_tv.BUCKET_VODS_URL.format(section_id=section_id, bucket_id=bucket_id),
                            params=vods_params,
                            headers={
                                'realm': rugbypass_tv.SITE_DICT["REALM_ID"],
                                'x-api-key': rugbypass_tv.SITE_DICT["REALM_API_KEY"],
                                'Authorization': f'Bearer {rugbypass_tv.SITE_DICT["AUTH_TOKEN"]}'
                            }
                        )
                        vods_response = vods_response.content.decode()
                        vods_response = json.loads(vods_response)

                        if vods_response.get("code", None) in ["UNAUTHORIZED"]:
                            if i == 1:
                                break
                            rugbypass_tv.refresh_account_tokens(collection_url)
                            continue
                        break

                    vods = vods_response.get("contentList", [])
                    if len(vods) == 0:
                        break

                    for vod in vods:
                        vod_index += 1
                        check = check_range(False, bucket_index, vod_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                        if vod.get("type", "").lower() not in ["vod"]:
                            continue
                        vod_url = rugbypass_tv.VIDEO_URL.format(vod_id=vod["id"])
                        vod_title = vod.get("title", vod["id"])
                        vod_title = f'Vod_{vod_index}_{vod_title}'

                        collection.append(BaseElement(
                            url=vod_url,
                            collection=join(collection_title, bucket_title),
                            element=get_valid_filename(vod_title)
                        ))

                    vods_paging = vods_response.get("paging", {})
                    if vods_paging in ["", None]:
                        break
                    if vods_paging.get("moreDataAvailable", False) in [None, False]:
                        break
                    vods_last_seen = vods_paging.get("lastSeen", None)
                    if vods_last_seen is None:
                        break

            buckets_paging = buckets_response.get("paging", {})
            if buckets_paging in ["", None]:
                break
            if buckets_paging.get("moreDataAvailable", False) in [None, False]:
                break
            buckets_last_seen = buckets_paging.get("lastSeen", None)
            if buckets_last_seen is None:
                break

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/video/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/playlist/" in collection_url:
            return rugbypass_tv.get_playlist(collection_url)
        if "/series/" in collection_url:
            return rugbypass_tv.get_series(collection_url)
        if "/section/" in collection_url:
            return rugbypass_tv.get_section(collection_url)
        return None
