import builtins
import re
from html import unescape
from os.path import join

import browser_cookie3
import requests
from bs4 import BeautifulSoup
from chompjs import parse_js_object

from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class veeps_com(BaseService):
    DEMO_URLS = [
        "https://veeps.com/e/artistfriendly/6da4a3b9-6f05-400b-a1f2-16209bc70a6c/312347b6-2345-1111-1111-234562972866",
        "https://veeps.com/e/b/68ea8351-ba2d-4313-9f2f-ec8b5f5cd164/312347b6-2345-1111-1111-234562972866",
        "https://veeps.com/a/b62bf5d7-2a65-42e4-a26b-a8df42f6db47",
        "https://veeps.com/artistfriendly/6da4a3b9-6f05-400b-a1f2-16209bc70a6c",
        "https://veeps.com/browse/country",
    ]

    LICENSE_URL = 'https://widevine-dash.ezdrm.com/proxy'
    BASE_URL = "https://veeps.com"

    LOGIN_COOKIES = None
    USER_ID = None
    LICENSE_ID = "72D27A"

    @staticmethod
    def test_service():
        main_service.run_service(veeps_com)

    @staticmethod
    def credentials_needed():
        return {"FIREFOX_COOKIES": True}

    @staticmethod
    def get_login_cookies():
        cookie_dict = {}
        for c in browser_cookie3.firefox(domain_name='veeps.com'):
            cookie_dict[c.name] = c.value

        try:
            assert len(cookie_dict.keys()) > 0
            return cookie_dict
        except:
            return None

    @staticmethod
    def get_user_id():
        response = requests.get(veeps_com.BASE_URL, cookies=veeps_com.LOGIN_COOKIES).content.decode()
        user_id = re.search(r'"user_id":[^"]*"(.+?)"', response).group(1)
        return user_id

    @staticmethod
    def initialize_service():
        if veeps_com.LOGIN_COOKIES is None:
            veeps_com.LOGIN_COOKIES = veeps_com.get_login_cookies()
            if veeps_com.LOGIN_COOKIES is None:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=f'from {veeps_com.__name__}',
                    reason='Need account for this service',
                    solution='Sign into your account using Firefox'
                ))

        if veeps_com.USER_ID is None:
            veeps_com.USER_ID = veeps_com.get_user_id()
        return veeps_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            veeps_com.LICENSE_URL,
            params={'pX': veeps_com.LICENSE_ID},
            data=challenge
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        response = requests.get(source_element.url, cookies=veeps_com.LOGIN_COOKIES).content.decode()
        soup = BeautifulSoup(response, 'html5lib')
        scripts = soup.find_all('script')

        response = None
        pattern = re.compile(r'window\.__CONFIG__[^={]*=[^{]*({.*?});', re.DOTALL)
        for script in scripts:
            code = script.string

            if code:
                match = pattern.search(code)
                if match:
                    try:
                        response = parse_js_object(match.group(1))
                    except:
                        continue
                    break

        if response is None:
            response = {}

        manifest = None
        video_title = ""
        for _, v in response.items():
            if type(v) is not list:
                v = [v]

            try:
                for d in v:
                    try:
                        manifest = d["playback"]["widevine_url"]
                        if len(manifest) == 0:
                            raise
                    except:
                        manifest = None
                        manifest = d["playback"]["stream_url"]

                    try:
                        video_title = d["event_name"]
                    except:
                        pass
                    try:
                        video_title = d["presentation"]["subtitle"] + " " + video_title
                    except:
                        pass
                    if manifest is not None:
                        break
            except:
                pass

            if manifest is not None:
                break

        if manifest is None:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't download paid content",
                solution='Do not attempt to download it'
            ))

        if len(video_title) == 0:
            try:
                video_title = unescape(soup.title.string)
            except:
                video_title = source_element.url.split(veeps_com.BASE_URL)[-1]
        video_title = get_valid_filename(video_title)

        if source_element.element is None:
            source_element.element = video_title
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                veeps_com.__name__
            )

        response = requests.get(manifest).content.decode()
        try:
            pssh_value = re.search(r'base64,([^"]+)"', response).group(1)
        except:
            pssh_value = None

        if pssh_value is None:
            try:
                pssh_value = str(min(re.findall(
                    r'<[^<>]*cenc:pssh[^<>]*>(.*?)</[^<>]*cenc:pssh[^<>]*>',
                    response
                ), key=len))
            except:
                pssh_value = None
        return manifest, pssh_value, {}

    @staticmethod
    def is_wide_card(tag):
        while tag:
            if tag.has_attr('data-card-content') and tag['data-card-content'] == 'wide':
                return True
            tag = tag.find_parent()
        return False

    @staticmethod
    def get_rails(tag):
        while tag:
            if tag.name == 'section':
                return tag
            tag = tag.find_parent()
        return None

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.split("#")[0].split("?")[0].rstrip("/")
        if collection_url.startswith(veeps_com.BASE_URL + "/e/"):
            return [BaseElement(url=collection_url)]

        response = requests.get(collection_url, cookies=veeps_com.LOGIN_COOKIES).content.decode()
        if '"widevine_url":"' in response or '"stream_url":"' in response:
            return [BaseElement(url=collection_url)]

        soup = BeautifulSoup(response, 'html5lib')
        a_nodes = soup.find_all('a', attrs={
            'data-phx-link': 'redirect',
            'data-testid': 'ds_card_link',
            'data-list-item': True
        })

        try:
            collection_name = unescape(soup.title.string)
        except:
            collection_name = collection_url.split(veeps_com.BASE_URL)[-1]
        collection_name = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                veeps_com.__name__
            ),
            get_valid_filename(collection_name)
        )

        collection = []
        rail_index = 0
        video_index = 0
        visited_videos = []
        visited_rails = []

        for a_node in a_nodes:
            if a_node.find(attrs={'data-testid': 'ds_card_subtitle'}) is None:
                continue
            if a_node["href"].startswith("/browse/"):
                continue
            if veeps_com.is_wide_card(a_node):
                continue
            rail = veeps_com.get_rails(a_node)

            try:
                rail_id = rail.get("id", rail["data-list-id"])
            except:
                rail_id = None
            if rail_id not in visited_rails:
                rail_index += 1
                video_index = 0
                visited_rails.append(rail_id)

            check = check_range(True, rail_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            try:
                if rail_id is None:
                    raise
                rail_name = get_valid_filename(f'Rail_{rail_index}_{rail["data-list-name"]}')
            except:
                rail_name = f"Rail_{rail_index}"
            rail_name = join(collection_name, rail_name)

            video_index += 1
            check = check_range(False, rail_index, video_index)
            if check is True:
                continue
            elif check is False:
                return collection

            if a_node["href"] in visited_videos:
                continue
            visited_videos.append(a_node["href"])
            collection.append(BaseElement(
                url=f'{veeps_com.BASE_URL}/e{a_node["href"]}/{veeps_com.USER_ID}',
                collection=rail_name,
                element=f'Video_{video_index}'
                        f'_'
                        f'{get_valid_filename(a_node["data-item-name"])}'
            ))
        return collection
