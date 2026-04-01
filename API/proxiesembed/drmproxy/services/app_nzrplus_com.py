import builtins
import json
import os
import re
import threading
from os.path import join

import m3u8
import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, CACHE_DIR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_default_kid
from utils.tools.common import clean_url, get_valid_filename, dict_to_file, file_to_dict


class app_nzrplus_com(BaseService):
    DEMO_URLS = [
        "https://app.nzrplus.com/video/642249",
        "https://app.nzrplus.com/video/526149?playlistId=25137",
        "https://app.nzrplus.com/playlist/25137",
        "https://app.nzrplus.com/playlist/17076",
        "https://app.nzrplus.com/section/BlackFerns",
        "https://app.nzrplus.com/section/AllBlacks",
    ]

    BUCKETS_URL = 'https://dce-frontoffice.imggaming.com/api/v4/content/{section_id}'
    BUCKET_VODS_URL = 'https://dce-frontoffice.imggaming.com/api/v4/content/{section_id}/bucket/{bucket_id}'
    PLAYLIST_URL = 'https://dce-frontoffice.imggaming.com/api/v4/playlist/{playlist_id}'
    REALM_URL = 'https://dce-frontoffice.imggaming.com/api/v1/init/'
    LOGIN_URL = 'https://dce-frontoffice.imggaming.com/api/v2/login'
    REFRESH_URL = 'https://dce-frontoffice.imggaming.com/api/v2/token/refresh'
    VOD_URL = 'https://dce-frontoffice.imggaming.com/api/v4/vod/{vod_id}'
    BASE_URL = "https://app.nzrplus.com"
    VIDEO_URL = BASE_URL + "/video/{vod_id}"

    EMAIL = "YOUR_EMAIL"
    PASSWORD = "YOUR_PASSWORD"
    SITE_DICT = None
    CACHE_FILE = None
    LOCK = None
    DRM_INFO = "eyJzeXN0ZW0iOiJjb20ud2lkZXZpbmUuYWxwaGEifQ=="
    PAGE_SIZE = 25
    BUCKET_SIZE = 10

    @staticmethod
    def test_service():
        main_service.run_service(app_nzrplus_com)

    @staticmethod
    def get_additional_params(additional):
        add_params = BaseService.get_additional_params(additional)
        if additional.get("USE_BASE_URL", False) is True:
            add_params += [("BASE_URL", lambda s: s.format(value=additional["MANIFEST_URL"]))]
        return add_params

    @staticmethod
    def credentials_needed():
        return {
            "EMAIL": app_nzrplus_com.EMAIL,
            "PASSWORD": app_nzrplus_com.PASSWORD
        }

    @staticmethod
    def set_site_dict():
        try:
            file_dict = file_to_dict(app_nzrplus_com.CACHE_FILE)
            assert len(file_dict.keys()) == 4
            app_nzrplus_com.SITE_DICT = file_dict
            return True
        except:
            pass

        class_name = app_nzrplus_com.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            assert type(credentials["EMAIL"]) is str
            assert type(credentials["PASSWORD"]) is str
        except:
            return None

        response = requests.get(app_nzrplus_com.BASE_URL).content.decode()
        app_js = re.findall(r'src="([^"]*app\.js)"', response)[0]
        if app_js[0] != "/":
            app_js = "/" + app_js
        app_js = app_nzrplus_com.BASE_URL + app_js
        response = requests.get(app_js).content.decode()
        realm_api_key = re.findall(r'API_KEY:"([^"]+)"', response)[0]

        response = requests.get(
            app_nzrplus_com.REALM_URL,
            headers={
                'x-api-key': realm_api_key,
                'Origin': app_nzrplus_com.BASE_URL
            }
        )
        response = response.content.decode()
        response = json.loads(response)
        realm_id = response["settings"]["realm"]

        response = requests.post(
            app_nzrplus_com.LOGIN_URL,
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
        dict_to_file(app_nzrplus_com.CACHE_FILE, site_dict)
        app_nzrplus_com.SITE_DICT = site_dict
        return True

    @staticmethod
    def initialize_service():
        if app_nzrplus_com.CACHE_FILE is None:
            app_nzrplus_com.CACHE_FILE = join(CACHE_DIR, f'{app_nzrplus_com.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(app_nzrplus_com.CACHE_FILE, {})

        if app_nzrplus_com.SITE_DICT is None:
            flag = app_nzrplus_com.set_site_dict()
            if flag is None:
                return flag
        if app_nzrplus_com.LOCK is None:
            app_nzrplus_com.LOCK = threading.Lock()
        return app_nzrplus_com

    @staticmethod
    def refresh_account_tokens(source_url):
        old_auth_token = app_nzrplus_com.SITE_DICT["AUTH_TOKEN"]
        with app_nzrplus_com.LOCK:
            if old_auth_token == app_nzrplus_com.SITE_DICT["AUTH_TOKEN"]:
                response = requests.post(
                    app_nzrplus_com.REFRESH_URL,
                    headers={
                        'realm': app_nzrplus_com.SITE_DICT["REALM_ID"],
                        'x-api-key': app_nzrplus_com.SITE_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {app_nzrplus_com.SITE_DICT["AUTH_TOKEN"]}'
                    },
                    json={'refreshToken': app_nzrplus_com.SITE_DICT["REFRESH_TOKEN"]}
                )
                response = response.content.decode()
                response = json.loads(response)

                if response.get("authorisationToken", None) in ["", None]:
                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=source_url,
                        reason="Can't access the video content because the cached information expired",
                        solution=f'Delete the {app_nzrplus_com.CACHE_FILE} cache manually or add the parameter --fresh to your command'
                    ))

                app_nzrplus_com.SITE_DICT["AUTH_TOKEN"] = response["authorisationToken"]
                dict_to_file(app_nzrplus_com.CACHE_FILE, app_nzrplus_com.SITE_DICT)

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"],
            headers={
                'Authorization': f'Bearer {additional["drm_token"]}',
                'X-DRM-INFO': app_nzrplus_com.DRM_INFO
            },
            data=challenge
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def generate_master_file(output_path, manifest, manifest_type, manifest_content):
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
                app_nzrplus_com.VOD_URL.format(vod_id=vod_id),
                params={'includePlaybackDetails': 'URL'},
                headers={
                    'realm': app_nzrplus_com.SITE_DICT["REALM_ID"],
                    'x-api-key': app_nzrplus_com.SITE_DICT["REALM_API_KEY"],
                    'Authorization': f'Bearer {app_nzrplus_com.SITE_DICT["AUTH_TOKEN"]}'
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
                app_nzrplus_com.refresh_account_tokens(source_element.url)
                continue
            break

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                app_nzrplus_com.__name__
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

        manifests = []
        for f in ["hls", "dash"]:
            try:
                m = response[f]
                assert len(m) > 0
                for mt in m:
                    manifests.append((mt, f))
            except:
                pass

        non_drm_manifests = []
        drm_manifests = []
        for m, t in manifests:
            m_drm = m.get("drm", None)
            if m_drm is None or type(m_drm) is not dict:
                non_drm_manifests.append((m, t))
                continue
            if m_drm.get("jwtToken", None) is None:
                non_drm_manifests.append((m, t))
                continue

            systems = m_drm.get("keySystems", [])
            if systems is None or type(systems) is not list:
                continue
            systems = [s.lower() for s in systems]
            if "widevine" in systems:
                drm_manifests.append((m, t))

        additional = {}
        pssh_value = None
        is_drm = False
        if len(non_drm_manifests) > 0:
            manifest, manifest_type = non_drm_manifests[0]
        else:
            if len(drm_manifests) == 0:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))
            manifest, manifest_type = drm_manifests[0]
            additional["license_url"] = manifest["drm"]["url"]
            additional["drm_token"] = manifest["drm"]["jwtToken"]
            is_drm = True

        manifest = manifest["url"]
        manifest_content = requests.get(manifest).content.decode()
        if is_drm:
            try:
                pssh_value = get_pssh_from_default_kid(manifest_content)
            except:
                pass

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {app_nzrplus_com.__name__} service"
                ))

        additional["USE_BASE_URL"] = manifest_type in ["dash"]
        additional["MANIFEST_URL"] = clean_url(manifest)
        manifest = app_nzrplus_com.generate_master_file(
            join(source_element.collection, source_element.element),
            manifest, manifest_type, manifest_content
        )
        return manifest, pssh_value, additional

    @staticmethod
    def get_playlist(collection_url):
        playlist_id = re.search(r"/playlist/([^/?]*)", collection_url).group(1)
        response = {}
        last_seen = None
        collection_title = None

        collection = []
        vod_index = 0
        while True:
            playlist_params = {'rpp': app_nzrplus_com.PAGE_SIZE}
            if last_seen is not None:
                playlist_params["lastSeen"] = last_seen

            for i in range(0, 2):
                response = requests.get(
                    app_nzrplus_com.PLAYLIST_URL.format(playlist_id=playlist_id),
                    params=playlist_params,
                    headers={
                        'realm': app_nzrplus_com.SITE_DICT["REALM_ID"],
                        'x-api-key': app_nzrplus_com.SITE_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {app_nzrplus_com.SITE_DICT["AUTH_TOKEN"]}'
                    }
                )
                response = response.content.decode()
                response = json.loads(response)

                if response.get("code", None) in ["UNAUTHORIZED"]:
                    if i == 1:
                        break
                    app_nzrplus_com.refresh_account_tokens(collection_url)
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
                        app_nzrplus_com.__name__
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
                vod_url = app_nzrplus_com.VIDEO_URL.format(vod_id=vod["id"])
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
    def get_section(collection_url):
        section_id = collection_url.split("/")[-1]
        buckets_response = {}
        buckets_last_seen = None
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                app_nzrplus_com.__name__
            ),
            get_valid_filename(f"Section {section_id}")
        )

        collection = []
        bucket_index = 0
        while True:
            buckets_params = {
                'bpp': app_nzrplus_com.BUCKET_SIZE,
                'rpp': app_nzrplus_com.PAGE_SIZE,
                'displaySectionLinkBuckets': 'SHOW',
                'displayEpgBuckets': 'HIDE',
                'displayEmptyBucketShortcuts': 'SHOW',
                'displayContentAvailableOnSignIn': 'SHOW',
                'displayGeoblocked': 'SHOW',
                'bspp': app_nzrplus_com.BUCKET_SIZE
            }
            if buckets_last_seen is not None:
                buckets_params["lastSeen"] = buckets_last_seen

            for i in range(0, 2):
                buckets_response = requests.get(
                    app_nzrplus_com.BUCKETS_URL.format(section_id=section_id),
                    params=buckets_params,
                    headers={
                        'realm': app_nzrplus_com.SITE_DICT["REALM_ID"],
                        'x-api-key': app_nzrplus_com.SITE_DICT["REALM_API_KEY"],
                        'Authorization': f'Bearer {app_nzrplus_com.SITE_DICT["AUTH_TOKEN"]}'
                    }
                )
                buckets_response = buckets_response.content.decode()
                buckets_response = json.loads(buckets_response)

                if buckets_response.get("code", None) in ["UNAUTHORIZED"]:
                    if i == 1:
                        break
                    app_nzrplus_com.refresh_account_tokens(collection_url)
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
                        'rpp': app_nzrplus_com.PAGE_SIZE,
                        'displayContentAvailableOnSignIn': 'SHOW',
                        'displayGeoblocked': 'SHOW'
                    }
                    if vods_last_seen is not None:
                        vods_params["lastSeen"] = vods_last_seen

                    for i in range(0, 2):
                        vods_response = requests.get(
                            app_nzrplus_com.BUCKET_VODS_URL.format(section_id=section_id, bucket_id=bucket_id),
                            params=vods_params,
                            headers={
                                'realm': app_nzrplus_com.SITE_DICT["REALM_ID"],
                                'x-api-key': app_nzrplus_com.SITE_DICT["REALM_API_KEY"],
                                'Authorization': f'Bearer {app_nzrplus_com.SITE_DICT["AUTH_TOKEN"]}'
                            }
                        )
                        vods_response = vods_response.content.decode()
                        vods_response = json.loads(vods_response)

                        if vods_response.get("code", None) in ["UNAUTHORIZED"]:
                            if i == 1:
                                break
                            app_nzrplus_com.refresh_account_tokens(collection_url)
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
                        vod_url = app_nzrplus_com.VIDEO_URL.format(vod_id=vod["id"])
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
            return app_nzrplus_com.get_playlist(collection_url)
        if "/section/" in collection_url:
            return app_nzrplus_com.get_section(collection_url)
        return None
