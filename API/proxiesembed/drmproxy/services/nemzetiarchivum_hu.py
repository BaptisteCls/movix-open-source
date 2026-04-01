import builtins
import json
import re
from os.path import join
from urllib.parse import urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import USER_ERROR, ERR_MSG
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, get_ext_from_url, update_url_params


class nemzetiarchivum_hu(BaseService):
    DEMO_URLS = [
        "https://nemzetiarchivum.hu/m3/open?id=M3-bFAxTUFOc0xJODY4ZEIxakJhWW5yemtEaHZVQmVGdVpkTFNxVWRpRlBXdz0",
        "https://nemzetiarchivum.hu/m3/open?id=M3-bDVlajVyZzBEZXhjcGxycngwaGNLM1lEUWlVYXJZTzZ2Z2FjQzIxcmdvVT0",
        "https://nemzetiarchivum.hu/m3/open?series=S3Vrb3JpIMOpcyBLb3Rrb2RhICBJLiBTb3JvemF0",
        "https://nemzetiarchivum.hu/m3/open?series=U3rDoXphZHVuaw%3D%3D",
    ]

    STREAM_URL = 'https://nemzetiarchivum.hu/api/m3/v3/stream'
    SUBTITLE_URL = 'https://nemzetiarchivum.hu/subtitle/{target_id}.srt'
    BASE_URL = 'https://nemzetiarchivum.hu'

    USER_AGENT = None

    @staticmethod
    def test_service():
        main_service.run_service(nemzetiarchivum_hu)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        if nemzetiarchivum_hu.USER_AGENT is None:
            nemzetiarchivum_hu.USER_AGENT = builtins.CONFIG["USER_AGENT"]
        return nemzetiarchivum_hu

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        if source_element.additional is None:
            source_element.additional = {}
        target_id = source_element.additional.get("target_id", None)

        if target_id is None:
            response = requests.get(source_element.url).text
            soup = BeautifulSoup(response, 'html5lib')

        if source_element.element is None:
            title = soup.find('div', class_='active-info-line')
            if title:
                titles = list(title.find_previous_siblings(limit=2))
                title = ""
                for t in reversed(titles):
                    try:
                        temp_title = t.text.strip()
                        assert len(temp_title) > 0
                        title = title + " " + temp_title
                    except:
                        pass

            if title in [None, ""]:
                try:
                    title = soup.title.getText().strip()
                    i = title.find("|") + 1
                    if i > 0:
                        title = title[i:]
                    assert len(title) > 0
                except:
                    title = ""
                title = title + " " + parse_qs(urlparse(source_element.url).query)["id"][0]

            source_element.element = get_valid_filename(title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                nemzetiarchivum_hu.__name__
            )

        if target_id is None:
            try:
                target_id = soup.find_all(attrs={'id': 'player', 'data-item': True})
                target_id = json.loads(target_id[0]["data-item"])["id"]
                assert len(target_id) > 0 and type(target_id) is str
                raise
            except:
                target_id = None
            if target_id is None:
                try:
                    target_id = re.findall(
                        "{[^{}]*id[^:]*:[^\"']*['\"]([^'\"]+)['\"][^{}]*}",
                        response
                    )[0]
                except:
                    target_id = None

        if target_id is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = requests.get(nemzetiarchivum_hu.STREAM_URL, params={'target': target_id, "type": "open"})
        response = response.content.decode()
        response = json.loads(response)

        for f in ["mpeg_dash"]:
            try:
                manifest = response[f]["url"]
                assert len(manifest) > 0
                break
            except:
                manifest = None

        try:
            manifest_content = requests.get(manifest, headers={"User-Agent": nemzetiarchivum_hu.USER_AGENT})
            pssh_value = get_pssh_from_cenc_pssh(manifest_content.text)
        except:
            pssh_value = None

        additional = {}
        if pssh_value is not None:
            license_url = nemzetiarchivum_hu.BASE_URL + response["proxy_url"]
            license_url += "?drm-type=widevine&type=open"
            additional["license_url"] = license_url

        srts = []
        srt_path = join(source_element.collection, source_element.element)
        srt_url = nemzetiarchivum_hu.SUBTITLE_URL.format(target_id=target_id)
        try:
            assert 200 <= requests.head(srt_url).status_code < 300
            assert len(requests.get(srt_url).text) > 0
            srts.append((False, BaseElement(
                url=srt_url,
                collection=srt_path,
                element=f'subtitle{get_ext_from_url(srt_url)}'
            )))
        except:
            pass

        additional["SUBTITLES"] = srts
        return manifest, pssh_value, additional

    @staticmethod
    def get_collection_elements(collection_url):
        if "/m3/open?" not in collection_url:
            return None
        if "?id=" in collection_url or "&id=" in collection_url:
            return [BaseElement(url=collection_url)]
        if "?series=" not in collection_url and "&series=" not in collection_url:
            return None

        collection_title = None
        page = 0
        collection = []
        while True:
            page += 1
            check = check_range(True, page, None)
            if check is True:
                continue
            elif check is False:
                return collection

            collection_url = update_url_params(collection_url, {"page": page})
            response_page = requests.get(collection_url).text
            soup_page = BeautifulSoup(response_page, "html5lib")

            if collection_title is None:
                try:
                    collection_title = soup_page.title.getText().strip()
                    i = collection_title.find("|") + 1
                    if i > 0:
                        collection_title = collection_title[i:]
                    assert len(collection_title) > 0
                except:
                    collection_title = ""

                if collection_title in ["", None]:
                    collection_title = "Series " + parse_qs(urlparse(collection_url).query)["series"][0]
                collection_title = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        nemzetiarchivum_hu.__name__
                    ),
                    get_valid_filename(collection_title)
                )

            videos = soup_page.find_all(attrs={'data-id': True, 'href': True})
            if len(videos) == 0:
                break

            video_index = 0
            for video in videos:
                video_index += 1
                check = check_range(False, page, video_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                video_url = video["href"]
                if not video_url.startswith("http"):
                    video_url = nemzetiarchivum_hu.BASE_URL + "/m3/" + video_url

                video_title = ""
                for node_1 in video.find_all(recursive=False):
                    if not node_1.find(class_="dp-item-inner") and "dp-item-inner" not in node_1.get("class", []):
                        direct_children = node_1.find_all(recursive=False)
                        selected_children = direct_children[:1] if len(direct_children) <= 2 else direct_children[:2]

                        for node_2 in selected_children:
                            video_title += node_2.getText().strip() + " "
                        if len(video_title) > 0:
                            video_title = video_title.strip()
                            break
                if len(video_title) == 0:
                    video_title = parse_qs(urlparse(video_url).query)["id"][0]

                try:
                    target_id = video.find_all(class_="show-bg", attrs={"style": True})[0]
                    target_id = re.findall(r'/m3/([^/?)]+)', target_id["style"])[0]
                except:
                    target_id = None

                collection.append(BaseElement(
                    url=video_url,
                    collection=join(collection_title, f'Page_{page}'),
                    element=get_valid_filename(f"Video_{video_index} " + video_title),
                    additional={"target_id": target_id}
                ))

        return collection
