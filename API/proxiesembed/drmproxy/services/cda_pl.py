import builtins
import html
import json
import os
import re
import time
import urllib.parse
from os.path import join

import browser_cookie3
import requests
from bs4 import BeautifulSoup
from cf_clearance import sync_cf_retry, sync_stealth
from playwright.sync_api import sync_playwright

from utils.constants.macros import ERR_MSG, APP_ERROR, USER_ERROR, WARN_MSG
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, get_width_res_from_height


class cda_pl(BaseService):
    DEMO_URLS = [
        "https://www.cda.pl/Bajki123/folder/19713517/vfilm",
        "https://www.cda.pl/STOPCHAM/folder/22765636/vfilm",
        "https://www.cda.pl/WojnaIdei/folder-glowny/vfilm",
        "https://www.cda.pl/video/lifestyle-kobieta",
        "https://www.cda.pl/video/75382667f",
        "https://www.cda.pl/video/4456700e0",
        "https://www.cda.pl/video/17625912bf/vfilm",
        "https://www.cda.pl/video/5809406b/vfilm",
        "https://www.cda.pl/video/504842386/vfilm",
        "https://www.cda.pl/video/153780264/vfilm",
    ]

    BASE_URL = "https://www.cda.pl"
    CLOUDFLARE = None
    SITE_COOKIES = None
    USER_AGENT = None
    CF_RETRIES = 8
    TIMEOUT_RETRIES = 8
    TIMEOUT = 30

    @staticmethod
    def bypass_cloudflare():
        user_agent, cf_clearance = cda_pl.USER_AGENT, None
        retry = 0
        failure = False

        with sync_playwright() as spw:
            browser = spw.firefox.launch(headless=True)
            page = browser.new_page()

            sync_stealth(page)
            page.goto(cda_pl.BASE_URL)
            while True:
                if sync_cf_retry(page):
                    for cookie in page.context.cookies():
                        if cookie.get('name') == 'cf_clearance':
                            cf_clearance = cookie.get('value')
                            break
                    user_agent = page.evaluate('() => {return navigator.userAgent}')

                    if cf_clearance is not None:
                        break
                else:
                    retry = cda_pl.CF_RETRIES

                retry += 1
                if retry >= cda_pl.CF_RETRIES:
                    failure = True
                    break
            browser.close()

        if failure:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}/{APP_ERROR}',
                url=f"from {cda_pl.__name__}",
                reason="Failed to bypass Cloudflare",
                solution=f"Try again and if it persists, then debug the {cda_pl.__name__} service"
            ))
        return user_agent, cf_clearance

    @staticmethod
    def check_cloudflare():
        if cda_pl.USER_AGENT is None:
            cda_pl.USER_AGENT = builtins.CONFIG["USER_AGENT"]

        if "Just a moment..." in requests.get(cda_pl.BASE_URL).content.decode():
            user_agent, cf_clearance = cda_pl.bypass_cloudflare()
            return {"User-Agent": user_agent, "cf_clearance": cf_clearance}
        return {"User-Agent": cda_pl.USER_AGENT, "cf_clearance": None}

    @staticmethod
    def test_service():
        main_service.run_service(cda_pl)

    @staticmethod
    def credentials_needed():
        return {
            "OPTIONAL": True,
            "FIREFOX_COOKIES": True
        }

    @staticmethod
    def set_site_cookies():
        cda_pl_cookies = {}
        try:
            for c in browser_cookie3.firefox(domain_name='cda.pl'):
                cda_pl_cookies[c.name] = c.value
        except browser_cookie3.BrowserCookieError:
            pass
        cda_pl_cookies["cf_clearance"] = cda_pl.CLOUDFLARE["cf_clearance"]
        cda_pl.SITE_COOKIES = cda_pl_cookies

    @staticmethod
    def initialize_service():
        if cda_pl.CLOUDFLARE is None:
            cda_pl.CLOUDFLARE = cda_pl.check_cloudflare()
        if cda_pl.SITE_COOKIES is None:
            cda_pl.set_site_cookies()
        return cda_pl

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"], data=challenge,
            headers={'x-dt-custom-data': additional["custom_data"]}
        )
        licence.raise_for_status()
        return licence.content

    # Taken from: https://github.com/divadsn/cda-video-extractor/blob/master/server.py#L37
    @staticmethod
    def decrypt_file(file_str: str):
        words = ["_XDDD", "_CDA", "_ADC", "_CXD", "_QWE", "_Q5", "_IKSDE"]
        for w in words:
            file_str = file_str.replace(w, "")
        file_str = urllib.parse.unquote(file_str)

        decrypted_chars = []
        for char in range(len(file_str)):
            char_ord = ord(file_str[char])
            decrypted_chars.append(
                chr(33 + (char_ord + 14) % 94) if 33 <= char_ord <= 126
                else chr(char_ord)
            )

        file_str = "".join(decrypted_chars)
        file_str = file_str.replace(".cda.mp4", "")
        file_str = file_str.replace(".2cda.pl", ".cda.pl")
        file_str = file_str.replace(".3cda.pl", ".cda.pl")
        return f"https://{file_str}.mp4"

    @staticmethod
    def generate_video_m3u8(output_path, content):
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
        m3u8_content += f'#EXTINF:{content["duration"]},\n'
        m3u8_content += f'{cda_pl.decrypt_file(content["file"])}\n'

        m3u8_content += "#EXT-X-ENDLIST\n"
        with open(output_path, "w") as f:
            f.write(m3u8_content)

    @staticmethod
    def generate_master_m3u8(source_element, content):
        output_path = str(join(source_element.collection, source_element.element))
        if not os.path.exists(output_path):
            os.makedirs(output_path)
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"

        index = 0
        for quality in content.get("qualities", {}):
            index += 1
            if content["quality"] != content["qualities"][quality]:
                c = cda_pl.get_video_content(f'{source_element.url}?wersja={quality}')
            else:
                c = content

            q = int(quality.split("p")[0])
            q = f'{get_width_res_from_height(q)}x{q}'
            title = f'video_{quality}.m3u8'

            cda_pl.generate_video_m3u8(join(output_path, title), c)
            m3u8_content += f"#EXT-X-STREAM-INF:BANDWIDTH={index * 1000},RESOLUTION={q},TYPE=VIDEO,MIME-TYPE=\"video/mp4\"\n"
            m3u8_content += f'{title}\n'

        output_path = join(output_path, "master.m3u8")
        with open(output_path, "w") as f:
            f.write(m3u8_content)
        return output_path

    @staticmethod
    def handle_cloudflare_timeout(url, lambda_request):
        for i in range(1, cda_pl.TIMEOUT_RETRIES + 1):
            response = lambda_request(url)
            if "Just a moment..." in response:
                print(WARN_MSG.format(
                    msg=f"Cloudflare timeout: ({i}/{cda_pl.TIMEOUT_RETRIES}). "
                        f"Duration (seconds): {cda_pl.TIMEOUT}")
                )

                if i == cda_pl.TIMEOUT_RETRIES:
                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=url,
                        reason='You requested too much content recently',
                        solution="Wait 1 minute"
                    ))

                time.sleep(cda_pl.TIMEOUT)
                continue
            return response

    @staticmethod
    def get_video_content(url):
        response = cda_pl.handle_cloudflare_timeout(
            url,
            lambda u: requests.post(
                u, cookies=cda_pl.SITE_COOKIES,
                headers={'User-Agent': cda_pl.CLOUDFLARE['User-Agent']},
                files={'age_confirm': (None, '')}
            ).content.decode()
        )

        if "player_data" not in response:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=url,
                reason="Need Polish IP to access content or it is paid premium",
                solution="Use a VPN or don't attempt to download it"
            ))

        player_match = re.findall(r'player_data="([^"]*)"', response)
        if len(player_match) == 0:
            player_match = re.findall(r"player_data='([^']*)'", response)
        return json.loads(html.unescape(player_match[0]))["video"]

    @staticmethod
    def get_video_data(source_element):
        content = cda_pl.get_video_content(source_element.url)
        if source_element.element is None:
            element_name = content.get("title", "")
            if "%" in element_name:
                element_name = urllib.parse.unquote(element_name)
            element_name = get_valid_filename(element_name)
            if element_name is None:
                element_name = re.search(r"/video/([^/?]*)", source_element.url).group(1)

            source_element.element = element_name
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                cda_pl.__name__
            )

        manifest = content.get("manifest", None)
        if manifest is None:
            return cda_pl.generate_master_m3u8(source_element, content), None, {}

        license_url = content["manifest_drm_proxy"]
        custom_data = content["manifest_drm_header"]
        try:
            pssh_value = str(min(re.findall(
                r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                requests.get(manifest).content.decode()
            ), key=len))
        except:
            return manifest, None, {}
        return manifest, pssh_value, {
            "license_url": license_url,
            "custom_data": custom_data,
            "FORCE_SHAKA": "vp9/" in manifest
        }

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.split("?")[0]
        content_id = None
        if "/video/" in collection_url:
            content_id = re.search(r"/video/([^/?]*)", collection_url).group(1)
            if content_id[0].isdigit():
                return [BaseElement(url=collection_url)]
            content_id = get_valid_filename(content_id)

        for p in ["/kolekcje/", "/premium", "/tv", "/powtorki-z-telewizji/"]:
            if p in collection_url:
                return None

        if "/video/" in collection_url or "/folder" in collection_url:
            if content_id is None:
                content_id = re.search(r"/([^/?]*)/folder", collection_url).group(1)
                is_folder = True
            else:
                is_folder = False

            if not collection_url.endswith("/"):
                collection_url += "/"
            collection = []

            page = builtins.CONFIG["QUERY"]["MIN"]["COLLECTION"]
            if page is None:
                page = 1
            else:
                page = int(page)

            while True:
                response = cda_pl.handle_cloudflare_timeout(
                    f'{collection_url}{page}',
                    lambda u: requests.get(
                        u, cookies=cda_pl.SITE_COOKIES,
                        headers={'User-Agent': cda_pl.CLOUDFLARE['User-Agent']}
                    ).content.decode()
                )

                soup = BeautifulSoup(response, 'html5lib')

                try:
                    pag_div = soup.find('div', class_='paginationControl')
                    if not is_folder:
                        disabled_page = pag_div.find('span', class_='disabledPage').text
                    else:
                        disabled_page = pag_div.find('li', class_='active').find('a').text

                    if disabled_page != str(page):
                        break
                except:
                    if page > 1:
                        break

                check = check_range(True, page, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                a_elements = soup.find_all(
                    'a',
                    class_="video-clip-link" if not is_folder else "link-title-visit"
                )
                a_elements = [
                    a for a in a_elements
                    if "/video/" in a["href"] and a["href"].split("/video/")[1][0].isdigit()
                ]

                index = 0
                for link in a_elements:
                    index += 1
                    check = check_range(False, page, index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    if not is_folder:
                        title = soup.find('a', href=link["href"], title=True)["title"]
                    else:
                        title = link.text

                    collection.append(BaseElement(
                        url=f'{cda_pl.BASE_URL}{link["href"]}',
                        collection=join(
                            join(
                                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                cda_pl.__name__
                            ),
                            join(content_id, f'Page_{page}')
                        ),
                        element=f"Video_{index}"
                                f'_'
                                f"{get_valid_filename(title)}"
                    ))

                page += 1

            return collection
        return None
