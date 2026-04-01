import base64
import builtins
import json
import re
from os.path import join
from urllib.parse import urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import USER_ERROR, ERR_MSG
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class rmcbfmplay_com(BaseService):
    DEMO_URLS = [
        "https://www.rmcbfmplay.com/info-programme/rmc-bfm-play/australie-la-ruee-vers-lor?contentId=Product::NEUF_BFMAVOD_BAV_623218986527&universe=PROVIDER",
        "https://www.rmcbfmplay.com/info-programme/bfm-tv/michel-edouard-leclerc-a-tout-prix?contentId=Product::NEUF_BFMTV_BFM989735110527&universe=PROVIDER",
        "https://www.rmcbfmplay.com/info-programme/rmc-decouverte/seuls-face-a-lalaska?contentId=Product::NEUF_RMCDEC_RMCP4341198&universe=PROVIDER",
        "https://www.rmcbfmplay.com/video/rmc-story/alien-theory/s6e10-lere-technologique?contentId=Product::NEUF_NUM23_N2341089&universe=PROVIDER",
        "https://www.rmcbfmplay.com/video/rmc-story/le-pal-au-coeur-du-zoo-le-plus-insolite-de-france?contentId=Product::NEUF_NUM23_N23544692327527&universe=PROVIDER",
        "https://www.rmcbfmplay.com/video/rmc-bfm-play/alexandre-le-grand-la-vraie-histoire-dun-conquerant-de-legende?contentId=Product::NEUF_BFMAVOD_BAV984224866527&universe=PROVIDER",
    ]

    CONFIG_URL = 'https://www.rmcbfmplay.com/assets/configs/config.json'
    CAS_AUTH_URL = 'https://sso.rmcbfmplay.com/cas/oidc/authorize'
    CONTENT_URL = 'https://ws-backendtv.rmcbfmplay.com/gaia-core/rest/api/web/v3/content/{content_id}/options'
    DETAIL_URL = 'https://ws-cdn.tv.sfr.net/gaia-core/rest/api/web/v1/content/{content_id}/detail'
    EPISODES_URL = 'https://ws-cdn.tv.sfr.net/gaia-core/rest/api/web/v1/content/{content_id}/episodes'
    VIDEO_URL = 'https://www.rmcbfmplay.com/video?contentId={content_id}&universe={universe}'
    LICENSE_URL = None

    EMAIL = 'YOUR_EMAIL'
    PASSWORD = 'YOUR_PASSWORD'
    BFM_TOKEN = None
    APP_VALUE = None
    CONFIG_CONTENT = None
    PAGE_LIMIT = 50
    RES_PRIORITY = {"sd": 0, "hd": 1}

    @staticmethod
    def test_service():
        main_service.run_service(rmcbfmplay_com)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/direct-tv/" in content

    @staticmethod
    def credentials_needed():
        return {
            "EMAIL": rmcbfmplay_com.EMAIL,
            "PASSWORD": rmcbfmplay_com.PASSWORD
        }

    @staticmethod
    def get_token():
        class_name = rmcbfmplay_com.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            assert type(credentials["EMAIL"]) is str
            assert type(credentials["PASSWORD"]) is str
        except:
            return None

        with requests.session() as login_session:
            response = login_session.get(
                rmcbfmplay_com.CAS_AUTH_URL, allow_redirects=False, params={
                    'client_id': rmcbfmplay_com.CONFIG_CONTENT["auth"]["OIDC_CLIENT_ID"],
                    'scope': 'openid', 'response_type': 'token',
                    'redirect_uri': 'https://www.rmcbfmplay.com'
                }
            )
            redirect = response.headers["location"]
            response = login_session.get(redirect)

            soup_login = BeautifulSoup(response.content, 'html5lib')
            form_data = {}
            for element in soup_login.find('form').find_all('input'):
                if element.has_attr('value'):
                    form_data[element['name']] = element['value']

            form_data['username'] = credentials["EMAIL"]
            form_data['password'] = credentials["PASSWORD"]
            form_data['remember-me'] = 'on'

            response = login_session.post(redirect, allow_redirects=False, data=form_data)
            redirect = response.headers["location"]
            response = login_session.get(redirect, allow_redirects=False)
            redirect = response.headers["location"]

            token = parse_qs(urlparse(redirect).query)["access_token"][0]
            for b64 in token.split("."):
                try:
                    return json.loads(base64.b64decode(b64 + "==").decode())["tu"]
                except:
                    pass
        return None

    @staticmethod
    def initialize_service():
        if rmcbfmplay_com.CONFIG_CONTENT is None:
            rmcbfmplay_com.CONFIG_CONTENT = json.loads(requests.get(rmcbfmplay_com.CONFIG_URL).content.decode())
            rmcbfmplay_com.APP_VALUE = rmcbfmplay_com.CONFIG_CONTENT["application"]["app"]

        if rmcbfmplay_com.BFM_TOKEN is None:
            rmcbfmplay_com.BFM_TOKEN = rmcbfmplay_com.get_token()
            if rmcbfmplay_com.BFM_TOKEN is None:
                return None
            rmcbfmplay_com.LICENSE_URL = rmcbfmplay_com.CONFIG_CONTENT[
                "player"
            ]["shaka"]["drm"]["servers"]["com.widevine.alpha"]

        return rmcbfmplay_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            rmcbfmplay_com.LICENSE_URL, data=challenge,
            headers={
                'customdata': '&'.join([f"{key}={value}" for key, value in {
                    "description": "description",
                    "deviceName": "deviceName",
                    "deviceType": "PC",
                    "tokenType": "castoken",
                    "tokenSSO": rmcbfmplay_com.BFM_TOKEN
                }.items()])
            }
        )
        if licence.status_code == 520:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=additional["URL"],
                reason="Need French IP to access content",
                solution="Use a VPN"
            ))
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        query_params = parse_qs(urlparse(source_element.url).query)
        content_id = query_params["contentId"][0]
        universe = query_params["universe"][0]

        response = json.loads(requests.get(
            rmcbfmplay_com.CONTENT_URL.format(content_id=content_id),
            params={
                'app': rmcbfmplay_com.APP_VALUE, 'device': 'browser',
                'token': rmcbfmplay_com.BFM_TOKEN, 'universe': universe
            }
        ).content.decode())

        manifest = []
        element_name = None
        for product in response:
            if product["productId"] != content_id:
                continue

            element_name = product.get("title", None)
            for offer in product["offers"]:
                for stream in offer["streams"]:
                    if stream["drm"] != "WIDEVINE":
                        continue
                    manifest += [(offer["definition"].lower(), stream["url"])]
        if len(manifest) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Content isn't available anymore",
                solution="Do not attempt to download it"
            ))
        manifest = sorted(manifest, key=lambda m: rmcbfmplay_com.RES_PRIORITY[m[0]], reverse=True)[0][1]

        if source_element.element is None:
            if element_name is None:
                element_name = content_id
            source_element.element = get_valid_filename(element_name)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rmcbfmplay_com.__name__
            )

        try:
            pssh_value = str(min(re.findall(
                r'<cenc:pssh>(.+?)</cenc:pssh>',
                requests.get(manifest).content.decode()
            ), key=len))
        except:
            return manifest, None, {}
        return manifest, pssh_value, {"URL": source_element.url}

    @staticmethod
    def get_collection_elements(collection_url):
        if "/video/" in collection_url and "contentId=" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/info-programme/" in collection_url:
            collection = []
            query_params = parse_qs(urlparse(collection_url).query)
            content_id = query_params["contentId"][0]
            universe = query_params["universe"][0]

            response = json.loads(requests.get(
                rmcbfmplay_com.DETAIL_URL.format(content_id=content_id),
                params={"universe": universe}
            ).content.decode())

            collection_name = response.get("title", None)
            if collection_name is None:
                collection_name = content_id
            collection_name = get_valid_filename(collection_name)

            is_series = response.get("seasons", None) is not None
            collection_key = "episodes"
            if is_series:
                collection_key = "seasons"

            index = 0
            for collection_object in response.get(collection_key, []):
                if not is_series:
                    index += 1
                    episode = collection_object
                    check = check_range(False, None, index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=rmcbfmplay_com.VIDEO_URL.format(content_id=episode["id"], universe=universe),
                        collection=join(
                            join(
                                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                rmcbfmplay_com.__name__
                            ),
                            collection_name
                        ),
                        element=f'{episode["sequence"]}'
                                f'_'
                                f'{get_valid_filename(episode.get("title", episode["id"]))}'
                    ))
                else:
                    season = collection_object
                    check = check_range(True, season["sequence"], None)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    page = -1
                    while True:
                        page += 1

                        episode_response = json.loads(requests.get(
                            rmcbfmplay_com.EPISODES_URL.format(content_id=season["id"]),
                            params={
                                'app': rmcbfmplay_com.APP_VALUE, 'device': 'browser',
                                'universe': universe, 'page': page,
                                'size': rmcbfmplay_com.PAGE_LIMIT
                            }
                        ).content.decode())

                        for episode in episode_response.get("content", []):
                            check = check_range(False, season["sequence"], episode['episodeNumber'])
                            if check is True:
                                continue
                            elif check is False:
                                return collection

                            collection.append(BaseElement(
                                url=rmcbfmplay_com.VIDEO_URL.format(content_id=episode["id"], universe=universe),
                                collection=join(
                                    join(
                                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                        rmcbfmplay_com.__name__
                                    ),
                                    join(collection_name, f'Season_{season["sequence"]}')
                                ),
                                element=f'Episode_{episode["episodeNumber"]}'
                                        f'_'
                                        f'{get_valid_filename(episode.get("title", episode["id"]))}'
                            ))

                        if len(episode_response.get("content", [])) < rmcbfmplay_com.PAGE_LIMIT:
                            break

            return collection
        return None
