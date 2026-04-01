import builtins
import json
import os
import re
from os.path import join
from urllib.parse import quote

import requests
from requests.adapters import HTTPAdapter
from urllib3 import Retry

from utils.constants.macros import CACHE_DIR, APP_ERROR, ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import dict_to_file, file_to_dict, get_valid_filename


class m6_fr(BaseService):
    DEMO_URLS = [
        "https://www.m6.fr/6play/top-6play-6play-f_1393",
        "https://www.m6.fr/les-animaux-p_25744",
        "https://www.m6.fr/l-incroyable-famille-kardashian-p_10941",
        "https://www.m6.fr/lois-et-clark-les-nouvelles-aventures-de-supe-p_25720/s1-e1-lois-et-clark-c_13064763",
        "https://www.m6.fr/alvinnn-et-les-chipmunks-p_16251/le-deluge-de-collations-c_12962956",
        "https://www.m6.fr/rtl-vous-regale-p_25746/la-recette-du-gratin-de-fraises-de-angele-ferreux-maeght-c_13070338",
    ]

    LAYOUT_URL = 'https://layout.6cloud.fr/front/v1/m6web/m6group_web/main/token-web-4/{content_type}/{video_id}/layout'
    PAGE_URL = 'https://layout.6cloud.fr/front/v1/m6web/m6group_web/main/token-web-4/{content_type}/{video_id}/block/{page_id}'
    PROFILES_URL = 'https://6play-users.6play.fr/v2/platforms/m6group_web/users/{user_id}/profiles'
    BOOTSTRAP_URL = 'https://login-gigya.6play.fr/accounts.webSdkBootstrap'
    LOGIN_URL = 'https://login-gigya.6play.fr/accounts.login'
    ACCOUNT_URL = 'https://accounts.eu1.gigya.com/accounts.getAccountInfo'
    JWT_URL = 'https://front-auth.6cloud.fr/v2/platforms/m6group_web/getJwt'
    TOKEN_URL = 'https://drm.6cloud.fr/v1/customers/m6web/platforms/m6group_web/services/6terreplay/users/-/videos/{video_id}/upfront-token'
    LICENSE_URL = 'https://lic.drmtoday.com/license-proxy-widevine/cenc/'
    BASE_URL = "https://www.m6.fr"

    API_KEY = '3_hH5KBv25qZTd_sURpixbQW6a4OsiIzIEF2Ei_2H7TXTGLJb_1Hr4THKZianCQhWK'
    EMAIL = "YOUR_EMAIL"
    PASSWORD = "YOUR_PASSWORD"
    CACHE_FILE = None
    BEARER_TOKEN = None
    RES_PRIORITY = {"sd": 0, "hd": 1}
    PAGE_SIZE = 10
    RETRIES_COUNT = 5
    RETRIES_TIMER = 5
    RETRIES_MAX = 10000

    @staticmethod
    def test_service():
        main_service.run_service(m6_fr)

    @staticmethod
    def credentials_needed():
        return {
            "EMAIL": m6_fr.EMAIL,
            "PASSWORD": m6_fr.PASSWORD
        }

    @staticmethod
    def get_bearer_token():
        session_info_keys = ["profile_id", "UID", "UIDSignature", "signatureTimestamp"]
        try:
            session_info = file_to_dict(m6_fr.CACHE_FILE)
            assert len(session_info.keys()) == len(session_info_keys)

            for k in session_info_keys:
                assert session_info[k] is not None
        except:
            session_info = None

        if session_info is None:
            class_name = m6_fr.__name__.replace("_", ".")
            credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
            try:
                assert type(credentials["EMAIL"]) is str
                assert type(credentials["PASSWORD"]) is str
            except:
                return None

            response = requests.get(
                m6_fr.BOOTSTRAP_URL, params={'apiKey': m6_fr.API_KEY}
            ).headers.get("set-cookie", None)
            if response in ["", None]:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=f'from the {m6_fr.__name__} service',
                    reason="Can't obtain the session info because the API key was changed",
                    solution='Update the API key manually'
                ))

            gmid = None
            for h in response.split(";"):
                if h.startswith("gmid="):
                    gmid = h[5:]
                    break
            assert gmid is not None

            response = json.loads(requests.post(
                m6_fr.LOGIN_URL,
                cookies={'gmid': gmid},
                headers={'Content-Type': 'application/x-www-form-urlencoded'},
                data="&".join([f"{k}={quote(v)}" for k, v in {
                    'loginID': credentials["EMAIL"],
                    'password': credentials["PASSWORD"],
                    'sessionExpiration': '-48',
                    'targetEnv': 'jssdk',
                    'APIKey': m6_fr.API_KEY
                }.items()])
            ).content.decode())

            message = response.get("errorDetails", "").lower()
            status_code = response.get("statusCode", None)
            if status_code == 403:
                if "loginid" in message or "password" in message:
                    return None
                if "locked" in message:
                    raise CustomException(ERR_MSG.format(
                        type=f'{USER_ERROR}',
                        url=f'from the {m6_fr.__name__} service',
                        reason="Account is temporarily locked because of too many failed login attempts",
                        solution="Wait 15 minutes or use another burner account"
                    ))
            if status_code != 200:
                raise CustomException(ERR_MSG.format(
                    type=f'{APP_ERROR}',
                    url=f"from the {m6_fr.__name__} service",
                    reason=f"Unknown error encountered: {str(response)}",
                    solution="Debug the service"
                ))

            session_info = {}
            for k in session_info_keys:
                if response.get(k, None) is None:
                    continue
                session_info[k] = response[k]

            response = json.loads(requests.get(
                m6_fr.JWT_URL,
                headers={
                    'x-auth-device-id': 'x-auth-device-id',
                    'X-Auth-gigya-uid': session_info["UID"],
                    'X-Auth-gigya-signature': session_info["UIDSignature"],
                    'X-Auth-gigya-signature-timestamp': str(session_info["signatureTimestamp"])
                }
            ).content.decode())

            bearer_token = response["token"]
            response = json.loads(requests.get(
                m6_fr.PROFILES_URL.format(user_id=session_info["UID"]),
                headers={'Authorization': f'Bearer {bearer_token}'}
            ).content.decode())
            if type(response) is not list:
                response = [response]

            assert len(response) > 0
            profile_id = None
            for profile in response:
                if profile.get("profile_type", "").lower() == "adult":
                    profile_id = profile["uid"]
            if profile_id is None:
                profile_id = response[0]["uid"]
            session_info["profile_id"] = profile_id

        response = requests.get(
            m6_fr.JWT_URL,
            headers={
                'x-auth-device-id': 'x-auth-device-id',
                'X-Auth-profile-id': session_info["profile_id"],
                'X-Auth-gigya-uid': session_info["UID"],
                'X-Auth-gigya-signature': session_info["UIDSignature"],
                'X-Auth-gigya-signature-timestamp': str(session_info["signatureTimestamp"])
            }
        )

        status_code = response.status_code
        response = json.loads(response.content.decode())
        message = response.get("message", response.get("error", {}).get("message", "")).lower()
        if status_code == 498 or "invalid" in message or "token" in message or "expired" in message:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=f"from the {m6_fr.__name__} service",
                reason="Can't access the video content because the session info expired",
                solution=f'Delete the {m6_fr.CACHE_FILE} cache manually or add the parameter --fresh to your command'
            ))

        bearer_token = response["token"]
        dict_to_file(m6_fr.CACHE_FILE, session_info)
        return bearer_token

    @staticmethod
    def initialize_service():
        if m6_fr.CACHE_FILE is None:
            m6_fr.CACHE_FILE = join(CACHE_DIR, f'{m6_fr.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(m6_fr.CACHE_FILE, {})

        if m6_fr.BEARER_TOKEN is None:
            m6_fr.BEARER_TOKEN = m6_fr.get_bearer_token()
            if m6_fr.BEARER_TOKEN is None:
                return None
        return m6_fr

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            m6_fr.LICENSE_URL, data=challenge,
            headers={'x-dt-auth-token': additional["auth_token"]}
        )
        licence.raise_for_status()
        return json.loads(licence.content.decode())["license"]

    @staticmethod
    def get_video_title(item_url, item_content):
        video_title = item_content.get("title", None)
        if video_title is None:
            video_title = item_content.get("extraTitle", None)
        elif item_content.get("extraTitle", None) is not None:
            if item_content["extraTitle"] != item_content["title"]:
                video_title = video_title + "_" + item_content["extraTitle"]

        if video_title is None:
            video_title = item_url.split("/")[-1]
        return get_valid_filename(video_title)

    @staticmethod
    def generate_video_m3u8(output_path, asset_info, content_info):
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
        m3u8_content += f'#EXTINF:{content_info.get("duration", 1)},\n'
        m3u8_content += f'{asset_info["path"]}\n'

        m3u8_content += "#EXT-X-ENDLIST\n"
        with open(output_path, "w") as f:
            f.write(m3u8_content)

    @staticmethod
    def generate_master_m3u8(source_element, asset_info, content_info):
        output_path = str(join(source_element.collection, source_element.element))
        if not os.path.exists(output_path):
            os.makedirs(output_path)
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"

        title = f'audio.m3u8'
        m6_fr.generate_video_m3u8(join(output_path, title), asset_info, content_info)
        m3u8_content += f"#EXT-X-STREAM-INF:BANDWIDTH=1000,TYPE=AUDIO,MIME-TYPE=\"audio/{asset_info['video_container']}\"\n"
        m3u8_content += f'{title}\n'

        output_path = join(output_path, "master.m3u8")
        with open(output_path, "w") as f:
            f.write(m3u8_content)
        return output_path

    @staticmethod
    def get_video_data(source_element):
        with requests.Session() as session:
            adapter = HTTPAdapter(max_retries=Retry(
                connect=m6_fr.RETRIES_COUNT,
                backoff_factor=m6_fr.RETRIES_MAX,
                backoff_max=m6_fr.RETRIES_TIMER
            ))
            session.mount('http://', adapter)
            session.mount('https://', adapter)

            content_id = re.search(r"-c_([^/?#]+)", source_element.url).group(1)
            content_id = "clip_" + content_id
            response = session.get(
                m6_fr.LAYOUT_URL.format(content_type="video", video_id=content_id),
                headers={'Authorization': f'Bearer {m6_fr.BEARER_TOKEN}'},
                params={"nbPages": m6_fr.PAGE_SIZE}
            )

            status_code = response.status_code
            response = json.loads(response.content.decode())
            message = response.get("message", "").lower()
            if status_code == 498 or "invalid" in message or "token" in message or "expired" in message:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason="Can't access the video content because the bearer token expired",
                    solution=f'Delete the {m6_fr.CACHE_FILE} cache manually or add the parameter --fresh to your command'
                ))

            has_drm = False
            manifest = None

            for block in response.get("blocks", []):
                if block.get("content", {}) in ["", None, {}]:
                    continue

                for item in block["content"].get("items", []):
                    item_content = item.get("itemContent", {})
                    video = item_content.get("video", {})
                    if video.get("id", None) != content_id:
                        continue

                    reason = item_content.get("action", {}).get("target", {}).get(
                        "value_lock", {}
                    ).get("reason", "").lower()
                    if "geoblock" in reason:
                        raise CustomException(ERR_MSG.format(
                            type=f'{USER_ERROR}',
                            url=source_element.url,
                            reason="Need French IP to access content or the VPN was detected",
                            solution="Use a VPN or get a better one"
                        ))

                    video_title = m6_fr.get_video_title(source_element.url, item_content)
                    if source_element.element is None:
                        source_element.element = video_title
                    if source_element.collection is None:
                        source_element.collection = join(
                            str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                            m6_fr.__name__
                        )

                    assets = video.get("assets", [])
                    has_drm = len(list(filter(
                        lambda d: d not in ["", None, {}] and 'none' not in d.get("type", ""),
                        [a.get("drm", None) for a in assets]
                    ))) > 0

                    if has_drm:
                        assets = list(filter(lambda a: a['format'].lower().startswith("dash"), assets))
                    if len(assets) == 0:
                        raise CustomException(ERR_MSG.format(
                            type=APP_ERROR,
                            url=source_element.url,
                            reason=f"Manifest format not supported: {str(video.get('assets', []))}",
                            solution=f"Extend the {m6_fr.__name__} service"
                        ))

                    assets = sorted(assets, key=lambda a: m6_fr.RES_PRIORITY[a["quality"].lower()], reverse=True)
                    asset = assets[0]

                    if asset['video_container'].lower() not in ["ism", "mpd", "m3u8"]:
                        if has_drm:
                            raise CustomException(ERR_MSG.format(
                                type=APP_ERROR,
                                url=source_element.url,
                                reason=f"Manifest format not supported: {manifest}. Can't extract pssh",
                                solution=f"Extend the {m6_fr.__name__} service"
                            ))
                        manifest = m6_fr.generate_master_m3u8(source_element, asset, video)
                    else:
                        manifest = asset["path"]
                    break
                if manifest is not None:
                    break

            if manifest is None:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available",
                    solution="Do not attempt to download it"
                ))

            pssh_value = None
            additional = {}
            if has_drm:
                try:
                    pssh_value = str(min(
                        re.findall(
                            r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                            session.get(manifest).content.decode()
                        ), key=len
                    ))
                except:
                    pass

                if pssh_value is None:
                    raise CustomException(ERR_MSG.format(
                        type=APP_ERROR,
                        url=source_element.url,
                        reason=f"Manifest format not supported: {manifest}. Can't extract pssh",
                        solution=f"Extend the {m6_fr.__name__} service"
                    ))

                response = json.loads(session.get(
                    m6_fr.TOKEN_URL.format(video_id=content_id),
                    headers={'Authorization': f'Bearer {m6_fr.BEARER_TOKEN}'}
                ).content.decode())
                additional["auth_token"] = response["token"]

            if builtins.CONFIG.get("BASIC", False) is True:
                manifest = re.sub(r'=eyJ[^&]*', '=<TOKEN>', manifest)
            return manifest, pssh_value, additional

    @staticmethod
    def get_series_handler(collection_url, content_type):
        collection_url = collection_url.split("?")[0].split("#")[0].rstrip("/")
        collection = []

        with requests.Session() as session:
            adapter = HTTPAdapter(max_retries=Retry(
                connect=m6_fr.RETRIES_COUNT,
                backoff_factor=m6_fr.RETRIES_MAX,
                backoff_max=m6_fr.RETRIES_TIMER
            ))
            session.mount('http://', adapter)
            session.mount('https://', adapter)

            content_id = re.search(fr"{content_type[0]}([^/?#]+)", collection_url).group(1)
            layout_page = 1
            layout_response = session.get(
                m6_fr.LAYOUT_URL.format(content_type=content_type[1], video_id=content_id),
                headers={'Authorization': f'Bearer {m6_fr.BEARER_TOKEN}'},
                params={'page': str(layout_page), 'nbPages': str(m6_fr.PAGE_SIZE)}
            )

            status_code = layout_response.status_code
            layout_response = json.loads(layout_response.content.decode())
            message = layout_response.get("message", "").lower()
            if status_code == 498 or "invalid" in message or "token" in message or "expired" in message:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=collection_url,
                    reason="Can't access the video content because the bearer token expired",
                    solution=f'Delete the {m6_fr.CACHE_FILE} cache manually or add the parameter --fresh to your command'
                ))

            collection_name = layout_response.get("entity", {}).get("metadata", {}).get("title", None)
            if collection is None:
                collection_name = layout_response.get("layout", {}).get("title", None)
            if collection_name is None:
                collection_name = layout_response.get("layout", {}).get("branding", {}).get("title", None)
            if collection_name is None:
                collection_name = layout_response.get("seo", {}).get("title", None)
            if collection_name is None:
                collection_name = collection_url.split("/")[-1]
            collection_name = join(
                join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    m6_fr.__name__
                ),
                get_valid_filename(collection_name)
            )

            rail_index = 0
            while True:
                if len(layout_response.get("blocks", [])) == 0:
                    break

                for rail_block in layout_response["blocks"]:
                    if rail_block.get("content", None) is None:
                        continue
                    if "jumbotron" in rail_block.get("templateId", "").lower():
                        continue

                    if len(list(filter(
                            lambda i: i.get("itemContent", {}).get("action", {}).get(
                                "target", {}
                            ).get("value_layout", {}).get("type", "").lower() in ["video", "audio"],
                            rail_block["content"].get("items", [])
                    ))) == 0:
                        continue

                    rail_index += 1
                    check = check_range(True, rail_index, None)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    rail_title = rail_block.get("title", {})
                    if rail_title is not None:
                        if rail_title.get("long", None) is None:
                            rail_title = rail_title.get("short", None)
                        else:
                            rail_title = rail_title["long"]
                    if rail_title is None:
                        rail_title = f'Rail_{rail_index}'
                    else:
                        rail_title = f'Rail_{rail_index}_{rail_title}'
                    rail_title = join(collection_name, get_valid_filename(rail_title))

                    rail_page = 1
                    loaded = []
                    if rail_block["content"].get("pagination", None) not in ["", {}, None]:
                        if rail_block["content"]["pagination"].get("nextPage", None) not in ["", {}, None]:
                            if rail_block["content"]["pagination"]["nextPage"] > 0:
                                rail_page = rail_block["content"]["pagination"]["nextPage"]
                                loaded = rail_block["content"]["items"]

                    content_index = 0
                    while True:
                        grid_response = json.loads(session.get(
                            m6_fr.PAGE_URL.format(
                                content_type=content_type[1], video_id=content_id, page_id=rail_block["id"]
                            ), params={'page': str(rail_page), 'nbPages': str(m6_fr.PAGE_SIZE)},
                            headers={'Authorization': f'Bearer {m6_fr.BEARER_TOKEN}'}
                        ).content.decode()).get("content", {})

                        if grid_response is None:
                            break
                        if grid_response.get("items", []) in [[], None]:
                            grid_response["items"] = []

                        page_items = loaded + grid_response["items"]
                        if len(page_items) == 0:
                            break
                        loaded = []

                        for page_item in page_items:
                            try:
                                value_layout = page_item["itemContent"]["action"]["target"]["value_layout"]
                                if value_layout["type"].lower() not in ["video", "audio"]:
                                    continue
                                parent = value_layout["parent"]

                                video_url = m6_fr.BASE_URL + "/" + parent["seo"]
                                video_url += "-" + parent["type"].lower()[0] + "_" + parent["id"]
                                video_url += "/" + value_layout["seo"]
                                video_url += "-" + value_layout["id"].split("_")[0].lower()[0] + "_"
                                video_url += value_layout["id"].split("_")[-1]
                            except:
                                continue

                            content_index += 1
                            check = check_range(False, rail_index, content_index)
                            if check is True:
                                continue
                            elif check is False:
                                return collection

                            video_title = m6_fr.get_video_title(video_url, page_item["itemContent"])
                            collection.append(BaseElement(
                                url=video_url,
                                collection=rail_title,
                                element=f'Content_{content_index}_{video_title}'
                            ))

                        if grid_response.get("pagination", None) not in ["", {}, None]:
                            if grid_response["pagination"].get("nextPage", None) not in ["", {}, None]:
                                if grid_response["pagination"]["nextPage"] > 0:
                                    rail_page = grid_response["pagination"]["nextPage"]
                                    continue
                        break

                if layout_response.get("pagination", None) not in ["", {}, None]:
                    if layout_response["pagination"].get("nextPage", None) not in ["", {}, None]:
                        if layout_response["pagination"]["nextPage"] > 0:
                            layout_page = layout_response["pagination"]["nextPage"]
                            layout_response = session.get(
                                m6_fr.LAYOUT_URL.format(content_type=content_type[1], video_id=content_id),
                                headers={'Authorization': f'Bearer {m6_fr.BEARER_TOKEN}'},
                                params={'page': str(layout_page), 'nbPages': str(m6_fr.PAGE_SIZE)}
                            )
                            continue
                break

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("/")
        nr_slash = collection_url.split(m6_fr.BASE_URL)[-1].count("/")
        slash_splits = collection_url.split("/")

        if "direct" == slash_splits[-1] and nr_slash == 2:
            return None
        if "-c_" in slash_splits[-1] and nr_slash == 2:
            return [BaseElement(url=collection_url)]

        for content_type in [("-f_", "folder"), ("-p_", "program")]:
            if content_type[0] in slash_splits[-1]:
                return m6_fr.get_series_handler(collection_url, content_type)
        return None
