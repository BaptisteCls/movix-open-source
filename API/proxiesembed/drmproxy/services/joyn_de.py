import builtins
import json
import re
from os.path import join
from urllib.parse import parse_qs, urlparse

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR, CACHE_DIR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, clean_url, dict_to_file, file_to_dict


class joyn_de(BaseService):
    DEMO_URLS = [
        # Without account
        "https://www.joyn.de/play/live-tv?channel_id=1007",
        "https://www.joyn.de/play/live-tv?channel_id=1298",
        "https://www.joyn.de/play/serien/the-race/2-1-bts-folge-1-the-race-staffel-2-beginnt",
        "https://www.joyn.de/play/serien/big-brother/2025-15-tageszusammenfassung-15-bluetenzauber-und-fleischeslust?from=%2F",
        "https://www.joyn.de/play/highlight/serien/newstime/wie-reagiert-deutschland-auf-trump-zoelle?from=%2F",
        "https://www.joyn.de/play/highlight/serien/newstime/supervulkan-neapel-plant-evakuierung?from=%2Fnews",
        "https://www.joyn.de/play/compilation/nba-orlando-magic-at-cleveland-cavaliers-im-relive/nba-overtime-krimi-bei-pacers-und-timberwolves",
        "https://www.joyn.de/play/compilation/ran-racing-dtm/dtm-kein-taxifahrer-mehr-timo-glock-ist-zurueck-in-der-dtm",
        "https://www.joyn.de/play/trailer/compilation/spacetime/spacetime-staffel-4-trailer",
        "https://www.joyn.de/play/filme/kung-fu-panda",
        "https://www.joyn.de/play/filme/die-olsenbande-sieht-rot",

        # With (free) account and no PIN
        "https://www.joyn.de/play/live-tv?channel_id=1132",
        "https://www.joyn.de/play/live-tv?channel_id=1043",
        "https://www.joyn.de/play/serien/detektiv-conan/1-198-das-haus-der-200-masken-1",
        "https://www.joyn.de/play/serien/joko-klaas-gegen-prosieben/3-10-episode-10-bptn5pr23j41",
        "https://www.joyn.de/play/compilation/ran-football-elf-live/elf-finale-rhein-fire-vs-vienna-vikings-in-voller-laenge",
        "https://www.joyn.de/play/filme/detektiv-conan-die-azurblaue-flagge",
        # With (free) account and PIN
        "https://www.joyn.de/play/live-tv?channel_id=1105",
        "https://www.joyn.de/play/serien/z-nation/2-1-der-murphy",
        "https://www.joyn.de/play/serien/killers-on-camera-auf-frischer-tat-ertappt/1-4-moerderische-rache-bpijk7f7j76s",
        "https://www.joyn.de/play/filme/the-demon-hunter",
        "https://www.joyn.de/play/filme/the-sniper",

        "https://www.joyn.de/play/live-tv",
        "https://www.joyn.de/serien/joko-klaas-gegen-prosieben",
        "https://www.joyn.de/serien/navy-cis",
        "https://www.joyn.de/serien/dragon-ball-z-kai",
        "https://www.joyn.de/serien/one-piece",
        "https://www.joyn.de/compilation/ran-football-elf-live",
        "https://www.joyn.de/compilation/spacetime",
        "https://www.joyn.de/play/playlist/639347?from=/sport",
        "https://www.joyn.de/play/playlist/617143?from=/sport",
    ]

    ENTITLEMENT_URL = None
    PLAYLIST_URL = None
    GRAPHQL_URL = None
    ANONYMOUS_URL = None
    REFRESH_URL = None
    ENDPOINTS_URL = None
    OAUTH_URL = 'https://www.joyn.de/oauth'
    LIVESTREAM_URL = 'https://www.joyn.de/play/live-tv?channel_id={channel_id}'
    BASE_URL = 'https://www.joyn.de'

    CACHE_FILE = None
    BEARER_TOKEN = None
    GRAPHQL_API_KEY = None
    PLATFORM = 'web'
    CLIENT_ID = 'client_id'
    PAGE_COUNT = 50
    EMAIL = ""
    PASSWORD = "YOUR_PASSWORD (leave at least one login field empty if you don't want to use an account)"
    PIN = "YOUR_PIN (this field is ignored if it's not a 4 digit text or if you don't use an account)"

    @staticmethod
    def test_service():
        main_service.run_service(joyn_de)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/live-tv" in content and "channel_id=" in content

    @staticmethod
    def credentials_needed():
        return {
            "OPTIONAL": True,
            "EMAIL": joyn_de.EMAIL,
            "PASSWORD": joyn_de.PASSWORD,
            "PIN": joyn_de.PIN
        }

    @staticmethod
    def get_anon_bearer_token():
        return json.loads(requests.post(
            joyn_de.ANONYMOUS_URL, json={'client_id': joyn_de.CLIENT_ID, 'client_name': joyn_de.PLATFORM}
        ).content.decode())["access_token"]

    @staticmethod
    def login_flow(credentials):
        response = requests.get(joyn_de.ENDPOINTS_URL, params={
            'client_id': joyn_de.CLIENT_ID, 'client_name': joyn_de.PLATFORM
        })
        response = json.loads(response.content.decode())
        token_url = response["redeem-token"]

        response = response["web-login"]
        auth_url = clean_url(response)
        login_url = urlparse(response)
        login_url = f"{login_url.scheme}://{login_url.netloc}" + "/login-srv/login"

        response = parse_qs(urlparse(response).query)
        client_id = response["client_id"][0]

        response = requests.get(
            auth_url, allow_redirects=False,
            params={'client_id': client_id, 'response_type': 'code'}
        )
        response = response.headers["location"]
        response = parse_qs(urlparse(response).query)
        request_id = response["requestId"][0]

        response = requests.post(login_url, allow_redirects=False, data={
            'username': credentials["EMAIL"], 'requestId': request_id,
            'password': credentials["PASSWORD"]
        })

        try:
            response = response.headers["location"]
            response = parse_qs(urlparse(response).query)
            code = response["code"][0]
            assert code not in ["", None]
        except:
            return None

        response = requests.post(token_url, json={
            'code': code, 'client_id': client_id,
            'redirect_uri': joyn_de.OAUTH_URL,
            'tracking_name': joyn_de.PLATFORM
        })
        return json.loads(response.content.decode())

    @staticmethod
    def refresh_flow(refresh_token):
        response = requests.post(
            joyn_de.REFRESH_URL, headers={'joyn-platform': joyn_de.PLATFORM},
            json={
                'client_name': joyn_de.PLATFORM, 'client_id': joyn_de.CLIENT_ID,
                'grant_type': 'Bearer', 'refresh_token': refresh_token
            }
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)

        joyn_de.check_expired_token(status_code, response, f'from the {joyn_de.__name__} service')
        return response

    @staticmethod
    def get_bearer_token():
        # return joyn_de.get_anon_bearer_token()
        try:
            refresh_token = file_to_dict(joyn_de.CACHE_FILE)["refresh_token"]
            assert type(refresh_token) is str and len(refresh_token) > 0
        except:
            refresh_token = None

        if refresh_token is not None:
            response = joyn_de.refresh_flow(refresh_token)
        else:
            class_name = joyn_de.__name__.replace("_", ".")
            credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
            try:
                assert type(credentials["EMAIL"]) is str
                assert type(credentials["PASSWORD"]) is str
            except:
                return None
            if credentials["EMAIL"].strip() == "" or credentials["PASSWORD"].strip() == "":
                return joyn_de.get_anon_bearer_token()

            response = joyn_de.login_flow(credentials)
            if response is None:
                return None

        bearer_token = response["access_token"]
        refresh_token = response["refresh_token"]
        for f in [bearer_token, refresh_token]:
            assert type(f) is str and len(f) > 0
        dict_to_file(joyn_de.CACHE_FILE, {"refresh_token": refresh_token})
        return bearer_token

    @staticmethod
    def get_pin():
        class_name = joyn_de.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            if credentials["EMAIL"].strip() == "" or credentials["PASSWORD"].strip() == "":
                raise
            pin = credentials["PIN"]
            assert type(pin) is str and pin.isdigit() and len(pin) == 4
            return pin
        except:
            return ""

    @staticmethod
    def endpoint_regex(regex_list, content):
        value = None
        for reg in regex_list:
            try:
                value = re.findall(reg + r"[^{}]*{([^{}]+)}", content)[0]
                value = re.findall(r'value[^:]*:[^"\']*["\']([^"\']+)["\']', value)[0]
                assert len(value) > 0
                break
            except:
                value = None
        return value

    @staticmethod
    def set_endpoints():
        try:
            response = requests.get(joyn_de.BASE_URL).text
            response = BeautifulSoup(response, "html5lib")
            response = response.find_all("script", src=True)
            response = [s["src"] for s in response if "app-" in s["src"] and ".js" in s["src"]][0]
            if not response.startswith("http"):
                response = joyn_de.BASE_URL + response
            response = requests.get(response).text
        except:
            response = None

        api_key = joyn_de.endpoint_regex(
            ["API_GW_API_KEY", "NEXT_PUBLIC_PLAYER_GRAPHQL_SERVICE_API_KEY"],
            response
        )
        if api_key in ["", None]:
            api_key = "4f0fd9f18abbe3cf0e87fdb556bc39c8"
        joyn_de.GRAPHQL_API_KEY = api_key

        entitlement = joyn_de.endpoint_regex(
            ["NEXT_PUBLIC_PLAYER_ENTITLEMENT_BASE_URL"],
            response
        )
        if entitlement in ["", None]:
            entitlement = 'https://entitlement.p7s1.io/api/user'
        if "/entitlement-token" not in entitlement:
            entitlement += "/entitlement-token"
        joyn_de.ENTITLEMENT_URL = entitlement

        playback = joyn_de.endpoint_regex(
            ["NEXT_PUBLIC_PLAYER_PLAYBACK_API_BASE_URL"],
            response
        )
        if playback in ["", None]:
            playback = 'https://api.vod-prd.s.joyn.de/v1'
        joyn_de.PLAYLIST_URL = playback + '/{asset_type}/{asset_id}/playlist'

        graphql = joyn_de.endpoint_regex(
            ["GRAPHQL_ENDPOINT", "NEXT_PUBLIC_PLAYER_GRAPHQL_ENDPOINT"],
            response
        )
        if graphql in ["", None]:
            graphql = 'https://api.joyn.de/graphql'
        joyn_de.GRAPHQL_URL = graphql

        auth_url = joyn_de.endpoint_regex(["AUTH_ENDPOINT"], response)
        if auth_url in ["", None]:
            auth_url = 'https://auth.joyn.de'
        joyn_de.ANONYMOUS_URL = auth_url + '/auth/anonymous'
        joyn_de.REFRESH_URL = auth_url + '/auth/refresh'
        joyn_de.ENDPOINTS_URL = auth_url + '/sso/endpoints'

    @staticmethod
    def initialize_service():
        if joyn_de.GRAPHQL_API_KEY is None:
            joyn_de.set_endpoints()
        if joyn_de.CACHE_FILE is None:
            joyn_de.CACHE_FILE = join(CACHE_DIR, f'{joyn_de.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(joyn_de.CACHE_FILE, {})

        if joyn_de.BEARER_TOKEN is None:
            joyn_de.BEARER_TOKEN = joyn_de.get_bearer_token()
            if joyn_de.BEARER_TOKEN is None:
                return None

            joyn_de.PIN = joyn_de.get_pin()
            if joyn_de.PIN is None:
                joyn_de.PIN = ""
        return joyn_de

    @staticmethod
    def check_expired_token(status_code, response, url):
        try:
            error_code = response.get("code", "").lower()
            assert len(error_code) > 0
        except:
            error_code = ""
        try:
            error_data = response.get("data", "").lower()
            assert len(error_data) > 0
        except:
            error_data = ""

        if (
                status_code in [401] or "invalid_jwt" in error_code or
                ("invalid refresh token" in error_data or "used refresh token" in error_data)
        ):
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=url,
                reason="Can't access the video content because the cached token expired",
                solution=f'Delete the {joyn_de.CACHE_FILE} cache manually or add the parameter --fresh to your command'
            ))

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def analyze_vod_format(url):
        content_client_hash = None
        content_client_path = None
        content_client_field = None
        content_query_lambda = None

        if "/filme/" in url:
            content_client_hash = "a06da53f05ced9524e1694940d6ceb23e97d85cdb081d3c2ac44ffae5b3190a6"
            content_client_field = "movie"
            content_client_path = "/" + url.split("/play/")[1]

            content_query_lambda = lambda cid: requests.post(
                joyn_de.GRAPHQL_URL,
                json={
                    'query': '''query Movie($id: ID!) { movie(id: $id) { title video { id } } }''',
                    "variables": {"id": cid}
                },
                headers={
                    'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                    'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
                }
            )
        elif "/serien/" in url:
            series_type = re.search(r'/play/([^/]+)/serien/', url)
            if series_type is None:
                content_client_hash = "864e9acb09fed428ad277efef2351295e76518b6803e63d5831a4150b96f9051"
                content_client_field = "episode"
                series_type = "play"

                content_query_lambda = lambda cid: requests.get(
                    joyn_de.GRAPHQL_URL,
                    params={
                        'query': '''query PlayerSeriesEpisode { episode(id: "{{content_id}}") {
                            title number season { number } series { title } video { id }
                        } }'''.replace("{{content_id}}", cid)
                    },
                    headers={
                        'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                        'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
                    }
                )
            else:
                content_client_field = "extra"
                series_type = series_type.group(1).lower()

                if series_type == "highlight":
                    content_client_hash = "497626ae16c19df71d61147590e7eaa7e3b288f90a3e207c400daaf1651563de"
                    content_query_lambda = lambda cid: requests.post(
                        joyn_de.GRAPHQL_URL,
                        json={
                            'query': '''query Highlight($id: ID!) { extra(id: $id) { title video { id } } }''',
                            "variables": {"id": cid}
                        },
                        headers={
                            'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                            'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
                        }
                    )
            content_client_path = "/" + url.split(f"/{series_type}/")[1]
        elif "/compilation/" in url:
            comp_type = re.search(r'/play/([^/]+)/compilation/', url)
            if comp_type is None:
                content_client_hash = "8025eaf32540f47be5a377ceef8ce718116159569ad1d7e32766abed97f87961"
                content_client_field = "compilationItem"
                comp_type = "play"

                content_query_lambda = lambda cid: requests.post(
                    joyn_de.GRAPHQL_URL,
                    json={
                        'variables': {'id': cid}, 'query': '''
                            query CompilationItem($id: ID!) { compilationItem(id: $id) { title video { id } } }
                        '''
                    },
                    headers={
                        'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                        'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
                    }
                )
            else:
                content_client_field = "extra"
                comp_type = comp_type.group(1).lower()

                if comp_type == "trailer":
                    content_client_hash = "81e7a9385cb87ae569178ceb96563c427b72efdf94183ae75952579b39226556"
                    content_query_lambda = lambda cid: requests.post(
                        joyn_de.GRAPHQL_URL,
                        json={
                            'query': '''query Extra($id: ID!) { extra(id: $id) { title video { id } } }''',
                            'variables': {'id': cid}
                        },
                        headers={
                            'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                            'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
                        }
                    )
            content_client_path = "/" + url.split(f"/{comp_type}/")[1]

        for var in [content_client_hash, content_client_path, content_client_field, content_query_lambda]:
            if var in [None, ""]:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=url,
                    reason=f"URL format not supported: {url}",
                    solution=f"Extend the {joyn_de.__name__} service"
                ))
        return content_client_hash, content_client_path, content_client_field, content_query_lambda

    @staticmethod
    def handle_vod(source_element):
        (content_client_hash, content_client_path,
         content_client_field, content_query_lambda
         ) = joyn_de.analyze_vod_format(source_element.url)

        response = requests.get(
            joyn_de.GRAPHQL_URL,
            params={
                'variables': json.dumps({"path": content_client_path}),
                'extensions': json.dumps({"persistedQuery": {"version": 1, "sha256Hash": content_client_hash}})
            },
            headers={
                'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
            }
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        temp_response = response

        try:
            content_id = response["data"]["page"][content_client_field]["id"]
            assert type(content_id) is str and len(content_id) > 0
        except:
            content_id = None

        if content_id is None:
            joyn_de.check_expired_token(status_code, temp_response, source_element.url)

            try:
                for error in response.get("errors", []):
                    if type(error) is not dict:
                        continue
                    error_code = error.get("extensions", {}).get("code", "").lower()
                    if error_code in ["not_found"]:
                        raise CustomException(ERR_MSG.format(
                            type=f'{USER_ERROR}',
                            url=source_element.url,
                            reason="The content isn't available",
                            solution="Do not attempt to download it"
                        ))

            except CustomException as e:
                raise e
            except:
                pass
            raise

        response = content_query_lambda(content_id)
        response = response.content.decode()
        response = json.loads(response)

        response = response["data"]
        response = response[content_client_field]
        asset_id = response["video"]["id"]

        if source_element.element is None:
            try:
                title = response["series"]["title"]
                assert len(title) > 0 and type(title) is str
            except:
                title = ""

            try:
                temp_title = response["season"]["number"]
                assert type(temp_title) in [str, int]
                title += " S" + str(temp_title)
            except:
                pass
            try:
                temp_title = response["number"]
                assert type(temp_title) in [str, int]
                title += " E" + str(temp_title)
            except:
                pass

            try:
                temp_title = response["title"]
                assert len(temp_title) > 0 and type(temp_title) is str
                title += " " + temp_title
            except:
                title += " " + source_element.url.split("/")[-1]

            source_element.element = get_valid_filename(title)
        return asset_id

    @staticmethod
    def handle_live(source_element):
        channel_id = parse_qs(urlparse(source_element.url).query)["channel_id"][0]
        response = requests.get(
            joyn_de.GRAPHQL_URL,
            headers={
                'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
            },
            params={
                'variables': json.dumps({"id": channel_id}),
                'extensions': json.dumps({"persistedQuery": {
                    "version": 1,
                    "sha256Hash": "6395983f3c004b2f9f42c0e9beee5efb1ca6d866fa0e637214220117ee411b15"
                }})
            }
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        temp_response = response

        try:
            response = response["data"]["brand"]
            assert response["id"] == channel_id

            live_id = response["livestream"]["id"]
            assert type(live_id) is str and live_id != ""
        except:
            joyn_de.check_expired_token(status_code, temp_response, source_element.url)
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            title = f"Live {live_id} id {channel_id}"
            source_element.element = get_valid_filename(title)
        return live_id

    @staticmethod
    def get_video_data(source_element):
        if source_element.additional is None:
            source_element.additional = {}
        asset_id = source_element.additional.get("asset_id", None)

        if "/live-tv" in source_element.url:
            if asset_id in ["", None]:
                asset_id = joyn_de.handle_live(source_element)
            content_type = "LIVE"
            asset_type = "channel"
        else:
            if asset_id in ["", None]:
                asset_id = joyn_de.handle_vod(source_element)
            content_type = "VOD"
            asset_type = "asset"

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                joyn_de.__name__
            )

        response = requests.post(
            joyn_de.ENTITLEMENT_URL,
            headers={
                'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                'joyn-platform': joyn_de.PLATFORM
            },
            json={'content_id': asset_id, 'content_type': content_type, "pin": joyn_de.PIN}
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)

        if status_code < 200 or 300 <= status_code:
            if type(response) is not list:
                response = [response]

            for error in response:
                error = error.get("code", "").lower()
                if "vpn_detected" in error or "notavailableincountry" in error:
                    raise CustomException(ERR_MSG.format(
                        type=f'{USER_ERROR}',
                        url=source_element.url,
                        reason="Need German IP to access content",
                        solution="Use a VPN (a good one that is not detected)"
                    ))
                if "ageverification" in error or "pinrequired" in error:
                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=source_element.url,
                        reason='Need PIN and account for this content',
                        solution='Set the PIN and account in the config file'
                    ))
                if "pininvalid" in error:
                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=source_element.url,
                        reason='Wrong PIN value',
                        solution='Set the correct PIN in the config file'
                    ))
                if "playback_restricted" in error:
                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=source_element.url,
                        reason='Need account for this content',
                        solution='Set the account credentials in the config file'
                    ))
                if "business_model" in error:
                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=source_element.url,
                        reason="Can't download paid content",
                        solution='Do not attempt to download it'
                    ))

            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Unknown error encountered: {str(response)}",
                solution=f"Debug the {joyn_de.__name__} service"
            ))

        response = requests.post(
            joyn_de.PLAYLIST_URL.format(asset_type=asset_type, asset_id=asset_id),
            headers={'authorization': f'Bearer {response["entitlement_token"]}'},
            json={
                'manufacturer': 'unknown', 'platform': 'browser', 'maxSecurityLevel': 1,
                'streamingFormat': 'dash', 'model': 'unknown', 'protectionSystem': 'widevine',
                'enableDolbyAudio': True, 'enableSubtitles': True, 'maxResolution': 1080,
                'variantName': 'default'
            }
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)

        if status_code < 200 or 300 <= status_code:
            message = response.get("message", "").lower()

            if "channel not found" in message:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The channel isn't available or it isn't a real livestream",
                    solution="Do not attempt to download it or download using the original vods URLs"
                ))
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Unknown error encountered: {str(message)}",
                solution=f"Debug the {joyn_de.__name__} service"
            ))

        additional = {}
        manifest = response["manifestUrl"]
        license_url = response.get("licenseUrl", None)
        pssh_value = None

        if license_url not in ["", None]:
            try:
                pssh_value = get_pssh_from_cenc_pssh(requests.get(manifest).text)
            except:
                pssh_value = None

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {joyn_de.__name__} service"
                ))
            additional["license_url"] = license_url

        return manifest, pssh_value, additional

    @staticmethod
    def handle_live_list(collection_url):
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                joyn_de.__name__
            ),
            get_valid_filename(collection_url.split("/")[-1] + " livestreams")
        )

        response = requests.get(
            joyn_de.GRAPHQL_URL,
            params={
                'extensions': json.dumps({"persistedQuery": {
                    "version": 1,
                    "sha256Hash": "52b37a3cf5bc75e56026aed7b0d234874eeabd2eccd369d0cd3d3a6ea15ef566"
                }})
            },
            headers={
                'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
            }
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        temp_response = response

        try:
            livestreams = response["data"]["liveStreams"]
            assert type(livestreams) is list
        except:
            joyn_de.check_expired_token(status_code, temp_response, collection_url)
            livestreams = []

        live_index = 0
        collection = []
        for livestream in livestreams:
            live_index += 1
            check = check_range(False, None, live_index)
            if check is True:
                continue
            elif check is False:
                return collection

            try:
                brand_id = livestream["brand"]["id"]
                assert brand_id is not None
            except:
                continue
            try:
                live_id = livestream["id"]
                assert live_id not in ["", None]
            except:
                continue

            collection.append(BaseElement(
                url=joyn_de.LIVESTREAM_URL.format(channel_id=brand_id),
                collection=collection_title,
                element=get_valid_filename(f"Channel {live_index} Live {live_id} id {brand_id}"),
                additional={"asset_id": live_id}
            ))
        return collection

    @staticmethod
    def get_content_url(content):
        content_url = joyn_de.BASE_URL
        if "/play/" not in content["path"]:
            content_url += "/play"
            try:
                assert type(content["type"]) is str and len(content["type"]) > 0
                content_type = content["type"].lower()
                if content_type[-1] == "s":
                    content_type = content_type[0:len(content_type) - 1]
                content_url += "/" + content_type
            except:
                pass
        content_url += content["path"]
        return content_url

    @staticmethod
    def handle_clips(clips_index, collection, collection_title, clips_path):
        check = check_range(True, clips_index, None)
        if check in [True, False]:
            return collection

        clip_index = 0
        clips_title = join(collection_title, f"Season_{clips_index}_Clips")
        clips_offset = -joyn_de.PAGE_COUNT
        while True:
            clips_offset += joyn_de.PAGE_COUNT

            response = requests.get(
                joyn_de.GRAPHQL_URL,
                params={
                    'variables': json.dumps({
                        "path": clips_path, "first": joyn_de.PAGE_COUNT, "offset": clips_offset
                    }),
                    'extensions': json.dumps({"persistedQuery": {
                        "version": 1,
                        "sha256Hash": "a68817f5c13383b59aa93cf97bf9892b364f1ce38523b4a20609ff1619523a30"
                    }})
                },
                headers={
                    'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                    'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
                }
            )
            try:
                response = response.content.decode()
                response = json.loads(response)
                clips = response["data"]["page"]["clipsAndTrailers"]["extras"]
                assert type(clips) is list and len(clips) > 0
            except:
                break

            for clip in clips:
                clip_index += 1
                check = check_range(False, clips_index, clip_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                clip_url = joyn_de.get_content_url(clip)
                try:
                    clip_id = clip["video"]["id"]
                    assert type(clip_id) is str and len(clip_id) > 0
                except:
                    continue

                try:
                    clip_title = clip["title"]
                    assert type(clip_title) is str and len(clip_title) > 0
                except:
                    clip_title = clip_url.split("/")
                clip_title = get_valid_filename(f'Clip_{clip_index} {clip_title}')

                collection.append(BaseElement(
                    url=clip_url,
                    collection=clips_title,
                    element=clip_title,
                    additional={"asset_id": clip_id}
                ))
        return collection

    @staticmethod
    def handle_serien(collection_url):
        response = requests.get(
            joyn_de.GRAPHQL_URL,
            params={
                'variables': json.dumps({"path": "/serien/" + collection_url.split("/serien/")[1]}),
                'extensions': json.dumps({"persistedQuery": {
                    "version": 1,
                    "sha256Hash": "43cad327eeae12e14dfb629d662ebc947d78b71ec91d972ea1ef46ccdb29eede"
                }})
            },
            headers={
                'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
            }
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        temp_response = response

        try:
            page = response["data"]["page"]
        except:
            page = None

        if page is None:
            joyn_de.check_expired_token(status_code, temp_response, collection_url)
            try:
                for error in response.get("errors", []):
                    if error.get("extensions", {}).get("code", "").lower() in ["not_found"]:
                        raise CustomException(ERR_MSG.format(
                            type=f'{USER_ERROR}',
                            url=collection_url,
                            reason="The content isn't available",
                            solution="Do not attempt to download it"
                        ))

            except CustomException as e:
                raise e
            except:
                pass
            raise

        response = page
        try:
            collection_title = response["series"]["title"]
            assert type(collection_title) is str and len(collection_title) > 0
        except:
            collection_title = None
        if collection_title in ["", None]:
            try:
                collection_title = response["tracking"]["payload"]["cms_title"]
                assert type(collection_title) is str and len(collection_title) > 0
            except:
                collection_title = None

        if collection_title in ["", None]:
            collection_title = collection_url.split("/serien/")[1]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                joyn_de.__name__
            ),
            get_valid_filename(collection_title)
        )

        response = response["series"]
        try:
            seasons = response["allSeasons"]
        except:
            seasons = []
        seasons = sorted(seasons, key=lambda s: s["number"])

        collection = []
        for season in seasons:
            try:
                season_id = season["id"]
                assert len(season_id) > 0 and type(season_id) is str
            except:
                continue

            season_index = season["number"]
            season_title = join(collection_title, f"Season_{season_index}")
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            episodes = []
            eps_offset = -joyn_de.PAGE_COUNT
            while True:
                eps_offset += joyn_de.PAGE_COUNT

                response = requests.get(
                    joyn_de.GRAPHQL_URL,
                    params={
                        'variables': json.dumps({
                            "id": season_id, "first": joyn_de.PAGE_COUNT, "offset": eps_offset
                        }),
                        'extensions': json.dumps({"persistedQuery": {
                            "version": 1,
                            "sha256Hash": "ee2396bb1b7c9f800e5cefd0b341271b7213fceb4ebe18d5a30dab41d703009f"
                        }})
                    },
                    headers={
                        'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                        'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
                    }
                )
                try:
                    response = response.content.decode()
                    response = json.loads(response)
                    current_episodes = response["data"]["season"]["episodes"]
                    assert type(current_episodes) is list and len(current_episodes) > 0
                except:
                    break
                episodes.extend(current_episodes)

            episodes = sorted(episodes, key=lambda ep: ep["number"])
            for episode in episodes:
                episode_index = episode["number"]
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episode_url = joyn_de.get_content_url(episode)
                try:
                    episode_id = episode["video"]["id"]
                    assert type(episode_id) is str and len(episode_id) > 0
                except:
                    continue

                try:
                    episode_title = episode["title"]
                    assert type(episode_title) is str and len(episode_title) > 0
                except:
                    episode_title = episode_url.split("/")
                episode_title = get_valid_filename(f'Episode_{episode_index} {episode_title}')

                collection.append(BaseElement(
                    url=episode_url,
                    collection=season_title,
                    element=episode_title,
                    additional={"asset_id": episode_id}
                ))

        try:
            clips_index = seasons[-1]["number"] + 1
        except:
            clips_index = 1
        return joyn_de.handle_clips(
            clips_index, collection, collection_title,
            "/serien/" + collection_url.split("/serien/")[1]
        )

    @staticmethod
    def handle_compilation(collection_url):
        collection_title = None
        collection = []
        item_index = 0

        season_index = 1
        check = check_range(True, season_index, None)
        skip_flag = check in [True, False]

        comp_offset = -joyn_de.PAGE_COUNT
        while True:
            comp_offset += joyn_de.PAGE_COUNT
            response = requests.get(
                joyn_de.GRAPHQL_URL,
                params={
                    'variables': json.dumps({
                        "path": "/compilation/" + collection_url.split("/compilation/")[1],
                        "first": joyn_de.PAGE_COUNT, "offset": comp_offset
                    }),
                    'extensions': json.dumps({"persistedQuery": {
                        "version": 1,
                        "sha256Hash": "0672194d788614168fba6effad2cf3f3de8cd73d980efd8a41991a177ded4693"
                    }})
                },
                headers={
                    'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                    'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
                }
            )
            status_code = response.status_code
            response = response.content.decode()
            response = json.loads(response)
            temp_response = response

            try:
                page = response["data"]["page"]
            except:
                page = None

            if page is None:
                joyn_de.check_expired_token(status_code, temp_response, collection_url)
                try:
                    for error in response.get("errors", []):
                        if error.get("extensions", {}).get("code", "").lower() in ["not_found"]:
                            raise CustomException(ERR_MSG.format(
                                type=f'{USER_ERROR}',
                                url=collection_url,
                                reason="The content isn't available",
                                solution="Do not attempt to download it"
                            ))

                except CustomException as e:
                    raise e
                except:
                    pass
                raise

            response = page
            if collection_title is None:
                try:
                    collection_title = response["compilation"]["title"]
                    assert type(collection_title) is str and len(collection_title) > 0
                except:
                    collection_title = None
                if collection_title in ["", None]:
                    try:
                        collection_title = response["tracking"]["payload"]["cms_title"]
                        assert type(collection_title) is str and len(collection_title) > 0
                    except:
                        collection_title = None

                if collection_title in ["", None]:
                    collection_title = collection_url.split("/compilation/")[1]
                collection_title = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        joyn_de.__name__
                    ),
                    get_valid_filename(collection_title)
                )

            try:
                assert skip_flag is False
                items = response["compilation"]["compilationItems"]
                assert type(items) is list and len(items) > 0
            except:
                break

            for item in items:
                item_index += 1
                check = check_range(False, season_index, item_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                item_url = joyn_de.get_content_url(item)
                try:
                    item_id = item["video"]["id"]
                    assert type(item_id) is str and len(item_id) > 0
                except:
                    continue

                try:
                    item_title = item["title"]
                    assert type(item_title) is str and len(item_title) > 0
                except:
                    item_title = item_url.split("/")
                item_title = get_valid_filename(f'Item_{item_index} {item_title}')

                collection.append(BaseElement(
                    url=item_url,
                    collection=join(collection_title, f"Season_{season_index}"),
                    element=item_title,
                    additional={"asset_id": item_id}
                ))

        return joyn_de.handle_clips(
            season_index + 1, collection, collection_title,
            "/compilation/" + collection_url.split("/compilation/")[1]
        )

    @staticmethod
    def handle_playlist(collection_url):
        playlist_id = collection_url.split("/playlist/")[1].split("/")[0]
        collection_title = None
        collection = []

        item_offset = 0
        item_index = 0
        visited = []
        current_item = None
        while True:
            response = requests.post(
                joyn_de.GRAPHQL_URL,
                headers={
                    'authorization': f'Bearer {joyn_de.BEARER_TOKEN}',
                    'joyn-platform': joyn_de.PLATFORM, 'x-api-key': joyn_de.GRAPHQL_API_KEY
                },
                json={
                    'query': '''query Playlist(
                            $playlistId: ID!, $playlistOffset: Int = 0, 
                            $playlistItemTypes: [PlaylistItemType] = [EXTRA, COMPILATION_ITEM]
                        ) { playlist(playlistId: $playlistId) {
                            title currentPlaylistItem(playlistItemTypes: $playlistItemTypes) { asset {
                                ... on Extra { title video { id } }
                                ... on CompilationItem { title path video { id } }
                            } }
                            remainingPlaylistItems(
                              first: {{page_count}} offset: $playlistOffset playlistItemTypes: $playlistItemTypes
                            ) { asset {
                                ... on Extra { title video { id } }
                                ... on CompilationItem { title path video { id } }
                            } }
                          }
                        }'''.replace("{{page_count}}", str(joyn_de.PAGE_COUNT)),
                    'variables': {'playlistId': playlist_id, 'playlistOffset': item_offset}
                }
            )
            status_code = response.status_code
            response = response.content.decode()
            response = json.loads(response)
            temp_response = response

            try:
                playlist = response["data"]["playlist"]
            except:
                playlist = None

            if playlist is None:
                joyn_de.check_expired_token(status_code, temp_response, collection_url)
                try:
                    for error in response.get("errors", []):
                        if error.get("extensions", {}).get("code", "").lower() in ["not_found"]:
                            raise CustomException(ERR_MSG.format(
                                type=f'{USER_ERROR}',
                                url=collection_url,
                                reason="The content isn't available",
                                solution="Do not attempt to download it"
                            ))

                except CustomException as e:
                    raise e
                except:
                    pass
                raise

            response = playlist
            if collection_title is None:
                try:
                    collection_title = response["title"]
                    assert type(collection_title) is str and len(collection_title) > 0
                except:
                    collection_title = None

                if collection_title in ["", None]:
                    collection_title = f'Playlist_{playlist_id}'
                collection_title = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        joyn_de.__name__
                    ),
                    get_valid_filename(collection_title)
                )

            playlist_items = []
            if current_item is None:
                try:
                    current_item = response["currentPlaylistItem"]
                    assert type(current_item) is dict
                    playlist_items = [current_item]
                except:
                    current_item = {}
                    playlist_items = []

            try:
                items = response["remainingPlaylistItems"]
                assert type(items) is list and len(items) > 0
                playlist_items += items
                skip_flag = False
            except:
                skip_flag = True

            for playlist_item in playlist_items:
                item_index += 1
                check = check_range(False, None, item_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                playlist_item = playlist_item["asset"]
                item_url = joyn_de.get_content_url(playlist_item)
                if item_url in visited:
                    continue
                visited.append(item_url)

                try:
                    item_id = playlist_item["video"]["id"]
                    assert type(item_id) is str and len(item_id) > 0
                except:
                    continue

                try:
                    item_title = playlist_item["title"]
                    assert type(item_title) is str and len(item_title) > 0
                except:
                    item_title = item_url.split("/")
                clip_title = get_valid_filename(f'Item_{item_index} {item_title}')

                collection.append(BaseElement(
                    url=item_url,
                    collection=collection_title,
                    element=clip_title,
                    additional={"asset_id": item_id}
                ))

            if skip_flag or len(playlist_items) == 0:
                break
            item_offset += len(playlist_items)
        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        if "/live-tv" not in collection_url:
            collection_url = clean_url(collection_url).rstrip("/")
        elif "channel_id=" not in collection_url:
            return joyn_de.handle_live_list(clean_url(collection_url).rstrip("/"))

        if "/play/" in collection_url:
            if "/playlist/" in collection_url:
                return joyn_de.handle_playlist(collection_url)
            return [BaseElement(url=collection_url)]

        if "/serien/" in collection_url:
            return joyn_de.handle_serien(collection_url)
        if "/compilation/" in collection_url:
            return joyn_de.handle_compilation(collection_url)
        return None
