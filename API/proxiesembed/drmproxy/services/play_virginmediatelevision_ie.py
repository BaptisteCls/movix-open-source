import builtins
import json
import re
from os.path import join

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import clean_url, get_valid_filename


class play_virginmediatelevision_ie(BaseService):
    DEMO_URLS = [
        "https://play.virginmediatelevision.ie/watch/vod/52664902/waterford-city",
        "https://play.virginmediatelevision.ie/watch/replay/19121626/uhl-irelands-hospital-crisis",
        "https://play.virginmediatelevision.ie/shows/596a0d0e-3ea9-11ef-b7e3-0276c1f87d2f/gogglebox-ireland",
        "https://play.virginmediatelevision.ie/shows/4405bcba-3212-11ef-8c5c-020f80c0527e/emmerdale",
        "https://play.virginmediatelevision.ie/vod/34824/virgin-media-two",
        "https://play.virginmediatelevision.ie/vod/34822/virgin-media-three",
    ]

    COMPANY_ID = "company_942f683c-9041-42de-9911-a9e4cd98a4e9"
    STREAM_URL = 'https://api-virginmedia.simplestreamcdn.com/streams/v2/' + COMPANY_ID + '/vod/{vod_id}'
    SLIDER_URL = 'https://play.virginmediatelevision.ie/renderable/slider/rendered'

    @staticmethod
    def test_service():
        main_service.run_service(play_virginmediatelevision_ie)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return play_virginmediatelevision_ie

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"],
            data=challenge
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        vod_id = re.findall(r'/watch/[^/]+/([^/]+)', source_element.url)[0]
        response = requests.post(
            play_virginmediatelevision_ie.STREAM_URL.format(vod_id=vod_id),
            params={'platform': 'chrome'},
            headers={'Userid': 'Userid'}
        )

        status_code = response.status_code
        response = response.content.decode()
        message = response.lower()
        if status_code in [404] or "video not found" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = json.loads(response)["response"]
        drm = response.get("drm", None)
        if drm is None:
            drm = {}

        try:
            license_url = drm["widevine"]["licenseAcquisitionUrl"]
            manifest = drm["widevine"]["stream"]
            assert len(license_url) > 0 and len(manifest) > 0
        except:
            manifest = license_url = None

        pssh_value = None
        if license_url is None:
            try:
                manifest = response["stream"]
                assert len(manifest) > 0
            except:
                manifest = None

            if manifest is None:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))
        else:
            manifest_content = requests.get(manifest).content.decode()
            try:
                pssh_value = get_pssh_from_cenc_pssh(manifest_content)
            except:
                pssh_value = None

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {play_virginmediatelevision_ie.__name__} service"
                ))

        if source_element.element is None:
            try:
                title = response["metadata"]["name"]
                assert len(title) > 0
            except:
                title = None
            if title is None:
                try:
                    title = response["metadata"]["metadata"]["title"]
                    assert len(title) > 0
                except:
                    title = None

            if title is None:
                title = source_element.url.split("/")[-1]
            source_element.element = get_valid_filename(title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                play_virginmediatelevision_ie.__name__
            )

        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/watch/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/shows/" not in collection_url and "/vod/" not in collection_url:
            return None

        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                play_virginmediatelevision_ie.__name__
            ),
            get_valid_filename(collection_url.split("/")[-1])
        )
        response = requests.get(collection_url)
        response = response.content.decode()
        soup = BeautifulSoup(response, 'html5lib')
        if "service unavailable" in soup.title.get_text().lower():
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="Need Irish IP to access content",
                solution="Use a VPN"
            ))
        collection = []

        if "/vod/" in collection_url:
            catch_id = re.findall(r'/vod/([^/]+)', collection_url)[0]
            render_nodes = re.findall(
                r'this\.url\.params\s*=\s*(\{.*?})\s*this\.url\.',
                response, flags=re.DOTALL
            )

            section_index = 0
            for render_node in render_nodes:
                try:
                    render_node = render_node.encode().decode('unicode_escape')
                except:
                    pass
                section_id = re.findall(r'"id":"([^"]+)"', render_node)
                if len(section_id) == 0:
                    continue
                section_id = section_id[0]

                section_index += 1
                check = check_range(True, section_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                section_title = re.findall(r'"title":"([^"]+)"', render_node)
                if len(section_title) == 0:
                    section_title = ""
                else:
                    section_title = section_title[0]
                section_title = f"Rail_{section_index} {section_title}"
                section_title = join(collection_title, get_valid_filename(section_title))

                response = requests.get(
                    play_virginmediatelevision_ie.SLIDER_URL,
                    params={
                        'endpoint': f'/api/vod/{catch_id}',
                        'finder': json.dumps([
                            {"key": "sections"},
                            {"key": "id", "value": section_id},
                            {"key": "tiles"}
                        ]),
                        'slider': json.dumps({"showTitle": True})
                    }
                )
                response = response.content.decode()
                soup = BeautifulSoup(response, 'html5lib')
                episode_nodes = soup.find_all(lambda tag: tag.has_attr('class') and 'slider-card' in tag['class'])

                episode_index = 0
                for episode_node in episode_nodes:
                    episode_index += 1
                    check = check_range(False, section_index, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    try:
                        episode_url = episode_node.find(
                            "a", attrs={"x-data": lambda x: x and "href" in x}
                        )["x-data"]
                        original_url = episode_url
                        episode_url = re.findall(r"href[^:]*:[^']*'([^']+)'", original_url)
                        if len(episode_url) == 0:
                            re.findall(r'href[^:]*:[^"]*"([^"]+)"', original_url)
                        episode_url = episode_url[0]
                        assert "/watch/" in episode_url
                    except:
                        continue

                    try:
                        episode_title = episode_node.find(
                            attrs={"class": lambda c: c and "card-title" in c}
                        ).getText()
                        assert len(episode_title) > 0
                    except:
                        episode_title = ""
                    episode_title = f"Video_{episode_index} {episode_title}"
                    episode_title = get_valid_filename(episode_title)

                    collection.append(BaseElement(
                        url=episode_url,
                        collection=section_title,
                        element=episode_title
                    ))

        if "/shows/" in collection_url:
            soup = soup.find("div", {"id": "seasonsContent"})
            if soup is None:
                return []
            a_nodes = soup.find_all('a', href=True)
            a_nodes = [a for a in a_nodes if "/watch/" in a["href"]]
            episodes = []

            for a_node in a_nodes:
                episode_title = a_node.text
                if episode_title is None:
                    episode_title = ""
                episode_title = episode_title.strip()
                if len(episode_title) == 0:
                    episode_title = a_node["href"].split("/")[-1]

                episodes.append((a_node["href"], episode_title))
            episodes = list(reversed(episodes))

            contents = []
            episode_nodes = soup.find_all(lambda tag: tag.has_attr('class') and 'card-body' in tag['class'])
            for episode_node in episode_nodes:
                try:
                    season_index = episode_node.find('span', attrs={"data-content-type": "season"})
                    season_index = season_index.text.strip()
                    season_index = re.findall(r'\d+', season_index)[0]
                    assert len(season_index) > 0
                    season_index = int(season_index)
                except:
                    continue

                try:
                    title_node = episode_node.find(lambda tag: tag.has_attr('class') and 'card-title' in tag['class'])
                    episode_index = title_node.text.strip()
                    episode_index = episode_index.split(".")[0]
                    episode_index = re.findall(r'\d+', episode_index)[0]
                    assert len(episode_index) > 0
                    episode_index = int(episode_index)
                except:
                    episode_index = None

                episode = episodes.pop()
                if episode_index is None:
                    try:
                        episode_title = episode[1].lower()
                        episode_index = re.findall(r'ep\.(\d+)', episode_title)
                        if len(episode_index) == 0:
                            episode_index = re.findall(r'episode\s*(\d+)', episode_title)
                        episode_index = episode_index[0]
                        assert len(episode_index) > 0
                        episode_index = int(episode_index)
                    except:
                        episode_index = None

                assert episode_index is not None
                found = False
                for c_s, c_e in contents:
                    if c_s == season_index:
                        c_e.append((episode_index, episode))
                        found = True
                        break

                if not found:
                    contents.append((season_index, [(episode_index, episode)]))

            contents = sorted(contents, key=lambda ct: ct[0])
            for season_index, episodes in contents:
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episodes = sorted(episodes, key=lambda ep: ep[0])
                for episode_index, episode in episodes:
                    check = check_range(False, season_index, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=episode[0],
                        collection=join(collection_title, f'Season_{season_index}'),
                        element=f'Episode_{episode_index}_{get_valid_filename(episode[1])}'
                    ))

        return collection
