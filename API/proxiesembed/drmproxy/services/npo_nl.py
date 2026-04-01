import builtins
import json
import re
import time
from os.path import join

import browser_cookie3
import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, get_ext_from_url


class npo_nl(BaseService):
    DEMO_URLS = [
        "https://npo.nl/npo3/undercover-sven/POMS_S_KN_20188850",
        "https://npo.nl/npo3/qucee-zoekt-cash/POMS_S_KN_16983903",
        "https://npo.nl/npo3/3-op-reis/10-05-2024/BV_101410427/POMS_BV_20193871",
        "https://npo.nl/npo3/houda-34-verdoofde-met-binge-eating-haar-gevoelens-de-bovenkamer-4-npo3/29-04-2024/WO_BV_20190951",
        "https://npo.nl/start/serie/dit-was-het-nieuws",
        "https://npo.nl/start/serie/powned-of-view",
        "https://npo.nl/start/serie/de-lama-s",
        "https://npo.nl/start/serie/hunted",
        "https://npo.nl/start/video/kom-hier-dat-ik-u-kus",
        "https://npo.nl/start/video/het-leven-is-vurrukkulluk",
        "https://npo.nl/start/serie/op1/seizoen-5/op1_505/afspelen",
        "https://npo.nl/start/serie/het-mooiste-meisje-van-de-klas/seizoen-16/femke/afspelen",
    ]

    STREAM_URL = 'https://prod.npoplayer.nl/stream-link'
    BASE_URL = 'https://npo.nl'
    TOKEN_URL = f'{BASE_URL}/start/api/domain/player-token'
    TICKETS_URL = f'{BASE_URL}/npo3/video_tickets'
    LICENSE_URL = 'https://npo-drm-gateway.samgcloud.nepworldwide.nl/authentication'

    LOGIN_COOKIES = None
    LICENSE_RETRIES = 3

    @staticmethod
    def test_service():
        main_service.run_service(npo_nl)

    @staticmethod
    def get_additional_params(additional):
        return [("MUXER", lambda s: s.format(args="mkv:muxer=mkvmerge"))]

    @staticmethod
    def credentials_needed():
        return {
            "OPTIONAL": True,
            "FIREFOX_COOKIES": True
        }

    @staticmethod
    def get_login_cookies():
        cookie_dict = {}
        try:
            for c in browser_cookie3.firefox(domain_name='npo.nl'):
                if c.name.lower().startswith("npoid."):
                    continue
                cookie_dict[c.name] = c.value
        except browser_cookie3.BrowserCookieError:
            pass

        try:
            assert len(cookie_dict.keys()) > 0
            return cookie_dict
        except:
            return {}

    @staticmethod
    def initialize_service():
        if npo_nl.LOGIN_COOKIES is None:
            npo_nl.LOGIN_COOKIES = npo_nl.get_login_cookies()
        return npo_nl

    @staticmethod
    def get_keys(challenge, additional):
        licence = None
        for i in range(1, npo_nl.LICENSE_RETRIES + 1):
            try:
                licence = requests.post(
                    npo_nl.LICENSE_URL,
                    params={'custom_data': additional["custom_data"]},
                    data=challenge
                )
                licence.raise_for_status()
                break
            except Exception as e:
                response = e.response
                if response.status_code == 500:
                    if i < npo_nl.LICENSE_RETRIES:
                        time.sleep(1)
                        continue

                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=additional["URL"],
                        reason='You requested too much content recently',
                        solution="Wait 1 minute"
                    ))
                raise e

        return licence.content

    @staticmethod
    def get_json_content(source_text):
        for start_char, end_char in [("{", "}")]:
            start_str = f'type="application/json">{start_char}'
            start_index = source_text.find(start_str)
            if start_index == -1:
                continue

            opening_brackets = 0
            start_index += len(start_str) - 1

            text_len = len(source_text)
            for char_index in range(start_index, text_len):
                if source_text[char_index] == start_char:
                    opening_brackets += 1
                elif source_text[char_index] == end_char:
                    opening_brackets -= 1
                    if opening_brackets == 0:
                        json_object = json.loads(source_text[start_index:char_index + 1])
                        return json_object
        return None

    @staticmethod
    def get_video_data_npo3(source_element):
        if "_" not in source_element.url:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Video not found. URL not supported",
                solution=f"Extend the {npo_nl.__name__} service"
            ))

        mid = None
        for p in list(reversed(source_element.url.split("/"))):
            if "_" in p:
                mid = p
                break

        response = requests.post(
            npo_nl.TICKETS_URL,
            params={'mid': mid},
            json={
                'data': {
                    'elementId': 'elementId',
                    'sterSiteId': 'npo3',
                    'hasAdConsent': '1',
                    'sterIdentifier': 'npo3-desktop'
                }
            }
        )
        response = response.content.decode()
        response = re.search(r"= '(ey[^/']+)'", response).group(1)

        response = json.loads(requests.post(
            npo_nl.STREAM_URL,
            headers={'Authorization': response},
            json={
                'profileName': 'dash',
                'drmType': 'widevine',
                'referrerUrl': source_element.url,
                'ster': {
                    'identifier': 'npo-app-desktop',
                    'player': 'web'
                }
            }
        ).content.decode())
        return response

    @staticmethod
    def get_video_data(source_element):
        if "/npo3/" in source_element.url:
            response = npo_nl.get_video_data_npo3(source_element)
        else:
            response = requests.get(source_element.url).content.decode()
            response = npo_nl.get_json_content(response)

            response = response["props"]["pageProps"]
            for k in response:
                if "state" in k.lower():
                    response = response[k]
                    break

            slug = None
            if "/afspelen" in source_element.url:
                slug = source_element.url.split("/afspelen")[0].split("/")[-1]
            elif "/video/" in source_element.url:
                slug = source_element.url.split("/video")[1].split("/")[-1]

            for query in response["queries"]:
                data = query["state"]["data"]

                if type(data) is not list:
                    data = [data]

                for d in data:
                    if d.get('slug', None) is None:
                        continue

                    if d["slug"] == slug and type(d["productId"]) is str:
                        try:
                            d["programKey"]
                        except:
                            continue

                        response = d["productId"]
                        break
                else:
                    continue
                break

            if type(response) is not str:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available anymore",
                    solution="Do not attempt to download it"
                ))

            response = json.loads(requests.get(
                npo_nl.TOKEN_URL,
                cookies=npo_nl.LOGIN_COOKIES,
                params={'productId': response}
            ).content.decode())["jwt"]

            response = json.loads(requests.post(
                npo_nl.STREAM_URL,
                cookies=npo_nl.LOGIN_COOKIES,
                headers={'Authorization': response},
                json={
                    'profileName': 'dash',
                    'drmType': 'widevine',
                    'referrerUrl': source_element.url,
                    'ster': {
                        'identifier': 'npo-app-desktop',
                        'player': 'web'
                    }
                }
            ).content.decode())

        status_code = response.get("code", response.get("status", None))
        if status_code in [401, 451]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Dutch IP to access content (and in this case, even to download it)",
                solution="Use a VPN"
            ))

        if "npo plus" in response.get("body", "").lower() or status_code in [402]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Cannot download paid content",
                solution="Do not attempt to download paid content"
            ))

        if source_element.element is None:
            name = response["metadata"]["title"]
            # if "/npo3/" in source_element.url:
            #     name += "_" + response["metadata"]["prid"]
            source_element.element = get_valid_filename(name)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                npo_nl.__name__
            )
        additional = {"URL": source_element.url}

        subtitles = []
        index = 0
        assets = []
        if response["assets"].get("subtitles", None) is not None:
            assets = response["assets"]["subtitles"]

        for subtitle in assets:
            index += 1
            url = subtitle["location"]
            srt_ext = get_ext_from_url(url)

            subtitles.append((False, BaseElement(
                url=url,
                collection=join(source_element.collection, source_element.element),
                element=f'subtitle_{index}_{subtitle["iso"].lower()}{srt_ext}'
            )))
        additional["SUBTITLES"] = subtitles

        manifest = response["stream"]["streamURL"]
        manifest_response = None
        try:
            manifest_response = requests.get(manifest)
            if manifest_response.status_code < 200 or manifest_response.status_code >= 300:
                raise

            pssh_value = str(min(re.findall(
                r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                manifest_response.content.decode()
            ), key=len))
        except:
            pssh_value = None

        if manifest_response is not None and manifest_response.status_code == 403:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason=f"The VPN was detected",
                solution="Use a better VPN"
            ))

        if pssh_value is not None:
            additional["custom_data"] = response["stream"]["drmToken"]
        # if builtins.CONFIG.get("BASIC", False) is True:
        #    manifest = re.sub(r'/eyJ[^/]*/', '/<TOKEN_TIED_TO_IP>/', manifest)
        return manifest, pssh_value, additional

    @staticmethod
    def npo_start_broadcasts_handler(url, response):
        contents = []
        for page_query in response["queries"]:
            data = page_query["state"]["data"]
            if type(data) is not list:
                continue

            for d in data:
                contents.append((
                    get_valid_filename(d.get("title", d["slug"])),
                    f'{url}/{d["season"]["slug"]}/{d["slug"]}/afspelen'
                ))

        # contents = list(reversed(contents))
        contents = [(index + 1, v1, v2) for index, (v1, v2) in enumerate(contents)]

        collection = []
        collection_name = get_valid_filename(url.split("/serie/")[1].split("/")[0])

        for content_index, content_title, content_url in contents:
            check = check_range(False, None, content_index)
            if check is True:
                continue
            elif check is False:
                return collection

            collection.append(BaseElement(
                url=content_url,
                collection=join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        npo_nl.__name__
                    ),
                    collection_name
                ),
                element=f"{content_index}"
                        f'_'
                        f"{content_title}"
            ))
        return collection

    @staticmethod
    def get_collection_elements_npo3(collection_url):
        collection_name = get_valid_filename(collection_url.split("/npo3/")[1].split("/")[0])
        if not collection_url.endswith("/"):
            collection_url = collection_url + "/"

        collection = []
        visited = []
        content_index = 0
        page = 0
        while True:
            page += 1
            response = requests.get(f'{collection_url}lists/all/{page}').content.decode()

            soup = BeautifulSoup(response, 'html5lib')
            links = soup.find_all(
                'a', class_='is-full-link',
                href=lambda href: href and href.startswith('/npo3/') and "_" in href
            )

            if len(links) == 0:
                break
            if links[0]["href"] in visited:
                break

            for link in links:
                content_index += 1
                check = check_range(False, None, content_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                visited.append(link["href"])
                content_title = get_valid_filename(link["href"].split("/npo3/")[1].split("/")[0])
                collection.append(BaseElement(
                    url=npo_nl.BASE_URL + link["href"],
                    collection=join(
                        join(
                            str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                            npo_nl.__name__
                        ),
                        collection_name
                    ),
                    element=f"{content_index}"
                            f'_'
                            f"{content_title}"
                ))

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        if "/npo3/" in collection_url:
            if collection_url.split("/npo3/")[1].count("/") >= 2:
                return [BaseElement(url=collection_url)]
            return npo_nl.get_collection_elements_npo3(collection_url)

        if "/start/" not in collection_url:
            return None

        if "/afspelen" in collection_url or "/video/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/seizoen-" in collection_url:
            return None

        if "/serie/" in collection_url:
            collection = []
            collection_name = get_valid_filename(collection_url.split("/serie/")[1].split("/")[0])
            response = requests.get(collection_url).content.decode()
            response = npo_nl.get_json_content(response)

            response = response["props"]["pageProps"]
            for k in response:
                if "state" in k.lower():
                    response = response[k]
                    break

            seasons = []
            for page_query in response["queries"]:
                data = page_query["state"]["data"]
                if type(data) is not list:
                    continue

                for d in data:
                    if d.get("seasonKey", None) is None:
                        continue
                    seasons.append((
                        int(d["seasonKey"]),
                        f'{collection_url}/{d["slug"]}',
                        d["label"]
                    ))

            if len(seasons) == 0:
                return npo_nl.npo_start_broadcasts_handler(collection_url, response)

            seasons = sorted(seasons, key=lambda s: s[0])
            seasons = [(index + 1, v1, v2) for index, (_, v1, v2) in enumerate(seasons)]

            for season_index, season_url, season_name in seasons:
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                response = requests.get(season_url).content.decode()
                response = npo_nl.get_json_content(response)

                response = response["props"]["pageProps"]
                for k in response:
                    if "state" in k.lower():
                        response = response[k]
                        break

                episodes = []
                for season_query in response["queries"]:
                    data = season_query["state"]["data"]
                    if type(data) is not list:
                        continue

                    for d in data:
                        if d.get("programKey", None) is None:
                            continue

                        episodes.append((
                            int(d["programKey"]),
                            f'{season_url}/{d["slug"]}/afspelen',
                            d["title"]
                        ))

                episodes = sorted(episodes, key=lambda s: s[0])
                episodes = [(index + 1, v1, v2) for index, (_, v1, v2) in enumerate(episodes)]

                for episode_index, episode_url, episode_name in episodes:
                    check = check_range(False, season_index, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(
                            join(
                                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                npo_nl.__name__
                            ),
                            join(collection_name, f'Season_{season_index}')
                        ),
                        element=f"Episode_{episode_index}"
                                f'_'
                                f"{get_valid_filename(episode_name)}"
                    ))

            return collection
        return None
