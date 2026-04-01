import builtins
import json
import re
from os.path import join

import browser_cookie3
import requests
from bs4 import BeautifulSoup

from utils.constants.macros import USER_ERROR, ERR_MSG, APP_ERROR, REQUESTS_TIMEOUT
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, get_ext_from_url, clean_url


class rtlplay_be(BaseService):
    DEMO_URLS = [
        "https://www.rtlplay.be/rtlplay/player/7f0e4189-2fbd-420a-b9a6-ba2427313bc2",
        "https://www.rtlplay.be/rtlplay/player/d0e99c40-1615-49de-a673-4f5080e56d74",
        "https://www.rtlplay.be/rtlplay/night-shift~73788600-5c11-4bd0-8001-2ac03a2c606d",
        "https://www.rtlplay.be/rtlplay/un-gars-une-fille~988763d8-30ce-418c-9cab-022f0a4bef45",
        "https://www.rtlplay.be/rtlplay/the-girlfriend-experience~7d95ecee-a8cf-45e2-be49-f2900cbe705b",
        "https://www.rtlplay.be/rtlplay/direct",
        "https://www.rtlplay.be/rtlplay/direct/tvi",
        "https://www.rtlplay.be/rtlplay/direct/contact",
    ]

    CONFIG_URL = 'https://videoplayer-service.dpgmedia.net/play-config/{content_id}'
    VIDEO_URL = "https://www.rtlplay.be/rtlplay/player/{video_id}"
    BASE_URL = "https://www.rtlplay.be/rtlplay"

    LOGIN_COOKIES = None
    USER_AGENT = None
    POPCORN_SDK = '8'

    @staticmethod
    def test_service():
        main_service.run_service(rtlplay_be)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/direct/" in content and "/player/" not in content

    @staticmethod
    def credentials_needed():
        return {"FIREFOX_COOKIES": True}

    @staticmethod
    def get_login_cookies():
        cookie_dict = {}
        for c in browser_cookie3.firefox(domain_name='rtlplay.be'):
            cookie_dict[c.name] = c.value

        try:
            assert len(cookie_dict.keys()) > 0
            assert cookie_dict["lfvp_auth_token"] is not None
            return cookie_dict
        except:
            return None

    @staticmethod
    def get_site_data(site_url, is_livestream):
        with requests.Session() as session:
            response = session.get(
                site_url, cookies=rtlplay_be.LOGIN_COOKIES, allow_redirects=False
            ).content.decode()

            try:
                api_key = re.search(r'apiKey: "([^"]*)"', response).group(1)
            except:
                api_key = None

            try:
                token = re.search(r'token: "([^"]*)"', response).group(1)
            except:
                token = None

            if is_livestream:
                for r1, r2 in [(r"playerData\s*=", "assetId"), (r"channel\s*:", "id")]:
                    try:
                        content_id = re.search(r1 + "[^{}]+{([^{}]+)}", response).group(1)
                        content_id = re.search(r2 + "[^\"']+[\"']([^\"']+)[\"']", content_id).group(1)
                        assert len(content_id) > 0
                        break
                    except:
                        content_id = None
            else:
                content_id = re.search(r"/player/([^/?]*)", site_url).group(1)
        return api_key, token, content_id

    @staticmethod
    def initialize_service():
        if rtlplay_be.USER_AGENT is None:
            rtlplay_be.USER_AGENT = builtins.CONFIG["USER_AGENT"]

        if rtlplay_be.LOGIN_COOKIES is None:
            rtlplay_be.LOGIN_COOKIES = rtlplay_be.get_login_cookies()
            if rtlplay_be.LOGIN_COOKIES is None:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=f'from {rtlplay_be.__name__}',
                    reason='Need account for this service',
                    solution='Sign into your account using Firefox'
                ))

        return rtlplay_be

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"], data=challenge,
            headers={"x-dt-auth-token": additional["auth_token"]}
        )
        licence.raise_for_status()
        return json.loads(licence.content.decode())["license"]

    @staticmethod
    def get_video_data(source_element):
        is_livestream = "/direct/" in source_element.url and "/player/" not in source_element.url
        api_key, bearer_token, content_id = rtlplay_be.get_site_data(source_element.url, is_livestream)
        if bearer_token is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}/{APP_ERROR}',
                url=source_element.url,
                reason='This content is no longer available or refresh the site cookies or VPN issues (Belgium)',
                solution='Do not attempt to download it or sign into your account using Firefox and play a '
                         'random video or fix your VPN. If it persists then debug the service'
            ))
        if api_key is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}/{APP_ERROR}',
                url=f'from {rtlplay_be.__name__}',
                reason='Refresh the site cookies',
                solution='Sign into your account using Firefox and play a random video. '
                         'If it persists then debug the service'
            ))

        try:
            response = requests.post(
                rtlplay_be.CONFIG_URL.format(content_id=content_id),
                json={'deviceType': 'web', 'zone': 'rtlplay'},
                headers={
                    'User-Agent': rtlplay_be.USER_AGENT,
                    'x-api-key': api_key,
                    'popcorn-sdk-version': rtlplay_be.POPCORN_SDK,
                    'authorization': f'Bearer {bearer_token}'
                },
                timeout=REQUESTS_TIMEOUT
            )

            if response.status_code == 403:
                raise
        except:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Timeout most likely due to fake user agent",
                solution='Use your real user agent'
            ))

        response = json.loads(response.content.decode())
        if response.get("code", None) == 103 and "available" in response.get("type", "").lower():
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't download paid content",
                solution='Do not attempt to download it'
            ))
        if response.get("code", None) == 104 and "found" in response.get("type", "").lower():
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="This content is no longer available",
                solution='Do not attempt to download it'
            ))

        response = response["video"]
        if source_element.element is None:
            metadata = response.get("metadata", {})
            source_element.element = get_valid_filename((
                f'{metadata.get("program", {}).get("title", "Livestream" if is_livestream else "Movie")}'
                f'_'
                f'{metadata.get("title", source_element.url.split("/")[-1] if is_livestream else content_id)}'
            ))
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rtlplay_be.__name__
            )

        additional = {}
        manifest = None
        is_drm = True
        for stream in response["streams"]:
            if stream["type"] != "dash" or ".mpd" not in stream["url"]:
                continue
            manifest = stream["url"]

            drm = stream.get("drm", None)
            if drm is None:
                is_drm = False
                break

            for k in drm:
                if "widevine" in k.lower():
                    drm = drm[k]
                    break

            additional["license_url"] = drm["licenseUrl"]
            additional["auth_token"] = drm["drmtoday"]["authToken"]
            break

        subtitles = []
        index = 0
        for subtitle in response.get("subtitles", []):
            index += 1
            srt_ext = get_ext_from_url(subtitle["url"])

            subtitles.append((False, BaseElement(
                url=subtitle["url"],
                collection=join(source_element.collection, source_element.element),
                element=f'subtitle_{index}_{subtitle["language"]}{srt_ext}'
            )))
        additional["SUBTITLES"] = subtitles

        try:
            if not is_drm:
                raise
            pssh_value = str(min(re.findall(
                r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                requests.get(manifest).content.decode()
            ), key=len))
        except:
            pssh_value = None
        return manifest, pssh_value, additional

    @staticmethod
    def get_episode_index(label):
        if label is None or len(label) == 0:
            return None
        label = label.lower()
        label = re.sub(r'\s+', ' ', label)
        label = label.replace(' ', "_")
        for r in ["pisode_(\\d+)", "(\\d+)\\.", "-_(\\d+)", "\\d+"]:
            try:
                return int(re.findall(r, label)[0])
            except:
                pass
        return None

    @staticmethod
    def handle_live_list(collection_url):
        collection = []
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rtlplay_be.__name__
            ),
            get_valid_filename(collection_url.split("/")[-1] + " livestreams")
        )

        with requests.Session() as session:
            response = session.get(collection_url, cookies=rtlplay_be.LOGIN_COOKIES).content.decode()
            livestreams = re.findall(r'href="([^"]+rtlplay.be/rtlplay/direct/[^"]+)"', response)
            if len(livestreams) == 0:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}/{APP_ERROR}',
                    url=f'from {rtlplay_be.__name__}',
                    reason='Refresh the site cookies',
                    solution='Sign into your account using Firefox and play a random video. '
                             'If it persists then debug the service'
                ))

            live_index = 0
            for livestream in livestreams:
                live_index += 1
                check = check_range(False, None, live_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                collection.append(BaseElement(
                    url=livestream,
                    collection=collection_title,
                    element=get_valid_filename(f"Channel {live_index} {livestream.split('/')[-1]}")
                ))
        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url).rstrip("/")
        if "/rtlplay/" not in collection_url:
            return None
        if "/player/" in collection_url or "/direct/" in collection_url:
            return [BaseElement(url=collection_url)]
        if collection_url.endswith("/direct"):
            return rtlplay_be.handle_live_list(collection_url)

        if collection_url.split(rtlplay_be.BASE_URL)[1].count("/") == 1 and "~" in collection_url:
            collection = []
            series_id = collection_url.split("~")[1]
            response = requests.get(collection_url, cookies=rtlplay_be.LOGIN_COOKIES).content.decode()

            matches = re.findall(r'"detail__title"[^>]*>([^<]+)</', response)
            if len(matches) > 0:
                collection_name = matches[0]
            else:
                collection_name = series_id
            collection_name = get_valid_filename(collection_name)

            matches = re.findall(fr'href="({collection_url}/saison-\d+)["#]', response)
            matches = [(m, int(m.split("/saison-")[1])) for m in matches]
            matches = sorted(matches, key=lambda m: m[1])

            indexes = []
            seasons = []
            for season_url, season_index in matches:
                if season_index in indexes:
                    continue
                indexes.append(season_index)
                seasons.append((season_url, season_index))

            for season_url, season_index in seasons:
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                response = requests.get(season_url, cookies=rtlplay_be.LOGIN_COOKIES).content.decode()
                soup = BeautifulSoup(response, 'html5lib')
                episodes_soup = soup.find_all(attrs={'class': 'detail__season'})[0]
                episodes_soup = episodes_soup.find_all(attrs={'class': 'list__item'})

                episodes = []
                for episode_soup in episodes_soup:
                    episode_soup = episode_soup.find_all(attrs={'class': 'media'})
                    if len(episode_soup) == 0:
                        continue
                    episode_soup = episode_soup[0]

                    episode_name = episode_soup.find_all(attrs={'class': 'media__title'})[0]
                    try:
                        temp_url = episode_name.find_all(attrs={'id': True})[0]['id']
                        temp_url = temp_url[temp_url.index("-") + 1:]
                        temp_url = rtlplay_be.VIDEO_URL.format(video_id=temp_url)
                    except:
                        temp_url = None

                    try:
                        temp_name = episode_name.find_all('span')[0].find(text=True, recursive=False).strip()
                        assert len(temp_name) > 0
                    except:
                        temp_name = None

                    if temp_name is None:
                        episode_name = episode_name.find(text=True, recursive=False).strip()
                    else:
                        episode_name = temp_name
                    episode_index = rtlplay_be.get_episode_index(episode_name)

                    try:
                        episode_url = episode_soup.find_all(attrs={'class': 'media__figure-link'})[0]
                        episode_url = episode_url["href"]
                        assert "/player/" in episode_url
                    except:
                        episode_url = temp_url
                    episodes.append((episode_url, episode_name, episode_index))

                episodes = sorted(episodes, key=lambda m: m[2])
                index = 0
                duplicates = []
                for episode_url, episode_name, episode_index in episodes:
                    check = check_range(False, season_index, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection
                    if episode_url is None:
                        continue

                    if episode_name in duplicates:
                        index += 1
                        index_name = "_" + str(index)
                    else:
                        duplicates.append(episode_name)
                        index_name = ""

                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(
                            join(
                                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                rtlplay_be.__name__
                            ),
                            join(collection_name, f'Season_{season_index}')
                        ),
                        element=f"Episode_{episode_index}"
                                f"_"
                                f"{get_valid_filename(episode_name)}"
                                f"{index_name}"
                    ))

            return collection
        return None
