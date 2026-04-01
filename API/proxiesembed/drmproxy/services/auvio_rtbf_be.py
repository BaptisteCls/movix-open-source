import builtins
import json
import os
import re
from os.path import join

import requests
from unidecode import unidecode

from utils.constants.macros import USER_ERROR, ERR_MSG, APP_ERROR, CACHE_DIR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, dict_to_file, file_to_dict, update_url_params


class auvio_rtbf_be(BaseService):
    DEMO_URLS = [
        "https://auvio.rtbf.be/chaine/musiq3-7",
        "https://auvio.rtbf.be/emission/deter-27162",
        "https://auvio.rtbf.be/emission/la-theorie-du-y-11043/bonus",
        "https://auvio.rtbf.be/widget/22508?context%5BprogramId%5D=8340",
        "https://auvio.rtbf.be/widget/19164",
        "https://auvio.rtbf.be/emission/le-cactus-4043",
        "https://auvio.rtbf.be/emission/l-art-du-crime-27164",
        "https://auvio.rtbf.be/media/les-grandes-vacances-de-cowboy-et-indien-les-grandes-vacances-3017947",
        "https://auvio.rtbf.be/emission/little-girl-blue-27421",
        "https://auvio.rtbf.be/media/l-heure-h-l-heure-h-3198029",
        "https://auvio.rtbf.be/live/tipikvision-515396",
    ]

    ENTITLEMENT_URL = 'https://exposure.api.redbee.live/v2/customer/RTBF/businessunit/Auvio/entitlement/{content_id}/play'
    EMBED_URL = "https://bff-service.rtbf.be/auvio/v1.23/embed/{content_type}/{content_id}"
    BOOTSTRAP_URL = 'https://login.auvio.rtbf.be/accounts.webSdkBootstrap'
    LOGIN_URL = 'https://login.auvio.rtbf.be/accounts.login'
    JWT_URL = 'https://login.auvio.rtbf.be/accounts.getJWT'
    GIGYA_URL = 'https://exposure.api.redbee.live/v2/customer/RTBF/businessunit/Auvio/auth/gigyaLogin'
    BASE_URL = 'https://auvio.rtbf.be'

    EMAIL = "YOUR_EMAIL"
    PASSWORD = "YOUR_PASSWORD"
    BEARER_TOKEN = None
    CACHE_FILE = None
    PAGE_SIZE = 50
    FORMAT_PRIORITY = {"": 0, "mss": 1, "aac": 2, "mp3": 3, "smoothstreaming": 4, "hls": 5, "dash": 6}

    @staticmethod
    def test_service():
        main_service.run_service(auvio_rtbf_be)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/live/" in content or "/chaine/" in content

    @staticmethod
    def credentials_needed():
        return {
            "EMAIL": auvio_rtbf_be.EMAIL,
            "PASSWORD": auvio_rtbf_be.PASSWORD
        }

    @staticmethod
    def get_api_key():
        app_js = re.findall(
            r'src="([^\"]*/[^\"/]app[^\"/]*\.js)"',
            requests.get(auvio_rtbf_be.BASE_URL).content.decode()
        )[0]
        if not app_js.startswith("/"):
            app_js = "/" + app_js
        app_js = requests.get(auvio_rtbf_be.BASE_URL + app_js).content.decode()

        api_key = re.findall(r'apiKey:"([^\-\"]*)"', app_js)[0]
        return api_key

    @staticmethod
    def get_bearer_token():
        try:
            return file_to_dict(auvio_rtbf_be.CACHE_FILE)["bearer_token"]
        except:
            pass

        class_name = auvio_rtbf_be.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            assert type(credentials["EMAIL"]) is str
            assert type(credentials["PASSWORD"]) is str
        except:
            return None

        api_key = auvio_rtbf_be.get_api_key()
        response = requests.get(
            auvio_rtbf_be.BOOTSTRAP_URL,
            params={'apiKey': api_key, 'sdk': 'js_latest', 'format': 'json'}
        )

        gmid = None
        response = response.headers["set-cookie"]
        for h in response.split(";"):
            if h.startswith("gmid="):
                gmid = h[5:]
                break
        assert gmid is not None

        response = requests.post(
            auvio_rtbf_be.LOGIN_URL,
            cookies={'gmid': gmid},
            data={
                "loginID": credentials["EMAIL"],
                "password": credentials["PASSWORD"],
                "sessionExpiration": "-2", "targetEnv": "jssdk", "APIKey": api_key,
                "sdk": "js_latest", "authMode": "cookie", "format": "json"
            }
        ).content.decode()
        response = json.loads(response)

        status_code = response.get("statusCode", None)
        status_reason = response.get("statusReason", "").lower()
        message = response.get("errorMessage", "").lower()
        if status_code == 403 or "forbidden" in status_reason:
            if "locked" in message:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=f'from the {auvio_rtbf_be.__name__} service',
                    reason="Account is temporarily locked because of too many failed login attempts",
                    solution="Wait 15 minutes or use another burner account"
                ))
            if "invalid" in message:
                return None

        response = requests.post(
            auvio_rtbf_be.JWT_URL,
            cookies={'gmid': gmid},
            data={
                'fields': 'email, firstName, lastName',
                'APIKey': api_key, 'sdk': 'js_latest',
                'login_token': response["sessionInfo"]["login_token"],
                'authMode': 'cookie', 'format': 'json'
            }
        ).content.decode()

        response = json.loads(response)
        response = requests.post(
            auvio_rtbf_be.GIGYA_URL,
            json={
                'device': {'deviceId': 'deviceId', 'name': 'Browser', 'type': 'WEB'},
                'jwt': response["id_token"]
            }
        ).content.decode()

        bearer_token = json.loads(response)["sessionToken"]
        dict_to_file(auvio_rtbf_be.CACHE_FILE, {"bearer_token": bearer_token})
        return bearer_token

    @staticmethod
    def initialize_service():
        if auvio_rtbf_be.CACHE_FILE is None:
            auvio_rtbf_be.CACHE_FILE = join(CACHE_DIR, f'{auvio_rtbf_be.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(auvio_rtbf_be.CACHE_FILE, {})

        if auvio_rtbf_be.BEARER_TOKEN is None:
            auvio_rtbf_be.BEARER_TOKEN = auvio_rtbf_be.get_bearer_token()
            if auvio_rtbf_be.BEARER_TOKEN is None:
                return None
        return auvio_rtbf_be

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_content_title(content):
        try:
            data = content["data"]
            title = f'{data.get("title", "")}_{data.get("subtitle", "")}'
            assert len(title) > 1
            return title
        except:
            pass

        try:
            return content["data"]["program"]["title"]
        except:
            pass
        try:
            return content["meta"]["seo"]["title"]
        except:
            pass
        return None

    @staticmethod
    def get_collection_info(content):
        state = content["props"]["pageProps"]["initialState"]
        asset_url = None

        for query in state["api"]["queries"]:
            if not query.startswith("page"):
                continue
            q = state["api"]["queries"][query]

            try:
                asset_url = q["data"]["data"]["content"]["media"]["path"]
                if not asset_url.startswith("/"):
                    asset_url = '/' + asset_url
                asset_url = auvio_rtbf_be.BASE_URL + asset_url
            except:
                pass
            try:
                return q["data"]["data"]["content"]["title"], asset_url
            except:
                pass
            try:
                return q["data"]["meta"]["seo"]["title"], asset_url
            except:
                pass
        return None, asset_url

    @staticmethod
    def generate_video_m3u8(output_path, manifest_info, content_info):
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
        m3u8_content += f'#EXTINF:{content_info.get("data", {}).get("duration", 1)},\n'
        m3u8_content += f'{manifest_info[0]}\n'

        m3u8_content += "#EXT-X-ENDLIST\n"
        with open(output_path, "w") as f:
            f.write(m3u8_content)

    @staticmethod
    def generate_master_m3u8(source_element, manifest_info, content_info):
        output_path = str(join(source_element.collection, source_element.element))
        if not os.path.exists(output_path):
            os.makedirs(output_path)
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"

        title = f'audio.m3u8'
        auvio_rtbf_be.generate_video_m3u8(join(output_path, title), manifest_info, content_info)
        m3u8_content += f"#EXT-X-STREAM-INF:BANDWIDTH=1000,TYPE=AUDIO,MIME-TYPE=\"audio/{manifest_info[1]}\"\n"
        m3u8_content += f'{title}\n'

        output_path = join(output_path, "master.m3u8")
        with open(output_path, "w") as f:
            f.write(m3u8_content)
        return output_path

    @staticmethod
    def get_video_data(source_element):
        if '/custom_dict://' in source_element.url:
            content_id = source_element.url.split("/custom_dict://")[1].split("_https://")[0]
            content_id = json.loads(content_id)["stream_asset_id"]
            content_info = {}

        else:
            content_id = source_element.url.split("-")[-1]
            response = json.loads(requests.get(
                auvio_rtbf_be.EMBED_URL.format(
                    content_type="live" if "/live/" in source_element.url else "media",
                    content_id=content_id
                ),
                params={"userAgent": "Chrome-web"}
            ).content.decode())

            content_info = response
            if response.get("status", None) == 404 or "not_found" in response.get("code", "").lower():
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available",
                    solution="Don't attempt to download it"
                ))

            content_id = response["data"]["assetId"]
            if source_element.element is None:
                title = auvio_rtbf_be.get_content_title(response)
                if title is None:
                    title = source_element.url.split("/")[-1]
                source_element.element = get_valid_filename(title)
            if source_element.collection is None:
                source_element.collection = join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    auvio_rtbf_be.__name__
                )

        response = json.loads(requests.get(
            auvio_rtbf_be.ENTITLEMENT_URL.format(content_id=content_id),
            params={
                'supportedFormats': 'dash,hls,mss,mp3,aac',
                'supportedDrms': 'widevine'
            },
            headers={'Authorization': f'Bearer {auvio_rtbf_be.BEARER_TOKEN}'}
        ).content.decode())

        message = response.get("message", "").lower()
        if "not_published" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))
        if "not_entitled" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Belgian IP to access content or the content isn't available yet",
                solution="Use a VPN or don't attempt to download it"
            ))
        if "invalid" in message and "token" in message:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't access the video content because the cached token expired",
                solution=f'Delete the {auvio_rtbf_be.CACHE_FILE} cache manually or add the parameter --fresh to your command'
            ))

        if len(message) > 0:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Unknown error encountered: {str(response)}",
                solution=f"Debug the {auvio_rtbf_be.__name__} service"
            ))

        license_url = manifest = None
        formats = sorted(
            response["formats"], reverse=True,
            key=lambda f: auvio_rtbf_be.FORMAT_PRIORITY.get(f.get("format", "").lower(), 0)
        )

        for current_format in formats:
            if len(current_format.get("format", "")) == 0:
                continue

            manifest = (current_format["mediaLocator"], current_format["format"].lower())
            if len(current_format.get("drm", {}).keys()) == 0:
                break

            license_url = None
            for k, v in current_format["drm"].items():
                if "widevine" not in k.lower():
                    continue

                license_url = v["licenseServerUrl"]
                break

            if license_url is not None:
                break
            manifest = None

        if manifest is None:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason=f"DRM not supported. Widevine wasn't found",
                solution="Do not attempt to download it"
            ))

        if manifest[1] in ["mss"] or (manifest[1] in ["hls"] and license_url is not None):
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {str(manifest)}",
                solution=f"Extend the {auvio_rtbf_be.__name__} service"
            ))

        if manifest[1] in ["aac", "mp3"]:
            manifest = auvio_rtbf_be.generate_master_m3u8(source_element, manifest, content_info)
            pssh_value = None
        else:
            manifest = manifest[0]

            try:
                pssh_value = str(min(re.findall(
                    r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                    requests.get(manifest).content.decode()
                ), key=len))
            except:
                return manifest, None, {}
        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_page_json(url):
        response = json.loads(re.findall(
            r'type="application/json"[^<>]*>({.*?})</script>',
            requests.get(url).content.decode()
        )[0])

        r = response["props"]["pageProps"]
        if r["initialState"].startswith("{"):
            r["initialState"] = json.loads(r["initialState"])

        response["props"]["pageProps"] = r
        return response

    @staticmethod
    def get_label_index(label):
        if label is None or len(label) == 0:
            return None
        label = unidecode(label.lower())
        label = re.sub(r'\s+', ' ', label)
        label = label.replace(' ', "_")
        for s in ["saison_", "annee_"]:
            try:
                return int(re.findall(fr'{s}(\d+)', label)[0])
            except:
                pass
        return None

    @staticmethod
    def handle_list(collection_name, season_index, content_url, collection_url):
        if season_index is not None:
            collection_name = join(collection_name, f'Season_{season_index}')

        content_url = update_url_params(content_url, {"_limit": auvio_rtbf_be.PAGE_SIZE})
        episode_index = 0
        collection = []

        while True:
            response = json.loads(requests.get(content_url).content.decode())
            if "/mosaic/" in content_url:
                contents = response.get("data", [])
            else:
                contents = response.get("data", {}).get("content", [])

            for content in contents:
                episode_index += 1
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                if content.get('resourceType', "").lower() in ["radio_live"]:
                    episode_title = (
                        f'{content["channel"].get("label", "")}'
                        f'_'
                        f'{content.get("title", "")}'
                        f'_'
                        f'{content.get("subtitle", "")}'
                    )

                    episode_url = (
                        f'{auvio_rtbf_be.BASE_URL}/custom_dict://'
                        f'{json.dumps({"stream_asset_id": content["channel"]["streamAssetId"]})}'
                        f'_{collection_url}'
                    )
                else:
                    episode_url = content["path"]
                    if not episode_url.startswith("/"):
                        episode_url = "/" + episode_url
                    episode_url = auvio_rtbf_be.BASE_URL + episode_url
                    episode_title = f'{content.get("title", "")}_{content.get("subtitle", "")}'

                name_prefix = str(episode_index)
                if season_index is not None:
                    name_prefix = f'Episode_{name_prefix}'

                collection.append(BaseElement(
                    url=episode_url,
                    collection=collection_name,
                    element=f'{name_prefix}'
                            f'_'
                            f'{get_valid_filename(episode_title)}'
                ))

            if response["links"].get("next", None) is None:
                break
            content_url = response["links"]["next"]

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("/")
        if "/media/" in collection_url or "/live/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/emission/" in collection_url or "/widget/" in collection_url or "/chaine/" in collection_url:
            collection = []
            page_json = auvio_rtbf_be.get_page_json(collection_url)

            collection_name, asset_url = auvio_rtbf_be.get_collection_info(page_json)
            if collection_name is None:
                collection_name = collection_url.split("/")[-1]
            collection_name = join(
                join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    auvio_rtbf_be.__name__
                ),
                get_valid_filename(collection_name)
            )

            queries = page_json["props"]["pageProps"]["initialState"]["api"]["queries"]
            collection_content = None
            for query in queries:
                if "/widget/" in collection_url or collection_url.endswith("/bonus"):
                    if not query.startswith("mosaic"):
                        continue
                else:
                    if not query.startswith("widget"):
                        continue
                collection_content = queries[query]
                break

            collection_content = collection_content["data"]
            if "/widget/" in collection_url or collection_url.endswith("/bonus") or "/chaine/" in collection_url:
                collection = auvio_rtbf_be.handle_list(
                    collection_name, None,
                    collection_content["links"]["first"], collection_url
                )
                return collection

            collection_content = collection_content["data"]
            if collection_content["type"].lower() not in ["tab_list"]:
                if asset_url is None:
                    return None
                return [BaseElement(url=asset_url)]

            collection_content = collection_content["content"]
            collection_content = [
                (auvio_rtbf_be.get_label_index(c["title"]), c)
                for c in collection_content
            ]
            other_content = [(i, c) for i, c in collection_content if i is None]
            collection_content = sorted([
                (i, c) for i, c in collection_content
                if i is not None
            ], key=lambda m: m[0])

            if len(collection_content) == 0:
                for _, c in other_content:
                    if c["title"].lower().startswith("tous les "):
                        collection = auvio_rtbf_be.handle_list(
                            collection_name, None,
                            c["contentPath"], collection_url
                        )
                        return collection
                return None

            for season_index, c in collection_content:
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                collection += auvio_rtbf_be.handle_list(
                    collection_name, season_index,
                    c["contentPath"], collection_url
                )

            return collection
        return None
