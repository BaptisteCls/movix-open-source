import builtins
import json
import re
from os.path import join

import browser_cookie3
import requests

import utils.tools.common as common_tools
from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range


class nba_com(BaseService):
    DEMO_URLS = [
        "https://www.nba.com/watch/list/collection/skills-drills",
        "https://www.nba.com/watch/list/collection/coaches-corner",
        # Without account
        "https://www.nba.com/watch/video/game-recap-lakers-120-timberwolves-109",
        "https://www.nba.com/watch/video/the-fast-break-mar-10-2",
        "https://www.nba.com/watch/video/game-recap-wizards-110-heat-108",
        "https://www.nba.com/game/hou-vs-ind-0022300719?watchRecap=true",
        "https://www.nba.com/game/mil-vs-lac-0022300924?watchRecap=true",
        "https://www.nba.com/game/ind-vs-orl-0022300928?watchRecap=true",
        # With (free) account
        "https://www.nba.com/watch/video/2016-dunk-contest-lavine-vs-gordon-best-ever",
        "https://www.nba.com/watch/video/2-27-2023-banchero-takes-over-in-clutch-vs-pels",
        "https://www.nba.com/watch/video/12-7-23-haliburton-shines-in-in-season-tournament",
    ]

    OPTIONS_URL = 'https://ottapp-appgw-client.nba.com/S1/subscriber/{path}/{program_id}/play-options'
    ROLL_URL = 'https://ottapp-appgw-amp.nba.com/v1/client/roll'
    STS_URL = 'https://identity.nba.com/api/v1/sts'
    VIDEO_URL = 'https://www.nba.com/watch/video/{slug}'
    LICENSE_URL = "https://ottapp-appgw-amp.nba.com/v1/client/get-widevine-license"

    AUTH_TOKEN = None
    AZUKI_IMC = "IMC7.2.0_AN_D3.0.0_S0"
    DEVICE_PROFILE = "eyJtb2RlbCI6IkRlc2t0b3AiLCJvc1ZlcnNpb24iOiIxMCIsInZlbmRvck5hbWUiOiJNaWNyb3NvZnQiLCJvc05hbWUiOiJIVE1MNSIsInd2TGV2ZWwiOiJMMyIsImRldmljZVVVSUQiOiJkZXZpY2VVVUlEIn0="

    @staticmethod
    def test_service():
        main_service.run_service(nba_com)

    @staticmethod
    def credentials_needed():
        return {
            "OPTIONAL": True,
            "FIREFOX_COOKIES": True
        }

    @staticmethod
    def get_auth_token():
        try:
            for c in browser_cookie3.firefox(domain_name='nba.com'):
                if "mediakindauth2token" in str(c):
                    return c.value
        except browser_cookie3.BrowserCookieError:
            pass
        return json.loads(requests.get(nba_com.STS_URL).content.decode())["data"]["AccessToken"]

    @staticmethod
    def initialize_service():
        if nba_com.AUTH_TOKEN is None:
            nba_com.AUTH_TOKEN = nba_com.get_auth_token()
        return nba_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            nba_com.LICENSE_URL, data=challenge,
            headers={
                "AuthorizationToken": nba_com.AUTH_TOKEN,
                'DeviceProfile': nba_com.DEVICE_PROFILE,
                'AzukiIMC': nba_com.AZUKI_IMC
            },
            params={
                "ownerUid": "azuki",
                "mediaId": additional["video_id"],
                "sessionId": "sessionId"
            }
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_pssh_info(base_uri, manifest_uri):
        manifest = f"{base_uri}/{manifest_uri}" + '&sessionId=sessionId'
        v_m3u8 = re.findall(r'^v.*?\.m3u8\?.*?$', requests.get(manifest).content.decode(), re.MULTILINE)[-1]
        v_m3u8 = f"{base_uri}/{manifest_uri.replace('index.m3u8', v_m3u8)}"
        pssh = re.search(r'base64,([^"]+)"', requests.get(v_m3u8).content.decode()).group(1)
        return manifest, pssh

    @staticmethod
    def get_program_info(source_url):
        response = requests.get(source_url).content.decode()
        title = json.loads(re.findall(
            r'type="application/json">(.*?)</script>', response
        )[0])['props']['pageProps']
        try:
            title = title['video']['title']
        except:
            title = title.get('game', {}).get('gameRecap', {}).get('title', None)

        if "/video/" in source_url:
            return "v3/programs", re.findall(
                r'"mediakindExternalProgramId":"([^"]*)"', response
            )[0], title
        if "/game/" in source_url:
            return "v2/events", max(re.findall(r'\d+', source_url), key=len), title
        return None, None, None

    @staticmethod
    def get_video_data(source_element):
        path, program_id, title = nba_com.get_program_info(source_element.url)
        title = common_tools.get_valid_filename(title)
        if title is None:
            title = program_id

        if source_element.element is None:
            source_element.element = title
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                nba_com.__name__
            )

        response = requests.get(
            nba_com.OPTIONS_URL.format(path=path, program_id=program_id),
            headers={'Authorization': f'OAUTH2 access_token="{nba_com.AUTH_TOKEN}"'},
            params={'IsexternalId': 'true'}
        ).content.decode()

        matches = re.findall(r'"Id":"([^"]*)"', response)
        video_id = sorted(
            [r for r in matches if "VIDEO" in r] if "VIDEO" in str(matches) else matches,
            key=len, reverse=True
        )[0]

        response = json.loads(requests.post(
            nba_com.ROLL_URL, data="{}",
            params={'ownerUid': 'azuki', 'mediaId': video_id, 'sessionId': 'sessionId'},
            headers={
                'AuthorizationToken': nba_com.AUTH_TOKEN,
                'AzukiIMC': nba_com.AZUKI_IMC,
                'DeviceProfile': nba_com.DEVICE_PROFILE
            }
        ).content.decode())

        if 'error' in response.get("result", ""):
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason='Need account for this content',
                solution='Sign into your account using Firefox'
            ))

        manifest, pssh = nba_com.get_pssh_info(
            response["response"]["cdns"]["cdn"][0]["base_uri"],
            response["response"]["manifest_uri"],
        )
        return manifest, pssh, {"video_id": video_id}

    @staticmethod
    def get_collection_elements(collection_url):
        if "/watch/video/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/game/" in collection_url and "?watchRecap=" in collection_url:
            return [BaseElement(url=collection_url)]

        collection_url = collection_url.rstrip("/")
        if "/watch/list/collection/" in collection_url:
            collection = []
            response = json.loads(re.findall(
                r'type="application/json"[^>]*>(.*?)</script>',
                requests.get(collection_url).content.decode()
            )[0])['props']['pageProps']

            collection_name = response.get("meta", {})
            collection_name = collection_name.get("title", collection_name.get("slug", None))
            if collection_name is None:
                collection_name = collection_url.split("/")[-1].split("?")[0]
            collection_name = join(
                join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    nba_com.__name__
                ),
                common_tools.get_valid_filename(collection_name)
            )

            videos = response.get("videos", [])
            if len(videos) == 0:
                return []

            video_index = 0
            for video in videos:
                video_index += 1
                check = check_range(False, None, video_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                video_title = video.get("title", video.get("name", video["slug"]))
                video_title = common_tools.get_valid_filename(video_title)

                collection.append(BaseElement(
                    url=nba_com.VIDEO_URL.format(slug=video["slug"]),
                    collection=collection_name,
                    element=f'{video_index}_{video_title}'
                ))

            return collection
        return None
