import base64
import builtins
import json
import re
import threading
from os.path import join
from urllib.parse import parse_qs, urlparse

import requests
import xmltodict
from curl_cffi import requests as requests_cf

from utils.constants.macros import WIDEVINE_SCHEME_ID, ERR_MSG, USER_ERROR, PLAYREADY_SCHEME_ID, CACHE_DIR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, update_url_params, dict_to_file, file_to_dict


class canalplus_com(BaseService):
    DEMO_URLS = [
        "https://www.canalplus.com/divertissement/hot-ones-jerome-niel-vrille-completement/h/21582462_50001",
        "https://www.canalplus.com/divertissement/pierre-niney-veritable-justicier-masque-dans-le-comte-de-monte-christo-canal/h/25788986_50001",
        "https://www.canalplus.com/divertissement/hot-ones/h/18582832_50001",
        "https://www.canalplus.com/series/bref/h/4603293_50001",
        "https://www.canalplus.com/series/d-argent-et-de-sang/h/22860111_50001/bonus/",
        "https://www.canalplus.com/live/?channel=450",
        "https://www.canalplus.com/pl/seria/the-office-pl/h/11800604_70026/explorer/bonus/",
        "https://www.canalplus.com/pl/seriale/za-kulisami-serialu-powrot-belfra/h/14153942_70033",
        "https://www.canalplus.com/pl/seriale/powrot-sezon-1/h/12397026_70033",
    ]

    CONFIG_URL = 'https://player.canalplus.com/one/configs/v2/11'
    MAP_URL = CONFIG_URL + '/mapping/mapping.json'
    PROD_URL = CONFIG_URL + '/{zone_value}/prod.json'
    ENDPOINT_URLS = None
    BASE_URL = "https://www.canalplus.com"
    VIDEO_URL = BASE_URL + "{language}/h/{video_id}"

    DIST_MODES = 'catchup,live,svod,tvod,posttvod'
    DEVICE_ID = 3
    DRM_ID = 31
    ECK = "pc"
    DEVICE = "pc"
    DEFAULT_GROUP_TYPE = "1"
    DEFAULT_LOCATION = "fr"
    LIVE_MODE = 'MKPL'
    PROFILE_ID = "undefined"
    QUALITY_PRIORITY = {"hd": 1, "sd": 0}
    DRM_PRIORITY = {
        "unprotected": 3,
        "drm_mkpc_widevine_dash": 2,
        "drm_mkpc_widevine_dash_download": 1,
        "drm_widevine": 0
    }
    IMPERSONATOR = "chrome110"
    LOCK = None
    CACHE_FILE = None
    USER_AGENT = None

    @staticmethod
    def test_service():
        main_service.run_service(canalplus_com)

    @staticmethod
    def is_content_livestream(content, additional):
        return additional["IS_LIVE"]

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_endpoints():
        try:
            endpoints_dict = file_to_dict(canalplus_com.CACHE_FILE)
            assert len(endpoints_dict.keys()) > 0
            return endpoints_dict
        except:
            endpoints_dict = {}

        response = requests.get(canalplus_com.MAP_URL)
        response = json.loads(response.content.decode())
        for zone, zone_value in response["mycanal"].items():
            if zone.lower() in ["default"]:
                continue

            response = requests.get(canalplus_com.PROD_URL.format(zone_value=zone_value))
            response = json.loads(response.content.decode())

            license_base_url = response["hapi"]["licenceBaseUrl"]
            if license_base_url.startswith("//"):
                license_base_url = f'https:{license_base_url}'

            view_url = response["hapi"]["view"]
            if view_url.startswith("//"):
                view_url = f'https:{view_url}'

            playset_url = response["hapi"]["playset"]
            if playset_url.startswith("//"):
                playset_url = f'https:{playset_url}'

            spyro_url = response["hapi"]["spyro"]
            if spyro_url.startswith("//"):
                spyro_url = f'https:{spyro_url}'

            service = response["hapi"]["service"]
            spyro_version = response["hapi"]["spyroVersion"]

            try:
                group_types = response["live"]["liveTvGroupType"][zone]
            except:
                group_types = canalplus_com.DEFAULT_GROUP_TYPE
            init_live_url = response["live"]["init"]
            license_live_url = response["live"]["licence"]

            pass_url = response["pass"]["url"]
            pass_media = response["pass"]["media"]
            pass_portail_id = response["pass"]["portailId"]
            pass_vect = response["pass"]["vect"]

            endpoints_dict[zone] = {
                "LICENSE_BASE_URL": license_base_url,
                "VIEW_URL": view_url,
                "PLAYSET_URL": playset_url,
                "SPYRO_URL": spyro_url,
                "SERVICE": service,
                "SPYRO_VERSION": spyro_version,
                "GROUP_TYPES": group_types,
                "INIT_LIVE_URL": init_live_url,
                "LICENSE_LIVE_URL": license_live_url,
                "PASS_URL": pass_url,
                "PASS_MEDIA": pass_media,
                "PASS_PORTAIL_ID": pass_portail_id,
                "PASS_VECT": pass_vect
            }
            for k, u in endpoints_dict[zone].items():
                u = u.replace("{offerZone}", zone)
                u = u.replace("{drmId}", str(canalplus_com.DRM_ID))
                u = u.replace("{deviceId}", str(canalplus_com.DEVICE_ID))
                endpoints_dict[zone][k] = u

        dict_to_file(canalplus_com.CACHE_FILE, endpoints_dict)
        return endpoints_dict

    @staticmethod
    def initialize_service():
        if canalplus_com.USER_AGENT is None:
            canalplus_com.USER_AGENT = builtins.CONFIG["USER_AGENT"]

        if canalplus_com.CACHE_FILE is None:
            canalplus_com.CACHE_FILE = join(CACHE_DIR, f'{canalplus_com.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(canalplus_com.CACHE_FILE, {})

        if canalplus_com.ENDPOINT_URLS is None:
            canalplus_com.ENDPOINT_URLS = canalplus_com.get_endpoints()
            assert len(canalplus_com.ENDPOINT_URLS.keys()) > 0

        if canalplus_com.LOCK is None:
            canalplus_com.LOCK = threading.Lock()
        return canalplus_com

    @staticmethod
    def get_best_decryptable_video(manifest, keys):
        mpd_content_raw = requests.get(manifest).content.decode()
        mpd_content = xmltodict.parse(mpd_content_raw)
        if mpd_content.get("MPD", None) is None:
            if WIDEVINE_SCHEME_ID not in mpd_content_raw and PLAYREADY_SCHEME_ID in mpd_content_raw:
                return None
            raise

        mpd_content = mpd_content["MPD"]["Period"]
        if type(mpd_content["AdaptationSet"]) is not list:
            mpd_content["AdaptationSet"] = [mpd_content["AdaptationSet"]]

        best_content = None
        best_height = None
        best_width = None
        for content in mpd_content["AdaptationSet"]:
            if content["@contentType"] != "video":
                continue

            default_kid = None
            for protection in content["ContentProtection"]:
                if protection.get("@cenc:default_KID", None) is None:
                    continue
                default_kid = protection["@cenc:default_KID"].lower().replace("-", "")

            if default_kid is None:
                continue
            is_decryptable = False
            for k in keys:
                k1 = k.split(":")[1]
                if k1 == "0" * len(k1):
                    continue

                if default_kid == k.split(":")[0]:
                    is_decryptable = True
                    break
            if not is_decryptable:
                continue

            for representation in content["Representation"]:
                update_content = False
                height = int(representation.get("@height", content.get("@height", None)))
                if height is None:
                    continue
                height = int(height)

                width = int(representation.get("@width", content.get("@width", None)))
                if width is None:
                    continue
                width = int(width)

                if best_content is None:
                    update_content = True
                else:
                    if height > best_height:
                        update_content = True

                if update_content:
                    best_content = content
                    best_height = height
                    best_width = width

        assert best_content is not None
        return best_width, best_height

    @staticmethod
    def get_keys(challenge, additional):
        if not additional["IS_LIVE"]:
            pass_token = additional["pass_token"]
            licence = requests.post(
                additional["license_url"],
                headers={
                    'Content-Type': 'text/plain',
                    'XX-OZ': additional["offer_zone"],
                    'XX-SERVICE': additional["service"],
                    'XX-OPERATOR': canalplus_com.ECK,
                    'Authorization': f'PASS Token="{pass_token}"',
                    'XX-Profile-Id': canalplus_com.PROFILE_ID,
                    'XX-DEVICE': f'{canalplus_com.DEVICE} device-device'
                },
                data=base64.b64encode(challenge).decode()
            )
            licence.raise_for_status()
            licence = xmltodict.parse(licence.content.decode())
            return licence["licenseresponse"]["clientresponse"]["license"]["#text"]

        else:
            licence = requests.post(
                additional["license_url"],
                json={
                    'ServiceRequest': {
                        'InData': {
                            'EpgId': additional["epg_id"],
                            'LiveToken': additional["live_token"],
                            'ChallengeInfo': base64.b64encode(challenge).decode(),
                            'Mode': canalplus_com.LIVE_MODE
                        }
                    }
                }
            )
            licence.raise_for_status()
            return json.loads(licence.content.decode())["ServiceResponse"]["OutData"]["LicenseInfo"]

    @staticmethod
    def sort_drm_quality(obj):
        quality_score = canalplus_com.QUALITY_PRIORITY[obj["quality"].lower()]
        drm_score = canalplus_com.DRM_PRIORITY[obj["drmType"].lower()]
        return -quality_score, -drm_score

    @staticmethod
    def get_pssh_from_manifest(manifest_content):
        psshs = re.findall(
            fr'<ContentProtection[^<>"]*"[^<>"]*{WIDEVINE_SCHEME_ID}[^<>"]*"[^<>]*>(.*?)</ContentProtection>',
            manifest_content,
            re.DOTALL | re.IGNORECASE
        )
        pssh = []

        for p in psshs:
            try:
                pssh.append(str(min(re.findall(
                    r'<[^<>]*cenc:pssh[^<>]*>(.*?)</[^<>]*cenc:pssh[^<>]*>', p
                ), key=len)))
            except:
                pass

        if len(psshs) > 0:
            return str(min(pssh, key=len))

        if PLAYREADY_SCHEME_ID not in manifest_content:
            return None

        psshs = re.findall(
            fr'<ProtectionHeader[^<>"]*"[^<>"]*{PLAYREADY_SCHEME_ID}[^<>"]*"[^<>]*>(.*?)</ProtectionHeader>',
            manifest_content,
            re.DOTALL | re.IGNORECASE
        )
        return str(min(psshs, key=len))

    @staticmethod
    def get_video_data(source_element):
        response = requests.get(source_element.url).content.decode()
        offer_zone = re.search(
            r'"offerZone":"(.+?)"',
            response
        ).group(1)

        page_json = re.findall(
            r'__data\s*=\s*({.+?})\s*;',
            response
        )
        if len(page_json) == 0:
            raise
        page_json = page_json[0].replace("undefined", "null")
        page_json = json.loads(page_json)

        offer_location = page_json.get("application", {}).get("zoneInfo", {}).get(
            "offerLocation", canalplus_com.DEFAULT_LOCATION
        )
        pass_token = canalplus_com.ENDPOINT_URLS[offer_zone].get("PASS_TOKEN", None)

        if pass_token is None:
            with canalplus_com.LOCK:
                pass_token = canalplus_com.ENDPOINT_URLS[offer_zone].get("PASS_TOKEN", None)

                if pass_token is None:
                    response = requests_cf.post(
                        canalplus_com.ENDPOINT_URLS[offer_zone]["PASS_URL"].format(
                            offerLocation=offer_location
                        ),
                        headers={'User-Agent': canalplus_com.USER_AGENT},
                        data='&'.join(f'{k}={v}' for k, v in {
                            'media': canalplus_com.ENDPOINT_URLS[offer_zone]["PASS_MEDIA"],
                            'portailId': canalplus_com.ENDPOINT_URLS[offer_zone]["PASS_PORTAIL_ID"],
                            'vect': canalplus_com.ENDPOINT_URLS[offer_zone]["PASS_VECT"]
                        }.items()),
                        impersonate=canalplus_com.IMPERSONATOR
                    )
                    response = json.loads(response.content.decode())

                    pass_token = response["response"]["passToken"]
                    canalplus_com.ENDPOINT_URLS[offer_zone]["PASS_TOKEN"] = pass_token

        epg_id = None
        if "/h/" in source_element.url:
            content_id = re.search(r"/h/([^/?]*)", source_element.url).group(1)
        else:
            content_id = None
            params_dict = parse_qs(urlparse(source_element.url).query)
            epg_id = params_dict["channel"][0]

        if content_id is not None:
            response = requests.get(
                canalplus_com.ENDPOINT_URLS[offer_zone]["PLAYSET_URL"].format(id=content_id),
                headers={
                    'XX-DISTMODES': canalplus_com.DIST_MODES,
                    'XX-OZ': offer_zone,
                    'XX-SERVICE': canalplus_com.ENDPOINT_URLS[offer_zone]["SERVICE"],
                    'XX-OPERATOR': canalplus_com.ECK,
                    'Authorization': f'PASS Token="{pass_token}"',
                    'XX-Profile-Id': canalplus_com.PROFILE_ID,
                    'XX-DEVICE': f'{canalplus_com.DEVICE} device-device'
                }
            )
            status_code = response.status_code
            response = json.loads(response.content.decode())

            if status_code < 200 or status_code >= 300:
                page_json = re.findall(
                    r'REACT_QUERY_STATE\s*=\s*({.+?})\s*;',
                    requests.get(source_element.url).content.decode()
                )
                if len(page_json) > 0:
                    page_json = page_json[0].replace("undefined", "null")
                    page_json = json.loads(page_json)

                    for q in page_json.get("queries", []):
                        d = q.get("state", {}).get("data", {})
                        p = d.get("currentPage", {}).get("path", None)

                        if p is None:
                            continue
                        if not source_element.url.endswith(p.rstrip("/")):
                            continue

                        for a in d.get("actionLayout", {}).get("primaryActions", []):
                            if a.get("type", "").lower() not in ["play"]:
                                continue
                            epg_id = a.get("onClick", {}).get("epgID", None)

                            if epg_id is None:
                                for o in a.get("onClick", {}).get("options", []):
                                    epg_id = o.get("onClick", {}).get("epgID", None)

                                    if epg_id is not None:
                                        break
                            if epg_id is not None:
                                break
                        if epg_id is not None:
                            break
        else:
            status_code = 500
            response = {}

        if epg_id is None:
            if status_code == 404 or response.get("code", "").lower() == "conso-404-0":
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available",
                    solution="Do not attempt to download it"
                ))

            if status_code in [500, 403] or response.get("code", "").lower() in ["tec-500-1", "conso-403-3"]:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason="Can't download paid content",
                    solution='Do not attempt to download it'
                ))

        live_token = None
        if epg_id is not None:
            has_drm = True

            response = requests.post(
                canalplus_com.ENDPOINT_URLS[offer_zone]["INIT_LIVE_URL"].replace("{offerLocation}", offer_location),
                json={
                    'ServiceRequest': {'InData': {
                        'PassData': {'Token': pass_token},
                        'PDSData': {'GroupTypes': canalplus_com.ENDPOINT_URLS[offer_zone]["GROUP_TYPES"]}
                    }}
                }
            )
            response = json.loads(response.content.decode())
            response = response["ServiceResponse"]["OutData"]
            live_token = response["LiveToken"]

            manifest = None
            for group in response.get("PDS", {}).get("ChannelsGroups", {}).get("ChannelsGroup", []):
                for channel in group.get("Channels", []):
                    if str(epg_id) != str(channel.get("EpgId", None)):
                        continue
                    manifest = channel.get("WSXUrl", None)

                    if channel.get("NoEncrypt", None) not in ["", None]:
                        has_drm = str(channel["NoEncrypt"]).lower() != "true"
                    if manifest is not None:
                        break
                if manifest is not None:
                    break

            manifest = requests.get(manifest).content.decode()
            manifest = json.loads(manifest)
            manifest = manifest["primary"]["src"]
            license_url = canalplus_com.ENDPOINT_URLS[offer_zone]["LICENSE_LIVE_URL"].format(
                offerZone=offer_zone,
                drmId=canalplus_com.DRM_ID
            )

        else:
            response = response.get("available", [])
            if len(response) == 0:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason="Can't download paid content",
                    solution='Do not attempt to download it'
                ))

            response = list(filter(
                lambda r: "widevine" in r.get("drmType", "").lower() or
                          "unprotected" in r.get("drmType", "").lower(),
                response
            ))
            response = sorted(response, key=canalplus_com.sort_drm_quality)
            if len(response) == 0:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))

            response = response[0]
            has_drm = "widevine" in response["drmType"].lower()
            response = response["hash"]

            response = requests.put(
                canalplus_com.ENDPOINT_URLS[offer_zone]["VIEW_URL"],
                headers={
                    'XX-DISTMODES': canalplus_com.DIST_MODES,
                    'XX-OZ': offer_zone,
                    'XX-SERVICE': canalplus_com.ENDPOINT_URLS[offer_zone]["SERVICE"],
                    'XX-OPERATOR': canalplus_com.ECK,
                    'Authorization': f'PASS Token="{pass_token}"',
                    'XX-Profile-Id': canalplus_com.PROFILE_ID,
                    'XX-DEVICE': f'{canalplus_com.DEVICE} device-device'
                },
                params={"include": "medias"},
                json={'hash': response}
            )

            response = json.loads(response.content.decode())
            licence_path = None
            if has_drm:
                licence_path = response["@licence"]
            manifest = None
            license_url = None

            for media in response.get("medias", []):
                try:
                    if has_drm:
                        if licence_path not in media["@licence"] and media["@licence"] not in licence_path:
                            continue

                    for file in media.get("files", []):
                        if "video" != file.get("type", "").lower():
                            continue

                        manifest = file.get("distribURL", None)
                        try:
                            redirect = requests.get(manifest, allow_redirects=False).headers
                            location = dict(redirect)["Location"]
                            assert len(location) > 0
                            manifest = location
                        except:
                            pass

                        if manifest is None:
                            try:
                                manifest = file["routemeup"]
                                manifest = requests.get(manifest)
                                manifest = json.loads(manifest.content.decode())
                                manifest = manifest["primary"]["src"]
                            except:
                                manifest = None

                        if manifest is not None:
                            if has_drm:
                                license_url = f'{canalplus_com.ENDPOINT_URLS[offer_zone]["LICENSE_BASE_URL"]}{media["@licence"]}'
                            break

                    if manifest is not None:
                        break
                except:
                    manifest = None

            if manifest is None:
                raise
            if manifest.endswith(".ism"):
                manifest += "/manifest"

            if has_drm and "drmConfig=" not in license_url:
                license_url = update_url_params(license_url, {
                    "drmConfig": "mkpl::true|persistent::false"
                })

        manifest_content = requests.get(manifest)
        if manifest_content.status_code < 200 or 300 <= manifest_content.status_code:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't download paid content or the VPN was detected",
                solution='Do not attempt to download it or use a better VPN'
            ))

        try:
            if not has_drm:
                raise
            pssh_value = canalplus_com.get_pssh_from_manifest(manifest_content.content.decode())
        except:
            pssh_value = None

        if has_drm and pssh_value is None:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason=f"DRM not supported. Widevine wasn't found",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            if content_id is not None:
                response = requests.post(
                    canalplus_com.ENDPOINT_URLS[offer_zone]["SPYRO_URL"],
                    headers={
                        'XX-OZ': offer_zone,
                        'XX-SERVICE': canalplus_com.ENDPOINT_URLS[offer_zone]["SERVICE"],
                        'XX-OPERATOR': canalplus_com.ECK,
                        'Authorization': f'PASS Token="{pass_token}"',
                        'XX-Profile-Id': canalplus_com.PROFILE_ID,
                        'XX-DEVICE': f'{canalplus_com.DEVICE} device-device',
                        'XX-SPYRO-VERSION': canalplus_com.ENDPOINT_URLS[offer_zone]["SPYRO_VERSION"]
                    },
                    json={
                        'operationName': 'content',
                        'variables': {'id': content_id},
                        'query': '''
                            query content($id: String!) {
                                catalog { unit(id: $id) {
                                    id titles {
                                        title originalTitle 
                                        subtitle
                                    }
                                }}
                            }
                        '''
                    }
                )
                response = json.loads(response.content.decode())

                response = response["data"]["catalog"]["unit"].get("titles", {})
                title = response.get("title", response.get("originalTitle", ""))
                if title is None:
                    title = ""

                if len(title) > 0 and response.get("subtitle", "") not in ["", None]:
                    title = title + "_" + response["subtitle"]

                if len(title) == 0:
                    title = content_id
            else:
                if epg_id is not None:
                    title = f"Live_{epg_id}"
                else:
                    title = source_element.url.split(canalplus_com.BASE_URL)[1]
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                canalplus_com.__name__
            )

        return manifest, pssh_value, {
            "license_url": license_url,
            "live_token": live_token,
            "epg_id": epg_id,
            "IS_LIVE": epg_id is not None,
            "USE_SHAKA": False,
            "pass_token": pass_token,
            "offer_zone": offer_zone,
            "service": canalplus_com.ENDPOINT_URLS[offer_zone]["SERVICE"],
        }

    @staticmethod
    def extra_sections_handler(collection_url, collection_page_content, extra_section, language):
        page_json = re.findall(
            r'REACT_QUERY_STATE\s*=\s*({.+?})\s*;',
            collection_page_content
        )
        if len(page_json) == 0:
            return None
        page_json = page_json[0].replace("undefined", "null")
        page_json = json.loads(page_json)

        content_id = re.search(r"/h/([^/?]*)", collection_url).group(1)
        collection_title = re.findall(r"/([^/]*)/h/", collection_url)
        if len(collection_title) == 0:
            collection_title = content_id
        else:
            collection_title = collection_title[0]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                canalplus_com.__name__
            ),
            get_valid_filename(collection_title + "_" + extra_section)
        )

        tabs = []
        for query in page_json.get("queries", []):
            query = query.get("state", {}).get("data", {})
            for k, v in query.items():
                if k not in ["pages", "tabs"]:
                    continue
                if type(v) is not list:
                    continue

                if k == "tabs":
                    for tab in v:
                        if tab.get("path", "") in [None, ""]:
                            continue

                        if collection_url.endswith(tab["path"].rstrip("/")):
                            tabs.append(tab["URLPage"])
                else:
                    pages = []
                    for page in v:
                        page_path = page.get("currentPage", {}).get("path", "")
                        if page_path in [None, ""]:
                            continue

                        if collection_url.endswith(page_path.rstrip("/")):
                            pages.append(page)
                    tabs.append({"strates": pages})

        rail_index = 0
        collection = []
        for tab in tabs:
            if type(tab) is not dict:
                response = requests.get(tab).content.decode()
                response = json.loads(response)
                is_tab = True
            else:
                response = tab
                is_tab = False

            for rail in response.get("strates", []):
                if type(rail) is not dict:
                    continue
                rail_index += 1

                check = check_range(True, rail_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                list_title = None
                if is_tab:
                    list_title = rail.get("title", rail.get("context", {}).get("context_list_title", None))
                rail_title = f"Rail_{rail_index}"
                if list_title is not None:
                    rail_title = f'{rail_title}_{list_title}'
                rail_title = get_valid_filename(rail_title)

                video_index = 0
                while True:
                    for content in rail.get("contents", []):
                        video_index += 1
                        if content.get("type", "").lower() not in ["vod", "detailpage"]:
                            continue

                        check = check_range(False, rail_index, video_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                        video_title = f"Video_{video_index}"
                        for f in ["title", "subtitle"]:
                            if content.get(f, None) not in ["", None]:
                                video_title = video_title + "_" + content[f]

                        collection.append(BaseElement(
                            url=canalplus_com.VIDEO_URL.format(
                                video_id=content["contentID"],
                                language=language
                            ),
                            collection=join(collection_title, rail_title),
                            element=get_valid_filename(video_title)
                        ))

                    paging = rail.get("paging", {})
                    if paging is None:
                        break
                    if paging.get("hasNextPage", False) is False:
                        break

                    rail = requests.get(paging["URLPage"])
                    rail = json.loads(rail.content.decode())

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        if "/live" in collection_url and "channel=" in collection_url:
            return [BaseElement(url=collection_url)]

        collection_url = collection_url.split("#")[0].split("?")[0].rstrip("/")
        if "/h/" not in collection_url:
            return None

        extra_section = re.findall(r"/h/[^/]*/(.+)", collection_url)
        if len(extra_section) == 0:
            extra_section = None
        else:
            extra_section = extra_section[0]
        if extra_section in ["saisons", "sezony"]:
            return None

        collection_page_content = requests.get(collection_url)
        if collection_page_content.status_code == 403:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="The VPN was detected",
                solution="Use a better VPN"
            ))

        collection_page_content = collection_page_content.content.decode()
        language = re.findall(fr'{canalplus_com.BASE_URL}/([^/?]*)/', collection_url)
        if len(language) == 0:
            language = ""
        else:
            language = language[0]
            if len(language) != 2:
                language = ""
            else:
                language = f"/{language}"

        if extra_section is not None:
            return canalplus_com.extra_sections_handler(
                collection_url, collection_page_content,
                extra_section, language
            )

        content_id = re.search(r"/h/([^/?]*)", collection_url).group(1)
        page_json = re.findall(
            r'REACT_QUERY_STATE\s*=\s*({.+?})\s*;',
            collection_page_content
        )
        if len(page_json) == 0:
            return None
        page_json = page_json[0].replace("undefined", "null")
        page_json = json.loads(page_json)

        episodes_url = None
        for query in page_json.get("queries", []):
            query = query.get("state", {}).get("data", {})
            for k, v in query.items():
                if k not in ["tabs"]:
                    continue
                if type(v) is not list:
                    continue

                for tab in v:
                    if tab.get("displayTemplate", "").lower() not in ["episodeslist"]:
                        continue
                    if tab.get("path", "") in [None, ""]:
                        continue

                    episodes_url = tab["URLPage"]
                    break
                if episodes_url is not None:
                    break
            if episodes_url is not None:
                break

        if episodes_url is None:
            return [BaseElement(url=collection_url)]

        response = json.loads(requests.get(episodes_url).content.decode())
        collection_title = response.get("meta", {}).get("title", None)
        if collection_title is None:
            collection_title = re.findall(r"/([^/]*)/h/", collection_url)
            if len(collection_title) == 0:
                collection_title = None
        if collection_title is None:
            collection_title = content_id

        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                canalplus_com.__name__
            ),
            get_valid_filename(collection_title)
        )

        seasons = []
        for season in response.get("selector", []):
            if season.get("seasonNumber", None) is None:
                continue
            seasons.append((season["seasonNumber"], season["contentID"]))
        seasons = sorted(seasons, key=lambda s: s[0])

        collection = []
        for season_index, season_id in seasons:
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            response = requests.get(update_url_params(
                episodes_url, {'seasonID': season_id}
            ))
            response = json.loads(response.content.decode())
            has_episode_index = None
            episode_counter = 0

            while True:
                episodes = response.get("episodes", {})

                for episode in episodes.get("contents", []):
                    if has_episode_index is None:
                        has_episode_index = episode.get("episodeNumber", None) is not None

                    episode_counter += 1
                    if not has_episode_index:
                        episode_index = episode_counter
                    else:
                        episode_index = episode["episodeNumber"]

                    check = check_range(False, season_index, episode_index)
                    if check in [True, False]:
                        continue

                    video_title = f"E{episode_index}"
                    for f in ["title", "editorialTitle"]:
                        if episode.get(f, None) not in ["", None]:
                            video_title = video_title + "_" + episode[f]

                    collection.append(BaseElement(
                        url=canalplus_com.VIDEO_URL.format(
                            language=language,
                            video_id=episode["contentID"]
                        ),
                        collection=join(collection_title, f'Season_{season_index}'),
                        element=get_valid_filename(video_title)
                    ))

                paging = episodes.get("paging", {})
                if paging is None:
                    break
                if paging.get("hasNextPage", False) is False:
                    break

                response = requests.get(paging["URLPage"])
                response = json.loads(response.content.decode())

        return collection
