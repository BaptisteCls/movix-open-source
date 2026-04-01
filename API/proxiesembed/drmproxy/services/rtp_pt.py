import base64
import builtins
import json
import os
import re
import time
from os.path import join
from urllib.parse import unquote

import m3u8
import requests
from bs4 import BeautifulSoup
from requests.exceptions import ChunkedEncodingError

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh, get_pssh_from_default_kid
from utils.tools.common import get_valid_filename, clean_url, get_ext_from_url


class rtp_pt(BaseService):
    DEMO_URLS = [
        "https://www.rtp.pt/play/p12760/e798080/bem-vindos/1273111",
        "https://www.rtp.pt/play/p12795/e742829/matilha",
        "https://www.rtp.pt/play/direto/rtpinternacional",
        "https://www.rtp.pt/play/direto/antena3",
        "https://www.rtp.pt/play/p303/e798812/ultima-edicao",
        "https://www.rtp.pt/play/zigzag/p13883/e799760/radar-xs",
        "https://www.rtp.pt/play/zigzag/p13605/e799752/vegesaurs",
        "https://www.rtp.pt/play/zigzag/direto/radio",
        "https://www.rtp.pt/play/zigzag/p3934/e316186/poe-mais-alto",
        "https://www.rtp.pt/play/palco/p13432/e769137/por-debaixo-dos-panos-dayse-albuquerque",
        "https://www.rtp.pt/play/palco/p12895/e749289/quis-saber-quem-sou-podcast",
        "https://www.rtp.pt/play/estudoemcasa/p7783/e501010/matematica-2-ano",
        "https://www.rtp.pt/play/p12763/a-prova-dos-factos",
        "https://www.rtp.pt/play/p13552/astro-mano",
        "https://www.rtp.pt/play/p10654/electromagnetico",
        "https://www.rtp.pt/play/zigzag/p10320/o-mundo-do-simao",
        "https://www.rtp.pt/play/zigzag/p13866/sempre-atrasados",
        "https://www.rtp.pt/play/zigzag/p2759/nacao-valente-personagens-historia",
        "https://www.rtp.pt/play/palco/p10973/womex-2022",
        "https://www.rtp.pt/play/palco/p305/teatro-sem-fios",
        "https://www.rtp.pt/play/estudoemcasa/p7789/matematica-3-e-4-anos",
    ]

    BASE_URL = "https://www.rtp.pt"
    EPISODES_URL = '{base_path}/bg_l_ep/'

    LICENSE_URL = "https://lic.drmtoday.com/license-proxy-widevine/cenc/"
    LICENSE_DATA = "eyJ1c2VySWQiOiJwdXJjaGFzZSIsInNlc3Npb25JZCI6InNlc3Npb25JZCIsIm1lcmNoYW50IjoibW9nX3J0cCJ9"
    USER_AGENT = None
    RETRIES_COUNT = 5
    RETRIES_TIMER = 5

    @staticmethod
    def test_service():
        main_service.run_service(rtp_pt)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/direto/" in content

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        if rtp_pt.USER_AGENT is None:
            rtp_pt.USER_AGENT = builtins.CONFIG["USER_AGENT"]
        return rtp_pt

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            rtp_pt.LICENSE_URL,
            headers={"x-dt-custom-data": rtp_pt.LICENSE_DATA},
            data=challenge
        )
        licence.raise_for_status()
        return json.loads(licence.content)["license"]

    @staticmethod
    def get_pssh_from_m3u8(m3u8_url, m3u8_content):
        m3u8_url = clean_url(m3u8_url)
        m3u8_content = m3u8.loads(m3u8_content)
        segment_url = m3u8_content.playlists[0].uri

        if not segment_url.startswith("http"):
            if not segment_url.startswith("/"):
                segment_url = "../" + segment_url

            dots = segment_url.count("../")
            temp_base_url = m3u8_url.split("/")
            temp_base_url = temp_base_url[0:len(temp_base_url) - dots]
            temp_base_url = "/".join(temp_base_url)

            segment_url = segment_url.replace("../", "")
            if not segment_url.startswith("/"):
                segment_url = "/" + segment_url
            segment_url = temp_base_url + segment_url

        for attempt in range(0, rtp_pt.RETRIES_COUNT):
            try:
                m3u8_content = requests.get(
                    segment_url,
                    headers={'User-Agent': rtp_pt.USER_AGENT}
                ).content.decode()
                break
            except ChunkedEncodingError:
                if attempt == rtp_pt.RETRIES_COUNT - 1:
                    raise
                time.sleep(rtp_pt.RETRIES_TIMER)
            except:
                raise

        try:
            return re.findall(r'base64,([^"]+)"', m3u8_content)[0]
        except:
            pass

        key_id = re.findall(r'[?&]keyId=([^&"]+)[&"]', m3u8_content)[0]
        return get_pssh_from_default_kid(None, None, key_id)

    @staticmethod
    def generate_audio_m3u8(output_path, manifest, content_duration):
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
        m3u8_content += f'#EXTINF:{content_duration},\n'
        m3u8_content += f'{manifest}\n'

        m3u8_content += "#EXT-X-ENDLIST\n"
        with open(output_path, "w") as f:
            f.write(m3u8_content)

    @staticmethod
    def generate_master_m3u8(source_element, manifest, content_duration):
        output_path = str(join(source_element.collection, source_element.element))
        if not os.path.exists(output_path):
            os.makedirs(output_path)
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"

        title = f'audio.m3u8'
        rtp_pt.generate_audio_m3u8(join(output_path, title), manifest, content_duration)
        m3u8_content += f'#EXT-X-STREAM-INF:BANDWIDTH=1000,TYPE=AUDIO,MIME-TYPE=\"audio/mp3\"\n'
        m3u8_content += f'{title}\n'

        output_path = join(output_path, "master.m3u8")
        with open(output_path, "w") as f:
            f.write(m3u8_content)
        return output_path

    @staticmethod
    def get_video_data(source_element):
        if "/direto/" in source_element.url:
            is_live = True
            p_id = None
        else:
            is_live = False
            p_id = re.findall(r'/p\d+/', source_element.url)[0]

        response = None
        try:
            response = source_element.additional["page_html"]
            assert response is not None
        except:
            for attempt in range(0, rtp_pt.RETRIES_COUNT):
                try:
                    response = requests.get(
                        source_element.url,
                        headers={'User-Agent': rtp_pt.USER_AGENT}
                    )
                    response = response.text
                    break
                except ChunkedEncodingError:
                    if attempt == rtp_pt.RETRIES_COUNT - 1:
                        raise
                    time.sleep(rtp_pt.RETRIES_TIMER)
                except:
                    raise

        is_drm = "drm: true," in response
        for f in ["content_type", "mediaType"]:
            try:
                content_type = re.findall(fr'{f}[^:]*:[^"]*"([^"]+)"[^,]*,', response)
                content_type = content_type[0]
                assert type(content_type) is str and content_type not in ["", None]
            except:
                content_type = None
        if content_type is None:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="This content isn't available",
                solution='Do not attempt to download it'
            ))

        manifest = re.findall(r'atob[^()]*\([^()]*decodeURIComponent[^()]*\([^\[\]]*\[([^\[\]]*)]', response)
        temp_manifest = re.findall(r'file[^:]*:[^{}]*{([^{}]+)},', response)
        if len(temp_manifest) > 0:
            temp_manifest = temp_manifest[0]
            if "decodeURIComponent" in temp_manifest:
                temp_manifest = ""
            temp_manifest = re.findall(r'\w+[^":]*:[^":]*"([^"]+)"', temp_manifest)
        manifest += temp_manifest

        temp_manifest = re.findall(r'\w\s*=\s*"(http[^"]+\.[^"]+)";', response)
        if len(temp_manifest) == 0:
            temp_manifest = re.findall(r'file[^:]*:[^"]*"(http[^"]+\.[^"]+)"', response)
        if len(temp_manifest) > 0:
            temp_manifest = [temp_manifest[0]]
        manifest += temp_manifest

        for m in manifest:
            is_valid_url = m.startswith("http")
            if is_valid_url:
                is_valid_url = get_ext_from_url(m) in [".mpd", ".m3u8", ".mp3"]

            if not is_valid_url:
                try:
                    m = m.replace(" ", "").replace('"', "")
                    m = ''.join([unquote(chunk) for chunk in m.split(',')])
                    m = base64.b64decode(unquote(m)).decode(errors='replace')
                except:
                    continue

            if not m.startswith("http"):
                continue

            if content_type == "video":
                if p_id is not None and p_id not in m:
                    continue
                is_valid_url = get_ext_from_url(m) in [".mpd", ".m3u8"]
                if not is_valid_url:
                    continue

            elif content_type == "audio":
                is_mp3 = get_ext_from_url(m) in [".mp3"]
                if is_live and is_mp3:
                    continue
                if not is_live and not is_mp3:
                    continue

            if is_live and is_drm:
                if get_ext_from_url(m) not in [".mpd"]:
                    continue
            if "/drm-fps/" in m:
                continue
            manifest = m
            break

        if type(manifest) is not str:
            if is_drm:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason="The manifest couldn't be extracted",
                solution=f'Debug the {rtp_pt.__name__} service'
            ))

        if source_element.element is None:
            title = ""
            program_info = re.findall(r'program:[^{]*{([^{}]+)}', response)
            if len(program_info) == 0:
                program_info = None
            else:
                program_info = program_info[0]
            try:
                title += re.findall(r'title:[^"]*"([^"]+)"', program_info)[0]
            except:
                pass

            episode_info = re.findall(r'episode:[^{]*{([^{}]+)}', response)
            if len(episode_info) == 0:
                episode_info = None
            else:
                episode_info = episode_info[0]

            for f in ["title", "number", "date", "part"]:
                try:
                    title += " " + re.findall(fr'{f}:[^"]*"([^"]+)"', episode_info)[0]
                except:
                    pass

            if is_live:
                channel_info = re.findall(r'channel:[^{]*{([^{}]+)}', response)
                if len(channel_info) == 0:
                    channel_info = None
                else:
                    channel_info = channel_info[0]
                try:
                    title += " " + re.findall(r'name:[^"]*"([^"]+)"', channel_info)[0]
                except:
                    pass

            title = title.strip()
            if len(title) == 0:
                title = source_element.url.split("/play/")[-1]
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rtp_pt.__name__
            )

        pssh_value = None
        manifest_content = None
        if get_ext_from_url(manifest) in [".mpd", ".m3u8"]:
            for attempt in range(0, rtp_pt.RETRIES_COUNT):
                try:
                    manifest_content = requests.get(
                        manifest,
                        headers={'User-Agent': rtp_pt.USER_AGENT}
                    )
                    break
                except ChunkedEncodingError:
                    if attempt == rtp_pt.RETRIES_COUNT - 1:
                        raise
                    time.sleep(rtp_pt.RETRIES_TIMER)
                except:
                    raise

            status_code = manifest_content.status_code
            manifest_content = manifest_content.content.decode()
            if status_code == 403 or (status_code == 204 and len(manifest_content) == 0):
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="Need Portuguese IP to access content",
                    solution="Use a VPN"
                ))

        if is_drm or "/drm-" in manifest:
            if content_type == "audio":
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {rtp_pt.__name__} service"
                ))

            manifest_ext = get_ext_from_url(manifest)
            if manifest_ext == ".mpd":
                try:
                    pssh_value = get_pssh_from_cenc_pssh(manifest_content)
                except:
                    pssh_value = None

                if pssh_value is None:
                    try:
                        pssh_value = get_pssh_from_default_kid(manifest_content)
                    except:
                        pssh_value = None
            elif manifest_ext == ".m3u8":
                try:
                    pssh_value = rtp_pt.get_pssh_from_m3u8(manifest, manifest_content)
                except:
                    pssh_value = None

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {rtp_pt.__name__} service"
                ))

        if content_type == "audio" and not is_live:
            for f in ["content_duration_complete", "content_duration"]:
                content_duration = re.findall(fr'{f}[^:\w]*:[^"]*"([^"]+)"[^,]*,', response)
                if len(content_duration) > 0:
                    content_duration = content_duration[0]
                    if re.search(r'^\d+$', content_duration) is not None:
                        break
                content_duration = "1"
            manifest = rtp_pt.generate_master_m3u8(source_element, manifest, content_duration)

        srts = []
        if content_type == "video":
            page_srts = re.findall(r'vtt:[^\[]*(\[\[.*?]]),', response)
        else:
            page_srts = []

        if len(page_srts) > 0:
            srt_path = join(source_element.collection, source_element.element)
            page_srts = page_srts[0]
            page_srts = page_srts.replace("]]", "]")
            page_srts = re.findall(r"\[('[^\[\]]+')]", page_srts)

            srt_index = 0
            for page_srt in page_srts:
                page_srt = re.findall(r"'([^']+)'", page_srt)
                srt_url = [s for s in page_srt if s.startswith("http")]
                if len(srt_url) == 0:
                    continue

                srt_index += 1
                srt_url = srt_url[0]
                srt_title = [s for s in page_srt if not s.startswith("http")]
                if len(srt_title) == 0:
                    srt_title = [""]
                srt_title = f'subtitle_{srt_index} {srt_title[0]}'

                srt_ext = get_ext_from_url(srt_url)
                srts.append((False, BaseElement(
                    url=srt_url,
                    collection=srt_path,
                    element=f'{get_valid_filename(srt_title)}{srt_ext}'
                )))

        return manifest, pssh_value, {"SUBTITLES": srts}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/play/" not in collection_url:
            return None
        if "/direto/" in collection_url:
            return [BaseElement(url=collection_url)]

        is_video = True
        for f in ["p", "e"]:
            if re.search(fr'/{f}\d+/', collection_url) is None:
                is_video = False
                break
        if is_video:
            return [BaseElement(url=collection_url)]

        program_id = re.findall(r'/p(\d+)/', collection_url)
        if len(program_id) == 0:
            return None
        program_id = program_id[0]
        base_endpoint = collection_url.split(f"/p{program_id}")[0]

        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rtp_pt.__name__
            ),
            get_valid_filename(collection_url.split("/")[-1])
        )

        collection = []
        response = None
        for attempt in range(0, rtp_pt.RETRIES_COUNT):
            try:
                response = requests.get(
                    collection_url,
                    headers={'User-Agent': rtp_pt.USER_AGENT}
                )
                response = response.text
                break
            except ChunkedEncodingError:
                if attempt == rtp_pt.RETRIES_COUNT - 1:
                    raise
                time.sleep(rtp_pt.RETRIES_TIMER)
            except:
                raise
        show_soup = BeautifulSoup(response, 'html5lib')

        seasons = []
        seasons_container = show_soup.find("div", class_=lambda c: c and "seasons-container" in c)
        if seasons_container is not None:
            seasons_container = seasons_container.find("select", attrs={"onchange": True})
        if seasons_container is not None:
            seasons_container = seasons_container.find_all("option", attrs={"value": True})
            if seasons_container is not None and len(seasons_container) == 0:
                seasons_container = None

        if seasons_container is not None:
            for season_option in seasons_container:
                season_id = season_option.get("value", None)
                if season_id is None:
                    continue
                season_id = re.findall(r'/p(\d+)/', season_id)
                if len(season_id) == 0:
                    continue
                season_id = season_id[0]
                seasons.append((season_id, season_option.get_text()))

        if seasons_container is None:
            seasons_container = show_soup.find("div", class_=lambda c: c and "seasons-available" in c)
            if seasons_container is not None:
                seasons_container = seasons_container.find_all(
                    "a", class_=lambda c: c and "episode-item" in c,
                    attrs={"href": True}
                )
                if seasons_container is not None and len(seasons_container) == 0:
                    seasons_container = None

            if seasons_container is not None:
                for season_a in seasons_container:
                    season_id = season_a.get("href", None)
                    if season_id is None:
                        continue
                    season_id = re.findall(r'/p(\d+)/', season_id)
                    if len(season_id) == 0:
                        continue
                    season_id = season_id[0]

                    season_title = season_a.get("title", "")
                    if " - " in season_title:
                        season_title = season_title.split(" - ")[-1]
                    seasons.append((season_id, season_title))

        if seasons_container is None:
            seasons = [(program_id, "")]

        season_index = 0
        for season_id, season_title in seasons:
            season_index += 1
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            season_title = get_valid_filename(f"S{season_index} {season_title}")
            page = 0
            episode_index = 0

            while True:
                page += 1
                for attempt in range(0, rtp_pt.RETRIES_COUNT):
                    try:
                        response = requests.get(
                            rtp_pt.EPISODES_URL.format(base_path=base_endpoint),
                            headers={'User-Agent': rtp_pt.USER_AGENT},
                            params={
                                'listProgram': season_id, 'listtype': 'recent',
                                'page': page
                            }
                        )
                        response = response.text
                        break
                    except ChunkedEncodingError:
                        if attempt == rtp_pt.RETRIES_COUNT - 1:
                            raise
                        time.sleep(rtp_pt.RETRIES_TIMER)
                    except:
                        raise

                episodes_soup = BeautifulSoup(response, 'html5lib')
                episode_nodes = episodes_soup.find_all("article", attrs={"class": True})
                if len(episode_nodes) == 0:
                    break

                for episode_node in episode_nodes:
                    episode_a = episode_node.find("a", class_=lambda c: c and "episode-item" in c, attrs={"href": True})
                    if episode_a is None:
                        continue

                    try:
                        episode_url = episode_a["href"]
                        if not episode_url.startswith("http"):
                            episode_url = rtp_pt.BASE_URL + episode_url
                    except:
                        continue

                    episode_index += 1
                    check1 = check_range(False, season_index, episode_index)
                    check2 = check_range(False, season_index, episode_index + 1)
                    if check1 is True and check2 is True:
                        continue
                    elif check1 is False and check2 is False:
                        return collection

                    episode_title = ""
                    visited_text = []
                    try:
                        episode_title = episode_a["title"]
                        if " - " in episode_title:
                            episode_title = episode_title.split(" - ")[-1]
                            visited_text.append(get_valid_filename(episode_title))
                        else:
                            episode_title = ""
                    except:
                        pass

                    metadata = episode_a.find("div", class_=lambda c: c and "article-meta-data" in c)
                    if metadata is not None:
                        for meta_node in metadata.find_all(recursive=True):
                            meta_class = meta_node.get("class", None)
                            if meta_class is None:
                                continue

                            for f in ["episode-title", "episode", "episode-date"]:
                                if f in meta_class:
                                    meta_text = meta_node.get_text()
                                    tmp_text = get_valid_filename(meta_text)

                                    is_visited = False
                                    for txt in visited_text:
                                        if tmp_text is None:
                                            break
                                        if txt in tmp_text or tmp_text in txt:
                                            is_visited = True
                                            break
                                    if is_visited:
                                        continue

                                    episode_title += " " + meta_text
                                    visited_text.append(get_valid_filename(meta_text))

                    if episode_title == "":
                        episode_title = episode_url.split("/play/")[-1]
                    episode_page = None

                    for attempt in range(0, rtp_pt.RETRIES_COUNT):
                        try:
                            episode_page = requests.get(
                                episode_url,
                                headers={'User-Agent': rtp_pt.USER_AGENT}
                            )
                            episode_page = episode_page.text
                            break
                        except ChunkedEncodingError:
                            if attempt == rtp_pt.RETRIES_COUNT - 1:
                                raise
                            time.sleep(rtp_pt.RETRIES_TIMER)
                        except:
                            raise

                    episode_parts_soup = BeautifulSoup(episode_page, 'html5lib')
                    episode_parts = episode_parts_soup.find("div", lambda c: c and "section-parts" in c)
                    if episode_parts is None:
                        episode_parts = []
                    else:
                        episode_parts = episode_parts.find_all("a", {"href": True})

                    part_index = 1
                    parts = [(part_index, episode_url, episode_page)]
                    for episode_part in episode_parts:
                        try:
                            part_url = episode_part["href"]
                            if not part_url.startswith("http"):
                                part_url = rtp_pt.BASE_URL + part_url
                        except:
                            continue
                        part_index += 1
                        parts.append((part_index, part_url, None))

                    for part_index, part_url, part_page in parts:
                        content_index = episode_index + part_index * 0.01
                        check = check_range(False, season_index, content_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                        collection.append(BaseElement(
                            url=part_url,
                            collection=join(collection_title, season_title),
                            element=get_valid_filename(f'E{episode_index}P{part_index} {episode_title}'),
                            additional={"page_html": part_page}
                        ))
        return collection
