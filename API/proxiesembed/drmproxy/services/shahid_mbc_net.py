import binascii
import builtins
import hashlib
import hmac
import json
import re
import time
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, APP_ERROR, CACHE_DIR, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import dict_to_file, file_to_dict, get_valid_filename, clean_url


class shahid_mbc_net(BaseService):
    DEMO_URLS = [
        "https://shahid.mbc.net/en/shows/Ma'-Al-Mestikawy/show-88548",
        "https://shahid.mbc.net/en/series/Leh%20Laa!-season-1/season-413520-413521",
        "https://shahid.mbc.net/en/player/episodes/Standup-Sketch-season-1-episode-1/id-921243",
        "https://shahid.mbc.net/en/player/movies/Special-Interview/id-979254",
        "https://shahid.mbc.net/ar/player/episodes/%D9%85%D9%81%D8%AA%D8%B1%D9%82-%D8%B7%D8%B1%D9%82-%D8%A7%D9%84%D9%85%D9%88%D8%B3%D9%85-1-%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9-1/id-1027258",
        "https://shahid.mbc.net/en/livestream/MBC-Masr/livechannel-387290",
        "https://shahid.mbc.net/en/livestream/MBC-Drama/livechannel-387251",
    ]

    DRM_URL = 'https://api3.shahid.net/proxy/v2.1/playout/new/drm'
    MANIFEST_URL = 'https://api3.shahid.net/proxy/v2.1/playout/new/url/{id}'
    ASSET_URL = 'https://api3.shahid.net/proxy/v2.1/playableAsset'
    PLAYLIST_URL = 'https://api3.shahid.net/proxy/v2.1/product/playlist'
    CHUNK_JS_URL = 'https://shahid.mbc.net/streaming-pages/_next/static/chunks/{chunk}'
    BASE_URL = 'https://shahid.mbc.net'

    CACHE_FILE = None
    SITE_INFO = None
    COUNTRY = "ARE"
    PAGE_SIZE = 25

    @staticmethod
    def test_service():
        main_service.run_service(shahid_mbc_net)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/livestream/" in content

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_site_info():
        try:
            file_dict = file_to_dict(shahid_mbc_net.CACHE_FILE)
            assert len(file_dict.keys()) == 2
            return file_dict
        except:
            pass

        response = requests.get(shahid_mbc_net.CHUNK_JS_URL.format(chunk="remoteEntry.js")).content.decode()
        response = re.search(r'"static/chunks/"(.*?)"\.js"', response).group(1)

        response = re.findall(r'(\d+):"([^"]+)"', response)
        for r in response:
            if not bool(re.search(r"\d", r[1])):
                continue

            response = requests.get(shahid_mbc_net.CHUNK_JS_URL.format(chunk=f"{r[0]}.{r[1]}.js")).content.decode()
            try:
                site_info = {
                    "BROWSER_VERSION": re.search(r'BROWSER_VERSION="([^\"]+)"', response).group(1),
                    "SECRET_KEY": max(re.findall(r'{let t="([^\"]+)";', response), key=len),
                    # "BROWSER_VERSION": "50.0.0",
                    # "SECRET_KEY": "z3qQSk17nbajIYUF0dU5f4+O/CxjFizcsEJr9ejOYFw=",
                }

                dict_to_file(shahid_mbc_net.CACHE_FILE, site_info)
                return site_info
            except:
                pass
        raise "Failed to extract site information"

    @staticmethod
    def initialize_service():
        if shahid_mbc_net.CACHE_FILE is None:
            shahid_mbc_net.CACHE_FILE = join(CACHE_DIR, f'{shahid_mbc_net.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(shahid_mbc_net.CACHE_FILE, {})

        if shahid_mbc_net.SITE_INFO is None:
            shahid_mbc_net.SITE_INFO = shahid_mbc_net.get_site_info()
        return shahid_mbc_net

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def generate_auth(auth_params):
        return binascii.hexlify(hmac.new(
            shahid_mbc_net.SITE_INFO["SECRET_KEY"].encode('utf-8'),
            ";".join(
                f"{k}={auth_params[k]}"
                for k in sorted(auth_params.keys())
            ).encode('utf-8'),
            hashlib.sha256
        ).digest()).decode('utf-8')

    @staticmethod
    def get_video_data(source_element):
        asset_type = "/id-"
        if "/livestream/" in source_element.url:
            asset_type = "/livechannel-"

        asset_id = re.search(fr"{asset_type}([^/?#]+)", source_element.url).group(1)
        if source_element.element is None:
            source_element.element = f"VideoId_{asset_id}"
            if "/ar/" not in source_element.url:
                source_element.element = source_element.url.split(asset_type)[0].split("/")[-1]
            source_element.element = get_valid_filename(source_element.element)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                shahid_mbc_net.__name__
            )

        response = json.loads(requests.get(
            shahid_mbc_net.MANIFEST_URL.format(id=asset_id),
            params={'outputParameter': 'vmap', 'country': shahid_mbc_net.COUNTRY}
        ).content.decode())
        status_code = response.get("responseCode", None)

        message = str(response).lower()
        if status_code == 404:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))
        if status_code == 401 and ("vpn" in message or "proxy" in message):
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The VPN was detected",
                solution="Get a better VPN or don't use one"
            ))
        if status_code == 422 and "subscriber" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Emirati IP to access content or it is paid content",
                solution="Use a VPN or don't attempt to download it"
            ))

        response = response["playout"]
        manifest = clean_url(response["url"]).split("&")[0]
        license_url = None
        pssh_value = None
        if response.get("drm", False) is False:
            return manifest, pssh_value, {"license_url": license_url}

        auth_params = {
            'country': shahid_mbc_net.COUNTRY, 'ts': int(time.time() * 1000),
            'request': json.dumps({"assetId": asset_id})
        }
        response = json.loads(requests.get(
            shahid_mbc_net.DRM_URL, params=auth_params,
            headers={
                'SHAHID_OS': 'WINDOWS', 'BROWSER_NAME': 'CHROME',
                'BROWSER_VERSION': shahid_mbc_net.SITE_INFO["BROWSER_VERSION"],
                'Authorization': shahid_mbc_net.generate_auth(auth_params)
            }
        ).content.decode())

        status_code = response.get("responseCode", None)
        if status_code == 403:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't access the video content because the secret key was changed",
                solution=f'Delete the {shahid_mbc_net.CACHE_FILE} cache manually or add the parameter --fresh to your command'
            ))

        license_url = response["signature"]
        try:
            pssh_value = str(min(
                re.findall(
                    r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                    requests.get(manifest).content.decode()
                ), key=len
            ))
        except:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Couldn't extract PSSH. Manifest not supported: {manifest}",
                solution=f"Extend the {shahid_mbc_net.__name__} service"
            ))

        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_series_handler(collection_url):
        site_language = collection_url.split(shahid_mbc_net.BASE_URL + "/")[1].split("/")[0]
        site_language = shahid_mbc_net.BASE_URL + "/" + site_language + "/"

        collection = []
        response = json.loads(re.findall(
            r'type="application/json"[^<>]*>({.*?})</script>',
            requests.get(collection_url).content.decode()
        )[0])["props"]["pageProps"]["response"]["productModel"]["show"]

        collection_name = None
        if "/ar/" not in collection_url:
            collection_name = response.get("title", None)
        if collection_name is None:
            if "/ar/" not in collection_url:
                if "-season-" in collection_url:
                    collection_name = collection_url.split("-season-")[0].split("/")[-1]
                elif "/show-" in collection_url:
                    collection_name = collection_url.split("/show-")[0].split("/")[-1]
                else:
                    collection_name = collection_url.split("/")[-2]
            else:
                collection_name = collection_url.split("/")[-1]
        collection_name = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                shahid_mbc_net.__name__
            ),
            get_valid_filename(collection_name)
        )

        seasons = response.get("seasons", [])
        seasons = sorted(seasons, key=lambda s: int(s["seasonNumber"]))
        if len(seasons) == 0:
            return []
        extra_season_index = int(seasons[-1]["seasonNumber"])

        for season in seasons:
            extra_season_index += 1
            season_index = int(season["seasonNumber"])

            playlists = season.get("EXTRA_CONTENT", None)
            if playlists is None:
                response = json.loads(requests.get(
                    shahid_mbc_net.ASSET_URL,
                    params={
                        'request': json.dumps({"seasonId": str(season["id"])}),
                        'country': shahid_mbc_net.COUNTRY
                    }
                ).content.decode())["productModel"]
                playlist = response["playlist"]

                playlists = response.get("show", {}).get("season", {}).get("playlists", [])
                playlists = filter(lambda p: p["id"] != playlist["id"], playlists)
                playlists = sorted(playlists, key=lambda p: p["id"])

                seasons.append({
                    "seasonNumber": extra_season_index,
                    "EXTRA_CONTENT": playlists
                })
                playlists = [playlist]

            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            extra_episode_index = 0
            for playlist in playlists:
                page = -1
                while True:
                    page += 1

                    episodes = json.loads(requests.get(
                        shahid_mbc_net.PLAYLIST_URL,
                        params={
                            'request': json.dumps({
                                "pageNumber": page, "pageSize": shahid_mbc_net.PAGE_SIZE,
                                "playListId": playlist["id"], "isDynamicPlaylist": False,
                                "sorts": [{"order": "DESC", "type": "SORTDATE"}]
                            }),
                            'country': shahid_mbc_net.COUNTRY
                        }
                    ).content.decode()).get("productList", {}).get("products", [])

                    if len(episodes) == 0:
                        break

                    for episode in episodes:
                        extra_episode_index += 1
                        if season.get("EXTRA_CONTENT", None) is not None:
                            episode["number"] = extra_episode_index

                        check = check_range(False, season_index, int(episode["number"]))
                        if check in [True, False]:
                            continue

                        episode_urls = episode.get("productUrls", []) + [episode.get("productUrl", {})]
                        episode_url = None
                        for url in episode_urls:
                            if url["url"].startswith(site_language):
                                episode_url = url["url"]
                                break

                        collection.append(BaseElement(
                            url=episode_url,
                            collection=join(
                                collection_name,
                                f'Season_{season_index}_{get_valid_filename(playlist["type"].lower())}'
                            ),
                            element=f'Episode_{episode["number"]}'
                        ))

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("/")

        if "/player/" in collection_url and "/id-" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/livestream/" in collection_url and "/livechannel-" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/series/" in collection_url or "/shows/" in collection_url:
            return shahid_mbc_net.get_series_handler(collection_url)

        return None
