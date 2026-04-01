import builtins
import json
import re
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class tf1_fr(BaseService):
    DEMO_URLS = [
        "https://www.tf1.fr/tf1/gladiators/videos/extract",
        "https://www.tf1.fr/tf1/les-freres-scott/videos",
        "https://www.tf1.fr/tf1/les-bracelets-rouges/videos/extract",
        "https://www.tf1.fr/tmc/les-mysteres-de-l-amour/videos",
        "https://www.tf1.fr/tf1/gladiators/videos",
        "https://www.tf1.fr/tmc/quotidien-avec-yann-barthes/videos/invites-fanny-ardant-et-thierry-klifa-rois-de-la-piste-et-de-larnaque-85679919.html",
        "https://www.tf1.fr/tmc/la-mode-by-loic-prigent/videos/5-minutes-de-mode-by-loic-prigent-du-8-mars-2024-73931950.html",
        "https://www.tf1.fr/tf1/double-zero/videos/double-zero-70592950.html",
    ]

    LOGIN_URL = 'https://compte.tf1.fr/accounts.login'
    TOKEN_URL = 'https://www.tf1.fr/token/gigya/web'
    MEDIAINFO_URL = 'https://mediainfo.tf1.fr/mediainfocombo/{media_id}'
    PLAYER_URL = 'https://prod-player.tf1.fr'
    BASE_URL = 'https://www.tf1.fr'
    LICENSE_URL = "https://widevine-proxy-m.prod.p.tf1.fr/proxy"

    EMAIL = "YOUR_EMAIL"
    PASSWORD = "YOUR_PASSWORD"
    BEARER_TOKEN = None
    API_KEY, CONSENT_IDS, PLAYER_VERSION = None, None, None

    @staticmethod
    def test_service():
        main_service.run_service(tf1_fr)

    @staticmethod
    def credentials_needed():
        return {
            "EMAIL": tf1_fr.EMAIL,
            "PASSWORD": tf1_fr.PASSWORD
        }

    @staticmethod
    def format_version(version):
        major, minor, patch = map(int, version.split('.'))
        return str(major * 1000000 + minor * 1000 + patch)

    @staticmethod
    def get_tf1_info():
        response = requests.get(tf1_fr.BASE_URL).content.decode().replace('\\"', '"')
        api_key = re.findall(r'"apiKey":"([^"]+)"', response)[0]
        consent_ids = re.findall(r'neededConsentIds":\[(.*?)]', response)[0].replace("\"", "").split(",")

        player_version = re.findall(
            rf'"playerEndpoint":"{tf1_fr.PLAYER_URL}/","version":"([^"]+)"', response
        )[0]
        return api_key, consent_ids, tf1_fr.format_version(player_version)

    @staticmethod
    def get_bearer_token():
        class_name = tf1_fr.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            assert type(credentials["EMAIL"]) is str
            assert type(credentials["PASSWORD"]) is str
        except:
            return None

        response = json.loads(requests.post(
            tf1_fr.LOGIN_URL,
            data={
                "loginID": credentials["EMAIL"],
                "password": credentials["PASSWORD"],
                "APIKey": tf1_fr.API_KEY
            }
        ).content.decode())

        status_code = response.get('statusCode', None)
        if status_code != 200:
            if status_code == 403:
                return None
            raise CustomException(ERR_MSG.format(
                type=f'{APP_ERROR}',
                url=f"from the {tf1_fr.__name__} service",
                reason=f"Unknown error encountered: {str(response)}",
                solution="Debug the service"
            ))

        return json.loads(requests.post(
            tf1_fr.TOKEN_URL,
            json={
                'uid': response["UID"], 'signature': response["UIDSignature"],
                'timestamp': int(response["signatureTimestamp"]),
                'consent_ids': tf1_fr.CONSENT_IDS
            }
        ).content.decode())["token"]

    @staticmethod
    def initialize_service():
        if tf1_fr.API_KEY is None or tf1_fr.CONSENT_IDS is None or tf1_fr.PLAYER_VERSION is None:
            tf1_fr.API_KEY, tf1_fr.CONSENT_IDS, tf1_fr.PLAYER_VERSION = tf1_fr.get_tf1_info()
        if tf1_fr.BEARER_TOKEN is None:
            tf1_fr.BEARER_TOKEN = tf1_fr.get_bearer_token()
            if tf1_fr.BEARER_TOKEN is None:
                return None
        return tf1_fr

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(tf1_fr.LICENSE_URL, data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        matches = re.findall(
            r'"embedUrl":"([^"]+)"', requests.get(source_element.url).content.decode()
        )
        match = [m for m in matches if "/player/" in m]
        if len(match) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Content isn't available anymore",
                solution="Do not attempt to download it"
            ))

        media_id = re.findall(r'/player/([^/]+)', match[0])[0]
        response = requests.get(
            tf1_fr.MEDIAINFO_URL.format(media_id=media_id),
            params={'pver': tf1_fr.PLAYER_VERSION, 'context': 'context'},
            headers={'authorization': f'Bearer {tf1_fr.BEARER_TOKEN}'}
        )

        response = response.content.decode()
        if "geoblocked" in response.lower():
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need French IP to access content",
                solution="Use a VPN"
            ))
        response = json.loads(response)
        if (response.get("delivery", {}).get("code", None) == 4034 or
                "permission_denied" in response.get("media", {}).get("error_code", "").lower()):
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Premium content can't be downloaded",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            source_element.element = get_valid_filename(response.get("media", {}).get("title", media_id))
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                tf1_fr.__name__
            )

        manifest = response["delivery"]["url"]
        try:
            pssh_value = str(min(re.findall(
                r'<cenc:pssh>(.+?)</cenc:pssh>',
                requests.get(manifest).content.decode()
            ), key=len))
        except:
            pssh_value = None

        if builtins.CONFIG.get("BASIC", False) is True:
            manifest = re.sub(r'/eyJ[^/]*/', '/<TOKEN>/', manifest)
        return manifest, pssh_value, {}

    @staticmethod
    def get_episode_index(label):
        if label is None or len(label) == 0:
            return None
        label = label.lower()
        label = re.sub(r'\s+', ' ', label)
        label = label.replace(' ', "_")
        for s in ["e", "pisode_", "pisodes_", "part_", "emission_"]:
            try:
                return int(re.findall(fr'{s}(\d+)', label)[0])
            except:
                if s == "emission_" and "emission_" in label:
                    return 1
        return None

    @staticmethod
    def get_collection_elements(collection_url):
        if "/playlist" in collection_url:
            return None
        if "/videos/" in collection_url and ".html" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/videos" in collection_url:
            collection = []
            try:
                section = re.search(r"/videos/([^/?]*)", collection_url).group(1)
            except:
                section = None

            response = requests.get(collection_url).content.decode()
            collection_name = re.search(r"([^/]+)/videos", collection_url).group(1)
            collection_name = get_valid_filename(collection_name)

            re_href = 'href="'
            re_href += re.search(fr"{tf1_fr.BASE_URL}(.*?)/videos", collection_url).group(1)
            re_href += "/videos/"

            if section is not None and len(section) > 0:
                collection_name = collection_name + "_" + section
                collection_name = get_valid_filename(collection_name)

                matches = re.findall(fr'({re_href}.*?\.html)"[^>]*><div[^>]*>([^<]+)</div>', response)
                if len(matches) == 0:
                    matches = re.findall(fr'({re_href}.*?\.html)"[^>]*>([^<]+)<', response)

                matches = [(
                    tf1_fr.BASE_URL + m[0].split('"')[1], m[1]
                ) for m in matches]
                matches = [(*value, index + 1) for index, value in enumerate(matches)]

                for content_url, content_name, content_index in matches:
                    check = check_range(False, None, content_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=content_url,
                        collection=join(join(
                            str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                            tf1_fr.__name__
                        ), collection_name),
                        element=f'{content_index}'
                                f'_'
                                f'{get_valid_filename(content_name)}'
                    ))
                return collection

            re_href += "saison-"
            matches = re.findall(fr'{re_href}\d+"', response)
            matches = [m.split('"')[1] for m in matches]
            matches = [(
                f'{tf1_fr.BASE_URL}{m}', int(m.split("/videos/saison-")[1])
            ) for m in matches]
            matches = sorted(matches, key=lambda m: m[1])

            re_href = re_href.replace("saison-", "")
            for season_url, season_index in matches:
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                page = 0
                while True:
                    page += 1
                    if page > 1:
                        response = requests.get(f'{season_url}/{page}', allow_redirects=False)
                        try:
                            assert 300 <= response.status_code < 400
                            assert len(response.headers["Location"]) > 0
                            assert response.headers["Location"] in season_url
                            break
                        except:
                            pass
                    else:
                        response = requests.get(f'{season_url}/{page}')

                    response = response.content.decode()
                    matches = re.findall(fr'({re_href}.*?\.html)"[^>]*><div[^>]*>([^<]+)</div>', response)
                    if len(matches) == 0:
                        matches = re.findall(fr'({re_href}.*?\.html)"[^>]*>([^<]+)<', response)

                    matches = [(
                        tf1_fr.BASE_URL + m[0].split('"')[1],
                        m[1],
                        tf1_fr.get_episode_index(m[1])
                    ) for m in matches]
                    matches = [m for m in matches if m[2] is not None]

                    for episode_url, episode_name, episode_index in matches:
                        check = check_range(False, season_index, episode_index)
                        if check in [True, False]:
                            continue

                        collection.append(BaseElement(
                            url=episode_url,
                            collection=join(
                                join(
                                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                    tf1_fr.__name__
                                ),
                                join(collection_name, f'Season_{season_index}')
                            ),
                            element=f"Episode_{episode_index}"
                                    f"_"
                                    f"{get_valid_filename(episode_name)}"
                        ))

                    if len(matches) == 0:
                        break

            return collection
        return None
