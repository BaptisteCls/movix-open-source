import builtins
import json
import os
import re
from copy import deepcopy
from os.path import join

import m3u8
import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, clean_url, get_public_ip


class adultswim_com(BaseService):
    DEMO_URLS = [
        "https://www.adultswim.com/videos/specials/mother-may-i-dance-with-mary-janes-fist-a-lifetone-original-movie",
        "https://www.adultswim.com/videos/12-oz-mouse/corndog-chronicles",
        "https://www.adultswim.com/videos/common-side-effects/pilot",
        "https://www.adultswim.com/videos/apollo-gauntlet/eros",
        "https://www.adultswim.com/videos/dragon-ball-z-kai/a-boundary-pushing-brawl-goku-frieza-and-ginyu-again",
        "https://www.adultswim.com/videos/toonami/toonami-music-video-koko-v",

        "https://www.adultswim.com/videos/aqua-teen-hunger-force",
        "https://www.adultswim.com/videos/rick-and-morty",
        "https://www.adultswim.com/videos/12-oz-mouse",
        "https://www.adultswim.com/videos/music-videos",
        "https://www.adultswim.com/videos/promos",
    ]

    VIDEO_API_URL = 'https://www.adultswim.com/api/shows/v1/videos/{video_id}'
    MEDIA_URL = 'https://medium.ngtv.io/v2/media/{media_id}/desktop'
    LICENSE_URL = "https://widevine.license.istreamplanet.com/widevine/api/license/e1b9076f-e876-436d-ba0a-d0fac24ff03e"
    DRM_TOKEN_URL = 'https://token.ngtv.io/token/token_isp'
    GRAPHQL_URL = 'https://api.adultswim.com/v1'
    APP_ID_URL = 'https://www.adultswim.com/videos/smalls'

    APP_ID = None
    PUBLIC_IP = None
    SHA256 = {
        "ShowPage": "bd4268978154f8418a63abb1571627cb322078e30d1ba2409b93d1e45d5648ed",
        "ShowExtras": "73ef922a385ce12855326cde2523273fed37347ea39e9549977247aa1a40eec0",
        "ShowClips": "f960692d22ecbd51f90be300cc61e30ac3ec847a54e833d196b2c1101b79ca91"
    }

    @staticmethod
    def test_service():
        main_service.run_service(adultswim_com)

    @staticmethod
    def get_additional_params(additional):
        additional_params = BaseService.get_additional_params(additional)
        if additional.get("FORWARD_IP", False) is True:
            additional_params = [(
                ("HEADER", lambda s: s.format(key="X-Forwarded-For", value=adultswim_com.PUBLIC_IP))
            )] + additional_params
        return additional_params

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_app_id():
        response = requests.get(adultswim_com.APP_ID_URL).text
        response = re.findall(r'[\'"](http[^\'"]*auth[^\'"]*\.js)[\'"]', response, re.IGNORECASE)
        response = requests.get(response[0]).text
        response = re.findall(r'withServiceAppId\([\'"]([^\'"]+)[\'"]', response)
        return response[0]

    @staticmethod
    def initialize_service():
        if adultswim_com.APP_ID is None:
            adultswim_com.APP_ID = adultswim_com.get_app_id()

        if adultswim_com.PUBLIC_IP is None:
            if builtins.CONFIG.get("BASIC", False) is True:
                adultswim_com.PUBLIC_IP = "<IP>"
            else:
                adultswim_com.PUBLIC_IP = get_public_ip()

            if adultswim_com.PUBLIC_IP is None:
                raise CustomException(ERR_MSG.format(
                    type=f'{APP_ERROR}',
                    url=f'from the {adultswim_com.__name__} service',
                    reason="Failed to obtain the public IP",
                    solution="Fix the code responsible for obtaining the IP"
                ))
        return adultswim_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            adultswim_com.LICENSE_URL, data=challenge,
            headers={"x-isp-token": additional["drm_token"]}
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_best_res_from_m3u8(m3u8_object):
        best_res = 0
        for segment in m3u8_object.playlists + m3u8_object.media:
            try:
                res = int(segment.stream_info.resolution[1])
                if res > best_res:
                    best_res = res
            except:
                pass
        return best_res

    @staticmethod
    def get_free_stream(free_streams, min_height):
        free_streams = free_streams["assets"]
        assert type(free_streams) is list and len(free_streams) > 0

        best_streams = []
        for free_stream in free_streams:
            try:
                assert free_stream["mime_type"].lower() in ["application/x-mpegurl"]
                assert clean_url(free_stream["url"]).endswith(".m3u8")
                bitrate = int(free_stream["bitrate"])
                assert bitrate > 0

                height = adultswim_com.get_best_res_from_m3u8(
                    m3u8.loads(requests.get(free_stream["url"]).text)
                )
                assert height >= min_height > 0
                best_streams.append((free_stream["url"], height, bitrate))
                break
            except:
                pass

        best_streams = sorted(best_streams, key=lambda st: (-st[1], -st[2]))
        return best_streams[0][0]

    @staticmethod
    def fix_relative_url(relative_url, absolute_url):
        dots = relative_url.count("../")
        temp_base_url = absolute_url.split("/")
        temp_base_url = temp_base_url[0:len(temp_base_url) - dots]
        temp_base_url = "/".join(temp_base_url)

        relative_url = relative_url.replace("../", "")
        if not relative_url.startswith("/"):
            relative_url = "/" + relative_url
        relative_url = temp_base_url + relative_url
        return relative_url

    @staticmethod
    def split_manifest(manifest_object, manifest_url, source_element):
        manifest_content = manifest_object.dumps()
        try:
            pssh_value = re.search(r'base64,([^"]+)"', manifest_content).group(1)
            assert len(pssh_value) > 0
            if builtins.CONFIG.get("BASIC", False) is True:
                return manifest_url, pssh_value
        except:
            pssh_value = None

        manifest_segments = {}
        parts_counter = None
        track_index = 0

        base_url = clean_url(manifest_url).split("/")
        del base_url[-1]
        base_url = "/".join(base_url)

        for segment in manifest_object.playlists + manifest_object.media:
            segment_url = segment.uri
            if segment_url is None:
                continue
            if manifest_segments.get(segment_url, None) is not None:
                continue
            if not segment_url.startswith("http"):
                segment_url = adultswim_com.fix_relative_url(segment_url, base_url)

            track_content = requests.get(segment_url).text
            if pssh_value is None:
                try:
                    pssh_value = re.search(r'base64,([^"]+)"', track_content).group(1)
                    assert len(pssh_value) > 0
                    if builtins.CONFIG.get("BASIC", False) is True:
                        return manifest_url, pssh_value
                except:
                    pssh_value = None

            current_parts = track_content.count("#EXT-X-MAP:")
            if parts_counter is None:
                parts_counter = current_parts
            else:
                assert parts_counter == current_parts
            init_m3u8 = track_content.split("#EXT-X-MAP:")[0]
            end_m3u8 = "#EXT-X-ENDLIST"
            m3u8_maps = [
                f'#EXT-X-MAP:{m.strip()}'
                for m in track_content.split('#EXT-X-MAP:')[1:] if m.strip()
            ]

            segment_base_url = clean_url(segment_url).split("/")
            del segment_base_url[-1]
            segment_base_url = "/".join(segment_base_url)
            part_m3u8s = []

            for m in m3u8_maps:
                part_m3u8 = list(reversed(m.splitlines()))
                ext_index = 0
                while "#ext-x-" in part_m3u8[ext_index].lower():
                    ext_index += 1
                part_m3u8 = "\n".join(list(reversed(part_m3u8[ext_index:])))
                part_m3u8 = f'{init_m3u8}\n{part_m3u8}\n{end_m3u8}'

                part_m3u8 = m3u8.loads(part_m3u8)
                for part_segment in part_m3u8.media + part_m3u8.segments:
                    if part_segment.uri is None:
                        continue
                    if not part_segment.uri.startswith("http"):
                        part_segment.uri = adultswim_com.fix_relative_url(part_segment.uri, segment_base_url)
                    try:
                        if not part_segment.init_section.uri.startswith("http"):
                            part_segment.init_section.uri = adultswim_com.fix_relative_url(
                                part_segment.init_section.uri, segment_base_url
                            )
                    except:
                        pass

                part_m3u8 = part_m3u8.dumps()
                part_m3u8s.append(part_m3u8)
            track_index += 1
            manifest_segments[segment.uri] = {"url": segment_url, "parts": part_m3u8s, "index": track_index}

        assert pssh_value is not None
        if parts_counter == 1:
            return manifest_url, pssh_value
        output_path = join(source_element.collection, source_element.element)

        visited = []
        master_paths = []
        z_width = len(str(parts_counter))
        for part_index in range(0, parts_counter):
            master_name = f"Part_{str(part_index + 1).zfill(z_width)}"
            master_path = join(str(output_path), master_name)
            if not os.path.exists(master_path):
                os.makedirs(master_path)

            temp_manifest_object = deepcopy(manifest_object)
            for segment in temp_manifest_object.playlists + temp_manifest_object.media:
                segment_url = segment.uri
                if segment_url is None:
                    continue
                segment_dict = manifest_segments.get(segment_url, None)
                if segment_dict is None:
                    continue

                segment_url = f"track_{segment_dict['index']}_part_{part_index + 1}.m3u8"
                if segment_url not in visited:
                    visited.append(segment_url)
                    with open(join(master_path, segment_url), "w") as f:
                        f.write(segment_dict["parts"][part_index])
                segment.uri = segment_url

            master_path = join(master_path, f'master.m3u8')
            with open(master_path, "w") as f:
                f.write(temp_manifest_object.dumps())
            master_paths.append((master_path, master_name))
        return master_paths, pssh_value

    @staticmethod
    def get_apollo_state(page_text):
        try:
            soup = BeautifulSoup(page_text, 'html5lib')
            script = soup.find_all('script', {'type': 'application/json'})
            script = [s for s in script if s.get("id", None) == "__NEXT_DATA__"][0]

            script = json.loads(script.string)
            page_content = script["props"]["pageProps"]["__APOLLO_STATE__"]
            assert type(page_content) is dict
        except:
            page_content = {}
        return page_content

    @staticmethod
    def get_video_data(source_element):
        if source_element.additional is None:
            source_element.additional = {}
        video_slug = source_element.url.split("/")[-1]
        video_id, video_content = source_element.additional.get("id", None), None

        if video_id in ["", None]:
            response = requests.get(source_element.url)
            if response.status_code < 200 or response.status_code >= 300:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available",
                    solution="Don't attempt to download it"
                ))
            page_content = adultswim_com.get_apollo_state(response.text)

            for page_k, page_v in page_content.items():
                if type(page_v) is not dict:
                    continue

                if "videocollection" in page_k.lower():
                    for col_k, col_v in page_v.items():
                        try:
                            check = re.search(fr'[\'"]slug[\'"]:[\'"]{video_slug}[\'"]', col_k)
                            assert check is not None

                            assert ":" in col_v["id"]
                            video_id = col_v["id"].split(":")[1]
                            assert len(video_id) > 0
                            video_content = col_v
                            break
                        except:
                            video_id, video_content = None, None

                if video_id is not None:
                    break
                try:
                    assert ":" in page_k
                    assert page_v["slug"] == video_slug

                    video_id = page_k.split(":")[1]
                    assert len(video_id) > 0
                    video_content = page_v
                    break
                except:
                    video_id, video_content = None, None

        if video_content is None:
            video_content = {}
        if video_id in ["", None]:
            show_slug = source_element.url.split("/")[-2]
            response = requests.get(
                adultswim_com.GRAPHQL_URL,
                params={
                    "operationName": "ShowPage",
                    "variables": json.dumps({"show": show_slug, "video": video_slug}),
                    "extensions": json.dumps({
                        "persistedQuery": {"version": 1, "sha256Hash": adultswim_com.SHA256["ShowPage"]}
                    })
                }
            )
            response = json.loads(response.content.decode())["data"]["show"]["collection"]["video"]
            video_id = response["id"]
            video_content = response

        assert video_id not in ["", None]
        if source_element.element is None:
            title = video_content.get("title", None)
            if title not in ["", None]:
                for f in ["seasonNumber", "episodeNumber"]:
                    try:
                        i = int(video_content[f])
                        assert i > 0
                        title += " " + f[0] + str(i)
                    except:
                        pass

                source_element.element = get_valid_filename(title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                adultswim_com.__name__
            )

        response = requests.get(
            adultswim_com.VIDEO_API_URL.format(video_id=video_id),
            params={
                "fields": ",".join([
                    "title", "type", "duration", "collection_title", "stream",
                    "title_id", "auth", "media_id", "season_number", "episode_number"
                ])
            })
        status_code = response.status_code
        response = response.content.decode()

        response = json.loads(response)
        error_code = response.get("errorCode", None)
        if status_code in [404] or error_code in [404]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))

        response = response["data"]["video"]
        if source_element.element is None:
            title = video_content.get("title", None)
            if title in ["", None]:
                title = video_slug
            if response.get("collection_title", None) not in ["", None]:
                title = response["collection_title"] + " " + title

            for f in ["season_number", "episode_number"]:
                try:
                    i = int(response[f])
                    assert i > 0
                    title += " " + f[0] + str(i)
                except:
                    pass
            source_element.element = get_valid_filename(title)

        free_streams = response.get("stream", None)
        media_id = response["media_id"]
        if media_id in ["", None]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))

        response = requests.get(
            adultswim_com.MEDIA_URL.format(media_id=media_id),
            params={"appId": adultswim_com.APP_ID}
        )
        response = response.content.decode()
        response = json.loads(response)
        try:
            error = response["error"]["error"].lower()
            assert len(error) > 0 and type(error) is str
        except:
            error = ""

        if "does not exist" in error and "mediaid" in error:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))

        response = response["media"]["desktop"]
        try:
            manifest_url = response["unprotected"]["unencrypted"]["url"]
            assert type(manifest_url) is str and len(manifest_url) > 0
        except:
            manifest_url = None

        if manifest_url is not None:
            status_code = requests.head(manifest_url, allow_redirects=False).status_code
            if status_code < 200 or 300 <= status_code:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="Need American IP to access content",
                    solution="Use a VPN"
                ))
            return manifest_url, None, {"FORWARD_IP": True}

        try:
            response = response["widevine"]["cenc"]
            manifest_url = response["url"]
            assert type(manifest_url) is str and len(manifest_url) > 0
        except:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason=f"DRM not supported. Widevine wasn't found",
                solution="Do not attempt to download it"
            ))

        check_url = clean_url(manifest_url)
        if not check_url.endswith(".m3u8"):
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {check_url}",
                solution=f"Extend the {adultswim_com.__name__} service"
            ))
        asset_id = response["assetId"]
        assert asset_id not in ["", None]

        response = requests.get(
            adultswim_com.DRM_TOKEN_URL,
            params={
                'appId': adultswim_com.APP_ID, 'format': 'json',
                'assetId': asset_id, 'mediaId': media_id
            }
        )
        response = response.content.decode()
        response = json.loads(response)
        try:
            err_msg = response["auth"]["error"]
            err_msg = err_msg.get("msg", err_msg.get("message", "")).lower()
            assert len(err_msg) > 0 and type(err_msg) is str
        except:
            err_msg = ""

        if "invalid asset id" in err_msg or "invalid media asset" in err_msg:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))
        if "content blocked" in err_msg and "location" in err_msg:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need American IP to access content",
                solution="Use a VPN"
            ))
        if "authentication token" in err_msg:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available without a TV provider account",
                solution="Do not attempt to download it"
            ))

        manifest_object = m3u8.loads(requests.get(manifest_url).text)
        min_res = adultswim_com.get_best_res_from_m3u8(manifest_object)
        if min_res == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need American IP to access content",
                solution="Use a VPN (that is not detected)"
            ))
        try:
            return adultswim_com.get_free_stream(free_streams, min_res), None, {"FORWARD_IP": True}
        except:
            pass

        additional = {"drm_token": response["jwt"]}
        try:
            manifest_url, pssh_value = adultswim_com.split_manifest(manifest_object, manifest_url, source_element)
        except:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {check_url}",
                solution=f"Extend the {adultswim_com.__name__} service"
            ))
        return manifest_url, pssh_value, additional

    @staticmethod
    def handle_seasons_episodes(collection_url, page_content, collection_title):
        videos = []
        season_max = None
        extra_cursor = None
        extra_contents = []
        past_urls = []

        for page_k, page_v in page_content.items():
            if extra_cursor is None:
                try:
                    assert "VideoCollection" in page_k and page_k.split(".")[-1] == "pageInfo"
                    assert len(page_v["endCursor"]) > 0 and type(page_v["endCursor"]) is str
                    assert page_v["hasNextPage"] is True
                    extra_cursor = page_v["endCursor"]
                except:
                    extra_cursor = None

            try:
                season_index = int(page_v["seasonNumber"])
                if season_max is None or season_index > season_max:
                    season_max = season_index
            except:
                season_index = None
            try:
                episode_index = int(page_v["episodeNumber"])
            except:
                episode_index = None

            try:
                video_id = page_v.get("id", None)
                if video_id in ["", None]:
                    video_id = page_k.split(":")[1]
                assert video_id not in ["", None]

                for f in [":", ".", "{", "}"]:
                    assert f not in video_id
            except:
                continue
            if season_index is None and episode_index is None:
                try:
                    assert "VideoCollection" not in page_k
                    for f in ["seasonNumber", "episodeNumber"]:
                        assert page_v[f] is None
                    extra_contents.append(page_v)
                except:
                    pass
                continue
            videos.append((season_index, episode_index, video_id, page_v))

        if season_max is None:
            season_max = 1
        else:
            season_max += 1
        temp_videos = []
        season_dict = {}

        for season_index, episode_index, video_id, video_info in videos:
            if season_index is None:
                season_index = season_max

            if episode_index is not None:
                if season_dict.get(season_index, None) is None:
                    season_dict[season_index] = episode_index
                elif episode_index > season_dict[season_index]:
                    season_dict[season_index] = episode_index
            temp_videos.append((season_index, episode_index, video_id, video_info))
        videos = temp_videos

        temp_videos = []
        for season_index, episode_index, video_id, video_info in videos:
            if episode_index is None:
                episode_index = season_dict.get(season_index, 0) + 1
                season_dict[season_index] = episode_index
            temp_videos.append((season_index, episode_index, video_id, video_info))
        videos = temp_videos

        videos = sorted(videos, key=lambda e: (e[0], e[1]))
        collection = []
        visited = []
        rail_index = 0
        rail_extras_index = 1

        for season_index, episode_index, video_id, video_info in videos:
            if season_index not in visited:
                visited.append(season_index)
                rail_index += 1
                rail_extras_index += 1

            video_url = collection_url + "/" + video_info["slug"]
            if video_url in past_urls:
                continue
            else:
                past_urls.append(video_url)

            check = check_range(True, rail_index, None)
            if check is True:
                continue
            elif check is False:
                return collection, True, None

            check = check_range(False, rail_index, episode_index)
            if check is True:
                continue
            elif check is False:
                return collection, True, None

            video_title = video_info.get("title", None)
            if video_title in ["", None]:
                video_title = video_info["slug"]

            collection.append(BaseElement(
                url=video_url,
                collection=join(collection_title, f'Rail_{rail_index}'),
                element=get_valid_filename(f"Video_{episode_index} {video_title}"),
                additional={"id": video_id}
            ))

        return collection, False, (rail_extras_index, extra_contents, extra_cursor)

    @staticmethod
    def handle_extras(collection, show_slug, collection_url, collection_title, extra_tuple):
        rail_extras_index, extra_contents, extra_cursor = extra_tuple
        check = check_range(True, rail_extras_index, None)
        if check is True:
            return collection, False
        elif check is False:
            return collection, True

        past_urls = [c.url for c in collection]
        extra_index = 0
        while True:
            response = None
            if extra_cursor is not None:
                response = requests.get(
                    adultswim_com.GRAPHQL_URL,
                    params={
                        "operationName": "ShowExtras",
                        "variables": json.dumps({"show": show_slug, "cursor": extra_cursor}),
                        "extensions": json.dumps({
                            "persistedQuery": {"version": 1, "sha256Hash": adultswim_com.SHA256["ShowExtras"]}
                        })
                    }
                )

            try:
                response = json.loads(response.content.decode())
                response = response["data"]["show"]["collection"]["videos"]
                extras = response["nodes"]
                assert len(extras) > 0 and type(extras) is list
            except:
                extras = []
            extras = extra_contents + extras
            extra_contents = []
            if len(extras) == 0:
                break

            for extra in extras:
                extra_url = collection_url + "/" + extra["slug"]
                if extra_url in past_urls:
                    continue
                else:
                    past_urls.append(extra_url)

                extra_index += 1
                check = check_range(False, rail_extras_index, extra_index)
                if check is True:
                    continue
                elif check is False:
                    return collection, True

                extra_title = extra.get("title", None)
                if extra_title in ["", None]:
                    extra_title = extra["slug"]

                collection.append(BaseElement(
                    url=extra_url,
                    collection=join(collection_title, f'Rail_{rail_extras_index}_Extras'),
                    element=get_valid_filename(f"Extra_{extra_index} {extra_title}"),
                    additional={"id": extra['id']}
                ))

            try:
                response = response["pageInfo"]
                assert response["hasNextPage"] is True
                extra_cursor = response["endCursor"]
                assert len(extra_cursor) > 0 and type(extra_cursor) is str
            except:
                extra_cursor = None
            if extra_cursor is None:
                break
        return collection, False

    @staticmethod
    def handle_clips(collection, show_slug, collection_url, collection_title, rail_clips_index):
        past_urls = [c.url for c in collection]

        try:
            response = requests.get(
                adultswim_com.GRAPHQL_URL,
                params={
                    "operationName": "ShowClips",
                    "variables": json.dumps({
                        "show": show_slug,
                        "sort": ["seasonNumber:desc", "episodeNumber:desc", "launchDate:desc", "clipOrder"]
                    }),
                    "extensions": json.dumps({
                        "persistedQuery": {"version": 1, "sha256Hash": adultswim_com.SHA256["ShowClips"]}}
                    )
                }
            )
            response = json.loads(response.content.decode())
            rail_clips = response["data"]["show"]["collection"]["seasons"]["nodes"]
            assert len(rail_clips) > 0 and type(rail_clips) is list
        except:
            rail_clips = []

        rail_clips_index -= 1
        for rail_clip in rail_clips:
            rail_clips_index += 1
            check = check_range(True, rail_clips_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            season_number = rail_clip["number"]
            clips_index = 0
            clips_cursor = None
            while True:
                variables = {
                    "season": season_number, "show": show_slug,
                    "sort": ["seasonNumber:desc", "episodeNumber:desc", "launchDate:desc", "clipOrder"]
                }
                if clips_cursor is not None:
                    variables["cursor"] = clips_cursor

                response = requests.get(
                    adultswim_com.GRAPHQL_URL,
                    params={
                        "operationName": "ShowClips",
                        "variables": json.dumps(variables),
                        "extensions": json.dumps({
                            "persistedQuery": {"version": 1, "sha256Hash": adultswim_com.SHA256["ShowClips"]}
                        })
                    }
                )
                try:
                    response = json.loads(response.content.decode())
                    response = response["data"]["show"]["collection"]["clips"]
                except:
                    break

                try:
                    clips = response["nodes"]
                    assert len(clips) > 0 and type(clips) is list
                except:
                    clips = []

                for clip in clips:
                    clip_url = collection_url + "/" + clip["slug"]
                    if clip_url in past_urls:
                        continue
                    else:
                        past_urls.append(clip_url)

                    clips_index += 1
                    check = check_range(False, rail_clips_index, clips_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    clips_title = clip.get("title", None)
                    if clips_title in ["", None]:
                        clips_title = clip["slug"]

                    collection.append(BaseElement(
                        url=clip_url,
                        collection=join(collection_title, f'Rail_{rail_clips_index}_Clips_{season_number}'),
                        element=get_valid_filename(f"Clip_{clips_index} {clips_title}"),
                        additional={"id": clip['id']}
                    ))
                try:
                    response = response["pageInfo"]
                    assert response["hasNextPage"] is True
                    clips_cursor = response["endCursor"]
                    assert len(clips_cursor) > 0 and type(clips_cursor) is str
                except:
                    clips_cursor = None
                if clips_cursor is None:
                    break
        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url).rstrip("/")
        if "/videos/" not in collection_url:
            return None

        slash_count = collection_url.split("/videos/")[1].count("/")
        if slash_count == 1:
            return [BaseElement(url=collection_url)]
        if slash_count > 0:
            return None

        response = requests.get(collection_url)
        if response.status_code < 200 or response.status_code >= 300:
            return []
        page_content = adultswim_com.get_apollo_state(response.text)
        show_slug = collection_url.split("/")[-1]
        try:
            collection_title = page_content[show_slug]["title"]
        except:
            collection_title = show_slug
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                adultswim_com.__name__
            ),
            get_valid_filename(collection_title)
        )

        collection, return_flag, extra_tuple = adultswim_com.handle_seasons_episodes(
            collection_url, page_content, collection_title
        )
        if return_flag:
            return collection

        rail_extras_index, extra_contents, extra_cursor = extra_tuple
        rail_clips_index = rail_extras_index
        if len(extra_contents) > 0 or extra_cursor is not None:
            rail_clips_index += 1

        collection, return_flag = adultswim_com.handle_extras(
            collection, show_slug, collection_url, collection_title, extra_tuple
        )
        if return_flag:
            return collection

        collection = adultswim_com.handle_clips(
            collection, show_slug, collection_url, collection_title, rail_clips_index
        )
        return collection
